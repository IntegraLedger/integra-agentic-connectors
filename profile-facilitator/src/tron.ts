/**
 * Rule 5 of `x402/exact/tron/lcp-trc20-memo` against one network's FullNode and Solidity node: `/verify` checks the
 * signed transaction against the requirements, the owner's permission, its reference block and the ids already held,
 * and simulates it; `/settle` repeats that, claims the transaction id, broadcasts, and reads the transaction's status
 * until it is final.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { isRefusal, pairingOf } from "@integraledger/lcp";
import {
  decodeTronTx,
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
  pending,
  type FacilitatorRequest,
  type InvalidReason,
  type OperatorLog,
  type SettleAnswer,
  type VerifyAnswer,
} from "./answers.js";
import { base58check } from "./base58check.js";
import { NodeError, postJson, sleep } from "./http.js";
import { answerReserve, inTime, type SettlementStore, type Stored } from "./store.js";
import { settleReason, unexpectedSettle, unexpectedVerify } from "./unexpected.js";

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

function hexOf(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

/** A permission's threshold or a key's weight: java-tron prints an int64 as a JSON number, read as a safe one ≥ 0. */
function int64(v: unknown): bigint | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : undefined;
}

/**
 * Why the FullNode did not accept a broadcast: java-tron's `code` and `message`, or a `malformed` NodeError for an
 * answer that has no `code`.
 */
function refusalOf(sent: unknown): Error {
  if (!isObject(sent) || typeof sent["code"] !== "string") {
    return new NodeError("malformed", true, "/wallet/broadcasthex: code");
  }
  return new Error(`${sent["code"]}: ${typeof sent["message"] === "string" ? sent["message"] : ""}`);
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
    // The payer's own signature bytes do not recover a key: refused `invalid_payload` to the client that sent them.
    return undefined;
  }
}

export function createTron(nodes: readonly TronNode[], s: SettlementStore, settleWaitMs: number, log: OperatorLog) {
  const byNetwork = new Map(nodes.map((n) => [n.network as string, n]));
  /** The fields that name a payment in an operator entry. */
  const about = (c: Checked) => ({ network: c.network, payer: c.payer, transaction: c.txid });
  /** `p`, rejecting as it does, after its rejection is given to the operator log as a failed call to `call`. */
  const reported = <T>(c: Checked, call: string, p: Promise<T>): Promise<T> =>
    p.catch((e: unknown) => {
      log({ event: "node-call-failed", ...about(c), call }, e);
      throw e;
    });
  /**
   * `unexpected_verify_error` for an answer to `call` this facilitator cannot read: a `node-call-failed` entry whose
   * cause is a `malformed` NodeError naming the part it cannot read.
   */
  const malformed = (c: Checked, call: string, part: string) =>
    unexpectedVerify(
      log,
      { event: "node-call-failed", ...about(c), call },
      new NodeError("malformed", true, `${call}: ${part}`),
    );
  /** The entry for a settle whose deadline, `settleWaitMs` after its request, passed before `before`. */
  const deadlinePassed = (c: Checked, before: string) => ({
    event: "settle-deadline-passed",
    ...about(c),
    before,
    settleWaitMs,
  });
  /** The stored row, or undefined when the store does not answer by `deadline`; the failure goes to the operator log. */
  const readStored = (c: Checked, deadline: number) =>
    inTime(s.read(c.network, c.txid), deadline).catch((e: unknown) => {
      log({ event: "store-call-failed", ...about(c), call: "read" }, e);
      return undefined;
    });

  /** Every check of rule 5 that reads neither the clock nor the node. */
  async function check(r: FacilitatorRequest): Promise<Checked | InvalidReason> {
    const req = r.paymentRequirements;
    if (!byNetwork.has(req.network)) return "invalid_network";
    if (pairingOf(req as never) !== "x402/exact/tron/lcp-trc20-memo") return "invalid_payment_requirements";
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

  /**
   * A FullNode call's JSON answer, as `answer`, bounded by `deadline` (a `performance.now()` time) and by the node call
   * bound; a call that fails gives `unexpected_verify_error`.
   */
  async function ask(
    c: Checked,
    path: string,
    body: unknown,
    deadline: number,
  ): Promise<{ answer: unknown } | InvalidReason> {
    const url = `${byNetwork.get(c.network)!.fullNode}${path}`;
    try {
      return { answer: await postJson(url, body, deadline - performance.now()) };
    } catch (e) {
      return unexpectedVerify(log, { event: "node-call-failed", ...about(c), call: path }, e);
    }
  }

  /**
   * The owner's permission accepts the one signature: the weight it gives the owner's own key is at least its
   * threshold. An account the node does not hold, or one with no owner permission set, has java-tron's default owner
   * permission: the address's own key, weight 1, threshold 1.
   */
  async function permitted(c: Checked, deadline: number): Promise<InvalidReason | null> {
    const call = "/wallet/getaccount";
    const read = await ask(c, call, { address: hexOf(c.raw.owner) }, deadline);
    if (typeof read === "string") return read;
    const account = read.answer;
    if (!isObject(account)) return malformed(c, call, "the account");
    const permission = account["owner_permission"];
    if (permission === undefined) return null;
    if (!isObject(permission) || !Array.isArray(permission["keys"])) return malformed(c, call, "owner_permission.keys");
    const threshold = int64(permission["threshold"]);
    if (threshold === undefined) return malformed(c, call, "owner_permission.threshold");
    const owner = hexOf(c.raw.owner);
    let weight = 0n;
    for (const key of permission["keys"] as unknown[]) {
      if (!isObject(key) || typeof key["address"] !== "string") {
        return malformed(c, call, "owner_permission.keys[].address");
      }
      const w = int64(key["weight"]);
      if (w === undefined) return malformed(c, call, "owner_permission.keys[].weight");
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
    if (typeof now === "string") return now;
    const header = isObject(now.answer) ? now.answer["block_header"] : undefined;
    const raw = isObject(header) ? header["raw_data"] : undefined;
    const head = isObject(raw) ? raw["number"] : undefined;
    if (typeof head !== "number" || !Number.isSafeInteger(head) || head < 0) {
      return malformed(c, "/wallet/getnowblock", "block_header.raw_data.number");
    }
    const low = (refBytes[0]! << 8) | refBytes[1]!;
    const number = head - ((head % 65_536) - low + 65_536) % 65_536;
    if (number < 0) return "invalid_transaction";
    const read = await ask(c, "/wallet/getblock", { id_or_num: String(number), detail: false }, deadline);
    if (typeof read === "string") return read;
    const block = read.answer;
    if (!isObject(block)) return malformed(c, "/wallet/getblock", "the block");
    if (Object.keys(block).length === 0) return "invalid_transaction";
    const id = block["blockID"];
    if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id) || BigInt(`0x${id.slice(0, 16)}`) !== BigInt(number)) {
      return malformed(c, "/wallet/getblock", "blockID");
    }
    return id.slice(16, 32) === hexOf(refHash) ? null : "invalid_transaction";
  }

  /**
   * The FullNode does not hold the transaction id at `path`: `/wallet/gettransactionbyid` for its blocks, or
   * `/wallet/gettransactionfrompending` for its pending pool. Each answers `{}` for an id it does not hold.
   */
  async function unheld(c: Checked, path: string, deadline: number): Promise<InvalidReason | null> {
    const read = await ask(c, path, { value: c.txid }, deadline);
    if (typeof read === "string") return read;
    if (!isObject(read.answer)) return malformed(c, path, "the transaction");
    return Object.keys(read.answer).length === 0 ? null : "invalid_transaction_state";
  }

  /** The two id reads, made together: the FullNode's blocks, then its pending pool. */
  function idReads(c: Checked, deadline: number): Promise<[InvalidReason | null, InvalidReason | null]> {
    return Promise.all([
      unheld(c, "/wallet/gettransactionbyid", deadline),
      unheld(c, "/wallet/gettransactionfrompending", deadline),
    ]);
  }

  /** The node's simulation of `transfer(payTo, amount)` from the owner on the asset. */
  async function simulated(c: Checked, deadline: number): Promise<InvalidReason | null> {
    const call = "/wallet/triggerconstantcontract";
    const read = await ask(
      c,
      call,
      {
        owner_address: hexOf(c.raw.owner),
        contract_address: hexOf(c.raw.contractAddress),
        function_selector: "transfer(address,uint256)",
        parameter: hexOf(c.raw.callData.subarray(4)),
      },
      deadline,
    );
    if (typeof read === "string") return read;
    const sim = read.answer;
    if (!isObject(sim) || !isObject(sim["result"])) return malformed(c, call, "result");
    if (sim["result"]["result"] !== true) return "invalid_transaction";
    const ret = isObject(sim["transaction"]) ? sim["transaction"]["ret"] : undefined;
    if (Array.isArray(ret) && ret.some((x) => isObject(x) && x["ret"] === "FAILED")) return "invalid_transaction";
    return null;
  }

  /**
   * The checks made before any node call, in this order: the expiration window, then `deadline`. The first refusal is
   * the answer. A deadline spent here sends no node call.
   */
  function beforeReads(c: Checked, deadline: number): InvalidReason | null {
    const now = BigInt(Date.now());
    const expiration = c.raw.expiration;
    if (expiration <= now || expiration > now + BigInt(c.maxTimeoutSeconds) * 1000n) return "invalid_payload";
    if (deadline - performance.now() <= 0) return unexpectedVerify(log, deadlinePassed(c, "node reads"));
    return null;
  }

  /**
   * The node reads, made together: the owner's permission, TaPoS, the ids the node holds in its blocks and in its
   * pending pool (`ids`), and the simulation. The first refusal in that order is the answer. Each call is bounded by
   * the node call bound and by `deadline`.
   */
  async function nodeReads(
    c: Checked,
    deadline: number,
    ids: Promise<[InvalidReason | null, InvalidReason | null]>,
  ): Promise<InvalidReason | null> {
    const [account, reference, [inBlocks, inPool], simulation] = await Promise.all([
      permitted(c, deadline),
      tapos(c, deadline),
      ids,
      simulated(c, deadline),
    ]);
    return [account, reference, inBlocks, inPool, simulation].find((r) => r !== null) ?? null;
  }

  /** Every check of `/verify`: the transaction, the store, which must not hold its id, and the node reads. */
  async function verify(r: FacilitatorRequest): Promise<VerifyAnswer> {
    const c = await check(r);
    if (typeof c === "string") return invalid(c);
    let stored: Stored;
    try {
      stored = await inTime(s.read(c.network, c.txid), Infinity);
    } catch (e) {
      return invalid(unexpectedVerify(log, { event: "store-call-failed", ...about(c), call: "read" }, e), c.payer);
    }
    if (stored.state !== "none") return invalid("invalid_transaction_state", c.payer);
    const now = beforeReads(c, Infinity) ?? (await nodeReads(c, Infinity, idReads(c, Infinity)));
    return now === null ? { isValid: true, payer: c.payer } : invalid(now, c.payer);
  }

  /**
   * The profile's reads at the Solidity node's `/walletsolidity` API and the FullNode's `/wallet` API, each bounded by
   * `deadline`. A receipt lookup that finds nothing names the time of the latest block at its level, read from the same
   * node before the lookup, or null when that read fails or its answer lacks the time. A read that fails is given to the
   * operator log.
   */
  function reader(c: Checked, deadline: number): TronReader {
    const node = byNetwork.get(c.network)!;
    const left = () => deadline - performance.now();
    /** `getnowblock` at `api`: the latest block's number and time in milliseconds. */
    async function latest(api: string): Promise<{ number: bigint; timestamp: bigint }> {
      const o = await postJson(`${api}/getnowblock`, {}, left());
      const header = isObject(o) ? o["block_header"] : undefined;
      const raw = isObject(header) ? header["raw_data"] : undefined;
      const number = isObject(raw) ? raw["number"] : undefined;
      const timestamp = isObject(raw) ? raw["timestamp"] : undefined;
      if (!Number.isSafeInteger(number) || !Number.isSafeInteger(timestamp)) {
        throw new NodeError("malformed", true, "getnowblock fields");
      }
      return { number: BigInt(number as number), timestamp: BigInt(timestamp as number) };
    }
    return {
      network: c.network as TronReader["network"],
      async info(txid, level) {
        const path = level === "solid" ? "/walletsolidity" : "/wallet";
        const api = `${level === "solid" ? node.solidityNode : node.fullNode}${path}`;
        const readTo = await reported(c, `${path}/getnowblock`, latest(api)).then(
          (block) => block.timestamp,
          () => null,
        );
        const o = await postJson(`${api}/gettransactioninfobyid`, { value: txid.replace(/^0x/, "") }, left());
        if (!isObject(o)) throw new NodeError("malformed", true, "gettransactioninfobyid");
        if (Object.keys(o).length === 0) return { notFound: true, timestamp: readTo };
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
      solidHead() {
        return latest(`${node.solidityNode}/walletsolidity`);
      },
    };
  }

  /**
   * One read of the transaction's status through the profile's `tronStatus`: settled, at the Solidity node or the
   * FullNode, only with receipt result `SUCCESS` and a `Transfer` log from the asset, whatever the call returned (a
   * TRC-20 token may return false from `transfer` and still transfer). A failed receipt, or one with no such log, is
   * final only when the Solidity node, which serves solidified blocks alone, shows it. A transaction that neither
   * lookup finds, with the latest solidified block, read first, two slots past its expiration, can never be included
   * once each lookup names a latest block at or past that block's time. Anything else gives undefined.
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
          const api = level === "solid" ? "/walletsolidity" : "/wallet";
          const info = await reported(c, `${api}/gettransactioninfobyid`, reads.info(txid, level));
          if (!("notFound" in info)) found = level;
          return info;
        },
        solidHead: () => reported(c, "/walletsolidity/getnowblock", reads.solidHead()),
      },
    );
    if (st.state === "settled") return { success: true, transaction: c.txid, network: c.network, payer: c.payer };
    if (st.state === "pending") return undefined;
    if (st.why === "expired") {
      log({ event: "settlement-expired", ...about(c) });
      return failed("invalid_transaction_state", c.txid, c.network);
    }
    if (found !== "solid") return undefined;
    log({ event: "settlement-failed", ...about(c), why: st.why, result: st.result });
    return failed("invalid_transaction_state", c.txid, c.network);
  }

  /** The answer to a `/settle` of a payment whose success has already been answered: a consumed payment fails. */
  function consumed(c: Checked): SettleAnswer {
    return failed("invalid_transaction_state", c.txid, c.network);
  }

  /**
   * Reads the transaction's status every second until `deadline`, and the stored answer too when `stored` is set,
   * answering with the first final answer either gives. A stored success is another settle's, so it gives the consumed
   * answer. Once `deadline` has passed, no status is read: the answer is the one the wait's end gives. Broadcasts
   * nothing.
   */
  async function watch(c: Checked, deadline: number, stored: boolean): Promise<SettleAnswer> {
    for (;;) {
      if (stored) {
        const row = await readStored(c, deadline);
        if (row?.state === "answered" && !isPending(row.answer)) return row.answer.success ? consumed(c) : row.answer;
      }
      if (deadline - performance.now() <= 0) return pending(c.txid, c.network);
      const final = await outcome(c, deadline);
      if (final !== undefined) return final;
      if (performance.now() + POLL_MS > deadline) return pending(c.txid, c.network);
      await sleep(POLL_MS);
    }
  }

  /**
   * Broadcasts, then reads the transaction's status until `deadline`. A `DUP_TRANSACTION_ERROR` says the node already
   * holds the transaction id, so the payment is consumed. Any other refusal, or a request that cannot have reached the
   * node, gives `unexpected_settle_error` with no transaction: nothing was broadcast.
   */
  async function submit(c: Checked, deadline: number): Promise<SettleAnswer> {
    const node = byNetwork.get(c.network)!;
    let sent: unknown;
    try {
      sent = await postJson(`${node.fullNode}/wallet/broadcasthex`, { transaction: c.hex }, deadline - performance.now());
    } catch (e) {
      const entry = { event: "node-call-failed", ...about(c), call: "/wallet/broadcasthex" };
      if (e instanceof NodeError && !e.sent) return unexpectedSettle(log, entry, e);
      log(entry, e);
      return pending(c.txid, c.network);
    }
    if (isObject(sent) && sent["code"] === "DUP_TRANSACTION_ERROR") return consumed(c);
    if (!isObject(sent) || sent["result"] !== true) {
      const entry = { event: "node-call-failed", ...about(c), call: "/wallet/broadcasthex" };
      return unexpectedSettle(log, entry, refusalOf(sent));
    }
    return watch(c, deadline, false);
  }

  /**
   * Stores the answer unless the row holds a final one. A success is given only by the settle whose write stored it,
   * so one payment is answered success once: a success another settle stored first gives the consumed answer, and a
   * success whose write fails gives `settlement_pending` with the id. An answer with no transaction, a refused
   * broadcast or one that cannot have reached the node, is given only once it is the stored answer: when the row holds
   * another final answer, the answer is what a repeat gets for it, and when the write fails, `settlement_pending` with
   * the id. A failed write of any other answer leaves the row for a later read of the chain.
   */
  async function keep(c: Checked, answer: SettleAnswer, deadline: number): Promise<SettleAnswer> {
    let wrote: boolean;
    try {
      wrote = await inTime(s.answer(c.network, c.txid, answer), deadline);
    } catch (e) {
      log({ event: "answer-not-stored", ...about(c) }, e);
      return answer.success || answer.transaction === "" ? pending(c.txid, c.network) : answer;
    }
    if (wrote) return answer;
    if (answer.success) return consumed(c);
    if (answer.transaction !== "") return answer;
    const row = await readStored(c, deadline);
    if (row?.state !== "answered" || isPending(row.answer)) return pending(c.txid, c.network);
    return row.answer.success ? consumed(c) : row.answer;
  }

  /**
   * Answers within `settleWaitMs`. A stored success means the payment is consumed, and gives
   * `invalid_transaction_state` with the id; any other stored final answer is given as it is. A claimed id, or a stored
   * pending answer, is read again from the chain. For an id the store does not hold, the expiration window and then
   * the deadline are checked before any node call: a deadline spent there sends none, and gives
   * `unexpected_settle_error`, or `invalid_payload` for an expiration outside the window. The node's id reads then
   * answer first: an id the node holds, in a block or its pending pool, is consumed too, whatever else the checks
   * refuse, the expiration window among them, and a node that does not answer them gives `unexpected_settle_error`.
   * A claimed id is never released: a broadcast the node refused as a duplicate is a consumed payment, and any other
   * refused broadcast, or a broadcast request that cannot have reached the node, gives `unexpected_settle_error` with
   * no transaction, which says nothing was broadcast. Each is stored final, and every repeat gets the stored answer.
   * When the store cannot be read, the facilitator cannot know whether the transaction was broadcast, so the answer is
   * pending with its id.
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
    } catch (e) {
      log({ event: "store-call-failed", ...about(c), call: "read" }, e);
      return pending(c.txid, c.network);
    }
    if (stored.state === "answered" && !isPending(stored.answer)) {
      return stored.answer.success ? consumed(c) : stored.answer;
    }
    const waitUntil = deadline - answerReserve(settleWaitMs);
    if (stored.state !== "none") return keep(c, await watch(c, waitUntil, true), deadline);
    // An expiration outside the window waits for the id reads while the deadline leaves time for them.
    const before = beforeReads(c, deadline);
    if (before !== null && (before !== "invalid_payload" || left() <= 0)) {
      return failed(settleReason(before), "", network);
    }
    const ids = idReads(c, deadline);
    const now = before ?? (await nodeReads(c, deadline, ids));
    const held = await ids;
    if (held.includes("invalid_transaction_state")) return consumed(c);
    if (now !== null) return failed(settleReason(held.find((r) => r !== null) ?? now), "", network);
    if (left() <= 0) return unexpectedSettle(log, deadlinePassed(c, "claim"));
    let won: boolean;
    try {
      won = await inTime(s.claim(c.network, c.txid, new Date(Number(c.raw.expiration))), deadline);
    } catch (e) {
      log({ event: "store-call-failed", ...about(c), call: "claim" }, e);
      return pending(c.txid, c.network);
    }
    if (!won) return keep(c, await watch(c, waitUntil, true), deadline);
    return keep(c, await submit(c, waitUntil), deadline);
  }

  return { verify, settle, networks: nodes.map((n) => n.network as string) };
}
