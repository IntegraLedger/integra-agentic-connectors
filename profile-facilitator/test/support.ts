// Test support: a fresh Postgres database per test file, local node stubs over node:http, a free port below the
// kernel's outgoing range, JSON POSTs, and the controlled clock the facilitator's waits run on.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as netServer } from "node:net";
import { gunzipSync } from "node:zlib";
import pg from "pg";
import { vi } from "vitest";

/** The real `setTimeout`, taken before any test installs fake timers. */
const realSetTimeout = globalThis.setTimeout;

/** Resolves once `condition` holds, checking it every 5 ms. It waits for the condition, however long it takes. */
export async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  while (!(await condition())) await new Promise((resolve) => realSetTimeout(resolve, 5));
}

/**
 * Resolves once `condition` holds: the settle whose answer is `answer` has reached the point the test waits for. Throws
 * if the settle answers first, so a settle that never reaches that point fails the test at once.
 */
export async function reaches(answer: Promise<unknown>, condition: () => boolean | Promise<boolean>): Promise<void> {
  let answered = false;
  void answer.then(
    () => (answered = true),
    () => (answered = true),
  );
  await until(async () => answered || (await condition()));
  if (!(await condition())) throw new Error("the settle answered before it reached the point the test waits for");
}

/** A point at which a stub's answer waits until the test opens it. */
export interface Gate {
  readonly opened: Promise<void>;
  open(): void;
}

export function gate(): Gate {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** When each settle asleep in its poll wakes, on the clock's `performance.now()`, as `countingSleep` records it. */
const sleepers = new Set<{ wakes: number }>();

/**
 * The facilitator's `http.js` with its `sleep` counted, for `vi.mock`: the sleep itself is the module's own, on the
 * controlled clock, and the test sees each settle asleep in its poll and when it wakes.
 */
export function countingSleep<T extends { sleep(ms: number): Promise<void> }>(http: T): T {
  return {
    ...http,
    async sleep(ms: number) {
      const sleeper = { wakes: performance.now() + ms };
      sleepers.add(sleeper);
      try {
        await http.sleep(ms);
      } finally {
        sleepers.delete(sleeper);
      }
    },
  };
}

export interface Clock {
  /** Milliseconds the clock has moved since `controlledClock` installed it. */
  readonly elapsed: number;
  /** How many settles are asleep in their poll. */
  readonly sleeping: number;
  /** Moves the clock on by `ms`, firing in order every timer due by then. */
  advance(ms: number): Promise<void>;
  /** Moves the clock on to `elapsed === ms`. */
  advanceTo(ms: number): Promise<void>;
  /**
   * Records `ms` as the settleWaitMs the facilitator under test is started with, and gives it back for its
   * configuration: `settleWaitMs: clock.settleWait(1_500)`. `answered()` holds each settle to it.
   */
  settleWait(ms: number): number;
  /**
   * Resolves with `answers` once each has arrived, waking the polls: whenever every settle not yet answered is asleep
   * in its poll, the clock moves on to the first of them to wake. A settle waiting on anything else is left to it.
   * Throws when a poll would wake, or the answers arrive, more than the recorded settleWaitMs after the call, and when
   * no settleWaitMs is recorded. Throws when a poll sleeps on once the clock has passed its wake: a sleep that does not
   * run on this clock.
   */
  answered<T>(answers: Promise<T>[]): Promise<T[]>;
}

/**
 * Puts every wait the facilitator makes on one clock that moves only when the test moves it: vitest's fake timers for
 * `setTimeout`, `setInterval`, `Date` and `performance.now()`, and `AbortSignal.timeout`, which Node runs on a timer of
 * its own, rebuilt on the fake `setTimeout`. The settle's wait, the bounds on its node and store calls, and its poll
 * then end when the test advances the clock, never because the machine is slow. `date` sets `Date`, in milliseconds
 * since the epoch. `restore()` puts the real timers back.
 */
export function controlledClock(date?: number): Clock & { restore(): void } {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
    ...(date === undefined ? {} : { now: date }),
  });
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
    return controller.signal;
  });
  sleepers.clear();
  const origin = performance.now();
  let settleWaitMs: number | undefined;
  const clock = {
    get elapsed() {
      return performance.now() - origin;
    },
    get sleeping() {
      return sleepers.size;
    },
    async advance(ms: number) {
      vi.advanceTimersByTime(ms);
      await new Promise((resolve) => setImmediate(resolve));
    },
    advanceTo(ms: number) {
      return clock.advance(ms - clock.elapsed);
    },
    settleWait(ms: number) {
      settleWaitMs = ms;
      return ms;
    },
    async answered<T>(answers: Promise<T>[]): Promise<T[]> {
      const wait = settleWaitMs;
      if (wait === undefined) {
        throw new Error("answered() holds each settle to settleWaitMs: start the facilitator with clock.settleWait(ms)");
      }
      const from = performance.now();
      let open = answers.length;
      const all = Promise.all(answers.map((a) => a.finally(() => (open -= 1))));
      let done = false;
      void all.then(
        () => (done = true),
        () => (done = true),
      );
      for (;;) {
        await until(() => done || (open > 0 && sleepers.size === open));
        if (done) break;
        const wakes = Math.min(...[...sleepers].map((s) => s.wakes));
        if (wakes - from > wait) {
          throw new Error(`a poll wakes ${wakes - from} ms after the settles are sent, past settleWaitMs (${wait} ms)`);
        }
        await clock.advance(wakes - performance.now());
        if ([...sleepers].some((s) => s.wakes <= performance.now())) {
          throw new Error("a poll sleeps on after the clock passed its wake: its sleep does not run on this clock");
        }
      }
      const took = performance.now() - from;
      if (took > wait) throw new Error(`the settles answer ${took} ms after they are sent, past settleWaitMs (${wait} ms)`);
      return all;
    },
    restore() {
      vi.useRealTimers();
      timeout.mockRestore();
    },
  };
  return clock;
}

/**
 * Counts the claims made on `settlement`: every insert the store attempts, including one that finds the id already
 * claimed and inserts nothing. Reads the count through `pool`. The table must exist (the facilitator creates it).
 */
export async function claimAttempts(pool: pg.Pool): Promise<() => Promise<number>> {
  await pool.query(`CREATE TABLE claim_attempt (n bigserial PRIMARY KEY, id text NOT NULL);
    CREATE FUNCTION count_claim() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO claim_attempt (id) VALUES (NEW.id); RETURN NEW; END $$;
    CREATE TRIGGER count_claim BEFORE INSERT ON settlement FOR EACH ROW EXECUTE FUNCTION count_claim();`);
  return async () => Number((await pool.query<{ n: string }>("SELECT count(*) AS n FROM claim_attempt")).rows[0]!.n);
}

export function databaseUrl(): string {
  const url = process.env["INTEGRA_DATABASE_URL"];
  if (url === undefined || url === "") throw new Error("INTEGRA_DATABASE_URL is not set: the Postgres tests need it");
  return url;
}

export async function freshDatabase(): Promise<{ url: string; pool: pg.Pool; drop(): Promise<void> }> {
  const admin = new pg.Pool({ connectionString: databaseUrl(), max: 1 });
  admin.on("error", () => {});
  const name = `facilitator_${randomBytes(6).toString("hex")}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(databaseUrl());
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  pool.on("error", () => {});
  return {
    url: url.toString(),
    pool,
    async drop() {
      await pool.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/** The lowest local port the kernel gives an outgoing connection, or a listen on port 0; 32768 where it cannot be read. */
function ephemeralLow(): number {
  try {
    const low = Number(readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0]);
    return Number.isInteger(low) ? low : 32_768;
  } catch {
    return 32_768;
  }
}

/**
 * A port on 127.0.0.1, free when chosen. It lies below the kernel's range for outgoing connections, so no client
 * socket, and no socket in TIME_WAIT, holds it when the facilitator binds it, and above 10080, the highest of the
 * Fetch Standard's bad ports, to which `fetch` refuses to connect.
 */
export async function freePort(): Promise<number> {
  const low = 10_081;
  const high = Math.min(ephemeralLow(), 32_768);
  if (high - low < 1_000) throw new Error(`no port range below the kernel's outgoing range (it starts at ${high})`);
  for (;;) {
    const port = low + Math.floor(Math.random() * (high - low));
    const s = netServer();
    const bound = await new Promise<boolean>((resolve) => {
      s.once("error", () => resolve(false));
      s.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (!bound) continue;
    await new Promise<void>((resolve) => s.close(() => resolve()));
    return port;
  }
}

export interface Call {
  path: string;
  body: unknown;
}

export interface Stub {
  url: string;
  calls: Call[];
  close(): Promise<void>;
  /** Listens again on the node's port, once `leaves` has stopped it. */
  listen(): Promise<void>;
}

/**
 * A local node: each POST's JSON body goes to `answer`, whose value is sent back as JSON; `hang` never answers.
 *
 * With `leaves`, the node stops listening once `leaves` is true of the calls it has received, so a later request is
 * refused at connect and carries no byte to it, while each call it has received is answered. Each answer closes its
 * connection, so no later request is sent over an earlier connection, and the node listens on a `freePort()`, which
 * `listen()` takes again.
 */
export async function stub(
  answer: (path: string, body: unknown) => unknown | Promise<unknown>,
  leaves?: (calls: readonly Call[]) => boolean,
): Promise<Stub> {
  const calls: Call[] = [];
  const open = new Set<ServerResponse>();
  let left = false;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    const text = Buffer.concat(parts).toString("utf8");
    const body: unknown = text === "" ? undefined : JSON.parse(text);
    const path = req.url ?? "";
    calls.push({ path, body });
    if (leaves !== undefined && !left && leaves(calls)) {
      left = true;
      server.close();
    }
    const value = await answer(path, body);
    if (value === HANG) {
      open.add(res);
      return;
    }
    const out = JSON.stringify(value);
    const closing = leaves === undefined ? {} : { connection: "close" };
    res.writeHead(200, { "content-type": "application/json", ...closing });
    res.end(out);
  });
  const chosen = leaves === undefined ? 0 : await freePort();
  await new Promise<void>((resolve) => server.listen(chosen, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    async listen() {
      await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    },
    async close() {
      for (const r of open) r.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export const HANG = Symbol("hang");

export async function post(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

export function fixture(name: string): unknown {
  const bytes = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse((name.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"));
}

/** The lcp vectors' V2 payer, as the 21 bytes a FullNode prints for an address. */
export const V2_PAYER_HEX = "41f39fd6e51aad88f6f4ce6ab8827279cfffb92266";
/** The lcp vectors' V2 reference block: solidified block 86542765 and its id, read live from Tron mainnet. */
export const V2_REF_BLOCK = { number: 86542765, id: "00000000052889ad7d1ddbe0b0adbe87d02b3cdbba73a6d485ff0392ab0e5003" };
/** The FullNode's head in these stubs: a block 25 after V2's reference block. */
export const V2_HEAD = 86542790;

/**
 * A FullNode's answers to the reads `/verify` makes before it simulates, for V2's payer and reference block, in
 * java-tron's HTTP shapes: `/wallet/getaccount` gives the default owner permission java-tron gives an account
 * (`AccountCapsule.createDefaultOwnerPermission`: the address's own key, weight 1, threshold 1); `/wallet/getnowblock`
 * the head; `/wallet/getblock` V2's reference block by number, and `{}` for a block it does not hold;
 * `/wallet/gettransactionbyid` and `/wallet/gettransactionfrompending` `{}`, the answer for an id the node does not
 * hold in its blocks or its pending pool. Undefined for any other path.
 */
export function tronChainReads(path: string, body: unknown): unknown {
  if (path === "/wallet/getaccount") {
    return {
      address: V2_PAYER_HEX,
      owner_permission: { permission_name: "owner", threshold: 1, keys: [{ address: V2_PAYER_HEX, weight: 1 }] },
    };
  }
  if (path === "/wallet/getnowblock") return { block_header: { raw_data: { number: V2_HEAD } } };
  if (path === "/wallet/getblock") {
    const wanted = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["id_or_num"] : undefined;
    return wanted === String(V2_REF_BLOCK.number)
      ? { blockID: V2_REF_BLOCK.id, block_header: { raw_data: { number: V2_REF_BLOCK.number } } }
      : {};
  }
  if (path === "/wallet/gettransactionbyid" || path === "/wallet/gettransactionfrompending") return {};
  return undefined;
}
