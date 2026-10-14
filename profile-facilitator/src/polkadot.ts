/**
 * Rule 5 of `x402/exact/polkadot/lcp-assets-remark` against one network's RPC node: `/verify` decodes the extrinsic
 * with the network's runtime metadata, checks its call against the requirements and asks the node to validate it;
 * `/settle` repeats that, claims the extrinsic's hash, submits, and scans new blocks for its inclusion and events.
 */
import { ApiPromise } from "@polkadot/api";
import type { ApiOptions } from "@polkadot/api/types";
import { blake2b } from "@noble/hashes/blake2.js";
import { isRefusal, pairingOf } from "@integraledger/lcp";
import {
  decodeProfileCall,
  exactPolkadotRemark,
  extrinsicHash,
  ss58Decode,
  type PolkadotNetwork,
} from "@integraledger/lcp/polkadot";
import {
  failed,
  invalid,
  isObject,
  isPending,
  pending,
  type FacilitatorRequest,
  type InvalidReason,
  type OperatorLog,
  type SettleAnswer,
  type VerifyAnswer,
} from "./answers.js";
import { NODE_MAX_BYTES, NODE_TIMEOUT_MS, NodeError, Slots, postJson, sleep, within } from "./http.js";
import { answerReserve, inTime, type SettlementStore, type Stored } from "./store.js";
import { settleReason, unexpectedSettle, unexpectedVerify } from "./unexpected.js";

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
/**
 * How many `chain_getBlock` reads, each bounded by the runtime's `System.BlockLength`, run at once in this process:
 * for Polkadot Asset Hub's runtime 2005000, at most 4 × 28,504,064 = 114,016,256 bytes of block answers.
 */
export const BLOCK_READS = 4;
/** The slots of `BLOCK_READS`, shared by every network and every scan in this process. */
export const blockReads = new Slots(BLOCK_READS);
/** The JSON-RPC error `author_submitExtrinsic` gives for an extrinsic already in the pool. */
const ALREADY_IMPORTED = 1013;
/** The JSON-RPC error for an extrinsic the pool refuses as invalid; its message or data names the reason. */
const INVALID_TRANSACTION = 1010;
/** The JSON-RPC error for an extrinsic the pool has recently seen and will not take again for a while. */
const TEMPORARILY_BANNED = 1012;

type Provider = NonNullable<ApiOptions["provider"]>;

/** No slot of `blockReads` came free before the pass's deadline, so block `n` was not read. */
class NoBlockReadSlot extends Error {
  constructor(n: number) {
    super(`block ${n}: no block read slot before the deadline`);
  }
}

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
 * temporarily banned, or an outdated nonce): the payment's replay primitive, the payer's nonce, is consumed.
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

export function createPolkadot(nodes: readonly PolkadotNode[], s: SettlementStore, settleWaitMs: number, log: OperatorLog) {
  const byNetwork = new Map(nodes.map((n) => [n.network as string, n]));
  const apis = new Map<string, Promise<ApiPromise>>();
  /** The fields that name a payment in an operator entry: the payer once the extrinsic is decoded. */
  const about = (c: { network: string; id: string; payer?: string }) => ({
    network: c.network,
    ...(c.payer === undefined ? {} : { payer: c.payer }),
    transaction: c.id,
  });
  /**
   * `unexpected_verify_error` for an answer to `call` this facilitator cannot read: a `node-call-failed` entry whose
   * cause is a `malformed` NodeError naming the part it cannot read.
   */
  const malformed = (c: { network: string; id: string; payer?: string }, call: string, part: string) =>
    unexpectedVerify(
      log,
      { event: "node-call-failed", ...about(c), call },
      new NodeError("malformed", true, `${call}: ${part}`),
    );
  /** The entry for a settle whose deadline, `settleWaitMs` after its request, passed before `before`. */
  const deadlinePassed = (c: { network: string; id: string; payer?: string }, before: string) => ({
    event: "settle-deadline-passed",
    ...about(c),
    before,
    settleWaitMs,
  });
  /** The stored row, or undefined when the store does not answer by `deadline`; the failure goes to the operator log. */
  const readStored = (c: { network: string; id: string; payer?: string }, deadline: number) =>
    inTime(s.read(c.network, c.id), deadline).catch((e: unknown) => {
      log({ event: "store-call-failed", ...about(c), call: "read" }, e);
      return undefined;
    });

  /**
   * The network's metadata, loaded once and loaded again when the node's runtime version changes, within `timeoutMs`:
   * the version read, the wait for a load another request started, and the wait for a new load. One failed load is one
   * failure, with one operator entry. A load that fails while the request that started it waits is that request's
   * failure, which it reports; one that fails once that request has stopped waiting goes to the operator log from the
   * handler below, with that request's payment `fields` and the load's cause.
   */
  async function apiFor(node: PolkadotNode, fields: Record<string, string>, timeoutMs: number): Promise<ApiPromise> {
    const deadline = performance.now() + timeoutMs;
    const left = () => deadline - performance.now();
    const version = await rpc(node.rpc, "state_getRuntimeVersion", [], timeoutMs);
    const spec = isObject(version) ? version["specVersion"] : undefined;
    if (typeof spec !== "number") throw new NodeError("malformed", true, "state_getRuntimeVersion: no specVersion");
    let loading = apis.get(node.network);
    if (loading !== undefined) {
      // A load that failed has gone to the operator log, from the request that started it or from the handler below;
      // a new one is made.
      const api = await within(loading.catch(() => undefined), left());
      if (api !== undefined && api.runtimeVersion.specVersion.toNumber() === spec) return api;
      apis.delete(node.network);
      void api?.disconnect();
    }
    const fresh = load(node);
    apis.set(node.network, fresh);
    let waiting = true;
    // Registered before the wait below, so a failure that ends the wait reaches this handler while `waiting` holds.
    fresh.catch((e: unknown) => {
      if (apis.get(node.network) === fresh) apis.delete(node.network);
      if (!waiting) log({ event: "node-call-failed", ...fields, call: "metadata" }, e);
    });
    try {
      return await within(fresh, left());
    } finally {
      waiting = false;
    }
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
    if (pairingOf(req as never) !== "x402/exact/polkadot/lcp-assets-remark") return "invalid_payment_requirements";
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
    const fields = about({ network: l.node.network, id: l.id });
    let api: ApiPromise;
    try {
      api = await apiFor(l.node, fields, timeoutMs);
    } catch (e) {
      return unexpectedVerify(log, { event: "node-call-failed", ...fields, call: "metadata" }, e);
    }
    let xt;
    try {
      xt = api.createType("Extrinsic", l.extrinsic);
    } catch {
      // The payer's own extrinsic bytes do not decode: refused `invalid_payload` to the client that sent them.
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
    const payer = xt.signer.toString();
    const decoded = { network: l.node.network, id: l.id, payer };
    const eventsKey = api.query["system"]?.["events"]?.key();
    if (eventsKey === undefined) return malformed(decoded, "metadata", "System.Events");
    const bounds = runtimeBounds(api);
    if (bounds === undefined) return malformed(decoded, "metadata", "System.BlockLength, System.BlockHashCount");
    return {
      network: l.node.network,
      api,
      hex: l.extrinsic,
      id: l.id,
      payer,
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
    let call = "chain_getBlockHash";
    try {
      best = await rpc(url, call, [], left());
      if (!isLowerHex(best) || best.length !== 66) return malformed(c, call, "the block hash");
      call = "chain_getHeader";
      header = await rpc(url, call, [best], left());
      call = "state_call";
      validity = await rpc(
        url,
        call,
        ["TaggedTransactionQueue_validate_transaction", `0x${EXTERNAL}${c.hex.slice(2)}${best.slice(2)}`, best],
        left(),
      );
    } catch (e) {
      return unexpectedVerify(log, { event: "node-call-failed", ...about(c), call }, e);
    }
    const height = blockNumber(header);
    if (height === undefined) return malformed(c, "chain_getHeader", "number");
    if (typeof validity !== "string") return malformed(c, "state_call", "the validity");
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
    if (final) log({ event: "settlement-failed", ...about(c), transaction: timepoint, events: seen });
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

  /**
   * The finalized head's height, read before `deadline`. Undefined when a read fails or the header names no number, a
   * node answer this facilitator cannot read; either is a `node-call-failed` entry with the call.
   */
  async function finalizedHeight(c: Checked, url: string, deadline: number): Promise<number | undefined> {
    let call = "chain_getFinalizedHead";
    try {
      const hash = await rpc(url, call, [], deadline - performance.now());
      call = "chain_getHeader";
      const height = blockNumber(await rpc(url, call, [hash], deadline - performance.now()));
      if (height === undefined) throw new NodeError("malformed", true, `${call}: number`);
      return height;
    } catch (e) {
      log({ event: "node-call-failed", ...about(c), call }, e);
      return undefined;
    }
  }

  /**
   * The head's height. Undefined when the read fails or the header names no number, a node answer this facilitator
   * cannot read; either is a `node-call-failed` entry with the call.
   */
  async function headHeight(c: Checked, url: string, left: () => number): Promise<number | undefined> {
    try {
      const height = blockNumber(await rpc(url, "chain_getHeader", [], left()));
      if (height === undefined) throw new NodeError("malformed", true, "chain_getHeader: number");
      return height;
    } catch (e) {
      log({ event: "node-call-failed", ...about(c), call: "chain_getHeader" }, e);
      return undefined;
    }
  }

  /**
   * The extrinsic's index in the block at `n`, and the block's hash; the index is -1 when the block does not hold it.
   * The block is read in one of `blockReads`' slots, waited for until `left()` ends; a read that cannot start by then
   * throws `NoBlockReadSlot`.
   */
  async function findIn(c: Checked, url: string, n: number, left: () => number): Promise<{ hash: string; index: number }> {
    const hash = await rpc(url, "chain_getBlockHash", [n], left());
    const release = await blockReads.take(left());
    if (release === undefined) throw new NoBlockReadSlot(n);
    let block: unknown;
    try {
      block = await rpc(url, "chain_getBlock", [hash], left(), c.bounds.blockAnswerBytes);
    } finally {
      release();
    }
    const xts = isObject(block) && isObject(block["block"]) ? block["block"]["extrinsics"] : undefined;
    if (typeof hash !== "string" || !Array.isArray(xts)) throw new NodeError("malformed", true, `block ${n}`);
    return { hash, index: xts.findIndex((x) => isLowerHex(x) && extrinsicHash(Buffer.from(x.slice(2), "hex")) === c.id) };
  }

  /**
   * Block `n` read for the extrinsic: the answer when the block holds it, `absent` when it does not, `unreadable` (with
   * the reason) when the node gives neither the block nor, for the block that holds it, its events, or when no block
   * read slot comes free before the deadline, and `stopped` when the deadline ends a read that started. Each read that
   * gives no block goes to the operator log, with what stopped it.
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
      if (!(e instanceof NoBlockReadSlot) && left() <= 0) {
        log({ event: "block-read-stopped", ...about(c), block: n }, e);
        return "stopped";
      }
      const reason = e instanceof Error ? e.message : String(e);
      log({ event: "block-unreadable", ...about(c), block: n, final, reason }, e);
      return { unreadable: reason };
    }
  }

  /**
   * One pass until `deadline`, no further than the last block that can include the extrinsic. First the blocks from
   * `at.proven` up to the finalized head, read at finality: a block that cannot be read is recorded as unread and
   * skipped, and the pass goes on to the blocks after it. Then the blocks above them, up to the head, where only a
   * success is an answer: a failure there waits until its block is final, and a block that cannot be read is skipped,
   * since it is read again at finality. Then, with the time left, the blocks recorded as unread before this pass are
   * read again. Once every block to the last is read at finality, and none is unread, the extrinsic can never be
   * included, and the answer is `invalid_transaction_state` with its hash. The head is not read once `deadline` has
   * passed. Gives the final answer, or where the scan has got to.
   */
  async function scanOnce(c: Checked, since: number, at: Scan, deadline: number): Promise<{ answer: SettleAnswer } | Scan> {
    const url = byNetwork.get(c.network)!.rpc;
    const left = () => deadline - performance.now();
    const last = lastBlock(c, since);
    let { proven, next } = at;
    const unread = new Set(at.unread);
    const resolved = new Set(at.resolved);
    const position = (): Scan => ({ proven, next, unread: [...unread].sort((a, b) => a - b), resolved: [...resolved] });
    const finalized = await finalizedHeight(c, url, deadline);
    while (finalized !== undefined && proven <= Math.min(finalized, last) && left() > 0) {
      const read = await readBlock(c, url, proven, left, true);
      if (read === "stopped") return position();
      if (typeof read === "object" && "unreadable" in read) {
        unread.add(proven);
      } else if (read !== "absent") {
        return { answer: read };
      }
      proven += 1;
    }
    next = Math.max(next, proven);
    const head = left() > 0 ? await headHeight(c, url, left) : undefined;
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
      log({ event: "settlement-expired", ...about(c) });
      return { answer: failed("invalid_transaction_state", c.id, c.network) };
    }
    return position();
  }

  /**
   * Scans for the extrinsic from `since`, with the stored `unread` blocks, every second until `deadline`, reading the
   * stored answer too when `stored` is set, and answers with the first final answer either gives. Once `deadline` has
   * passed, no pass is made: the answer is the one the wait's end gives. Where the scan got to at finality is stored:
   * `since` moves on, and the blocks it could not read are recorded. Submits nothing.
   */
  async function scan(c: Checked, since: number, unread: number[], deadline: number, stored: boolean): Promise<SettleAnswer> {
    let at: Scan = { proven: since, next: since, unread, resolved: [] };
    for (;;) {
      if (stored) {
        const row = await readStored(c, deadline);
        if (row?.state === "answered" && !isPending(row.answer)) return row.answer;
      }
      if (deadline - performance.now() > 0) {
        const step = await scanOnce(c, since, at, deadline);
        if ("answer" in step) return step.answer;
        at = step;
      }
      if (performance.now() + POLL_MS > deadline) {
        if (at.proven > since || at.unread.length > 0 || at.resolved.length > 0) {
          const to = Math.min(at.proven, lastBlock(c, since));
          void s
            .advance(c.network, c.id, { from: since, to, unread: at.unread, resolved: at.resolved })
            .catch((e: unknown) => log({ event: "store-call-failed", ...about(c), call: "advance" }, e));
        }
        return pending(c.id, c.network);
      }
      await sleep(POLL_MS);
    }
  }

  /**
   * Submits, then scans for the extrinsic until `deadline`. A refusal that says the node has already seen the extrinsic
   * or its nonce is a consumed payment: `invalid_transaction_state` with the extrinsic's hash, and no scan. Any other
   * refusal, or a request that cannot have reached the node, gives `unexpected_settle_error` with no transaction:
   * nothing was submitted.
   */
  async function submit(c: Checked, since: number, deadline: number): Promise<SettleAnswer> {
    const url = byNetwork.get(c.network)!.rpc;
    try {
      await rpc(url, "author_submitExtrinsic", [c.hex], deadline - performance.now());
    } catch (e) {
      const entry = { event: "node-call-failed", ...about(c), call: "author_submitExtrinsic" };
      const notSubmitted = e instanceof RpcError ? !seenBefore(e) : e instanceof NodeError && !e.sent;
      if (notSubmitted) return unexpectedSettle(log, entry, e);
      log(entry, e);
      return e instanceof RpcError ? failed("invalid_transaction_state", c.id, c.network) : pending(c.id, c.network);
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
    log({ event: "settlement-consumed", network: stored.network, payer: stored.payer, transaction: stored.transaction });
    return failed("invalid_transaction_state", stored.transaction, stored.network);
  }

  /**
   * Stores the answer, unless the row holds a final one. A success is given only by the settle whose write stored it:
   * when the row already holds a final answer, the answer is what a repeat gets for it, and when the write fails, it is
   * pending with the hash, for a later read of the chain. An answer with no transaction, a refused submission or one
   * that cannot have reached the node, is given the same way: only once it is the stored answer. Any other answer is
   * given whether or not it is stored; a failed write leaves the row for a later read of the chain.
   */
  async function keep(c: Checked, answer: SettleAnswer, deadline: number): Promise<SettleAnswer> {
    let wrote: boolean;
    try {
      wrote = await inTime(s.answer(c.network, c.id, answer), deadline);
    } catch (e) {
      log({ event: "answer-not-stored", ...about(c) }, e);
      return answer.success || answer.transaction === "" ? pending(c.id, c.network) : answer;
    }
    if (wrote || (!answer.success && answer.transaction !== "")) return answer;
    const row = await readStored(c, deadline);
    return row?.state === "answered" && !isPending(row.answer) ? repeatOf(row.answer) : pending(c.id, c.network);
  }

  /**
   * Reads a claimed id, or a stored pending answer, again from the chain until the answer's reserve before `deadline`,
   * from the stored `since` and `unread`, then stores what it read. Once that wait has ended, the node is asked nothing:
   * the answer is the stored one, as a repeat gets it, or pending with the hash.
   */
  async function follow(l: Local, since: number | null, unread: number[], deadline: number): Promise<SettleAnswer> {
    const waitUntil = deadline - answerReserve(settleWaitMs);
    const c = waitUntil - performance.now() > 0 ? await decode(l, deadline - performance.now()) : undefined;
    if (typeof c !== "object" || since === null) {
      const row = await readStored(typeof c === "object" ? c : { network: l.node.network, id: l.id }, deadline);
      return row?.state === "answered" ? repeatOf(row.answer) : pending(l.id, l.node.network);
    }
    return keep(c, await scan(c, since, unread, waitUntil, true), deadline);
  }

  /**
   * Answers within `settleWaitMs`. The stored answer is read before the node is asked anything, and a final one is
   * given as a repeat gets it. A claimed id, or a stored pending answer, is read again from the chain. A claimed id is
   * never released: a submission the node refused as one it has already seen is a consumed payment, and any other
   * refused submission, or a submission request that cannot have reached the node, gives `unexpected_settle_error`
   * with no transaction, which says nothing was submitted. Each is stored final, and every repeat gets the stored
   * answer. When the store cannot be read, the facilitator cannot know whether the extrinsic was submitted, so the
   * answer is pending with its hash. For a hash the store does not hold, the deadline is checked before each node read:
   * the decode, the finalized head read and the validation. A deadline spent there sends no node call, and gives
   * `unexpected_settle_error`; a refusal the client's own bytes give comes first, so the decode's refusals, which need
   * the metadata, are given when the deadline leaves time for it. The scan starts after the finalized head read before
   * validation (never before the era's birth): validation at the best block shows the extrinsic absent from that
   * block's ancestry, and the finalized head is in every later best chain.
   */
  async function settle(r: FacilitatorRequest): Promise<SettleAnswer> {
    const deadline = performance.now() + settleWaitMs;
    const left = () => deadline - performance.now();
    const network = r.paymentRequirements.network;
    const l = await local(r);
    if (typeof l === "string") return failed(l, "", network);
    let stored: Stored;
    try {
      stored = await inTime(s.read(l.node.network, l.id), deadline);
    } catch (e) {
      log({ event: "store-call-failed", ...about({ network: l.node.network, id: l.id }), call: "read" }, e);
      return pending(l.id, l.node.network);
    }
    if (stored.state === "answered" && !isPending(stored.answer)) return repeatOf(stored.answer);
    if (stored.state !== "none") return follow(l, stored.since, stored.unread, deadline);
    if (left() <= 0) return unexpectedSettle(log, deadlinePassed({ network: l.node.network, id: l.id }, "node reads"));
    const c = await decode(l, left());
    if (typeof c === "string") return failed(settleReason(c), "", network);
    if (left() <= 0) return unexpectedSettle(log, deadlinePassed(c, "finalized head"));
    const finalized = await finalizedHeight(c, l.node.rpc, deadline);
    if (left() <= 0) return unexpectedSettle(log, deadlinePassed(c, "validation"));
    const v = await validate(c, left());
    if (typeof v === "string") return failed(settleReason(v), "", network);
    if (left() <= 0) return unexpectedSettle(log, deadlinePassed(c, "claim"));
    const birth = c.era.birth(v.best);
    const since = Math.min(finalized === undefined ? birth : Math.max(birth, finalized + 1), lastBlock(c, v.best));
    let won: boolean;
    try {
      won = await inTime(s.claim(c.network, c.id, v.until, since), deadline);
    } catch (e) {
      log({ event: "store-call-failed", ...about(c), call: "claim" }, e);
      return pending(c.id, c.network);
    }
    if (!won) {
      const row = await readStored(c, deadline);
      const claimed = row !== undefined && row.state !== "none" ? row : undefined;
      return follow(l, claimed?.since ?? null, claimed?.unread ?? [], deadline);
    }
    return keep(c, await submit(c, since, deadline - answerReserve(settleWaitMs)), deadline);
  }

  async function close(): Promise<void> {
    const all = [...apis];
    apis.clear();
    // A load that failed has gone to the operator log from `decode` or `apiFor`; a failed disconnect goes there here.
    await Promise.all(
      all.map(([network, p]) =>
        p.then(
          (api) => api.disconnect().catch((e: unknown) => log({ event: "node-call-failed", network, call: "disconnect" }, e)),
          () => undefined,
        ),
      ),
    );
  }

  return { verify, settle, close, networks: nodes.map((n) => n.network as string) };
}
