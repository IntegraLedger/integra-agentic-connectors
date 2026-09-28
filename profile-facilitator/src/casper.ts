/**
 * Rule 5 of `x402/exact/casper/lcp-runtime-arg` against one network's JSON-RPC node: `/verify` checks the payer's
 * signed `Version1` transaction against the requirements and dry-runs it with `speculative_exec`; `/settle` repeats
 * that, claims the transaction hash, submits it with `account_put_transaction`, and polls `info_get_transaction` for
 * the execution result.
 *
 * On Casper the ATR hash rides in a named runtime argument of the transaction the payer signed, `lcp_atr_hash`, as a
 * `ByteArray(32)`: the 32 bytes of H themselves, a typed argument of the call rather than an opaque memo. The hash the
 * payer signs covers those arguments, and the executed call's arguments are on chain.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { fromRawBytes } from "@integraledger/lcp";
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
import { NODE_TIMEOUT_MS, NodeError, postJson, sleep } from "./http.js";
import { answerReserve, inTime, type SettlementStore, type Stored } from "./store.js";

/** CAIP-2: `casper:` and the chainspec name, which is the transaction's `chain_name`. */
export type CasperNetwork = `casper:${string}`;

export interface CasperNode {
  network: CasperNetwork;
  /** An HTTP JSON-RPC endpoint that serves `speculative_exec`, `account_put_transaction` and `info_get_transaction`. */
  rpc: string;
}

/** The profile's `extra.assetTransferMethod`. */
export const LCP_RUNTIME_ARG = "lcp-runtime-arg";
/** The pairing this module serves. */
export const X402_EXACT_CASPER_LCP_RUNTIME_ARG = "x402/exact/casper/lcp-runtime-arg";
/** The named runtime argument that carries H. */
export const ATR_HASH_ARG = "lcp_atr_hash";
/** The named runtime argument that carries the amount, in the asset's atomic units. */
const AMOUNT_ARG = "amount";
/** The CEP-18 entry point, and the argument naming its recipient. */
const CEP18_ENTRY_POINT = "transfer";
const CEP18_RECIPIENT_ARG = "recipient";
/** The native transfer's entry point, and the argument naming its target. */
const NATIVE_ENTRY_POINT = "Transfer";
const NATIVE_TARGET_ARG = "target";
/** The `asset` of a requirement paid in native CSPR; any other value is a CEP-18 contract package hash. */
export const NATIVE_ASSET = "native";

const POLL_MS = 1_000;
/** A Casper chainspec's longest transaction time to live, from `max_ttl`. */
const MAX_TTL_MS = 18 * 60 * 60 * 1000;
/** `casper:` and a chainspec name, as the network ids of these integrations write it. */
const NETWORK = /^casper:[a-z0-9-]{1,64}$/;
/** 64 lowercase-or-uppercase hex digits: a transaction hash, an account hash or a contract package hash. */
const HASH64 = /^[0-9a-fA-F]{64}$/;
/** A tagged address: `00` an account hash, `01` a contract package hash, then 32 bytes. */
const ADDRESS = /^0[01][0-9a-fA-F]{64}$/;
/** A key or a signature in hex, with a one-byte algorithm tag: `01` ed25519, `02` secp256k1. */
const TAGGED = /^0[12](?:[0-9a-fA-F]{2})+$/;
/** An unsigned decimal, as `amount` is written. */
const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
/** A humanized time to live, as the node writes it: `30m`, `1h 30m`, `45s`, `2day`. */
const TTL_PART = /^([0-9]+)(day|hour|h|min|m|sec|s|ms)$/;
const TTL_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  sec: 1_000,
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  day: 86_400_000,
};

/** A transaction that passed every check that does not depend on time or chain state. */
interface Checked {
  network: CasperNetwork;
  /** The signed transaction, as the node takes it in `account_put_transaction`. */
  transaction: Record<string, unknown>;
  /** The transaction hash, lowercase hex, which is the key of the deduplication row. */
  hash: string;
  /** The initiator's public key, tagged hex, which is the answer's `payer`. */
  payer: string;
  /** When the transaction stops being valid: its timestamp plus its time to live. */
  expiresAt: number;
}

/** What one named runtime argument carries: its declared type and its serialized bytes. */
interface Arg {
  clType: unknown;
  bytes: string;
}

/** A verify reason as a settle answer's: a node that could not be read before submission is a settle error. */
function settleReason(r: InvalidReason): string {
  return r === "unexpected_verify_error" ? "unexpected_settle_error" : r;
}

function bytesOf(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

/**
 * True when two byte strings of equal length are equal, read whole either way: every byte is compared before the
 * answer, so the comparison of H does not stop at the first difference.
 */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** True when two hex strings hold the same bytes, whatever their case. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return sameBytes(bytesOf(a), bytesOf(b));
}

/** A JSON-RPC 2.0 call, whose error answer is the node's refusal of the call, not a failure to read it. */
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

async function rpc(url: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
  const answer = await postJson(url, { jsonrpc: "2.0", id: 1, method, params }, timeoutMs);
  if (!isObject(answer)) throw new NodeError("malformed", true, `${method}: not a JSON-RPC answer`);
  const error = answer["error"];
  if (isObject(error)) {
    throw new RpcError(typeof error["code"] === "number" ? error["code"] : 0, String(error["message"]));
  }
  const result = answer["result"];
  if (!isObject(result)) throw new NodeError("malformed", true, `${method}: no result object`);
  return result;
}

/** The requirements this profile admits: its rule 1, as a local check so the profile stands on its own. */
export function casperPairingOf(req: FacilitatorRequest["paymentRequirements"]): string | undefined {
  if (req.scheme !== "exact") return undefined;
  if (typeof req.network !== "string" || !NETWORK.test(req.network)) return undefined;
  const nativeAsset = req.asset === NATIVE_ASSET;
  if (!nativeAsset && (typeof req.asset !== "string" || !HASH64.test(req.asset))) return undefined;
  if (typeof req.payTo !== "string" || !ADDRESS.test(req.payTo)) return undefined;
  if (typeof req.amount !== "string" || !DECIMAL.test(req.amount)) return undefined;
  const timeout = req.maxTimeoutSeconds;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout * 1000 > MAX_TTL_MS) return undefined;
  if (req.extra?.["assetTransferMethod"] !== LCP_RUNTIME_ARG) return undefined;
  return X402_EXACT_CASPER_LCP_RUNTIME_ARG;
}

/** The `Version1` body of a signed transaction, or undefined when the payload does not hold one. */
function version1(tx: unknown): Record<string, unknown> | undefined {
  if (!isObject(tx)) return undefined;
  const v1 = tx["Version1"];
  return isObject(v1) ? v1 : undefined;
}

/** The named runtime arguments of a transaction's payload, by name; undefined when they are not a `Named` list. */
function namedArgs(fields: Record<string, unknown>): Map<string, Arg> | undefined {
  const args = fields["args"];
  const named = isObject(args) ? args["Named"] : undefined;
  if (!Array.isArray(named)) return undefined;
  const out = new Map<string, Arg>();
  for (const entry of named) {
    if (!Array.isArray(entry) || entry.length !== 2) return undefined;
    const [name, value] = entry as [unknown, unknown];
    if (typeof name !== "string" || !isObject(value)) return undefined;
    const bytes = value["bytes"];
    if (typeof bytes !== "string" || !/^(?:[0-9a-fA-F]{2})*$/.test(bytes)) return undefined;
    // A repeated name is refused: which of the two the runtime would take is not this facilitator's to guess.
    if (out.has(name)) return undefined;
    out.set(name, { clType: value["cl_type"], bytes });
  }
  return out;
}

/** The contract package hash a `Stored` target names, or `NATIVE_ASSET` for the native target. */
function targetAsset(target: unknown): string | undefined {
  if (target === "Native") return NATIVE_ASSET;
  const stored = isObject(target) ? target["Stored"] : undefined;
  const id = isObject(stored) ? stored["id"] : undefined;
  const byPackage = isObject(id) ? (id["ByPackageHash"] ?? id["ByPackageName"]) : undefined;
  const addr = isObject(byPackage) ? byPackage["addr"] : undefined;
  return typeof addr === "string" && HASH64.test(addr) ? addr : undefined;
}

/** The entry point a transaction calls: `"Transfer"` for the native one, the name of a `Custom` one. */
function entryPointOf(fields: Record<string, unknown>): string | undefined {
  const ep = fields["entry_point"];
  if (typeof ep === "string") return ep;
  const custom = isObject(ep) ? ep["Custom"] : undefined;
  return typeof custom === "string" ? custom : undefined;
}

/** A `U512` argument's value: one length byte, then that many bytes little-endian. */
function u512Of(bytes: string): bigint | undefined {
  const b = bytesOf(bytes);
  if (b.length === 0 || b.length !== b[0]! + 1) return undefined;
  let v = 0n;
  for (let i = b.length - 1; i >= 1; i--) v = (v << 8n) | BigInt(b[i]!);
  return v;
}

/** The transaction's time to live in milliseconds, from the humanized string the node writes. */
function ttlMs(ttl: unknown): number | undefined {
  if (typeof ttl !== "string" || ttl.trim() === "") return undefined;
  let total = 0;
  for (const part of ttl.trim().split(/\s+/)) {
    const m = TTL_PART.exec(part);
    if (m === null) return undefined;
    total += Number(m[1]) * TTL_MS[m[2]!]!;
    if (total > MAX_TTL_MS) return undefined;
  }
  return total;
}

/** True when the one approval's signature is the initiator's over the transaction hash. */
function signedByInitiator(hash: string, signer: string, signature: string): boolean {
  const message = bytesOf(hash);
  const key = bytesOf(signer.slice(2));
  const sig = bytesOf(signature.slice(2));
  try {
    if (signer.startsWith("01")) return key.length === 32 && sig.length === 64 && ed25519.verify(sig, message, key);
    if (signer.startsWith("02")) {
      return key.length === 33 && sig.length === 64 && secp256k1.verify(sig, message, key, { prehash: false });
    }
    return false;
  } catch {
    return false;
  }
}

export function createCasper(nodes: readonly CasperNode[], s: SettlementStore, settleWaitMs: number) {
  const byNetwork = new Map(nodes.map((n) => [n.network as string, n]));

  /** Every check of rule 5 that reads neither the clock nor the node. */
  function check(r: FacilitatorRequest): Checked | InvalidReason {
    const req = r.paymentRequirements;
    const node = byNetwork.get(req.network);
    if (node === undefined) return "invalid_network";
    if (casperPairingOf(req) === undefined) return "invalid_payment_requirements";
    const tx = r.paymentPayload.payload["transaction"];
    const v1 = version1(tx);
    if (v1 === undefined) return "invalid_payload";
    const hash = v1["hash"];
    const payload = v1["payload"];
    const approvals = v1["approvals"];
    if (typeof hash !== "string" || !HASH64.test(hash) || !isObject(payload) || !Array.isArray(approvals)) {
      return "invalid_payload";
    }
    const fields = payload["fields"];
    const initiator = payload["initiator_addr"];
    if (!isObject(fields) || !isObject(initiator)) return "invalid_payload";
    // The chain name is inside what the payer signed, so it binds the payment to one network.
    if (payload["chain_name"] !== node.network.slice("casper:".length)) return "invalid_payload";
    const args = namedArgs(fields);
    if (args === undefined) return "invalid_payload";

    // The call: the native transfer, or `transfer` on the CEP-18 package the requirements name.
    const asset = targetAsset(fields["target"]);
    const native = req.asset === NATIVE_ASSET;
    if (asset === undefined || (native ? asset !== NATIVE_ASSET : !sameHex(asset, req.asset))) return "invalid_payload";
    if (entryPointOf(fields) !== (native ? NATIVE_ENTRY_POINT : CEP18_ENTRY_POINT)) return "invalid_payload";

    // The payee: a CEP-18 `recipient` is a `Key`, whose bytes are the tag and the 32 bytes `payTo` writes. A native
    // `target` may be written as that tagged address or as the account hash alone.
    const to = args.get(native ? NATIVE_TARGET_ARG : CEP18_RECIPIENT_ARG);
    if (to === undefined) return "invalid_payload";
    const payTo = req.payTo.toLowerCase();
    if (!sameHex(to.bytes, payTo) && !(native && sameHex(to.bytes, payTo.slice(2)))) return "invalid_payload";

    // The amount, in the asset's atomic units: motes for native CSPR, the token's own units for a CEP-18 asset. The
    // facilitator converts nothing, so no decimals are assumed anywhere.
    const amount = args.get(AMOUNT_ARG);
    if (amount === undefined || u512Of(amount.bytes) !== BigInt(req.amount)) return "invalid_payload";

    // H: the 32 bytes themselves, as a `ByteArray(32)` argument named `lcp_atr_hash`.
    const carried = args.get(ATR_HASH_ARG);
    if (carried === undefined || carried.bytes.length !== 64) return "invalid_payload";
    if (!isObject(carried.clType) || carried.clType["ByteArray"] !== 32) return "invalid_payload";
    if (fromRawBytes(bytesOf(carried.bytes)) === null) return "invalid_payload";

    // One approval by the initiator: a transaction approved by more than one key is not served.
    if (approvals.length !== 1) return "unsupported_permission";
    const approval = approvals[0];
    const payer = initiator["PublicKey"];
    const signer = isObject(approval) ? approval["signer"] : undefined;
    const signature = isObject(approval) ? approval["signature"] : undefined;
    if (typeof payer !== "string" || !TAGGED.test(payer)) return "invalid_payload";
    if (typeof signer !== "string" || typeof signature !== "string" || !TAGGED.test(signature)) return "invalid_payload";
    if (!sameHex(signer, payer)) return "invalid_payload";
    if (!signedByInitiator(hash, payer, signature)) return "invalid_payload";

    const ttl = ttlMs(payload["ttl"]);
    const timestamp = Date.parse(String(payload["timestamp"]));
    if (ttl === undefined || !Number.isSafeInteger(timestamp)) return "invalid_payload";
    return {
      network: node.network,
      transaction: tx as Record<string, unknown>,
      hash: hash.toLowerCase(),
      payer,
      expiresAt: timestamp + ttl,
    };
  }

  /** The validity window, then the node's dry run of the transaction, within `timeoutMs`. */
  async function checkNow(c: Checked, req: FacilitatorRequest, timeoutMs = NODE_TIMEOUT_MS): Promise<InvalidReason | null> {
    const now = Date.now();
    if (c.expiresAt <= now || c.expiresAt > now + req.paymentRequirements.maxTimeoutSeconds * 1000) {
      return "invalid_payload";
    }
    if (timeoutMs <= 0) return "unexpected_verify_error";
    let result: unknown;
    try {
      result = await rpc(byNetwork.get(c.network)!.rpc, "speculative_exec", { transaction: c.transaction }, timeoutMs);
    } catch (e) {
      // The node read the transaction and refused to execute it; any other failure is a read that did not happen.
      return e instanceof RpcError ? "invalid_transaction" : "unexpected_verify_error";
    }
    const error = errorMessage(isObject(result) ? result["execution_result"] : undefined);
    if (error === undefined) return "unexpected_verify_error";
    return error === null ? null : "invalid_transaction";
  }

  async function verify(r: FacilitatorRequest): Promise<VerifyAnswer> {
    const c = check(r);
    if (typeof c === "string") return invalid(c);
    const now = await checkNow(c, r);
    return now === null ? { isValid: true, payer: c.payer } : invalid(now, c.payer);
  }

  /**
   * An execution result's error: null when it executed without one, the message when it failed, and undefined when the
   * value is not an execution result this facilitator reads.
   */
  function errorMessage(result: unknown): string | null | undefined {
    if (!isObject(result)) return undefined;
    const body = isObject(result["Version2"]) ? result["Version2"] : isObject(result["Version1"]) ? result["Version1"] : result;
    const error = body["error_message"];
    if (error === null || error === undefined) return "error_message" in body || "limit" in body || "consumed" in body ? null : undefined;
    return typeof error === "string" ? error : undefined;
  }

  /**
   * One read of the transaction's execution: success once a node shows it executed in a block without an error, a
   * failure once it shows an error, and undefined while there is nothing to read or the read failed.
   */
  async function execution(c: Checked, deadline: number): Promise<SettleAnswer | undefined> {
    const url = byNetwork.get(c.network)!.rpc;
    let result: unknown;
    try {
      result = await rpc(
        url,
        "info_get_transaction",
        { transaction_hash: { Version1: c.hash }, finalized_approvals: true },
        deadline - performance.now(),
      );
    } catch {
      return undefined;
    }
    const info = isObject(result) ? result["execution_info"] : undefined;
    if (!isObject(info)) return undefined;
    const height = info["block_height"];
    const error = errorMessage(info["execution_result"]);
    if (error === undefined || !Number.isSafeInteger(height)) return undefined;
    if (error === null) return { success: true, transaction: c.hash, network: c.network, payer: c.payer };
    operatorLog({ event: "settlement-failed", network: c.network, transaction: c.hash, error });
    return failed("invalid_transaction_state", c.hash, c.network);
  }

  /**
   * Reads the execution every second until `deadline`, and the stored answer too when `stored` is set, answering with
   * the first final answer either gives, or with `invalid_transaction_state` once the transaction can never be
   * included: its time to live has passed and no node has shown it. Submits nothing.
   */
  async function watch(c: Checked, deadline: number, stored: boolean): Promise<SettleAnswer> {
    for (;;) {
      if (stored) {
        const row = await inTime(s.read(c.network, c.hash), deadline).catch(() => undefined);
        if (row?.state === "answered" && !isPending(row.answer)) return row.answer;
      }
      const final = await execution(c, deadline);
      if (final !== undefined) return final;
      if (Date.now() > c.expiresAt) {
        // A transaction the node does not hold once its time to live has passed is refused by every node from now on.
        operatorLog({ event: "settlement-expired", network: c.network, transaction: c.hash });
        return failed("invalid_transaction_state", c.hash, c.network);
      }
      if (performance.now() + POLL_MS > deadline) return pending(c.hash, c.network);
      await sleep(POLL_MS);
    }
  }

  /** Submits the payer's bytes, then reads the execution until `deadline`. */
  async function submit(c: Checked, deadline: number): Promise<SettleAnswer> {
    const url = byNetwork.get(c.network)!.rpc;
    try {
      await rpc(url, "account_put_transaction", { transaction: c.transaction }, deadline - performance.now());
    } catch (e) {
      // A node that refuses the transaction has taken nothing; a read that may not have reached it leaves the answer
      // pending, with the hash, so a later settle reads the chain.
      if (e instanceof RpcError) {
        return alreadyKnown(e) ? watch(c, deadline, false) : failed("unexpected_settle_error", "", c.network);
      }
      if (e instanceof NodeError && !e.sent) return failed("unexpected_settle_error", "", c.network);
      return pending(c.hash, c.network);
    }
    return watch(c, deadline, false);
  }

  /** True when a refused submission says the node already holds this transaction, so it may still be executed. */
  function alreadyKnown(e: RpcError): boolean {
    return /already (?:received|in|known)|duplicate/i.test(e.message);
  }

  /** Stores the answer, unless the row holds a final one; a failed write leaves the row for a later read of the chain. */
  async function keep(c: Checked, answer: SettleAnswer, deadline: number): Promise<SettleAnswer> {
    await inTime(s.answer(c.network, c.hash, answer), deadline).catch(() => {
      operatorLog({ event: "answer-not-stored", network: c.network, transaction: c.hash });
    });
    return answer;
  }

  /**
   * Answers within `settleWaitMs`. A stored final answer is given as it is. A claimed hash, or a stored pending answer,
   * is read again from the chain. An answer with no transaction says nothing was submitted, so it is given only for a
   * hash the store does not hold: a submission the node refused releases the claim, and when nothing is released the
   * answer is pending with the hash. When the store cannot be read, the facilitator cannot know whether the
   * transaction was submitted, so the answer is pending with the hash.
   */
  async function settle(r: FacilitatorRequest): Promise<SettleAnswer> {
    const deadline = performance.now() + settleWaitMs;
    const left = () => deadline - performance.now();
    const network = r.paymentRequirements.network;
    const c = check(r);
    if (typeof c === "string") return failed(settleReason(c), "", network);
    let stored: Stored;
    try {
      stored = await inTime(s.read(c.network, c.hash), deadline);
    } catch {
      return pending(c.hash, c.network);
    }
    if (stored.state === "answered" && !isPending(stored.answer)) return stored.answer;
    const waitUntil = deadline - answerReserve(settleWaitMs);
    if (stored.state !== "none") return keep(c, await watch(c, waitUntil, true), deadline);
    const now = await checkNow(c, r, left());
    if (now !== null) return failed(settleReason(now), "", network);
    if (left() <= 0) return failed("unexpected_settle_error", "", network);
    let won: boolean;
    try {
      won = await inTime(s.claim(c.network, c.hash, new Date(c.expiresAt)), deadline);
    } catch {
      return pending(c.hash, c.network);
    }
    if (!won) return keep(c, await watch(c, waitUntil, true), deadline);
    const answer = await submit(c, waitUntil);
    if (answer.success || answer.transaction !== "") return keep(c, answer, deadline);
    const released = await inTime(s.release(c.network, c.hash), deadline).catch(() => false);
    return released ? answer : pending(c.hash, c.network);
  }

  return { verify, settle, networks: nodes.map((n) => n.network as string) };
}
