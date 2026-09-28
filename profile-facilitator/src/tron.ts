/**
 * Rule 5 of `x402/exact/tron/lcp-trc20-memo` against one network's FullNode and Solidity node: `/verify` checks the
 * signed transaction against the requirements, the owner's permission, its reference block and the ids already held,
 * and simulates it; `/settle` repeats that, claims the transaction id, broadcasts, and reads the transaction's status
 * until it is final.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { isRefusal } from "@integraledger/lcp";
import {
  decodeTronTx,
  pairingOf,
  tronAddress,
  tronCarrier,
  tronStatus,
  type TronInfo,
  type TronRaw,
  type TronReader,
} from "@integraledger/lcp/tron";
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
import { base58check } from "./base58check.js";
import { NodeError, postJson, sleep } from "./http.js";
import { answerReserve, inTime, type SettlementStore, type Stored } from "./store.js";

export interface TronNode {
  network: `tron:${number}`;
  fullNode: string;
  solidityNode: string;
}

const POLL_MS = 1_000;

/** A transaction that passed every check that does not depend on time or chain state. */
interface Checked {
  network: string;
  hex: string;
  raw: TronRaw;
  txid: string;
  payer: string;
  maxTimeoutSeconds: number;
}

/** A verify reason as a settle answer's: a node that could not be read before submission is a settle error. */
function settleReason(r: InvalidReason): string {
  return r === "unexpected_verify_error" ? "unexpected_settle_error" : r;
}

function hexOf(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

/** A permission's threshold or a key's weight: java-tron prints an int64 as a JSON number, read as a safe one ≥ 0. */
function int64(v: unknown): bigint | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : undefined;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** `transfer(payTo, amount)` call data: the selector, payTo's 20 bytes as a word, amount as a 32-byte word. */
function transferCall(payTo: Uint8Array, amount: bigint): Uint8Array {
  const out = new Uint8Array(68);
  out.set([0xa9, 0x05, 0x9c, 0xbb], 0);
  out.set(payTo.subarray(1), 16);
  let v = amount;
  for (let i = 67; i >= 36; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** The Tron address (0x41 ‖ 20 bytes) whose key made the 65-byte signature over the transaction id. */
function signerOf(signature: Uint8Array, txid: Uint8Array): Uint8Array | undefined {
  const v = signature[64]!;
  const bit = v >= 27 ? v - 27 : v;
  if (bit !== 0 && bit !== 1) return undefined;
  try {
    const point = secp256k1.Signature.fromBytes(signature.subarray(0, 64), "compact")
      .addRecoveryBit(bit)
      .recoverPublicKey(txid);
    const key = point.toBytes(false);
    const out = new Uint8Array(21);
    out[0] = 0x41;
    out.set(keccak_256(key.subarray(1)).subarray(12), 1);
    return out;
  } catch {
    return undefined;
  }
}

export function createTron(nodes: readonly TronNode[], s: SettlementStore, settleWaitMs: number) {
  const byNetwork = new Map(nodes.map((n) => [n.network as string, n]));

  /** Every check of rule 5 that reads neither the clock nor the node. */
  async function check(r: FacilitatorRequest): Promise<Checked | InvalidReason> {
    const req = r.paymentRequirements;
    if (!byNetwork.has(req.network)) return "invalid_network";
    if (pairingOf(req as never) === undefined) return "invalid_payment_requirements";
    const hex = r.paymentPayload.payload["transaction"];
    if (typeof hex !== "string") return "invalid_payload";
    const tx = decodeTronTx(hex);
    if (isRefusal(tx)) return "invalid_payload";
    const carried = await tronCarrier(tx);
    if (isRefusal(carried)) return "invalid_payload";
    const asset = await tronAddress(req.asset);
    const payTo = await tronAddress(req.payTo);
    if (isRefusal(asset) || isRefusal(payTo)) return "invalid_payment_requirements";
    if (!sameBytes(tx.raw.contractAddress, asset)) return "invalid_payload";
    if (!sameBytes(tx.raw.callData, transferCall(payTo, BigInt(req.amount)))) return "invalid_payload";
    if (tx.signatures.length !== 1) return "unsupported_permission";
    const txid = carried.txid.slice(2);
    const signer = signerOf(tx.signatures[0]!, Buffer.from(txid, "hex"));
    if (signer === undefined || !sameBytes(signer, tx.raw.owner)) return "invalid_payload";
    return {
      network: req.network,
      hex,
      raw: tx.raw,
      txid,
      payer: base58check(tx.raw.owner),
      maxTimeoutSeconds: req.maxTimeoutSeconds,
    };
  }

  /** A FullNode call's JSON answer, bounded by `deadline` (a `performance.now()` time) and by the node call bound. */
  async function ask(c: Checked, path: string, body: unknown, deadline: number): Promise<unknown> {
    try {
      return await postJson(`${byNetwork.get(c.network)!.fullNode}${path}`, body, deadline - performance.now());
    } catch {
      return undefined;
    }
  }

  /**
   * The owner's permission accepts the one signature: the weight it gives the owner's own key is at least its
   * threshold. An account the node does not hold, or one with no owner permission set, has java-tron's default owner
   * permission: the address's own key, weight 1, threshold 1.
   */
  async function permitted(c: Checked, deadline: number): Promise<InvalidReason | null> {
    const account = await ask(c, "/wallet/getaccount", { address: hexOf(c.raw.owner) }, deadline);
    if (!isObject(account)) return "unexpected_verify_error";
    const permission = account["owner_permission"];
    if (permission === undefined) return null;
    if (!isObject(permission) || !Array.isArray(permission["keys"])) return "unexpected_verify_error";
    const threshold = int64(permission["threshold"]);
    if (threshold === undefined) return "unexpected_verify_error";
    const owner = hexOf(c.raw.owner);
    let weight = 0n;
    for (const key of permission["keys"] as unknown[]) {
      if (!isObject(key) || typeof key["address"] !== "string") return "unexpected_verify_error";
      const w = int64(key["weight"]);
      if (w === undefined) return "unexpected_verify_error";
      if (key["address"].toLowerCase() === owner) weight = w;
    }
    return weight >= threshold ? null : "unsupported_permission";
  }

  /**
   * TaPoS as the node checks it: `ref_block_bytes` are bytes 6–7 of a block number, and `ref_block_hash` must equal
   * bytes 8–15 of the id of the latest block at or below the FullNode's head whose number ends in those two bytes.
   */
  async function tapos(c: Checked, deadline: number): Promise<InvalidReason | null> {
    const refBytes = c.raw.refBlockBytes;
    const refHash = c.raw.refBlockHash;
    if (refBytes.length !== 2 || refHash.length !== 8) return "invalid_transaction";
    const now = await ask(c, "/wallet/getnowblock", {}, deadline);
    const header = isObject(now) ? now["block_header"] : undefined;
    const raw = isObject(header) ? header["raw_data"] : undefined;
    const head = isObject(raw) ? raw["number"] : undefined;
    if (typeof head !== "number" || !Number.isSafeInteger(head) || head < 0) return "unexpected_verify_error";
    const low = (refBytes[0]! << 8) | refBytes[1]!;
    const number = head - ((head % 65_536) - low + 65_536) % 65_536;
    if (number < 0) return "invalid_transaction";
    const block = await ask(c, "/wallet/getblock", { id_or_num: String(number), detail: false }, deadline);
    if (!isObject(block)) return "unexpected_verify_error";
    if (Object.keys(block).length === 0) return "invalid_transaction";
    const id = block["blockID"];
    if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id) || BigInt(`0x${id.slice(0, 16)}`) !== BigInt(number)) {
      return "unexpected_verify_error";
    }
    return id.slice(16, 32) === hexOf(refHash) ? null : "invalid_transaction";
  }

  /**
   * The FullNode does not hold the transaction id at `path`: `/wallet/gettransactionbyid` for its blocks, or
   * `/wallet/gettransactionfrompending` for its pending pool. Each answers `{}` for an id it does not hold.
   */
  async function unheld(c: Checked, path: string, deadline: number): Promise<InvalidReason | null> {
    const tx = await ask(c, path, { value: c.txid }, deadline);
    if (!isObject(tx)) return "unexpected_verify_error";
    return Object.keys(tx).length === 0 ? null : "invalid_transaction_state";
  }

  /** The node's simulation of `transfer(payTo, amount)` from the owner on the asset. */
  async function simulated(c: Checked, deadline: number): Promise<InvalidReason | null> {
    const sim = await ask(
      c,
      "/wallet/triggerconstantcontract",
      {
        owner_address: hexOf(c.raw.owner),
        contract_address: hexOf(c.raw.contractAddress),
        function_selector: "transfer(address,uint256)",
        parameter: hexOf(c.raw.callData.subarray(4)),
      },
      deadline,
    );
    if (!isObject(sim) || !isObject(sim["result"])) return "unexpected_verify_error";
    if (sim["result"]["result"] !== true) return "invalid_transaction";
    const ret = isObject(sim["transaction"]) ? sim["transaction"]["ret"] : undefined;
    if (Array.isArray(ret) && ret.some((x) => isObject(x) && x["ret"] === "FAILED")) return "invalid_transaction";
    return null;
  }

  /**
   * The expiration window, then the node reads, made together: the owner's permission, TaPoS, the ids the node holds
   * in its blocks and in its pending pool, and the simulation. The first refusal in that order is the answer. Each call is bounded by the node call bound and
   * by `deadline`.
   */
  async function checkNow(c: Checked, deadline = Infinity): Promise<InvalidReason | null> {
    const now = BigInt(Date.now());
    const expiration = c.raw.expiration;
    if (expiration <= now || expiration > now + BigInt(c.maxTimeoutSeconds) * 1000n) return "invalid_payload";
    if (deadline - performance.now() <= 0) return "unexpected_verify_error";
    const reads = await Promise.all([
      permitted(c, deadline),
      tapos(c, deadline),
      unheld(c, "/wallet/gettransactionbyid", deadline),
      unheld(c, "/wallet/gettransactionfrompending", deadline),
      simulated(c, deadline),
    ]);
    return reads.find((r) => r !== null) ?? null;
  }

  /** Every check of `/verify`: the transaction, the store, which must not hold its id, and the node reads. */
  async function verify(r: FacilitatorRequest): Promise<VerifyAnswer> {
    const c = await check(r);
    if (typeof c === "string") return invalid(c);
    let stored: Stored;
    try {
      stored = await inTime(s.read(c.network, c.txid), Infinity);
    } catch {
      return invalid("unexpected_verify_error", c.payer);
    }
    if (stored.state !== "none") return invalid("invalid_transaction_state", c.payer);
    const now = await checkNow(c);
    return now === null ? { isValid: true, payer: c.payer } : invalid(now, c.payer);
  }

  /** The profile's reads at the Solidity node and the FullNode, each bounded by `deadline`. */
  function reader(c: Checked, deadline: number): TronReader {
    const node = byNetwork.get(c.network)!;
    const left = () => deadline - performance.now();
    return {
      network: c.network as TronReader["network"],
      async info(txid, level) {
        const url = level === "solid" ? `${node.solidityNode}/walletsolidity` : `${node.fullNode}/wallet`;
        const o = await postJson(`${url}/gettransactioninfobyid`, { value: txid.replace(/^0x/, "") }, left());
        if (!isObject(o)) throw new NodeError("malformed", true, "gettransactioninfobyid");
        if (Object.keys(o).length === 0) return null;
        const blockNumber = o["blockNumber"];
        const result = isObject(o["receipt"]) ? o["receipt"]["result"] : undefined;
        if (!Number.isSafeInteger(blockNumber) || typeof result !== "string") {
          throw new NodeError("malformed", true, "gettransactioninfobyid fields");
        }
        const logs = (Array.isArray(o["log"]) ? o["log"] : []).filter(
          (l): l is TronInfo["logs"][number] =>
            isObject(l) && typeof l["address"] === "string" && Array.isArray(l["topics"]),
        );
        return { blockNumber: BigInt(blockNumber as number), result, logs };
      },
      transaction() {
        return Promise.reject(new NodeError("malformed", false, "not read by this facilitator"));
      },
      async solidHead() {
        const o = await postJson(`${node.solidityNode}/walletsolidity/getnowblock`, {}, left());
        const header = isObject(o) ? o["block_header"] : undefined;
        const raw = isObject(header) ? header["raw_data"] : undefined;
        const number = isObject(raw) ? raw["number"] : undefined;
        const timestamp = isObject(raw) ? raw["timestamp"] : undefined;
        if (!Number.isSafeInteger(number) || !Number.isSafeInteger(timestamp)) {
          throw new NodeError("malformed", true, "getnowblock fields");
        }
        return { number: BigInt(number as number), timestamp: BigInt(timestamp as number) };
      },
    };
  }

  /**
   * One read of the transaction's status through the profile's `tronStatus`: settled, at the Solidity node or the
   * FullNode, only with receipt result `SUCCESS` and a `Transfer` log from the asset, whatever the call returned (a
   * TRC-20 token may return false from `transfer` and still transfer). A failed receipt, or one with no such log, is
   * final only when the Solidity node, which serves solidified blocks alone, shows it. A transaction no node holds,
   * with the latest solidified block two slots past its expiration, can never be included. Anything else gives
   * undefined.
   */
  async function outcome(c: Checked, deadline: number): Promise<SettleAnswer | undefined> {
    const reads = reader(c, deadline);
    let found: "solid" | "head" | undefined;
    const st = await tronStatus(
      {
        network: c.network as TronReader["network"],
        txid: `0x${c.txid}`,
        asset: `0x${hexOf(c.raw.contractAddress)}`,
        expiration: c.raw.expiration.toString(),
      },
      {
        ...reads,
        async info(txid, level) {
          const info = await reads.info(txid, level);
          if (info !== null) found = level;
          return info;
        },
      },
    );
    if (st.state === "settled") return { success: true, transaction: c.txid, network: c.network, payer: c.payer };
    if (st.state === "pending") return undefined;
    if (st.why === "expired") {
      operatorLog({ event: "settlement-expired", network: c.network, transaction: c.txid });
      return failed("invalid_transaction_state", c.txid, c.network);
    }
    if (found !== "solid") return undefined;
    operatorLog({
      event: "settlement-failed",
      network: c.network,
      transaction: c.txid,
      why: st.why,
      result: st.result,
    });
    return failed("invalid_transaction_state", c.txid, c.network);
  }

  /** The answer to a `/settle` of a payment whose success has already been answered: a consumed payment fails. */
  function consumed(c: Checked): SettleAnswer {
    return failed("invalid_transaction_state", c.txid, c.network);
  }

  /**
   * Reads the transaction's status every second until `deadline`, and the stored answer too when `stored` is set,
   * answering with the first final answer either gives. A stored success is another settle's, so it gives the consumed
   * answer. Broadcasts nothing.
   */
  async function watch(c: Checked, deadline: number, stored: boolean): Promise<SettleAnswer> {
    for (;;) {
      if (stored) {
        const row = await inTime(s.read(c.network, c.txid), deadline).catch(() => undefined);
        if (row?.state === "answered" && !isPending(row.answer)) return row.answer.success ? consumed(c) : row.answer;
      }
      const final = await outcome(c, deadline);
      if (final !== undefined) return final;
      if (performance.now() + POLL_MS > deadline) return pending(c.txid, c.network);
      await sleep(POLL_MS);
    }
  }

  /** Broadcasts, then reads the transaction's status until `deadline`. */
  async function submit(c: Checked, deadline: number): Promise<SettleAnswer> {
    const node = byNetwork.get(c.network)!;
    let sent: unknown;
    try {
      sent = await postJson(`${node.fullNode}/wallet/broadcasthex`, { transaction: c.hex }, deadline - performance.now());
    } catch (e) {
      return e instanceof NodeError && !e.sent
        ? failed("unexpected_settle_error", "", c.network)
        : pending(c.txid, c.network);
    }
    const accepted = isObject(sent) && (sent["result"] === true || sent["code"] === "DUP_TRANSACTION_ERROR");
    if (!accepted) return failed("unexpected_settle_error", "", c.network);
    return watch(c, deadline, false);
  }

  /**
   * Stores the answer unless the row holds a final one. A success is given only by the settle whose write stored it,
   * so one payment is answered success once: a success another settle stored first gives the consumed answer, and a
   * success whose write fails gives `settlement_pending` with the id. A failed write of any other answer leaves the row
   * for a later read of the chain.
   */
  async function keep(c: Checked, answer: SettleAnswer, deadline: number): Promise<SettleAnswer> {
    let wrote: boolean;
    try {
      wrote = await inTime(s.answer(c.network, c.txid, answer), deadline);
    } catch {
      operatorLog({ event: "answer-not-stored", network: c.network, transaction: c.txid });
      return answer.success ? pending(c.txid, c.network) : answer;
    }
    return answer.success && !wrote ? consumed(c) : answer;
  }

  /**
   * Answers within `settleWaitMs`. A stored success means the payment is consumed, and gives
   * `invalid_transaction_state` with the id; any other stored final answer is given as it is. A claimed id, or a stored
   * pending answer, is read again from the chain. An id the node already holds is consumed too. An answer with no
   * transaction says nothing was broadcast, so it is given only for an id the store does not hold: a broadcast the node
   * refused releases the claim, and when nothing is released the answer is pending with its id. A refusal as a
   * duplicate is read as broadcast. When the store cannot be read, the facilitator cannot know whether the transaction
   * was broadcast, so the answer is pending with its id.
   */
  async function settle(r: FacilitatorRequest): Promise<SettleAnswer> {
    const deadline = performance.now() + settleWaitMs;
    const left = () => deadline - performance.now();
    const network = r.paymentRequirements.network;
    const c = await check(r);
    if (typeof c === "string") return failed(settleReason(c), "", network);
    let stored: Stored;
    try {
      stored = await inTime(s.read(c.network, c.txid), deadline);
    } catch {
      return pending(c.txid, c.network);
    }
    if (stored.state === "answered" && !isPending(stored.answer)) {
      return stored.answer.success ? consumed(c) : stored.answer;
    }
    const waitUntil = deadline - answerReserve(settleWaitMs);
    if (stored.state !== "none") return keep(c, await watch(c, waitUntil, true), deadline);
    const now = await checkNow(c, deadline);
    if (now === "invalid_transaction_state") return consumed(c);
    if (now !== null) return failed(settleReason(now), "", network);
    if (left() <= 0) return failed("unexpected_settle_error", "", network);
    let won: boolean;
    try {
      won = await inTime(s.claim(c.network, c.txid, new Date(Number(c.raw.expiration))), deadline);
    } catch {
      return pending(c.txid, c.network);
    }
    if (!won) return keep(c, await watch(c, waitUntil, true), deadline);
    const answer = await submit(c, waitUntil);
    if (answer.success || answer.transaction !== "") return keep(c, answer, deadline);
    const released = await inTime(s.release(c.network, c.txid), deadline).catch(() => false);
    return released ? answer : pending(c.txid, c.network);
  }

  return { verify, settle, networks: nodes.map((n) => n.network as string) };
}
