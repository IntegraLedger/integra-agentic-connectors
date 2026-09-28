/**
 * The deduplication table: one row per settled payment, keyed by network and transaction id, holding the answer the
 * first `/settle` gave. A row is claimed by one conditional insert, so concurrent settles of one payment submit once.
 * A final answer is never replaced; a pending one is replaced by what a later read of the chain shows. A row whose
 * answer is final is kept until `KEEP_AFTER_UNTIL_MS` after its validity window has ended, so a repeat in that time
 * reads the stored answer and the chain before anything is verified again. A row whose answer is not final (a claim
 * with no answer yet, or `settlement_pending`) is kept until a read of the chain makes it final, so a repeat never
 * finds its id missing and never answers that nothing was broadcast. Every call to the database is bounded by
 * `STORE_TIMEOUT_MS`.
 */
import pg from "pg";
import { isPending, type SettleAnswer } from "./answers.js";
import { within } from "./http.js";

/** A row's answer is final when it is written and is not `settlement_pending`. */
const FINAL = "answer IS NOT NULL AND answer->>'errorReason' IS DISTINCT FROM 'settlement_pending'";

/** The table, and the index the sweep reads: the rows whose answer is final, by `until`. */
export const SCHEMA = `CREATE TABLE IF NOT EXISTS settlement (
  network text NOT NULL,
  id text NOT NULL,
  answer jsonb,
  until timestamptz NOT NULL,
  since bigint,
  unread bigint[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (network, id)
);
CREATE INDEX IF NOT EXISTS settlement_final_until ON settlement (until) WHERE ${FINAL}`;

/** The bound on acquiring a connection, on each query as the client waits for it, and on each statement in the server. */
export const STORE_TIMEOUT_MS = 5_000;
/** How long a row whose answer is final is kept after `until`. */
export const KEEP_AFTER_UNTIL_MS = 24 * 60 * 60 * 1000;
const DROP_EVERY_MS = 60_000;

/**
 * What the table holds for an id: nothing, a claim whose answer is not written yet, or the answer. `since` is, for a
 * Polkadot extrinsic, the first block the scan has not yet read at finality: at the claim, the block after the finalized
 * head read before validation (never before the era's birth), and later moved on past the blocks read at finality. It
 * is null for Tron. `unread` is, for a Polkadot extrinsic, the finalized blocks below `since` that could not be read:
 * none of them is shown to lack the extrinsic, so each is read again. It is empty for Tron.
 */
export type Stored =
  | { state: "none" }
  | { state: "claimed"; since: number | null; unread: number[] }
  | { state: "answered"; answer: SettleAnswer; since: number | null; unread: number[] };

export interface SettlementStore {
  read(network: string, id: string): Promise<Stored>;
  /** True when this call inserted the row, and so owns the submission. */
  claim(network: string, id: string, until: Date, since?: number): Promise<boolean>;
  /** Writes the answer unless the row already holds a final one. True when this call wrote it. */
  answer(network: string, id: string, answer: SettleAnswer): Promise<boolean>;
  /** Removes a claim that has no answer: the claimant submitted nothing. True when a row was removed. */
  release(network: string, id: string): Promise<boolean>;
  /**
   * Moves `since` on to `to`, never back, after a scan that read every finalized block from `from` up to `to` except
   * `unread`, and read `resolved`, blocks of the stored `unread` it read again. The stored `unread` gains `unread`,
   * and keeps every block this scan did not read: a concurrent scan's record is never lost.
   */
  advance(network: string, id: string, scan: { from: number; to: number; unread: number[]; resolved: number[] }): Promise<void>;
  /** Drops the rows whose answer is final and whose `until` is more than `KEEP_AFTER_UNTIL_MS` past. */
  drop(): Promise<void>;
  close(): Promise<void>;
}

export async function openStore(url: string): Promise<SettlementStore> {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: STORE_TIMEOUT_MS,
    query_timeout: STORE_TIMEOUT_MS,
    statement_timeout: STORE_TIMEOUT_MS,
  });
  pool.on("error", () => {});
  await pool.query(SCHEMA);

  const store: SettlementStore = {
    async read(network, id) {
      const r = await pool.query<{ answer: SettleAnswer | null; since: string | null; unread: string[] }>(
        "SELECT answer, since, unread FROM settlement WHERE network = $1 AND id = $2",
        [network, id],
      );
      const row = r.rows[0];
      if (row === undefined) return { state: "none" };
      const since = row.since === null ? null : Number(row.since);
      const unread = row.unread.map(Number);
      return row.answer === null
        ? { state: "claimed", since, unread }
        : { state: "answered", answer: row.answer, since, unread };
    },
    async claim(network, id, until, since) {
      const r = await pool.query(
        "INSERT INTO settlement (network, id, answer, until, since) VALUES ($1, $2, NULL, $3, $4) ON CONFLICT DO NOTHING",
        [network, id, until.toISOString(), since ?? null],
      );
      return r.rowCount === 1;
    },
    async answer(network, id, answer) {
      const r = await pool.query(
        `UPDATE settlement SET answer = $3 WHERE network = $1 AND id = $2
           AND (answer IS NULL OR answer->>'errorReason' = 'settlement_pending')${isPending(answer) ? " AND answer IS NULL" : ""}`,
        [network, id, JSON.stringify(answer)],
      );
      return r.rowCount === 1;
    },
    async release(network, id) {
      const r = await pool.query("DELETE FROM settlement WHERE network = $1 AND id = $2 AND answer IS NULL", [network, id]);
      return r.rowCount === 1;
    },
    async advance(network, id, scan) {
      await pool.query(
        `UPDATE settlement SET since = GREATEST(since, $3),
           unread = ARRAY(
             SELECT DISTINCT u FROM unnest(unread || $5::bigint[]) AS u
             WHERE u = ANY($5::bigint[]) OR NOT (u = ANY($6::bigint[]) OR (u >= $4 AND u < $3))
             ORDER BY u)
         WHERE network = $1 AND id = $2`,
        [network, id, scan.to, scan.from, scan.unread, scan.resolved],
      );
    },
    async drop() {
      await pool.query(`DELETE FROM settlement WHERE until < now() - $1 * interval '1 millisecond' AND ${FINAL}`, [
        KEEP_AFTER_UNTIL_MS,
      ]);
    },
    async close() {
      clearInterval(timer);
      await pool.end();
    },
  };
  const timer = setInterval(() => {
    store.drop().catch(() => {});
  }, DROP_EVERY_MS);
  timer.unref();
  return store;
}

/**
 * The part of `settleWaitMs` kept for writing the answer once the wait for the chain ends: a second, or a quarter of a
 * shorter wait. The node calls and the waits end that much before the deadline, so the answer is stored, then given.
 */
export function answerReserve(settleWaitMs: number): number {
  return Math.min(1_000, settleWaitMs / 4);
}

/** A store call bounded by `STORE_TIMEOUT_MS` and by what is left before `deadline` (a `performance.now()` time). */
export function inTime<T>(p: Promise<T>, deadline: number): Promise<T> {
  return within(p, Math.min(STORE_TIMEOUT_MS, deadline - performance.now()));
}
