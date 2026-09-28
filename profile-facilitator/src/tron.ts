/**
 * Rule 5 of `x402/exact/tron/lcp-trc20-memo` against one network's FullNode: `/verify` checks the signed transaction
 * against the requirements and simulates it; `/settle` repeats that, claims the transaction id, broadcasts, and polls
 * for the receipt.
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
import { NODE_TIMEOUT_MS, NodeError, postJson, sleep } from "./http.js";
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

  /** The expiration window, then the node's simulation of the call, within `timeoutMs`. */
  async function checkNow(c: Checked, timeoutMs = NODE_TIMEOUT_MS): Promise<InvalidReason | null> {
    const now = BigInt(Date.now());
    const expiration = c.raw.expiration;
    if (expiration <= now || expiration > now + BigInt(c.maxTimeoutSeconds) * 1000n) return "invalid_payload";
    if (timeoutMs <= 0) return "unexpected_verify_error";
    let sim: unknown;
    try {
      sim = await postJson(
        `${byNetwork.get(c.network)!.fullNode}/wallet/triggerconstantcontract`,
        {
          owner_address: hexOf(c.raw.owner),
          contract_address: hexOf(c.raw.contractAddress),
          function_selector: "transfer(address,uint256)",
          parameter: hexOf(c.raw.callData.subarray(4)),
        },
        timeoutMs,
      );
    } catch {
      return "unexpected_verify_error";
    }
    if (!isObject(sim) || !isObject(sim["result"])) return "unexpected_verify_error";
    if (sim["result"]["result"] !== true) return "invalid_transaction";
    const ret = isObject(sim["transaction"]) ? sim["transaction"]["ret"] : undefined;
    if (Array.isArray(ret) && ret.some((x) => isObject(x) && x["ret"] === "FAILED")) return "invalid_transaction";
    return null;
  }

  async function verify(r: FacilitatorRequest): Promise<VerifyAnswer> {
    const c = await check(r);
    if (typeof c === "string") return invalid(c);
    const now = await checkNow(c);
    return now === null ? { isValid: true, payer: c.payer } : invalid(now, c.payer);
  }

  /** A receipt's block and result from `gettransactioninfobyid` at `url`; undefined when there is none or it is unreadable. */
  async function infoAt(url: string, c: Checked, deadline: number): Promise<{ result: string } | undefined> {
    let info: unknown;
    try {
      info = await postJson(`${url}/gettransactioninfobyid`, { value: c.txid }, deadline - performance.now());
    } catch {
      return undefined;
    }
    if (!isObject(info) || typeof info["blockNumber"] !== "number") return undefined;
    const result = isObject(info["receipt"]) ? info["receipt"]["result"] : undefined;
    return typeof result === "string" ? { result } : undefined;
  }

  /**
   * One read of the transaction's receipt: success once the FullNode shows it in a block with `SUCCESS`; a failure only
   * once the Solidity node, which serves solidified blocks alone, shows it with another result; else undefined.
   */
  async function receipt(c: Checked, deadline: number): Promise<SettleAnswer | undefined> {
    const node = byNetwork.get(c.network)!;
    const head = await infoAt(`${node.fullNode}/wallet`, c, deadline);
    if (head === undefined) return undefined;
    const success: SettleAnswer = { success: true, transaction: c.txid, network: c.network, payer: c.payer };
    if (head.result === "SUCCESS") return success;
    const solid = await infoAt(`${node.solidityNode}/walletsolidity`, c, deadline);
    if (solid === undefined) return undefined;
    if (solid.result === "SUCCESS") return success;
    operatorLog({ event: "settlement-failed", network: c.network, transaction: c.txid, result: solid.result });
    return failed("invalid_transaction_state", c.txid, c.network);
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
   * True once the reads prove the transaction can never be included: the profile's status finds it at no node, with the
   * latest solidified block two slots past its expiration. Reads nothing while the local clock is before the expiration.
   */
  async function expired(c: Checked, deadline: number): Promise<boolean> {
    if (BigInt(Date.now()) < c.raw.expiration) return false;
    const ref = {
      network: c.network as TronReader["network"],
      txid: `0x${c.txid}` as const,
      asset: `0x${hexOf(c.raw.contractAddress)}` as const,
      expiration: c.raw.expiration.toString(),
    };
    const st = await tronStatus(ref, reader(c, deadline));
    return st.state === "failed" && st.why === "expired";
  }

  /**
   * Reads the receipt every second until `deadline`, and the stored answer too when `stored` is set, answering with the
   * first final answer either gives, or with `invalid_transaction_state` once the transaction can never be included.
   * Broadcasts nothing.
   */
  async function watch(c: Checked, deadline: number, stored: boolean): Promise<SettleAnswer> {
    for (;;) {
      if (stored) {
        const row = await inTime(s.read(c.network, c.txid), deadline).catch(() => undefined);
        if (row?.state === "answered" && !isPending(row.answer)) return row.answer;
      }
      const final = await receipt(c, deadline);
      if (final !== undefined) return final;
      if (await expired(c, deadline)) {
        operatorLog({ event: "settlement-expired", network: c.network, transaction: c.txid });
        return failed("invalid_transaction_state", c.txid, c.network);
      }
      if (performance.now() + POLL_MS > deadline) return pending(c.txid, c.network);
      await sleep(POLL_MS);
    }
  }

  /** Broadcasts, then reads the receipt until `deadline`. */
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

  /** Stores the answer, unless the row holds a final one; a failed write leaves the row for a later read of the chain. */
  async function keep(c: Checked, answer: SettleAnswer, deadline: number): Promise<SettleAnswer> {
    await inTime(s.answer(c.network, c.txid, answer), deadline).catch(() => {
      operatorLog({ event: "answer-not-stored", network: c.network, transaction: c.txid });
    });
    return answer;
  }

  /**
   * Answers within `settleWaitMs`. A stored final answer is given as it is. A claimed id, or a stored pending answer, is
   * read again from the chain. An answer with no transaction says nothing was broadcast, so it is given only for an id
   * the store does not hold: a broadcast the node refused releases the claim, and when nothing is released the answer
   * is pending with its id. A refusal as a duplicate is read as broadcast. When the store cannot be read, the
   * facilitator cannot know whether the transaction was broadcast, so the answer is pending with its id.
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
    if (stored.state === "answered" && !isPending(stored.answer)) return stored.answer;
    const waitUntil = deadline - answerReserve(settleWaitMs);
    if (stored.state !== "none") return keep(c, await watch(c, waitUntil, true), deadline);
    const now = await checkNow(c, left());
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
