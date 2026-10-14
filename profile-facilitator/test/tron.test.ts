// The Tron profile's rule 5 (x402/exact/tron/lcp-trc20-memo), as a facilitator's /verify and /settle. Expected values
// come from the profile's rules, x402's facilitator answers and its exact family's rules, java-tron's validation
// (TransactionCapsule.validateSignature, Manager.validateTapos and updateRecentBlock), TRC-20's Transfer event, and the
// lcp vectors' V2 (raw_data, id, payer, signature ends and reference block). The nodes are local stubs whose answers
// are Tron mainnet's live answers (fixtures/tron-mainnet-answers.json), with V2's id and the receipt result the test
// names, and java-tron's HTTP shapes for the account, block and transaction reads (support.ts). Every wait the
// facilitator makes runs on a clock the test moves (support.ts's `controlledClock`): a settle's wait ends when the test
// moves the clock to its end, never because the machine is slow.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRefusal } from "@integraledger/lcp";
import { decodeTronTx, encodeTronRaw } from "@integraledger/lcp/tron";
import { guarded, operatorLine } from "../src/answers.js";
import { NodeError } from "../src/http.js";
import { serveProfileFacilitator } from "../src/index.js";
import {
  asked,
  claimAttempts,
  controlledClock,
  fixture,
  gate,
  freePort,
  freshDatabase,
  HANG,
  post,
  RawBody,
  reaches,
  resumeLate,
  stub,
  tronChainReads,
  until,
  V2_PAYER_HEX,
  V2_REF_BLOCK,
  type Call,
  type Clock,
  type Stub,
} from "./support.js";

vi.mock("../src/http.js", async (original) => {
  const support = await import("./support.js");
  return support.lateResume(support.countingSleep(await original<typeof import("../src/http.js")>()));
});
vi.mock("../src/store.js", async (original) => {
  const support = await import("./support.js");
  return support.lateStore(await original<typeof import("../src/store.js")>());
});

// The lcp vectors' V2.
const RAW_V2 =
  "0a0289ad22087d1ddbe0b0adbe8740a0b6f4b18d34524d6c63703a7368613235363a3078626137383136626638663031636665613431343134306465356461653232323362303033363161333936313737613963623431306666363166323030313561645aae01081f12a9010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412740a1541f39fd6e51aad88f6f4ce6ab8827279cfffb92266121541a614f803b6fd780986a42c78ec9c7f77e6ded13c2244a9059cbb000000000000000000000000209693bc6afc0c5328ba36faf03c514ef312287c000000000000000000000000000000000000000000000000000000000000271070c0e1f0b18d34900180c2d72f";
const TXID_V2 = "bc5ef82919472351c4e4640798f5d8e87a43c93edc9d867b5f9d40b5077c73f1";
const PAYER = "TYBNgWfhGuNzdLtjKtxXTfskAhTbMcqbaG";
/** The published Anvil key #0, the lcp vectors' V2 payer. */
const ANVIL_0 = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const NOW_V2 = 1790300664000;
const EXPIRATION_V2 = 1790300724000;
const NETWORK = "tron:728126428";
const O = {
  scheme: "exact",
  network: NETWORK,
  amount: "10000",
  asset: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  payTo: "TCwX1UeSkVfu43HD5xNMmFqDR2Xgjdxihx",
  maxTimeoutSeconds: 60,
  extra: { assetTransferMethod: "lcp-trc20-memo" },
};

const live = fixture("tron-mainnet-answers.json") as Record<string, Record<string, unknown>>;

/** r ‖ s ‖ v over the transaction id, v in {0, 1}, as java-tron writes it. */
function sign(rawHex: string, key = ANVIL_0): string {
  const id = createHash("sha256").update(Buffer.from(rawHex, "hex")).digest();
  const sig = secp256k1.Signature.fromBytes(
    secp256k1.sign(id, Buffer.from(key, "hex"), { prehash: false, format: "recovered" }),
    "recovered",
  );
  return Buffer.from(sig.toBytes("compact")).toString("hex") + sig.recovery!.toString(16).padStart(2, "0");
}

/** A protobuf length prefix. */
function varint(n: number): string {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out).toString("hex");
}

function transaction(rawHex: string, signatures: readonly string[]): string {
  return `0a${varint(rawHex.length / 2)}${rawHex}` + signatures.map((s) => `1241${s}`).join("");
}

function body(tx: string, requirements: Record<string, unknown> = O) {
  return {
    x402Version: 2,
    paymentPayload: { x402Version: 2, accepted: O, payload: { transaction: tx } },
    paymentRequirements: requirements,
  };
}

/** A receipt modelled on the live answer for V1's id, carrying V2's id and the given result. */
function info(result: string) {
  const v1 = live["infoV1"]!;
  return { ...v1, id: TXID_V2, blockNumber: 86542790, receipt: { ...(v1["receipt"] as object), result } };
}

/** The same receipt with the given logs in place of the live answer's one Transfer log from USDT-TRC20. */
function infoWithLogs(log: unknown[]) {
  return { ...info("SUCCESS"), log };
}

/** Another key's Tron address, as a FullNode prints it: the lcp vectors' payTo bytes. */
const OTHER_HEX = "41209693bc6afc0c5328ba36faf03c514ef312287c";

const PENDING = { success: false, errorReason: "settlement_pending", transaction: TXID_V2, network: NETWORK };
const STATE_FAILED = { success: false, errorReason: "invalid_transaction_state", transaction: TXID_V2, network: NETWORK };
const SUCCESS = { success: true, transaction: TXID_V2, network: NETWORK, payer: PAYER };
/** A broadcast the node refused: nothing was broadcast. */
const REFUSED = { success: false, errorReason: "unexpected_settle_error", transaction: "", network: NETWORK };

interface Node {
  trigger?: unknown;
  broadcast?: unknown;
  /** Called before the broadcast answers. */
  onBroadcast?: () => Promise<void>;
  info?: () => unknown;
  /** The Solidity node's receipt; the FullNode's when not given. */
  solidInfo?: () => unknown;
  /** `/wallet/getaccount`'s answer. */
  account?: unknown;
  /** `/wallet/getblock`'s answer for the number asked. */
  block?: (number: string) => unknown;
  /** `/wallet/getnowblock`'s answer. */
  head?: unknown;
  /** `/walletsolidity/getnowblock`'s answer; `{}` when not given. */
  solidHead?: unknown;
  /** `/wallet/gettransactionbyid`'s answer. */
  held?: () => unknown;
  /** `/wallet/gettransactionfrompending`'s answer. */
  pendingPool?: () => unknown;
  /** When the node stops listening, given the calls it has received (support.ts's `stub`). */
  leaves?: (calls: readonly Call[]) => boolean;
  /** Awaited before the node answers a call: the test holds the answer until what it waits for has happened. */
  hold?: (path: string) => Promise<void> | void;
}

let clock: Clock & { restore(): void };
let db: Awaited<ReturnType<typeof freshDatabase>>;
let node: Stub;
let base: string;
let closeFacilitator: () => Promise<void>;
/** What the facilitator gave its operator log: each entry, with its cause. */
let entries: { entry: Record<string, unknown>; cause: unknown }[] = [];

async function start(n: Node = {}, settleWaitMs = 3_000): Promise<void> {
  node = await stub(async (path, sent) => {
    await n.hold?.(path);
    if (path === "/wallet/triggerconstantcontract") return n.trigger ?? live["triggerSuccess"];
    if (path === "/wallet/broadcasthex") {
      await n.onBroadcast?.();
      return n.broadcast ?? { result: true, txid: TXID_V2 };
    }
    if (path === "/wallet/gettransactioninfobyid") return n.info ? n.info() : info("SUCCESS");
    if (path === "/walletsolidity/gettransactioninfobyid") {
      if (n.solidInfo) return n.solidInfo();
      return n.info ? n.info() : info("SUCCESS");
    }
    if (path === "/wallet/getaccount" && n.account !== undefined) return n.account;
    if (path === "/wallet/getnowblock" && n.head !== undefined) return n.head;
    if (path === "/walletsolidity/getnowblock" && n.solidHead !== undefined) return n.solidHead;
    if (path === "/wallet/getblock" && n.block !== undefined) return n.block((sent as { id_or_num: string }).id_or_num);
    if (path === "/wallet/gettransactionbyid" && n.held !== undefined) return n.held();
    if (path === "/wallet/gettransactionfrompending" && n.pendingPool !== undefined) return n.pendingPool();
    return tronChainReads(path, sent) ?? {};
  }, n.leaves);
  const port = await freePort();
  const f = await serveProfileFacilitator({
    listen: `127.0.0.1:${port}`,
    tron: [{ network: NETWORK, fullNode: node.url, solidityNode: node.url }],
    store: { url: db.url },
    settleWaitMs: clock.settleWait(settleWaitMs),
    operatorLog: (entry, cause) => entries.push({ entry, cause }),
  });
  closeFacilitator = f.close;
  base = `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  clock = controlledClock(NOW_V2);
  entries = [];
  db = await freshDatabase();
});

afterEach(async () => {
  clock.restore();
  await closeFacilitator?.();
  await node?.close();
  await db.drop();
}, 60_000);

/** The calls the node has received at `path`. */
const calls = (path: string) => node.calls.filter((c) => c.path === path);
/** The reads /settle makes before the broadcast. */
const BEFORE_BROADCAST = [
  "/wallet/getaccount",
  "/wallet/getnowblock",
  "/wallet/getblock",
  "/wallet/gettransactionbyid",
  "/wallet/gettransactionfrompending",
  "/wallet/triggerconstantcontract",
];

/** A /settle's answer, waking its poll whenever it sleeps; a wait that ends pending ends within settleWaitMs. */
async function settle(): Promise<unknown> {
  const [res] = await clock.answered([post(`${base}/settle`, body(TX_V2))]);
  return res!.json;
}

const signatureV2 = sign(RAW_V2);
const TX_V2 = transaction(RAW_V2, [signatureV2]);

describe("V2's transaction, as the lcp vectors give it", () => {
  it("is signed by the published key: the signature's ends are the vectors', and the transaction is 360 bytes", () => {
    expect(signatureV2.startsWith("f2075adbf3a105a5")).toBe(true);
    expect(signatureV2.endsWith("e1c2497801")).toBe(true);
    expect(TX_V2.length / 2).toBe(360);
    expect(TX_V2.startsWith("0aa2020a")).toBe(true);
  });
});

describe("GET /supported", () => {
  it("lists one kind per configured network, no extensions and no signers", async () => {
    await start();
    const res = await fetch(`${base}/supported`);
    expect(await res.json()).toEqual({
      kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK, extra: { assetTransferMethod: "lcp-trc20-memo" } }],
      extensions: [],
      signers: {},
    });
  });
});

describe("/verify", () => {
  it("accepts V2's transaction under its requirements, with the owner as payer", async () => {
    await start();
    const res = await post(`${base}/verify`, body(TX_V2));
    expect(res.json).toEqual({ isValid: true, payer: PAYER });
  });

  it("refuses the same transaction with data = 提现, V1's memo", async () => {
    await start();
    const decoded = decodeTronTx(TX_V2);
    if (isRefusal(decoded)) throw new Error("V2 did not decode");
    const raw = Buffer.from(encodeTronRaw({ ...decoded.raw, data: Buffer.from("提现", "utf8") })).toString("hex");
    const res = await post(`${base}/verify`, body(transaction(raw, [sign(raw)])));
    expect(res.json).toEqual({ isValid: false, invalidReason: "invalid_payload" });
  });
});

describe("/verify, further", () => {
  it("refuses two signatures as unsupported_permission", async () => {
    await start();
    const res = await post(`${base}/verify`, body(transaction(RAW_V2, [signatureV2, signatureV2])));
    expect(res.json).toEqual({ isValid: false, invalidReason: "unsupported_permission" });
  });

  it("refuses a signature by another key", async () => {
    await start();
    const other = sign(RAW_V2, Buffer.from(secp256k1.utils.randomSecretKey()).toString("hex"));
    const res = await post(`${base}/verify`, body(transaction(RAW_V2, [other])));
    expect(res.json).toEqual({ isValid: false, invalidReason: "invalid_payload" });
  });

  it("refuses requirements naming another transfer method, or none, as invalid_payment_requirements", async () => {
    // The profile's scope: extra.assetTransferMethod "lcp-trc20-memo" (required).
    await start();
    for (const change of [{ extra: { assetTransferMethod: "lcp-trc20" } }, { extra: {} }]) {
      const res = await post(`${base}/verify`, body(TX_V2, { ...O, ...change }));
      expect(res.json).toEqual({ isValid: false, invalidReason: "invalid_payment_requirements" });
    }
  });

  it("refuses requirements whose payTo, asset or amount differ from the transfer", async () => {
    await start();
    for (const change of [{ payTo: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" }, { asset: "TCwX1UeSkVfu43HD5xNMmFqDR2Xgjdxihx" }, { amount: "10001" }]) {
      const res = await post(`${base}/verify`, body(TX_V2, { ...O, ...change }));
      expect(res.json).toEqual({ isValid: false, invalidReason: "invalid_payload" });
    }
  });

  it("refuses an expiration in the past, and one later than now + maxTimeoutSeconds", async () => {
    await start();
    vi.setSystemTime(EXPIRATION_V2);
    expect((await post(`${base}/verify`, body(TX_V2))).json).toEqual({ isValid: false, invalidReason: "invalid_payload", payer: PAYER });
    vi.setSystemTime(NOW_V2 - 1);
    expect((await post(`${base}/verify`, body(TX_V2))).json).toEqual({ isValid: false, invalidReason: "invalid_payload", payer: PAYER });
    vi.setSystemTime(NOW_V2);
    expect((await post(`${base}/verify`, body(TX_V2))).json).toEqual({ isValid: true, payer: PAYER });
  });

  it("refuses a transaction the node's simulation reverts, as invalid_transaction", async () => {
    await start({ trigger: live["triggerRevert"] });
    const res = await post(`${base}/verify`, body(TX_V2));
    expect(res.json).toEqual({ isValid: false, invalidReason: "invalid_transaction", payer: PAYER });
  });

  it("simulates transfer(payTo, amount) from the owner on the asset", async () => {
    await start();
    await post(`${base}/verify`, body(TX_V2));
    expect(node.calls.filter((c) => c.path === "/wallet/triggerconstantcontract")).toEqual([
      {
        path: "/wallet/triggerconstantcontract",
        body: {
          owner_address: "41f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
          contract_address: "41a614f803b6fd780986a42c78ec9c7f77e6ded13c",
          function_selector: "transfer(address,uint256)",
          parameter:
            "000000000000000000000000209693bc6afc0c5328ba36faf03c514ef312287c0000000000000000000000000000000000000000000000000000000000002710",
        },
      },
    ]);
  });
});

describe("/verify, the owner's permission", () => {
  // java-tron checks a transaction's signatures against the owner's permission: each signer's key must be in it, and
  // their weights must sum to its threshold (TransactionCapsule.validateSignature and checkWeight). An account the node
  // does not hold, or one with no owner permission set, has the default: the address's own key, weight 1, threshold 1.
  it("reads the owner's permission from /wallet/getaccount by the owner's address", async () => {
    await start();
    expect((await post(`${base}/verify`, body(TX_V2))).json).toEqual({ isValid: true, payer: PAYER });
    expect(node.calls.filter((c) => c.path === "/wallet/getaccount").map((c) => c.body)).toEqual([{ address: V2_PAYER_HEX }]);
  });

  it("refuses a signature whose weight is below the threshold of a multi-signature owner, as unsupported_permission", async () => {
    const account = {
      address: V2_PAYER_HEX,
      owner_permission: {
        permission_name: "owner",
        threshold: 2,
        keys: [
          { address: V2_PAYER_HEX, weight: 1 },
          { address: OTHER_HEX, weight: 1 },
        ],
      },
    };
    await start({ account });
    expect((await post(`${base}/verify`, body(TX_V2))).json).toEqual({
      isValid: false,
      invalidReason: "unsupported_permission",
      payer: PAYER,
    });
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual({
      success: false,
      errorReason: "unsupported_permission",
      transaction: "",
      network: NETWORK,
    });
    expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(0);
  });

  it("refuses the address's own key once the owner permission holds only another key, as unsupported_permission", async () => {
    const account = {
      address: V2_PAYER_HEX,
      owner_permission: { permission_name: "owner", threshold: 1, keys: [{ address: OTHER_HEX, weight: 1 }] },
    };
    await start({ account });
    expect((await post(`${base}/verify`, body(TX_V2))).json).toEqual({
      isValid: false,
      invalidReason: "unsupported_permission",
      payer: PAYER,
    });
  });

  it("accepts a key whose weight meets the threshold", async () => {
    const account = {
      address: V2_PAYER_HEX,
      owner_permission: {
        permission_name: "owner",
        threshold: 2,
        keys: [
          { address: V2_PAYER_HEX, weight: 2 },
          { address: OTHER_HEX, weight: 1 },
        ],
      },
    };
    await start({ account });
    expect((await post(`${base}/verify`, body(TX_V2))).json).toEqual({ isValid: true, payer: PAYER });
  });

  it("accepts an account the node does not hold, under the default owner permission", async () => {
    await start({ account: {} });
    expect((await post(`${base}/verify`, body(TX_V2))).json).toEqual({ isValid: true, payer: PAYER });
  });

  it("answers unexpected_verify_error for an owner permission it cannot read", async () => {
    await start({ account: { address: V2_PAYER_HEX, owner_permission: { threshold: "one", keys: [] } } });
    expect((await post(`${base}/verify`, body(TX_V2))).json).toEqual({
      isValid: false,
      invalidReason: "unexpected_verify_error",
      payer: PAYER,
    });
  });
});

describe("/verify, TaPoS", () => {
  // java-tron keeps, for each value of a block number's bytes 6-7, bytes 8-15 of the latest such block's id
  // (Manager.updateRecentBlock), and refuses a transaction whose ref_block_hash differs from the entry its
  // ref_block_bytes name, or whose entry is missing ("Tapos failed", Manager.validateTapos). V2 refers to solidified
  // block 86542765, whose number ends in 89ad and whose id's bytes 8-15 are 7d1ddbe0b0adbe87.
  it("reads the latest block at or below the head whose number ends in ref_block_bytes, and accepts V2", async () => {
    await start();
    expect((await post(`${base}/verify`, body(TX_V2))).json).toEqual({ isValid: true, payer: PAYER });
    expect(node.calls.filter((c) => c.path === "/wallet/getblock").map((c) => c.body)).toEqual([
      { id_or_num: String(V2_REF_BLOCK.number), detail: false },
    ]);
  });

  it("refuses a reference block whose id differs in bytes 8-15, as invalid_transaction", async () => {
    const id = `${V2_REF_BLOCK.id.slice(0, 16)}${"00".repeat(8)}${V2_REF_BLOCK.id.slice(32)}`;
    await start({ block: (n) => ({ blockID: id, block_header: { raw_data: { number: Number(n) } } }) });
    expect((await post(`${base}/verify`, body(TX_V2))).json).toEqual({
      isValid: false,
      invalidReason: "invalid_transaction",
      payer: PAYER,
    });
  });

  it("reads the newer block once the head has passed 65 536 more blocks, and refuses V2's reference as invalid_transaction", async () => {
    const later = V2_REF_BLOCK.number + 65_536;
    const laterId = `${later.toString(16).padStart(16, "0")}${"11".repeat(24)}`;
    await start({
      head: { block_header: { raw_data: { number: later + 3 } } },
      block: (n) => (n === String(later) ? { blockID: laterId, block_header: { raw_data: { number: later } } } : {}),
    });
    expect((await post(`${base}/verify`, body(TX_V2))).json).toEqual({
      isValid: false,
      invalidReason: "invalid_transaction",
      payer: PAYER,
    });
    expect(node.calls.filter((c) => c.path === "/wallet/getblock").map((c) => c.body)).toEqual([
      { id_or_num: String(later), detail: false },
    ]);
  });

  it("refuses a reference block the node does not hold, as invalid_transaction", async () => {
    await start({ block: () => ({}) });
    expect((await post(`${base}/verify`, body(TX_V2))).json).toEqual({
      isValid: false,
      invalidReason: "invalid_transaction",
      payer: PAYER,
    });
  });

  it("refuses a transaction whose ref_block_bytes are not two bytes, as invalid_transaction", async () => {
    const decoded = decodeTronTx(TX_V2);
    if ("refused" in decoded) throw new Error("V2 did not decode");
    const raw = Buffer.from(encodeTronRaw({ ...decoded.raw, refBlockBytes: Uint8Array.of(0x05, 0x28, 0x89, 0xad) })).toString("hex");
    await start();
    const res = await post(`${base}/verify`, body(transaction(raw, [sign(raw)])));
    expect(res.json).toEqual({ isValid: false, invalidReason: "invalid_transaction", payer: PAYER });
  });
});

describe("deduplication", () => {
  it("two concurrent /settle calls for V2 broadcast once, and only one of them answers success", async () => {
    // x402's exact family: settlements are deduplicated atomically across every process serving /settle, and a
    // consumed primitive produces a settlement failure, never a success. The node holds each simulation until both
    // settles have asked for it, so both have read no stored answer before either claims; and it holds each settle's
    // first read of the transaction's status until both have made it, so both have claimed, and both find the success
    // on chain before either stores it. Each status read asks the Solidity node's latest block twice: for the solidified
    // block, then before its receipt lookup.
    await start({
      hold: async (path) => {
        if (path === "/wallet/triggerconstantcontract") await until(() => calls(path).length === 2);
        if (path === "/walletsolidity/getnowblock") await until(() => calls(path).length >= 2);
      },
    });
    const claims = await claimAttempts(db.pool);
    const answers = await Promise.all([post(`${base}/settle`, body(TX_V2)), post(`${base}/settle`, body(TX_V2))]);
    expect(await claims()).toBe(2);
    expect(calls("/walletsolidity/getnowblock")).toHaveLength(4);
    expect(calls("/walletsolidity/gettransactioninfobyid")).toHaveLength(2);
    expect(calls("/wallet/broadcasthex")).toHaveLength(1);
    expect(answers.map((a) => a.json)).toEqual(expect.arrayContaining([SUCCESS, STATE_FAILED]));
  });

  it("a repeated /settle of a consumed payment answers invalid_transaction_state with the id, never success", async () => {
    await start();
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(SUCCESS);
    for (let i = 0; i < 5; i++) expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(STATE_FAILED);
    expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(1);
  });

  it("a /verify of a transaction id the store holds is refused as invalid_transaction_state", async () => {
    await start();
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(SUCCESS);
    expect((await post(`${base}/verify`, body(TX_V2))).json).toEqual({
      isValid: false,
      invalidReason: "invalid_transaction_state",
      payer: PAYER,
    });
  });

  it("refuses a transaction id in the node's pending pool as invalid_transaction_state, and broadcasts nothing", async () => {
    // java-tron's /wallet/gettransactionfrompending returns a transaction its pending pool holds, and {} otherwise.
    await start({ pendingPool: () => ({ txID: TXID_V2, raw_data_hex: RAW_V2, signature: [signatureV2] }) });
    expect((await post(`${base}/verify`, body(TX_V2))).json).toEqual({
      isValid: false,
      invalidReason: "invalid_transaction_state",
      payer: PAYER,
    });
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(STATE_FAILED);
    expect(node.calls.filter((c) => c.path === "/wallet/gettransactionfrompending").map((c) => c.body)).toEqual([
      { value: TXID_V2 },
      { value: TXID_V2 },
    ]);
    expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(0);
  });

  it("a facilitator with another store refuses a transaction id the node already holds, and broadcasts nothing", async () => {
    // Once the transaction is in a block, java-tron's /wallet/gettransactionbyid returns it; before, it returns {}.
    let inBlock = false;
    await start({
      held: () => (inBlock ? { txID: TXID_V2, raw_data_hex: RAW_V2, signature: [signatureV2] } : {}),
      onBroadcast: async () => {
        inBlock = true;
      },
    });
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(SUCCESS);
    const other = await freshDatabase();
    const port = await freePort();
    const second = await serveProfileFacilitator({
      listen: `127.0.0.1:${port}`,
      tron: [{ network: NETWORK, fullNode: node.url, solidityNode: node.url }],
      store: { url: other.url },
      settleWaitMs: 3_000,
    });
    try {
      expect((await post(`http://127.0.0.1:${port}/verify`, body(TX_V2))).json).toEqual({
        isValid: false,
        invalidReason: "invalid_transaction_state",
        payer: PAYER,
      });
      expect((await post(`http://127.0.0.1:${port}/settle`, body(TX_V2))).json).toEqual(STATE_FAILED);
      expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(1);
      expect(node.calls.filter((c) => c.path === "/wallet/gettransactionbyid").at(-1)?.body).toEqual({ value: TXID_V2 });
    } finally {
      await second.close();
      await other.drop();
    }
  });
});

describe("settlement outcomes", () => {
  it("a receipt reading REVERT gives success: false, never true, as invalid_transaction_state", async () => {
    await start({ info: () => info("REVERT") });
    const res = await post(`${base}/settle`, body(TX_V2));
    expect(res.json).toEqual({
      success: false,
      errorReason: "invalid_transaction_state",
      transaction: TXID_V2,
      network: NETWORK,
    });
  });

  it("a receipt reading SUCCESS whose transfer returned false settles, since it holds the asset's Transfer log", async () => {
    // The live receipt of USDT-TRC20 transfer 40662c9c…: contractResult is the zero word (transfer returned false)
    // with receipt result SUCCESS and the token's Transfer event.
    expect(live["infoV1"]!["contractResult"]).toEqual(["0".repeat(64)]);
    await start();
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(SUCCESS);
  });

  it("a receipt reading SUCCESS with no Transfer log is never success: invalid_transaction_state once solidified", async () => {
    // TRC-20: a transfer MUST fire the Transfer event; without it there is no transfer to report.
    await start({ info: () => infoWithLogs([]) });
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(STATE_FAILED);
  });

  it("a receipt reading SUCCESS whose Transfer log comes from another contract is never success", async () => {
    const v1Log = (live["infoV1"]!["log"] as Record<string, unknown>[])[0]!;
    await start({ info: () => infoWithLogs([{ ...v1Log, address: OTHER_HEX.slice(2) }]) });
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(STATE_FAILED);
  });

  it("a receipt reading SUCCESS with no Transfer log at the FullNode, not yet at the Solidity node, stays settlement_pending", async () => {
    await start({ info: () => infoWithLogs([]), solidInfo: () => live["infoNotFound"] }, 1_000);
    expect(await settle()).toEqual(PENDING);
  });

  it("a receipt reading REVERT at the FullNode, not yet at the Solidity node, stays settlement_pending", async () => {
    // A failure is final only once read from a solidified block: the Solidity API serves only blocks that have crossed
    // the irreversibility threshold.
    await start({ info: () => info("REVERT"), solidInfo: () => live["infoNotFound"] }, 1_000);
    expect(await settle()).toEqual({ success: false, errorReason: "settlement_pending", transaction: TXID_V2, network: NETWORK });
  });

  it("a broadcast the node refuses as a duplicate is a consumed payment: invalid_transaction_state with the id, stored final", async () => {
    // java-tron answers DUP_TRANSACTION_ERROR for a transaction id it already holds. A transaction id the node holds is
    // a consumed payment, and x402's exact family: "A consumed primitive MUST produce a settlement failure, never a
    // success." The non-empty id says the transaction may be on chain.
    await start({ broadcast: { code: "DUP_TRANSACTION_ERROR", message: "" } });
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(STATE_FAILED);
    expect(node.calls.filter((c) => c.path.endsWith("/gettransactioninfobyid"))).toHaveLength(0);
    const stored = await db.pool.query("SELECT answer FROM settlement WHERE network = $1 AND id = $2", [NETWORK, TXID_V2]);
    expect(stored.rows[0]?.answer).toEqual(STATE_FAILED);
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(STATE_FAILED);
    expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(1);
  });

  it("a refused broadcast is stored final over a pending answer another settle wrote, and every repeat gets it", async () => {
    await start({
      broadcast: live["broadcastExpired"],
      onBroadcast: async () => {
        await db.pool.query("UPDATE settlement SET answer = $1", [JSON.stringify(PENDING)]);
      },
    });
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(REFUSED);
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(REFUSED);
    expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(1);
  });

  it("a refused broadcast whose row another settle has made final gives the stored answer, as a repeat gets it", async () => {
    // An empty transaction says nothing was broadcast: it is given only once it is the stored answer.
    await start({
      broadcast: live["broadcastExpired"],
      onBroadcast: async () => {
        await db.pool.query("UPDATE settlement SET answer = $1", [JSON.stringify(STATE_FAILED)]);
      },
    });
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(STATE_FAILED);
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(STATE_FAILED);
    expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(1);
  });

  it("two concurrent /settle calls whose broadcast the node refuses broadcast once, and both give the stored refusal", async () => {
    // The node holds each simulation until both settles have asked for it, so both have read no stored answer before
    // either claims. It holds the broadcast until the settle that lost the claim has begun reading the transaction's
    // status, so that settle reads the row before the refusal is stored, and again, on its poll, until it is; a second
    // broadcast is let through, and counted.
    await start(
      {
        broadcast: live["broadcastExpired"],
        info: () => live["infoNotFound"],
        hold: async (path) => {
          if (path === "/wallet/triggerconstantcontract") await until(() => calls(path).length === 2);
          if (path === "/wallet/broadcasthex") {
            await until(() => calls("/walletsolidity/getnowblock").length > 0 || calls(path).length > 1);
          }
        },
      },
      5_000,
    );
    const answers = await clock.answered([post(`${base}/settle`, body(TX_V2)), post(`${base}/settle`, body(TX_V2))]);
    expect(answers.map((a) => a.json)).toEqual([REFUSED, REFUSED]);
    expect(calls("/wallet/broadcasthex")).toHaveLength(1);
  });

  it("a refused broadcast whose answer cannot be stored gives settlement_pending with the id, and keeps the claim", async () => {
    await start({ broadcast: live["broadcastExpired"] });
    await db.pool.query(`CREATE FUNCTION refuse_answer() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'answer refused'; END $$`);
    await db.pool.query("CREATE TRIGGER refuse_answer BEFORE UPDATE OF answer ON settlement FOR EACH ROW EXECUTE FUNCTION refuse_answer()");
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(PENDING);
    const rows = await db.pool.query("SELECT answer FROM settlement WHERE network = $1 AND id = $2", [NETWORK, TXID_V2]);
    expect(rows.rows).toEqual([{ answer: null }]);
    expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(1);
  });

  it("a node that never shows the transaction in a block gives settlement_pending with the id", async () => {
    await start({ info: () => live["infoNotFound"] }, 2_500);
    expect(await settle()).toEqual({ success: false, errorReason: "settlement_pending", transaction: TXID_V2, network: NETWORK });
  });

  it("a node that times out gives settlement_pending with the id", async () => {
    // The node never answers the receipt read; the clock moves to the end of the wait for the chain, which keeps a
    // quarter of a 1,000 ms wait for storing the answer: 750 ms.
    await start({ info: () => HANG }, 1_000);
    const answer = post(`${base}/settle`, body(TX_V2));
    await reaches(answer, () => calls("/walletsolidity/gettransactioninfobyid").length > 0);
    await clock.advanceTo(750);
    expect((await answer).json).toEqual({ success: false, errorReason: "settlement_pending", transaction: TXID_V2, network: NETWORK });
  });

  it("a wait that ends on an unanswered receipt read stores the pending answer before it answers", async () => {
    const pendingAnswer = { success: false, errorReason: "settlement_pending", transaction: TXID_V2, network: NETWORK };
    // The node holds the Solidity node's receipt read, the first read of the transaction's status after the
    // broadcast. Its bound is the end of the wait for the chain, which keeps a quarter of a 1,500 ms wait for storing
    // the answer: 1,125 ms. Once the clock is there the node answers with a landed receipt: too late, so the answer is
    // settlement_pending, stored and given with the clock at 1,125 ms.
    const receipt = gate();
    await start(
      {
        hold: async (path) => {
          if (path === "/walletsolidity/gettransactioninfobyid") await receipt.opened;
        },
      },
      1_500,
    );
    const answer = post(`${base}/settle`, body(TX_V2));
    await reaches(answer, () => calls("/walletsolidity/gettransactioninfobyid").length > 0);
    await clock.advanceTo(1_125);
    receipt.open();
    expect((await answer).json).toEqual(pendingAnswer);
    expect(clock.elapsed).toBe(1_125);
    const stored = await db.pool.query("SELECT answer FROM settlement WHERE network = $1 AND id = $2", [NETWORK, TXID_V2]);
    expect(stored.rows[0]?.answer).toEqual(pendingAnswer);
    expect(entries.filter((e) => e.entry["event"] === "answer-not-stored")).toEqual([]);
  });
});

describe("repeated settles and node errors", () => {
  it("a repeated /settle whose stored answer is settlement_pending re-reads the chain, broadcasts nothing more, and stores the final answer, which is success once", async () => {
    let landed = false;
    await start({ info: () => (landed ? info("SUCCESS") : live["infoNotFound"]) }, 1_500);
    expect(await settle()).toEqual({ success: false, errorReason: "settlement_pending", transaction: TXID_V2, network: NETWORK });
    landed = true;
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(SUCCESS);
    const reads = node.calls.filter((c) => c.path.endsWith("/gettransactioninfobyid")).length;
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(STATE_FAILED);
    expect(node.calls.filter((c) => c.path.endsWith("/gettransactioninfobyid"))).toHaveLength(reads);
    expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(1);
  });

  it("a repeated /settle gives the stored failure as it is, and broadcasts nothing more, after the expiration has passed", async () => {
    await start({ info: () => info("REVERT") });
    const first = await post(`${base}/settle`, body(TX_V2));
    expect(first.json).toEqual(STATE_FAILED);
    vi.setSystemTime(EXPIRATION_V2 + 1);
    const second = await post(`${base}/settle`, body(TX_V2));
    expect(second.json).toEqual(first.json);
    expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(1);
  });

  it("a repeated /settle of a consumed payment after the expiration has passed answers invalid_transaction_state with the id", async () => {
    await start();
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(SUCCESS);
    vi.setSystemTime(EXPIRATION_V2 + 1);
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(STATE_FAILED);
    expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(1);
  });

  // A transaction id the node holds, in a block or its pending pool, is a consumed payment (x402's exact family: "a
  // consumed primitive MUST produce a settlement failure, never a success"), and an empty `transaction` says nothing
  // was broadcast. So for an id the store does not hold, the node's id reads, made while the settle's deadline leaves
  // time for them, answer before the expiration refusal and before any other refusal.
  it("a /settle of an expired transaction the store does not hold and the node's blocks hold answers invalid_transaction_state with the id", async () => {
    await start({ held: () => ({ txID: TXID_V2, raw_data_hex: RAW_V2, signature: [signatureV2] }) });
    vi.setSystemTime(EXPIRATION_V2 + 1);
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(STATE_FAILED);
    expect(node.calls.filter((c) => c.path === "/wallet/gettransactionbyid").map((c) => c.body)).toEqual([{ value: TXID_V2 }]);
    expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(0);
  });

  it("a /settle of an expired transaction that neither the store nor the node holds is refused as invalid_payload, with no transaction", async () => {
    await start();
    vi.setSystemTime(EXPIRATION_V2 + 1);
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual({
      success: false,
      errorReason: "invalid_payload",
      transaction: "",
      network: NETWORK,
    });
    expect(node.calls.filter((c) => c.path === "/wallet/gettransactionfrompending").map((c) => c.body)).toEqual([
      { value: TXID_V2 },
    ]);
    expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(0);
  });

  it("a /settle of an expired transaction whose id the node does not answer gives unexpected_settle_error, with no transaction", async () => {
    // The node never answers the read of its blocks; the clock moves to the end of settleWaitMs.
    await start({ held: () => HANG }, 1_000);
    vi.setSystemTime(EXPIRATION_V2 + 1);
    const answer = post(`${base}/settle`, body(TX_V2));
    await reaches(answer, () => calls("/wallet/gettransactionbyid").length > 0);
    await clock.advanceTo(1_000);
    expect((await answer).json).toEqual({
      success: false,
      errorReason: "unexpected_settle_error",
      transaction: "",
      network: NETWORK,
    });
    expect(calls("/wallet/broadcasthex")).toHaveLength(0);
  });

  it("a /settle that the owner's permission refuses, of an id in the node's pending pool, answers invalid_transaction_state with the id", async () => {
    const account = {
      address: V2_PAYER_HEX,
      owner_permission: { permission_name: "owner", threshold: 1, keys: [{ address: OTHER_HEX, weight: 1 }] },
    };
    await start({ account, pendingPool: () => ({ txID: TXID_V2, raw_data_hex: RAW_V2, signature: [signatureV2] }) });
    expect((await post(`${base}/verify`, body(TX_V2))).json).toEqual({
      isValid: false,
      invalidReason: "unsupported_permission",
      payer: PAYER,
    });
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(STATE_FAILED);
    expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(0);
  });

  it("a node error before anything is submitted gives unexpected_settle_error and no broadcast", async () => {
    // The node never answers the simulation; the clock moves to the end of settleWaitMs (3,000 ms).
    await start({ trigger: HANG });
    const answer = post(`${base}/settle`, body(TX_V2));
    await reaches(answer, () => calls("/wallet/triggerconstantcontract").length > 0);
    await clock.advanceTo(3_000);
    expect((await answer).json).toEqual({ success: false, errorReason: "unexpected_settle_error", transaction: "", network: NETWORK });
    expect(calls("/wallet/broadcasthex")).toHaveLength(0);
  });

  it("a broadcast the node refuses gives unexpected_settle_error with no transaction, stored final: a repeat gets it and broadcasts nothing", async () => {
    // A refused broadcast keeps its row with the stored answer, so the payment is broadcast at most once: every answer
    // to a repeated /settle for the same id is the stored one.
    await start({ broadcast: live["broadcastExpired"] });
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(REFUSED);
    const stored = await db.pool.query("SELECT answer FROM settlement WHERE network = $1 AND id = $2", [NETWORK, TXID_V2]);
    expect(stored.rows[0]?.answer).toEqual(REFUSED);
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(REFUSED);
    expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(1);
  });

  it("a broadcast refused at connect gives unexpected_settle_error with no transaction, stored final: a repeat once the node listens again gets it and broadcasts nothing", async () => {
    // x402: `transaction` is "empty string if no transaction was broadcast", and a connection the node refuses at
    // connect carries no byte of the broadcast to it. The node stops listening once it has received the reads /settle
    // makes before the broadcast. Every answer to a repeated /settle for the same id is the stored one, so the claim
    // keeps that answer, and a repeat gets it even once the node listens again.
    await start({ leaves: (calls) => BEFORE_BROADCAST.every((path) => calls.some((c) => c.path === path)) });
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(REFUSED);
    expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(0);
    const stored = await db.pool.query("SELECT answer FROM settlement WHERE network = $1 AND id = $2", [NETWORK, TXID_V2]);
    expect(stored.rows[0]?.answer).toEqual(REFUSED);
    await node.listen();
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(REFUSED);
    expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(0);
  });
});

describe("a store that cannot answer", () => {
  // x402: `transaction` is "empty string if no transaction was broadcast", and settlement_pending is non-terminal ("the
  // transaction may still confirm on chain"). A facilitator that cannot read its store cannot know that nothing was
  // broadcast, so it never answers a failure with an empty transaction.
  it("a repeat whose store read fails gives settlement_pending with the id, and broadcasts nothing more", async () => {
    await start();
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(SUCCESS);
    await db.pool.query("ALTER TABLE settlement RENAME TO settlement_unreadable");
    const res = await post(`${base}/settle`, body(TX_V2));
    expect(res.json).toEqual({ success: false, errorReason: "settlement_pending", transaction: TXID_V2, network: NETWORK });
    expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(1);
  });

  /** Whether a query is waiting for a lock in the test's database: the facilitator's read, behind the test's lock. */
  const waitingForLock = async () =>
    (await db.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'"))
      .rowCount !== 0;

  it("a store that stalls is waited for until settleWaitMs: a read that answers before then gives the stored answer", async () => {
    // The store holds the read of a consumed payment's row; the clock moves to 1 ms before settleWaitMs (1,000 ms), and
    // the store then answers: the settle is waiting for that read, and answers as a repeat of a consumed payment does.
    await start({}, 1_000);
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(SUCCESS);
    const holder = await db.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE settlement IN ACCESS EXCLUSIVE MODE");
      const answer = post(`${base}/settle`, body(TX_V2));
      await reaches(answer, waitingForLock);
      await clock.advanceTo(999);
      await holder.query("ROLLBACK");
      expect((await answer).json).toEqual(STATE_FAILED);
      expect(calls("/wallet/broadcasthex")).toHaveLength(1);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });

  it("a store that stalls is bounded: /settle answers settlement_pending with the id, and broadcasts nothing", async () => {
    // The store holds the read; the clock moves to settleWaitMs (1,000 ms), and the store's answer then comes too late
    // to be used.
    await start({}, 1_000);
    const holder = await db.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE settlement IN ACCESS EXCLUSIVE MODE");
      const answer = post(`${base}/settle`, body(TX_V2));
      await reaches(answer, waitingForLock);
      await clock.advanceTo(1_000);
      await holder.query("ROLLBACK");
      expect((await answer).json).toEqual({ success: false, errorReason: "settlement_pending", transaction: TXID_V2, network: NETWORK });
      expect(clock.elapsed).toBe(1_000);
      expect(calls("/wallet/broadcasthex")).toHaveLength(0);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });
});

describe("the facilitator's own bounds", () => {
  it("refuses a body over 64 KiB", async () => {
    await start();
    const res = await fetch(`${base}/verify`, { method: "POST", body: "x".repeat(64 * 1024 + 1) });
    expect(res.status).toBe(413);
  });

  it("answers a network it does not serve as invalid_network", async () => {
    await start();
    const res = await post(`${base}/verify`, body(TX_V2, { ...O, network: "tron:3448148188" }));
    expect(res.json).toEqual({ isValid: false, invalidReason: "invalid_network" });
  });

  it("answers a /settle refused on the request's shape with the requirements' network when they name one as a string", async () => {
    // x402's settlement response carries the `network`, and an empty `transaction` when nothing was broadcast.
    await start();
    const refused = (errorReason: string, network: string) => ({ success: false, errorReason, transaction: "", network });
    const settle = async (b: unknown) => (await post(`${base}/settle`, b)).json;
    expect(await settle({ ...body(TX_V2), x402Version: 1 })).toEqual(refused("invalid_x402_version", NETWORK));
    expect(await settle({ ...body(TX_V2), paymentPayload: [] })).toEqual(refused("invalid_payload", NETWORK));
    expect(await settle(body(TX_V2, { ...O, scheme: "upto" }))).toEqual(refused("unsupported_scheme", NETWORK));
    expect(await settle(body(TX_V2, { ...O, network: 728126428 }))).toEqual(refused("invalid_network", ""));
    expect(await settle([body(TX_V2)])).toEqual(refused("invalid_payload", ""));
  });
});

describe("the operator log", () => {
  // The operator gets the cause of every error the facilitator answers for; the client's answer stays x402's and
  // carries nothing from it. The fields name the payment: network, payer and the transaction id.
  const ABOUT = { network: NETWORK, payer: PAYER, transaction: TXID_V2 };
  const logged = (event: string) => entries.filter((e) => e.entry["event"] === event);

  it("an error a rail throws reaches the log with the request's network, and the answer is the unexpected error", async () => {
    // A clock that reads no time: the expiration check cannot compare, and throws.
    await start();
    const now = vi.spyOn(Date, "now").mockReturnValue(NaN);
    try {
      expect((await post(`${base}/verify`, body(TX_V2))).json).toEqual({ isValid: false, invalidReason: "unexpected_verify_error" });
      expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(REFUSED);
    } finally {
      now.mockRestore();
    }
    for (const event of ["verify-error", "settle-error"]) {
      expect(logged(event)).toHaveLength(1);
      expect(logged(event)[0]!.entry).toEqual({ event, network: NETWORK });
      expect(logged(event)[0]!.cause).toBeInstanceOf(Error);
    }
  });

  it("a node read that fails reaches the log with the payment's fields and the call, and the answer is unchanged", async () => {
    // The stub's Solidity node answers getnowblock with {}, which names no block.
    await start();
    expect(await settle()).toEqual(SUCCESS);
    const failedReads = logged("node-call-failed");
    expect(failedReads.length).toBeGreaterThan(0);
    expect(failedReads[0]!.entry).toEqual({ event: "node-call-failed", ...ABOUT, call: "/walletsolidity/getnowblock" });
    expect((failedReads[0]!.cause as Error).message).toBe("malformed: getnowblock fields");
  });

  it("a store call that fails reaches the log with the payment's fields and the call, and the answer is pending with the id", async () => {
    await start();
    await db.pool.query("ALTER TABLE settlement RENAME TO settlement_elsewhere");
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(PENDING);
    expect(logged("store-call-failed").map((e) => e.entry)).toEqual([{ event: "store-call-failed", ...ABOUT, call: "read" }]);
    expect(String((logged("store-call-failed")[0]!.cause as Error).message)).toContain("settlement");
  });

  it("a store read that fails on /verify reaches the log with the payment's fields and the call, and the answer is unchanged", async () => {
    await start();
    await db.pool.query("ALTER TABLE settlement RENAME TO settlement_elsewhere");
    expect((await post(`${base}/verify`, body(TX_V2))).json).toEqual({
      isValid: false,
      invalidReason: "unexpected_verify_error",
      payer: PAYER,
    });
    expect(entries.map((e) => e.entry)).toEqual([{ event: "store-call-failed", ...ABOUT, call: "read" }]);
    expect(String((entries[0]!.cause as Error).message)).toContain("settlement");
  });

  it("a broadcast refused at connect reaches the log as the call that failed, its cause the request that never reached the node, and the answer is unchanged", async () => {
    // The node stops listening once it has received the reads /settle makes before the broadcast.
    await start({ leaves: (sent) => BEFORE_BROADCAST.every((path) => sent.some((c) => c.path === path)) });
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(REFUSED);
    expect(entries.map((e) => e.entry)).toEqual([{ event: "node-call-failed", ...ABOUT, call: "/wallet/broadcasthex" }]);
    const cause = entries[0]!.cause;
    expect(cause).toBeInstanceOf(NodeError);
    expect((cause as NodeError).code).toBe("transport");
    expect((cause as NodeError).sent).toBe(false);
  });

  it("a receipt the Solidity node shows reading REVERT reaches the log as settlement-failed", async () => {
    await start({ info: () => info("REVERT") });
    expect(await settle()).toEqual(STATE_FAILED);
    expect(logged("settlement-failed").map((e) => e.entry)).toEqual([
      { event: "settlement-failed", ...ABOUT, why: "contract-failed", result: "REVERT" },
    ]);
  });

  it("by default, writes one JSON line on standard error, with the cause's name, message, stack and cause chain", async () => {
    await start();
    const lines: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true));
    try {
      const cause = new TypeError("outer", { cause: new RangeError("inner") });
      operatorLine({ event: "settle-error", network: NETWORK }, cause);
      operatorLine({ event: "settlement-expired", ...ABOUT });
    } finally {
      write.mockRestore();
    }
    expect(lines.every((l) => l.endsWith("\n"))).toBe(true);
    const [first, second] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(second).toEqual({ event: "settlement-expired", ...ABOUT });
    expect(first).toMatchObject({
      event: "settle-error",
      network: NETWORK,
      cause: { name: "TypeError", message: "outer", cause: { name: "RangeError", message: "inner" } },
    });
    expect((first!["cause"] as { stack: string }).stack).toContain("TypeError: outer");
  });

  it("a log that throws never changes an answer: the entry goes to standard error, with operator-log-failed", async () => {
    await start();
    const lines: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true));
    try {
      guarded(() => {
        throw new Error("sink down");
      })({ event: "answer-not-stored", ...ABOUT }, new Error("store down"));
    } finally {
      write.mockRestore();
    }
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>)).toMatchObject([
      { event: "answer-not-stored", ...ABOUT, cause: { message: "store down" } },
      { event: "operator-log-failed", ...ABOUT, cause: { message: "sink down" } },
    ]);
  });

  it("a node answer that is not JSON reaches the log as the node error, whose cause is the parse error, and the answer is unchanged", async () => {
    // A proxy in front of the FullNode answers the account read with a page of text.
    await start({ account: new RawBody("<html><body>502 Bad Gateway</body></html>") });
    expect((await post(`${base}/verify`, body(TX_V2))).json).toEqual({
      isValid: false,
      invalidReason: "unexpected_verify_error",
      payer: PAYER,
    });
    expect(logged("node-call-failed").map((e) => e.entry)).toEqual([
      { event: "node-call-failed", ...ABOUT, call: "/wallet/getaccount" },
    ]);
    const cause = logged("node-call-failed")[0]!.cause;
    expect(cause).toBeInstanceOf(NodeError);
    expect((cause as NodeError).code).toBe("malformed");
    expect((cause as NodeError).cause).toBeInstanceOf(SyntaxError);
  });

  it("a request whose client leaves before its body ends writes no entry, the connection ends, and the next request is answered", async () => {
    // The client caused it, and nothing failed in the facilitator: there is no one to answer and nothing to log.
    await start();
    const client = connect(Number(new URL(base).port), "127.0.0.1");
    client.on("error", () => {});
    // The client reads, and drops, whatever comes back, so it sees the connection end.
    client.resume();
    let closed = false;
    client.on("close", () => (closed = true));
    // The request declares 100 bytes of body; the client sends 10 of them, then ends its side of the connection.
    client.end("POST /settle HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: 100\r\n\r\n{\"x402Vers");
    // Either is enough to go on: an entry fails the test below, as the connection kept open does.
    await until(() => closed || entries.length > 0);
    expect((await fetch(`${base}/supported`)).status).toBe(200);
    expect(entries).toEqual([]);
    expect(closed).toBe(true);
  });

  it("an error a request's handling throws reaches the log as request-error with its path, and the answer is 500", async () => {
    // The /supported answer cannot be written: its JSON throws. Every other JSON is written as it is.
    await start();
    const write = JSON.stringify;
    const failing = new Error("the answer cannot be written");
    const spy = vi.spyOn(JSON, "stringify").mockImplementation((value: unknown, ...rest: unknown[]) => {
      if (typeof value === "object" && value !== null && "kinds" in value) throw failing;
      return (write as (v: unknown, ...r: unknown[]) => string)(value, ...rest);
    });
    let status: number;
    try {
      status = (await fetch(`${base}/supported`)).status;
    } finally {
      spy.mockRestore();
    }
    expect(status).toBe(500);
    expect(entries.map((e) => e.entry)).toEqual([{ event: "request-error", path: "/supported" }]);
    expect(entries[0]!.cause).toBe(failing);
  });

  it("a sweep that fails reaches the log, and the sweep a minute later drops the rows it is due to drop", async () => {
    await start();
    await db.pool.query("ALTER TABLE settlement RENAME TO settlement_elsewhere");
    await clock.advance(60_000);
    await until(() => logged("store-call-failed").length > 0);
    expect(logged("store-call-failed").map((e) => e.entry)).toEqual([{ event: "store-call-failed", call: "sweep" }]);
    expect((logged("store-call-failed")[0]!.cause as Error).message).toContain("settlement");
    await db.pool.query("ALTER TABLE settlement_elsewhere RENAME TO settlement");
    await db.pool.query("INSERT INTO settlement (network, id, answer, until) VALUES ($1, $2, $3, now() - interval '25 hours')", [
      NETWORK,
      TXID_V2,
      JSON.stringify(STATE_FAILED),
    ]);
    await clock.advance(60_000);
    await until(async () => (await db.pool.query("SELECT id FROM settlement")).rowCount === 0);
    expect(logged("store-call-failed")).toHaveLength(1);
  });

  it("a store connection the server ends while it is idle reaches the log, and the next settle answers success", async () => {
    await start();
    // Ends every other connection to the test's database: the facilitator's, idle since it created the table.
    await db.pool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()",
    );
    await until(() => logged("store-connection-error").length > 0);
    expect(logged("store-connection-error")[0]!.entry).toEqual({ event: "store-connection-error" });
    // Postgres's admin_shutdown: the server ended the connection.
    expect((logged("store-connection-error")[0]!.cause as { code?: string }).code).toBe("57P01");
    expect(await settle()).toEqual(SUCCESS);
  });

  // An unexpected answer that no error caused has its entry too: a node answer the facilitator cannot read, a settle
  // whose deadline passed, and a broadcast the node did not accept.

  // Every node answer the facilitator cannot read, one row per branch: the call, the node's answer, and the part the
  // cause names. java-tron prints a permission's threshold and a key's weight as int64 JSON numbers, a block's id as
  // 64 hex digits whose first 16 are its number, and a broadcast it does not accept with a `code`. The broadcast's row
  // is a /settle's; every other row is a /verify's.
  const owner = (permission: unknown) => ({ account: { address: V2_PAYER_HEX, owner_permission: permission } });
  const CANNOT_READ: { call: string; what: string; part: string; answers: Node; settles?: true }[] = [
    { call: "/wallet/getaccount", what: "an array", part: "the account", answers: { account: [] } },
    { call: "/wallet/getaccount", what: "a permission with no keys", part: "owner_permission.keys", answers: owner({ threshold: 1 }) },
    {
      call: "/wallet/getaccount",
      what: "a threshold that is a word",
      part: "owner_permission.threshold",
      answers: owner({ threshold: "one", keys: [] }),
    },
    {
      call: "/wallet/getaccount",
      what: "a key with no address",
      part: "owner_permission.keys[].address",
      answers: owner({ threshold: 1, keys: [{ weight: 1 }] }),
    },
    {
      call: "/wallet/getaccount",
      what: "a key whose weight is a string",
      part: "owner_permission.keys[].weight",
      answers: owner({ threshold: 1, keys: [{ address: V2_PAYER_HEX, weight: "1" }] }),
    },
    {
      call: "/wallet/getnowblock",
      what: "a head with no number",
      part: "block_header.raw_data.number",
      answers: { head: { block_header: { raw_data: {} } } },
    },
    { call: "/wallet/getblock", what: "an array", part: "the block", answers: { block: () => [] } },
    {
      call: "/wallet/getblock",
      what: "the id of another block number",
      part: "blockID",
      answers: { block: () => ({ blockID: "00".repeat(32) }) },
    },
    { call: "/wallet/gettransactionbyid", what: "an array", part: "the transaction", answers: { held: () => [] } },
    { call: "/wallet/gettransactionfrompending", what: "an array", part: "the transaction", answers: { pendingPool: () => [] } },
    { call: "/wallet/triggerconstantcontract", what: "no result", part: "result", answers: { trigger: { transaction: {} } } },
    {
      call: "/wallet/broadcasthex",
      what: "neither a result nor a code",
      part: "code",
      answers: { broadcast: { result: false } },
      settles: true,
    },
  ];

  it.each(CANNOT_READ)(
    "$call answering $what reaches the log as the call that failed, its cause naming $part, and the answer is unchanged",
    async ({ call, part, answers, settles }) => {
      await start(answers);
      if (settles) {
        expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(REFUSED);
      } else {
        expect((await post(`${base}/verify`, body(TX_V2))).json).toEqual({
          isValid: false,
          invalidReason: "unexpected_verify_error",
          payer: PAYER,
        });
      }
      expect(entries.map((e) => e.entry)).toEqual([{ event: "node-call-failed", ...ABOUT, call }]);
      const cause = entries[0]!.cause;
      expect(cause).toBeInstanceOf(NodeError);
      expect((cause as NodeError).code).toBe("malformed");
      expect((cause as NodeError).message).toBe(`malformed: ${call}: ${part}`);
    },
  );

  // The receipt reads after the broadcast: an answer the facilitator cannot read is a failed read, and the status stays
  // pending (lcp's tronStatus). java-tron answers an id it holds with an object naming its blockNumber and receipt.
  const RECEIPT_CANNOT_READ: { what: string; part: string; answers: () => unknown }[] = [
    { what: "an array", part: "gettransactioninfobyid", answers: () => [] },
    { what: "a receipt with no result", part: "gettransactioninfobyid fields", answers: () => ({ blockNumber: 1, receipt: {} }) },
  ];

  it.each(RECEIPT_CANNOT_READ)(
    "/walletsolidity/gettransactioninfobyid answering $what reaches the log as the call that failed, its cause naming $part, and the answer is pending with the id",
    async ({ part, answers }) => {
      await start({ info: answers });
      expect(await settle()).toEqual(PENDING);
      const call = "/walletsolidity/gettransactioninfobyid";
      const failedReads = logged("node-call-failed").filter((e) => e.entry["call"] === call);
      expect(failedReads.length).toBeGreaterThan(0);
      expect(failedReads[0]!.entry).toEqual({ event: "node-call-failed", ...ABOUT, call });
      const cause = failedReads[0]!.cause;
      expect(cause).toBeInstanceOf(NodeError);
      expect((cause as NodeError).code).toBe("malformed");
      expect((cause as NodeError).message).toBe(`malformed: ${part}`);
    },
  );

  it("a settle whose deadline passes once its node reads have answered reaches the log as settle-deadline-passed with the bound, and claims and broadcasts nothing", async () => {
    // The simulation's answer arrives within its bound, and the facilitator goes on with it once the clock is at
    // settleWaitMs (1,000 ms), as after time spent elsewhere: the deadline has passed before the claim.
    await start({}, 1_000);
    const simulation = resumeLate((url) => url.endsWith("/wallet/triggerconstantcontract"));
    const answer = post(`${base}/settle`, body(TX_V2));
    await reaches(answer, simulation.arrived);
    await clock.advanceTo(1_000);
    simulation.resume();
    expect((await answer).json).toEqual({ success: false, errorReason: "unexpected_settle_error", transaction: "", network: NETWORK });
    expect(entries.map((e) => e.entry)).toEqual([
      { event: "settle-deadline-passed", ...ABOUT, before: "claim", settleWaitMs: 1_000 },
    ]);
    expect(entries[0]!.cause).toBeUndefined();
    expect((await db.pool.query("SELECT id FROM settlement")).rowCount).toBe(0);
    expect(calls("/wallet/broadcasthex")).toHaveLength(0);
  });

  it("a settle whose deadline passes once its store read has answered reaches the log as settle-deadline-passed before the node reads, and sends no node call", async () => {
    // The store's answer for the id (none held) arrives within its bound, and the facilitator goes on with it once the
    // clock is at settleWaitMs (1,000 ms): the deadline has passed before the node reads, the two id reads among them.
    await start({}, 1_000);
    const read = resumeLate((call) => call === "store.read");
    const answer = post(`${base}/settle`, body(TX_V2));
    await reaches(answer, read.arrived);
    await clock.advanceTo(1_000);
    read.resume();
    expect((await answer).json).toEqual(REFUSED);
    expect(entries.map((e) => e.entry)).toEqual([
      { event: "settle-deadline-passed", ...ABOUT, before: "node reads", settleWaitMs: 1_000 },
    ]);
    expect(entries[0]!.cause).toBeUndefined();
    for (const path of [
      "/wallet/gettransactionbyid",
      "/wallet/gettransactionfrompending",
      "/wallet/getaccount",
      "/wallet/getnowblock",
      "/wallet/getblock",
      "/wallet/triggerconstantcontract",
    ]) {
      expect(calls(path)).toHaveLength(0);
    }
    expect((await db.pool.query("SELECT id FROM settlement")).rowCount).toBe(0);
    expect(calls("/wallet/broadcasthex")).toHaveLength(0);
  });

  it("a settle of an expired transaction whose deadline passes once its store read has answered is refused as invalid_payload, writes no entry, and sends no node call", async () => {
    // The expiration window is checked before the deadline: the client's own transaction is refused, and with no time
    // left the id reads that could have found it consumed are not made.
    await start({}, 1_000);
    vi.setSystemTime(EXPIRATION_V2 + 1);
    const read = resumeLate((call) => call === "store.read");
    const answer = post(`${base}/settle`, body(TX_V2));
    await reaches(answer, read.arrived);
    await clock.advanceTo(1_000);
    read.resume();
    expect((await answer).json).toEqual({ success: false, errorReason: "invalid_payload", transaction: "", network: NETWORK });
    expect(entries).toEqual([]);
    expect(node.calls).toEqual([]);
  });

  // A stored settlement_pending, or a claimed id, is read again from the chain until the wait for the chain ends, a
  // quarter of settleWaitMs (1,000 ms) before the deadline: at 750 ms. Each row holds the settle's store read until the
  // clock is there, so the wait has ended before the first status read.
  const FOLLOWED: { what: string; stored: string | null }[] = [
    { what: "a stored settlement_pending", stored: JSON.stringify(PENDING) },
    { what: "a claimed id", stored: null },
  ];

  it.each(FOLLOWED)(
    "$what whose wait for the chain has ended once its store read has answered reads no status, writes no entry, and stores and gives settlement_pending",
    async ({ stored }) => {
      await start({}, 1_000);
      await db.pool.query("INSERT INTO settlement (network, id, answer, until) VALUES ($1, $2, $3, $4)", [
        NETWORK,
        TXID_V2,
        stored,
        new Date(EXPIRATION_V2).toISOString(),
      ]);
      const read = resumeLate((call) => call === "store.read");
      const answer = post(`${base}/settle`, body(TX_V2));
      await reaches(answer, read.arrived);
      await clock.advanceTo(750);
      read.resume();
      expect((await answer).json).toEqual(PENDING);
      expect(entries).toEqual([]);
      expect(node.calls).toEqual([]);
      expect(asked).toEqual([]);
      expect((await db.pool.query("SELECT answer FROM settlement")).rows).toEqual([{ answer: PENDING }]);
    },
  );

  /** The paths of the node calls the facilitator has asked for since the `from`th. */
  const pathsOf = (from: number) => asked.slice(from).map((a) => new URL(a.url).pathname);

  it("a settle whose TaPoS head read answers once its deadline has passed sends no reference block read, and reaches the log once, as settle-deadline-passed naming it", async () => {
    // TaPoS reads the head, then the reference block. The head's answer arrives within its bound, and the facilitator
    // goes on with it once the clock is at settleWaitMs (1,000 ms), as after time spent elsewhere; the other node reads
    // have answered by then. The reference block read is asked for and not sent.
    await start({}, 1_000);
    const head = resumeLate((url) => url.endsWith("/wallet/getnowblock"));
    const answer = post(`${base}/settle`, body(TX_V2));
    await reaches(answer, head.arrived);
    const [sent, wanted] = [node.calls.length, asked.length];
    await clock.advanceTo(1_000);
    head.resume();
    expect((await answer).json).toEqual(REFUSED);
    expect(entries.map((e) => e.entry)).toEqual([
      { event: "settle-deadline-passed", ...ABOUT, before: "/wallet/getblock", settleWaitMs: 1_000 },
    ]);
    expect(entries[0]!.cause).toBeUndefined();
    expect(pathsOf(wanted)).toEqual(["/wallet/getblock"]);
    expect(node.calls).toHaveLength(sent);
    expect((await db.pool.query("SELECT id FROM settlement")).rowCount).toBe(0);
  });

  it("a settle whose deadline passes between its check and its node reads sends only the reads started before it, and reaches the log once, as settle-deadline-passed naming the first read not sent", async () => {
    // The node reads start together once the deadline check has passed. Here the clock reads 999 ms of settleWaitMs
    // 1,000 until the facilitator asks for its first node read, and 1,000 ms from then on: that read has 1 ms and is
    // sent, and each read asked for after it finds no time left and is not sent.
    await start({}, 1_000);
    const read = resumeLate((call) => call === "store.read");
    const answer = post(`${base}/settle`, body(TX_V2));
    await reaches(answer, read.arrived);
    const wanted = asked.length;
    const now = vi.spyOn(performance, "now").mockImplementation(() => (asked.length > wanted ? 1_000 : 999));
    try {
      read.resume();
      expect((await answer).json).toEqual(REFUSED);
    } finally {
      now.mockRestore();
    }
    const [first, ...rest] = pathsOf(wanted);
    expect(node.calls.map((c) => c.path)).toEqual([first]);
    expect(rest).toHaveLength(4);
    expect(entries.map((e) => e.entry)).toEqual([
      { event: "settle-deadline-passed", ...ABOUT, before: rest[0], settleWaitMs: 1_000 },
    ]);
    expect((await db.pool.query("SELECT id FROM settlement")).rowCount).toBe(0);
  });

  it("a claimed id whose Solidity head read answers once the wait for the chain has ended sends no status read after it, writes no entry, and stores and gives settlement_pending", async () => {
    // A pass of status reads starts with the Solidity node's head. Its answer goes on once the clock is at the wait's
    // end, 750 ms of settleWaitMs 1,000: the pass's next reads are asked for and not sent, and give no final answer.
    await start({ solidHead: tronChainReads("/wallet/getnowblock", {}) }, 1_000);
    await db.pool.query("INSERT INTO settlement (network, id, answer, until) VALUES ($1, $2, NULL, $3)", [
      NETWORK,
      TXID_V2,
      new Date(EXPIRATION_V2).toISOString(),
    ]);
    const head = resumeLate((url) => url.endsWith("/walletsolidity/getnowblock"));
    const answer = post(`${base}/settle`, body(TX_V2));
    await reaches(answer, head.arrived);
    const [sent, wanted] = [node.calls.length, asked.length];
    await clock.advanceTo(750);
    head.resume();
    expect((await answer).json).toEqual(PENDING);
    expect(entries).toEqual([]);
    expect(pathsOf(wanted)).toEqual(["/walletsolidity/getnowblock", "/walletsolidity/gettransactioninfobyid"]);
    expect(node.calls).toHaveLength(sent);
    expect((await db.pool.query("SELECT answer FROM settlement")).rows).toEqual([{ answer: PENDING }]);
  });

  it("a settle whose claim answers once the wait for the chain has ended broadcasts nothing, reaches the log once, as settle-deadline-passed naming the broadcast, and stores unexpected_settle_error, which a repeat gets", async () => {
    // The claim's answer arrives within its bound, and the facilitator goes on with it once the clock is at the wait's
    // end, 750 ms of settleWaitMs 1,000: the broadcast is asked for and not sent. The id is left as a broadcast that
    // cannot have reached the node leaves it: claimed, with unexpected_settle_error and no transaction stored final.
    await start({}, 1_000);
    const claim = resumeLate((call) => call === "store.claim");
    const answer = post(`${base}/settle`, body(TX_V2));
    await reaches(answer, claim.arrived);
    const wanted = asked.length;
    await clock.advanceTo(750);
    claim.resume();
    expect((await answer).json).toEqual(REFUSED);
    expect(entries.map((e) => e.entry)).toEqual([
      { event: "settle-deadline-passed", ...ABOUT, before: "/wallet/broadcasthex", settleWaitMs: 1_000 },
    ]);
    expect(entries[0]!.cause).toBeUndefined();
    expect(pathsOf(wanted)).toEqual(["/wallet/broadcasthex"]);
    expect(calls("/wallet/broadcasthex")).toHaveLength(0);
    expect((await db.pool.query("SELECT answer FROM settlement")).rows).toEqual([{ answer: REFUSED }]);
    // A repeat of the payment takes the path of any stored unexpected_settle_error: it gets the stored answer, and
    // asks the node nothing and writes no entry.
    const repeat = asked.length;
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(REFUSED);
    expect(asked.slice(repeat)).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(calls("/wallet/broadcasthex")).toHaveLength(0);
  });

  it("a broadcast the node does not accept reaches the log as the call that failed, its cause the node's code and message, and the answer is unchanged", async () => {
    // Tron mainnet's live answer to a broadcast of V2 past its expiration (fixtures/tron-mainnet-answers.json).
    await start({ broadcast: live["broadcastExpired"] });
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(REFUSED);
    expect(entries.map((e) => e.entry)).toEqual([{ event: "node-call-failed", ...ABOUT, call: "/wallet/broadcasthex" }]);
    expect((entries[0]!.cause as Error).message).toBe("TRANSACTION_EXPIRATION_ERROR: Transaction expired");
    expect(calls("/wallet/broadcasthex")).toHaveLength(1);
  });
});
