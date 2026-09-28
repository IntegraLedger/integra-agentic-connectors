// The Tron profile's rule 5 (x402/exact/tron/lcp-trc20-memo), as a facilitator's /verify and /settle. Expected values
// come from the profile's rules, x402's facilitator answers and its exact family's rules, java-tron's validation
// (TransactionCapsule.validateSignature, Manager.validateTapos and updateRecentBlock), TRC-20's Transfer event, and the
// lcp vectors' V2 (raw_data, id, payer, signature ends and reference block). The nodes are local stubs whose answers
// are Tron mainnet's live answers (fixtures/tron-mainnet-answers.json), with V2's id and the receipt result the test
// names, and java-tron's HTTP shapes for the account, block and transaction reads (support.ts).
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRefusal } from "@integraledger/lcp";
import { decodeTronTx, encodeTronRaw } from "@integraledger/lcp/tron";
import { serveProfileFacilitator } from "../src/index.js";
import {
  fixture,
  freePort,
  freshDatabase,
  HANG,
  post,
  stub,
  tronChainReads,
  V2_PAYER_HEX,
  V2_REF_BLOCK,
  type Stub,
} from "./support.js";

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

interface Node {
  trigger?: unknown;
  /** How long the simulation takes to answer. */
  triggerMs?: number;
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
  /** `/wallet/gettransactionbyid`'s answer. */
  held?: () => unknown;
}

let db: Awaited<ReturnType<typeof freshDatabase>>;
let node: Stub;
let base: string;
let closeFacilitator: () => Promise<void>;

async function start(n: Node = {}, settleWaitMs = 3_000): Promise<void> {
  node = await stub(async (path, sent) => {
    if (path === "/wallet/triggerconstantcontract") {
      if (n.triggerMs !== undefined) await new Promise((resolve) => setTimeout(resolve, n.triggerMs));
      return n.trigger ?? live["triggerSuccess"];
    }
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
    if (path === "/wallet/getblock" && n.block !== undefined) return n.block((sent as { id_or_num: string }).id_or_num);
    if (path === "/wallet/gettransactionbyid" && n.held !== undefined) return n.held();
    return tronChainReads(path, sent) ?? {};
  });
  const port = await freePort();
  const f = await serveProfileFacilitator({
    listen: `127.0.0.1:${port}`,
    tron: [{ network: NETWORK, fullNode: node.url, solidityNode: node.url }],
    store: { url: db.url },
    settleWaitMs,
  });
  closeFacilitator = f.close;
  base = `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_V2);
  db = await freshDatabase();
});

afterEach(async () => {
  await closeFacilitator?.();
  await node?.close();
  await db.drop();
  vi.useRealTimers();
}, 60_000);

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
    // consumed primitive produces a settlement failure, never a success. The simulation answers slowly, so both settles
    // have read no stored answer before either claims.
    await start({ triggerMs: 300 }, 5_000);
    const answers = await Promise.all([post(`${base}/settle`, body(TX_V2)), post(`${base}/settle`, body(TX_V2))]);
    expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(1);
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
    expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(PENDING);
  });

  it("a receipt reading REVERT at the FullNode, not yet at the Solidity node, stays settlement_pending", async () => {
    // A failure is final only once read from a solidified block: the Solidity API serves only blocks that have crossed
    // the irreversibility threshold.
    await start({ info: () => info("REVERT"), solidInfo: () => live["infoNotFound"] }, 1_000);
    const res = await post(`${base}/settle`, body(TX_V2));
    expect(res.json).toEqual({ success: false, errorReason: "settlement_pending", transaction: TXID_V2, network: NETWORK });
  });

  it("a broadcast the node refuses as a duplicate is read as broadcast, and the receipt answers", async () => {
    await start({ broadcast: { code: "DUP_TRANSACTION_ERROR", message: "" } });
    const res = await post(`${base}/settle`, body(TX_V2));
    expect(res.json).toEqual({ success: true, transaction: TXID_V2, network: NETWORK, payer: PAYER });
  });

  it("a refused broadcast whose claim another settle has already answered pending gives settlement_pending with the id", async () => {
    // An empty transaction says nothing was broadcast; the store holding the id, the facilitator does not say so.
    await start({
      broadcast: live["broadcastExpired"],
      onBroadcast: async () => {
        await db.pool.query("UPDATE settlement SET answer = $1", [
          JSON.stringify({ success: false, errorReason: "settlement_pending", transaction: TXID_V2, network: NETWORK }),
        ]);
      },
    });
    const res = await post(`${base}/settle`, body(TX_V2));
    expect(res.json).toEqual({ success: false, errorReason: "settlement_pending", transaction: TXID_V2, network: NETWORK });
  });

  it("a node that never shows the transaction in a block gives settlement_pending with the id", async () => {
    await start({ info: () => live["infoNotFound"] }, 2_500);
    const res = await post(`${base}/settle`, body(TX_V2));
    expect(res.json).toEqual({ success: false, errorReason: "settlement_pending", transaction: TXID_V2, network: NETWORK });
  });

  it("a node that times out gives settlement_pending with the id", async () => {
    await start({ info: () => HANG }, 1_000);
    const res = await post(`${base}/settle`, body(TX_V2));
    expect(res.json).toEqual({ success: false, errorReason: "settlement_pending", transaction: TXID_V2, network: NETWORK });
  }, 15_000);

  it("a wait that ends on an unanswered receipt read stores the pending answer before it answers", async () => {
    const logged: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array, ...rest: unknown[]) => {
      logged.push(String(chunk));
      return (write as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
    });
    const pendingAnswer = { success: false, errorReason: "settlement_pending", transaction: TXID_V2, network: NETWORK };
    try {
      await start({ info: () => HANG }, 1_500);
      expect((await post(`${base}/settle`, body(TX_V2))).json).toEqual(pendingAnswer);
      const stored = await db.pool.query("SELECT answer FROM settlement WHERE network = $1 AND id = $2", [NETWORK, TXID_V2]);
      expect(stored.rows[0]?.answer).toEqual(pendingAnswer);
    } finally {
      spy.mockRestore();
    }
    expect(logged.filter((l) => l.includes("answer-not-stored"))).toEqual([]);
  }, 15_000);
});

describe("repeated settles and node errors", () => {
  it("a repeated /settle whose stored answer is settlement_pending re-reads the chain, broadcasts nothing more, and stores the final answer, which is success once", async () => {
    let landed = false;
    await start({ info: () => (landed ? info("SUCCESS") : live["infoNotFound"]) }, 1_500);
    const first = await post(`${base}/settle`, body(TX_V2));
    expect(first.json).toEqual({ success: false, errorReason: "settlement_pending", transaction: TXID_V2, network: NETWORK });
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

  it("a node error before anything is submitted gives unexpected_settle_error and no broadcast", async () => {
    await start({ trigger: HANG });
    const res = await post(`${base}/settle`, body(TX_V2));
    expect(res.json).toEqual({ success: false, errorReason: "unexpected_settle_error", transaction: "", network: NETWORK });
    expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(0);
  }, 15_000);

  it("a broadcast the node refuses gives success: false with no transaction, and is never retried as a success", async () => {
    await start({ broadcast: live["broadcastExpired"] });
    const res = await post(`${base}/settle`, body(TX_V2));
    expect(res.json).toEqual({ success: false, errorReason: "unexpected_settle_error", transaction: "", network: NETWORK });
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

  it("a store that stalls is bounded: /settle answers settlement_pending with the id, and broadcasts nothing", async () => {
    await start({}, 1_000);
    const holder = await db.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE settlement IN ACCESS EXCLUSIVE MODE");
      const started = performance.now();
      const res = await post(`${base}/settle`, body(TX_V2));
      expect(performance.now() - started).toBeLessThan(1_000 + 1_000);
      expect(res.json).toEqual({ success: false, errorReason: "settlement_pending", transaction: TXID_V2, network: NETWORK });
      expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(0);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  }, 30_000);
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
});
