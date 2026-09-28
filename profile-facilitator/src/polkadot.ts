/**
 * Rule 5 of `x402/exact/polkadot/lcp-assets-remark` against one network's RPC node: `/verify` decodes the extrinsic
 * with the network's runtime metadata, checks its call against the requirements and asks the node to validate it;
 * `/settle` repeats that, claims the extrinsic's hash, submits, and scans new blocks for its inclusion and events.
 */
import { ApiPromise } from "@polkadot/api";
import type { ApiOptions } from "@polkadot/api/types";
import { blake2b } from "@noble/hashes/blake2.js";
import { isRefusal } from "@integraledger/lcp";
import {
  decodeProfileCall,
  exactPolkadotRemark,
  extrinsicHash,
  polkadotPairingOf,
  ss58Decode,
  type PolkadotNetwork,
} from "@integraledger/lcp/polkadot";
import {
  failed,
  invalid,
  isObject,
  isPending,
  operatorLog,
  pending,
  type FacilitatorRequest,
  type InvalidReason,
  type SettleAnswer,
  type VerifyAnswer,
} from "./answers.js";
import { NODE_MAX_BYTES, NODE_TIMEOUT_MS, NodeError, postJson, sleep, within } from "./http.js";
import { answerReserve, inTime, type SettlementStore, type Stored } from "./store.js";

export interface PolkadotNode {
  network: PolkadotNetwork;
  rpc: string;
}

const POLL_MS = 1_000;
/** The longest a metadata load may take: its calls are each bounded, and this bounds them together. */
const INIT_TIMEOUT_MS = 30_000;
/** Milliseconds per block, used to turn the era's last block into the row's `until`. */
const SLOW_BLOCK_MS = 12_000;
/** `TransactionSource::External`. */
const EXTERNAL = "02";
/** The JSON-RPC error `author_submitExtrinsic` gives for an extrinsic already in the pool. */
const ALREADY_IMPORTED = 1013;
/** The JSON-RPC error for an extrinsic the pool refuses as invalid; its message or data names the reason. */
const INVALID_TRANSACTION = 1010;
/** The JSON-RPC error for an extrinsic the pool has recently seen and will not take again for a while. */
const TEMPORARILY_BANNED = 1012;

type Provider = NonNullable<ApiOptions["provider"]>;

/** A JSON-RPC error answer: the node read the call and refused it. */
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data: string,
  ) {
    super(message);
  }
}

/**
 * True when a refused submission says the node has already seen the extrinsic or its nonce (already in the pool,
 * temporarily banned, or an outdated nonce), so it may be included.
 */
function seenBefore(e: RpcError): boolean {
  if (e.code === ALREADY_IMPORTED || e.code === TEMPORARILY_BANNED) return true;
  return e.code === INVALID_TRANSACTION && /outdated|stale/i.test(`${e.message} ${e.data}`);
}

async function rpc(url: string, method: string, params: unknown[], timeoutMs?: number, maxBytes?: number): Promise<unknown> {
  const answer = await postJson(url, { jsonrpc: "2.0", id: 1, method, params }, timeoutMs, maxBytes);
  if (!isObject(answer)) throw new NodeError("malformed", true, `${method}: not a JSON-RPC answer`);
  const error = answer["error"];
  if (isObject(error)) {
    const data = error["data"] === undefined ? "" : String(error["data"]);
    throw new RpcError(typeof error["code"] === "number" ? error["code"] : 0, String(error["message"]), data);
  }
  return answer["result"];
}

/** A provider for `@polkadot/api` whose every call is one bounded JSON-RPC POST, with no subscriptions. */
function boundedProvider(url: string): Provider {
  const provider = {
    hasSubscriptions: false,
    isClonable: false,
    isConnected: true,
    clone(): Provider {
      return boundedProvider(url);
    },
    async connect(): Promise<void> {},
    async disconnect(): Promise<void> {},
    on(): () => void {
      return () => {};
    },
    send<T>(method: string, params: unknown[]): Promise<T> {
      return rpc(url, method, params) as Promise<T>;
    },
    subscribe(): Promise<number | string> {
      return Promise.reject(new Error("subscriptions are not used"));
    },
    unsubscribe(): Promise<boolean> {
      return Promise.resolve(false);
    },
  };
  return provider as unknown as Provider;
}

function hexOf(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

function isLowerHex(v: unknown): v is string {
  return typeof v === "string" && /^0x(?:[0-9a-f]{2})+$/.test(v);
}

function blockNumber(header: unknown): number | undefined {
  const n = isObject(header) ? header["number"] : undefined;
  if (typeof n === "number") return n;
  if (typeof n === "string" && /^0x[0-9a-f]+$/i.test(n)) return Number.parseInt(n, 16);
  return undefined;
}

/**
 * The runtime's bounds, from its metadata. `blockAnswerBytes` is the most bytes a `chain_getBlock` answer can take for
 * a block within `System.BlockLength`: an extrinsic of n encoded bytes (n >= 2: its length prefix and its version
 * byte) is at most 2n + 5 JSON characters (`"0x…",`), so the body's largest class limit L takes at most 9L/2; a
 * header digest item of n >= 1 bytes takes at most 7n, within `maxHeaderSize`; and `NODE_MAX_BYTES` more holds the
 * header's fixed fields and the JSON-RPC envelope. `blockHashCount` is `System.BlockHashCount`.
 */
interface RuntimeBounds {
  blockAnswerBytes: number;
  blockHashCount: number;
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** `System.BlockLength` and `System.BlockHashCount` from the metadata; undefined when either is missing or malformed. */
function runtimeBounds(api: ApiPromise): RuntimeBounds | undefined {
  const system = api.consts["system"];
  const length = system?.["blockLength"]?.toJSON();
  const count = Number(system?.["blockHashCount"]?.toString());
  if (!isObject(length) || !isObject(length["max"]) || !isCount(count) || count === 0) return undefined;
  const classes = [length["max"]["normal"], length["max"]["operational"], length["max"]["mandatory"]];
  if (!classes.every(isCount)) return undefined;
  const header = length["maxHeaderSize"];
  const headerBytes = isCount(header) ? header : 0;
  const body = Math.max(...classes);
  return { blockAnswerBytes: NODE_MAX_BYTES + Math.ceil((9 * body) / 2) + 7 * headerBytes, blockHashCount: count };
}

interface EventRecordLike {
  phase: { isApplyExtrinsic: boolean; asApplyExtrinsic: { toNumber(): number } };
  event: { section: string; method: string; data: readonly { toString(): string; toHex(): string }[] };
}

/** An extrinsic that passed every check that does not ask the node about chain state. */
interface Checked {
  network: PolkadotNetwork;
  api: ApiPromise;
  hex: string;
  id: string;
  payer: string;
  assetId: number;
  remarkHash: string;
  era: { birth(current: number): number; death(current: number): number };
  /** The storage key of `System.Events`. */
  eventsKey: string;
  bounds: RuntimeBounds;
}

/** What rule 5 checks from the request alone: the lcp profile, the requirements, and the extrinsic's hash. */
interface Local {
  node: PolkadotNode;
  extrinsic: string;
  call: string;
  id: string;
  assetId: number;
  remarkHash: string;
}

export function createPolkadot(nodes: readonly PolkadotNode[], s: SettlementStore, settleWaitMs: number) {
  const byNetwork = new Map(nodes.map((n) => [n.network as string, n]));
  const apis = new Map<string, Promise<ApiPromise>>();

  /** The network's metadata, loaded once and loaded again when the node's runtime version changes. */
  async function apiFor(node: PolkadotNode, timeoutMs = NODE_TIMEOUT_MS): Promise<ApiPromise> {
    const version = await rpc(node.rpc, "state_getRuntimeVersion", [], timeoutMs);
    const spec = isObject(version) ? version["specVersion"] : undefined;
    if (typeof spec !== "number") throw new NodeError("malformed", true, "state_getRuntimeVersion: no specVersion");
    let loading = apis.get(node.network);
    if (loading !== undefined) {
      const api = await loading.catch(() => undefined);
      if (api !== undefined && api.runtimeVersion.specVersion.toNumber() === spec) return api;
      apis.delete(node.network);
      void api?.disconnect();
    }
    const fresh = load(node);
    apis.set(node.network, fresh);
    fresh.catch(() => {
      if (apis.get(node.network) === fresh) apis.delete(node.network);
    });
    return fresh;
  }

  async function load(node: PolkadotNode): Promise<ApiPromise> {
    const api = new ApiPromise({ provider: boundedProvider(node.rpc), noInitWarn: true, initWasm: false });
    try {
      await within(api.isReadyOrError, INIT_TIMEOUT_MS);
    } catch (e) {
      void api.disconnect();
      throw e;
    }
    if (api.genesisHash.toHex().slice(2, 34) !== node.network.slice("polkadot:".length)) {
      void api.disconnect();
      throw new Error(`the node at ${node.network} serves another chain`);
    }
    return api;
  }

  /** The checks of rule 5 that read nothing from the node. */
  async function local(r: FacilitatorRequest): Promise<Local | InvalidReason> {
    const req = r.paymentRequirements;
    const node = byNetwork.get(req.network);
    if (node === undefined) return "invalid_network";
    if (polkadotPairingOf(req as never) === undefined) return "invalid_payment_requirements";
    const { extrinsic, call } = r.paymentPayload.payload;
    if (!isLowerHex(extrinsic) || !isLowerHex(call)) return "invalid_payload";
    const bound = await exactPolkadotRemark.bound({ x402Version: 2, accepted: req as never, payload: { extrinsic, call } } as never);
    if (typeof bound !== "string") return "invalid_payload";
    const profile = decodeProfileCall(Buffer.from(call.slice(2), "hex"));
    const dest = ss58Decode(req.payTo);
    if (isRefusal(profile) || isRefusal(dest)) return "invalid_payload";
    if (profile.assetId !== Number(req.asset) || profile.amount !== BigInt(req.amount)) return "invalid_payload";
    if (hexOf(profile.dest) !== hexOf(dest)) return "invalid_payload";
    return {
      node,
      extrinsic,
      call,
      id: extrinsicHash(Buffer.from(extrinsic.slice(2), "hex")),
      assetId: profile.assetId,
      remarkHash: `0x${hexOf(blake2b(profile.remark, { dkLen: 32 }))}`,
    };
  }

  /** The checks of rule 5 that decode the extrinsic with the network's metadata, within `timeoutMs`. */
  async function decode(l: Local, timeoutMs: number): Promise<Checked | InvalidReason> {
    let api: ApiPromise;
    try {
      api = await within(apiFor(l.node, timeoutMs), timeoutMs);
    } catch {
      return "unexpected_verify_error";
    }
    let xt;
    try {
      xt = api.createType("Extrinsic", l.extrinsic);
    } catch {
      return "invalid_payload";
    }
    if (!xt.isSigned || xt.type !== 4 || xt.toHex() !== l.extrinsic || xt.method.toHex() !== l.call) return "invalid_payload";
    const calls = xt.method.args[0] as unknown as readonly { section: string; method: string }[] | undefined;
    if (
      xt.method.section !== "utility" ||
      xt.method.method !== "batchAll" ||
      !Array.isArray(calls) ||
      calls.length !== 2 ||
      calls[0]!.section !== "assets" ||
      calls[0]!.method !== "transferKeepAlive" ||
      calls[1]!.section !== "system" ||
      calls[1]!.method !== "remarkWithEvent"
    ) {
      return "invalid_payload";
    }
    if (!xt.era.isMortalEra) return "invalid_payload";
    const eventsKey = api.query["system"]?.["events"]?.key();
    const bounds = runtimeBounds(api);
    if (eventsKey === undefined || bounds === undefined) return "unexpected_verify_error";
    return {
      network: l.node.network,
      api,
      hex: l.extrinsic,
      id: l.id,
      payer: xt.signer.toString(),
      assetId: l.assetId,
      remarkHash: l.remarkHash,
      era: xt.era.asMortalEra,
      eventsKey,
      bounds,
    };
  }

  /**
   * The last block that can include the extrinsic, for a block `at` from its era's birth to that last block: the era's
   * last block, and no later than `BlockHashCount` + 1 blocks after its birth. Each block's execution keeps the hashes of
   * the `BlockHashCount` + 1 blocks before it in `System.BlockHash`, and `CheckMortality` refuses an extrinsic whose
   * birth block's hash is not there.
   */
  function lastBlock(c: Checked, at: number): number {
    const birth = c.era.birth(at);
    return Math.min(c.era.death(at) - 1, birth + c.bounds.blockHashCount + 1);
  }

  /**
   * `TaggedTransactionQueue_validate_transaction` at the best block, within `timeoutMs`: the best block's height, and
   * when the last block that can include the extrinsic ends.
   */
  async function validate(c: Checked, timeoutMs = 3 * NODE_TIMEOUT_MS): Promise<{ best: number; until: Date } | InvalidReason> {
    const url = byNetwork.get(c.network)!.rpc;
    const deadline = performance.now() + timeoutMs;
    const left = () => deadline - performance.now();
    let best: unknown;
    let header: unknown;
    let validity: unknown;
    try {
      best = await rpc(url, "chain_getBlockHash", [], left());
      if (!isLowerHex(best) || best.length !== 66) return "unexpected_verify_error";
      header = await rpc(url, "chain_getHeader", [best], left());
      validity = await rpc(
        url,
        "state_call",
        ["TaggedTransactionQueue_validate_transaction", `0x${EXTERNAL}${c.hex.slice(2)}${best.slice(2)}`, best],
        left(),
      );
    } catch {
      return "unexpected_verify_error";
    }
    const height = blockNumber(header);
    if (height === undefined || typeof validity !== "string") return "unexpected_verify_error";
    if (!validity.startsWith("0x00")) return "invalid_transaction";
    const blocksLeft = Math.max(0, lastBlock(c, height) + 1 - height);
    return { best: height, until: new Date(Date.now() + blocksLeft * SLOW_BLOCK_MS) };
  }

  async function verify(r: FacilitatorRequest): Promise<VerifyAnswer> {
    const l = await local(r);
    if (typeof l === "string") return invalid(l);
    const c = await decode(l, INIT_TIMEOUT_MS);
    if (typeof c === "string") return invalid(c);
    const v = await validate(c);
    return typeof v === "string" ? invalid(v, c.payer) : { isValid: true, payer: c.payer };
  }

  /**
   * The answer for the extrinsic at `index` of block `hash`, from that block's events. A failure is logged for the
   * operator when `final`, that is when the block was read at finality.
   */
  async function included(
    c: Checked,
    url: string,
    hash: string,
    index: number,
    timeoutMs: number,
    final: boolean,
  ): Promise<SettleAnswer> {
    const timepoint = `${hash}-${index}`;
    const raw = await rpc(url, "state_getStorage", [c.eventsKey, hash], timeoutMs);
    const records = c.api.createType("Vec<EventRecord>", raw) as unknown as readonly EventRecordLike[];
    const mine = records.filter((r) => r.phase.isApplyExtrinsic && r.phase.asApplyExtrinsic.toNumber() === index);
    const has = (section: string, method: string, test: (d: EventRecordLike["event"]["data"]) => boolean) =>
      mine.some((r) => r.event.section === section && r.event.method === method && test(r.event.data));
    const ok =
      has("system", "ExtrinsicSuccess", () => true) &&
      has("system", "Remarked", (d) => d[1]?.toHex() === c.remarkHash) &&
      has("assets", "Transferred", (d) => d[0]?.toString() === String(c.assetId));
    if (ok) return { success: true, transaction: timepoint, network: c.network, payer: c.payer };
    const seen = mine.map((r) => `${r.event.section}.${r.event.method}`);
    if (final) operatorLog({ event: "settlement-failed", network: c.network, transaction: timepoint, events: seen });
    return failed("invalid_transaction_state", timepoint, c.network);
  }

  /**
   * Where a scan has got to: `proven` is the first block from `since` not yet read at finality; `next`, at the head;
   * `unread`, the finalized blocks below `proven` that could not be read; `resolved`, blocks of the stored `unread` that
   * this scan has read since.
   */
  interface Scan {
    proven: number;
    next: number;
    unread: number[];
    resolved: number[];
  }

  /** The finalized head's height, read before `deadline`; undefined when the node does not give it. */
  async function finalizedHeight(url: string, deadline: number): Promise<number | undefined> {
    try {
      const hash = await rpc(url, "chain_getFinalizedHead", [], deadline - performance.now());
      return blockNumber(await rpc(url, "chain_getHeader", [hash], deadline - performance.now()));
    } catch {
      return undefined;
    }
  }

  /** The head's height; undefined when the node does not give it. */
  async function headHeight(url: string, left: () => number): Promise<number | undefined> {
    try {
      return blockNumber(await rpc(url, "chain_getHeader", [], left()));
    } catch {
      return undefined;
    }
  }

  /** The extrinsic's index in the block at `n`, and the block's hash; the index is -1 when the block does not hold it. */
  async function findIn(c: Checked, url: string, n: number, left: () => number): Promise<{ hash: string; index: number }> {
    const hash = await rpc(url, "chain_getBlockHash", [n], left());
    const block = await rpc(url, "chain_getBlock", [hash], left(), c.bounds.blockAnswerBytes);
    const xts = isObject(block) && isObject(block["block"]) ? block["block"]["extrinsics"] : undefined;
    if (typeof hash !== "string" || !Array.isArray(xts)) throw new NodeError("malformed", true, `block ${n}`);
    return { hash, index: xts.findIndex((x) => isLowerHex(x) && extrinsicHash(Buffer.from(x.slice(2), "hex")) === c.id) };
  }

  /**
   * Block `n` read for the extrinsic: the answer when the block holds it, `absent` when it does not, `unreadable` (with
   * the node's reason) when the node gives neither the block nor, for the block that holds it, its events, and `stopped`
   * when the deadline ends the read.
   */
  async function readBlock(
    c: Checked,
    url: string,
    n: number,
    left: () => number,
    final: boolean,
  ): Promise<SettleAnswer | "absent" | "stopped" | { unreadable: string }> {
    try {
      const found = await findIn(c, url, n, left);
      if (found.index < 0) return "absent";
      return await included(c, url, found.hash, found.index, left(), final);
    } catch (e) {
      if (left() <= 0) return "stopped";
      return { unreadable: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * One pass until `deadline`, no further than the last block that can include the extrinsic. First the blocks from
   * `at.proven` up to the finalized head, read at finality: a block that cannot be read is recorded as unread and
   * skipped, and the pass goes on to the blocks after it. Then the blocks above them, up to the head, where only a
   * success is an answer: a failure there waits until its block is final, and a block that cannot be read is skipped,
   * since it is read again at finality. Then, with the time left, the blocks recorded as unread before this pass are
   * read again. Once every block to the last is read at finality, and none is unread, the extrinsic can never be
   * included, and the answer is `invalid_transaction_state` with its hash. Gives the final answer, or where the scan has
   * got to.
   */
  async function scanOnce(c: Checked, since: number, at: Scan, deadline: number): Promise<{ answer: SettleAnswer } | Scan> {
    const url = byNetwork.get(c.network)!.rpc;
    const left = () => deadline - performance.now();
    const last = lastBlock(c, since);
    let { proven, next } = at;
    const unread = new Set(at.unread);
    const resolved = new Set(at.resolved);
    const position = (): Scan => ({ proven, next, unread: [...unread].sort((a, b) => a - b), resolved: [...resolved] });
    const finalized = await finalizedHeight(url, deadline);
    while (finalized !== undefined && proven <= Math.min(finalized, last) && left() > 0) {
      const read = await readBlock(c, url, proven, left, true);
      if (read === "stopped") return position();
      if (typeof read === "object" && "unreadable" in read) {
        unread.add(proven);
        operatorLog({ event: "block-unreadable", network: c.network, transaction: c.id, block: proven, reason: read.unreadable });
      } else if (read !== "absent") {
        return { answer: read };
      }
      proven += 1;
    }
    next = Math.max(next, proven);
    const head = await headHeight(url, left);
    while (head !== undefined && next <= Math.min(head, last) && left() > 0) {
      const read = await readBlock(c, url, next, left, false);
      if (read === "stopped") return position();
      if (typeof read === "object" && !("unreadable" in read)) {
        if (read.success) return { answer: read };
        break;
      }
      next += 1;
    }
    for (const n of at.unread) {
      if (finalized === undefined || n > finalized || left() <= 0) break;
      const read = await readBlock(c, url, n, left, true);
      if (read === "stopped") return position();
      if (typeof read === "object" && "unreadable" in read) continue;
      unread.delete(n);
      resolved.add(n);
      if (read !== "absent") return { answer: read };
    }
    if (proven > last && unread.size === 0) {
      operatorLog({ event: "settlement-expired", network: c.network, transaction: c.id });
      return { answer: failed("invalid_transaction_state", c.id, c.network) };
    }
    return position();
  }

  /**
   * Scans for the extrinsic from `since`, with the stored `unread` blocks, every second until `deadline`, reading the
   * stored answer too when `stored` is set, and answers with the first final answer either gives. Where the scan got to
   * at finality is stored: `since` moves on, and the blocks it could not read are recorded. Submits nothing.
   */
  async function scan(c: Checked, since: number, unread: number[], deadline: number, stored: boolean): Promise<SettleAnswer> {
    let at: Scan = { proven: since, next: since, unread, resolved: [] };
    for (;;) {
      if (stored) {
        const row = await inTime(s.read(c.network, c.id), deadline).catch(() => undefined);
        if (row?.state === "answered" && !isPending(row.answer)) return row.answer;
      }
      const step = await scanOnce(c, since, at, deadline);
      if ("answer" in step) return step.answer;
      at = step;
      if (performance.now() + POLL_MS > deadline) {
        if (at.proven > since || at.unread.length > 0 || at.resolved.length > 0) {
          const to = Math.min(at.proven, lastBlock(c, since));
          void s.advance(c.network, c.id, { from: since, to, unread: at.unread, resolved: at.resolved }).catch(() => {});
        }
        return pending(c.id, c.network);
      }
      await sleep(POLL_MS);
    }
  }

  /**
   * Submits, then scans for the extrinsic until `deadline`. A refusal that says the node has already seen the extrinsic
   * or its nonce is read as possibly included, and the scan runs; any other refusal means nothing was submitted.
   */
  async function submit(c: Checked, since: number, deadline: number): Promise<SettleAnswer> {
    const url = byNetwork.get(c.network)!.rpc;
    try {
      await rpc(url, "author_submitExtrinsic", [c.hex], deadline - performance.now());
    } catch (e) {
      if (e instanceof RpcError && !seenBefore(e)) return failed("unexpected_settle_error", "", c.network);
      if (e instanceof NodeError && !e.sent) return failed("unexpected_settle_error", "", c.network);
      if (!(e instanceof RpcError)) return pending(c.id, c.network);
    }
    return scan(c, since, [], deadline, false);
  }

  /**
   * What a repeated `/settle` gets for a stored answer. A success is given once, to the settle that stored it, so the
   * payment is consumed: a repeat gets `invalid_transaction_state` with the success's transaction (x402's `exact`
   * family: a consumed primitive produces a settlement failure, never a success). Any other answer is given as stored.
   */
  function repeatOf(stored: SettleAnswer): SettleAnswer {
    if (!stored.success) return stored;
    operatorLog({ event: "settlement-consumed", network: stored.network, transaction: stored.transaction });
    return failed("invalid_transaction_state", stored.transaction, stored.network);
  }

  /**
   * Stores the answer, unless the row holds a final one. A success is given only by the settle whose write stored it:
   * when the row already holds a final answer, the answer is what a repeat gets for it, and when the write fails, it is
   * pending with the hash, for a later read of the chain. Any other answer is given whether or not it is stored; a
   * failed write leaves the row for a later read of the chain.
   */
  async function keep(c: { network: string; id: string }, answer: SettleAnswer, deadline: number): Promise<SettleAnswer> {
    let wrote: boolean;
    try {
      wrote = await inTime(s.answer(c.network, c.id, answer), deadline);
    } catch {
      operatorLog({ event: "answer-not-stored", network: c.network, transaction: c.id });
      return answer.success ? pending(c.id, c.network) : answer;
    }
    if (!answer.success || wrote) return answer;
    const row = await inTime(s.read(c.network, c.id), deadline).catch(() => undefined);
    return row?.state === "answered" && !isPending(row.answer) ? repeatOf(row.answer) : pending(c.id, c.network);
  }

  /**
   * Reads a claimed id, or a stored pending answer, again from the chain until the answer's reserve before `deadline`,
   * from the stored `since` and `unread`, then stores what it read.
   */
  async function follow(l: Local, since: number | null, unread: number[], deadline: number): Promise<SettleAnswer> {
    const c = await decode(l, deadline - performance.now());
    if (typeof c === "string" || since === null) {
      const row = await inTime(s.read(l.node.network, l.id), deadline).catch(() => undefined);
      return row?.state === "answered" ? repeatOf(row.answer) : pending(l.id, l.node.network);
    }
    return keep(c, await scan(c, since, unread, deadline - answerReserve(settleWaitMs), true), deadline);
  }

  /**
   * Answers within `settleWaitMs`. The stored answer is read before the node is asked anything, and a final one is
   * given as a repeat gets it. A claimed id, or a stored pending answer, is read again from the chain. An answer with no
   * transaction says nothing was submitted, so it is given only for an id the store does not hold: a submission the node
   * refused releases the claim, and when nothing is released the answer is pending with its hash. When the store cannot
   * be read, the facilitator cannot know whether the extrinsic was submitted, so the answer is pending with its hash. The
   * scan starts after the finalized head read before validation (never before the era's birth): validation at the best
   * block shows the extrinsic absent from that block's ancestry, and the finalized head is in every later best chain.
   */
  async function settle(r: FacilitatorRequest): Promise<SettleAnswer> {
    const deadline = performance.now() + settleWaitMs;
    const left = () => deadline - performance.now();
    const network = r.paymentRequirements.network;
    const settleReason = (v: InvalidReason) => (v === "unexpected_verify_error" ? "unexpected_settle_error" : v);
    const l = await local(r);
    if (typeof l === "string") return failed(l, "", network);
    let stored: Stored;
    try {
      stored = await inTime(s.read(l.node.network, l.id), deadline);
    } catch {
      return pending(l.id, l.node.network);
    }
    if (stored.state === "answered" && !isPending(stored.answer)) return repeatOf(stored.answer);
    if (stored.state !== "none") return follow(l, stored.since, stored.unread, deadline);
    const c = await decode(l, left());
    if (typeof c === "string") return failed(settleReason(c), "", network);
    const finalized = await finalizedHeight(l.node.rpc, deadline);
    const v = await validate(c, left());
    if (typeof v === "string") return failed(settleReason(v), "", network);
    if (left() <= 0) return failed("unexpected_settle_error", "", network);
    const birth = c.era.birth(v.best);
    const since = Math.min(finalized === undefined ? birth : Math.max(birth, finalized + 1), lastBlock(c, v.best));
    let won: boolean;
    try {
      won = await inTime(s.claim(c.network, c.id, v.until, since), deadline);
    } catch {
      return pending(c.id, c.network);
    }
    if (!won) {
      const row = await inTime(s.read(c.network, c.id), deadline).catch(() => undefined);
      const claimed = row !== undefined && row.state !== "none" ? row : undefined;
      return follow(l, claimed?.since ?? null, claimed?.unread ?? [], deadline);
    }
    const answer = await submit(c, since, deadline - answerReserve(settleWaitMs));
    if (answer.success || answer.transaction !== "") return keep(c, answer, deadline);
    const released = await inTime(s.release(c.network, c.id), deadline).catch(() => false);
    return released ? answer : pending(c.id, c.network);
  }

  async function close(): Promise<void> {
    const all = [...apis.values()];
    apis.clear();
    await Promise.all(all.map((p) => p.then((api) => api.disconnect()).catch(() => {})));
  }

  return { verify, settle, close, networks: nodes.map((n) => n.network as string) };
}
