// The sweep of the dedupe table. A row whose answer is final is dropped once its `until` is more than 24 h past. A row
// whose answer is not final (claimed with no answer, or settlement_pending) is kept whatever its age, until a read of the
// chain makes its answer final. x402 defines settlement_pending as not final, with a non-empty `transaction`, and an
// empty `transaction` as nothing broadcast, so a repeat of a broadcast payment must find its row and read the chain.
// Expected values: those rules, the profile's rule 5 (success: true with transaction = the id and payer = the owner,
// once a node shows the transaction in a block with SUCCESS), the lcp tron entry point's status rule (final as never
// included once no node holds it and the latest solidified block is two 3-second slots past the expiration), and the
// lcp vectors' V2 (raw_data, id, payer, expiration).
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failed, pending } from "../src/answers.js";
import { serveProfileFacilitator } from "../src/index.js";
import { openStore } from "../src/store.js";
import { fixture, freePort, freshDatabase, post, stub, type Stub } from "./support.js";

const RAW_V2 =
  "0a0289ad22087d1ddbe0b0adbe8740a0b6f4b18d34524d6c63703a7368613235363a3078626137383136626638663031636665613431343134306465356461653232323362303033363161333936313737613963623431306666363166323030313561645aae01081f12a9010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412740a1541f39fd6e51aad88f6f4ce6ab8827279cfffb92266121541a614f803b6fd780986a42c78ec9c7f77e6ded13c2244a9059cbb000000000000000000000000209693bc6afc0c5328ba36faf03c514ef312287c000000000000000000000000000000000000000000000000000000000000271070c0e1f0b18d34900180c2d72f";
const TXID_V2 = "bc5ef82919472351c4e4640798f5d8e87a43c93edc9d867b5f9d40b5077c73f1";
const PAYER = "TYBNgWfhGuNzdLtjKtxXTfskAhTbMcqbaG";
/** The published Anvil key #0, the lcp vectors' V2 payer. */
const ANVIL_0 = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const NOW_V2 = 1790300664000;
const EXPIRATION_V2 = 1790300724000;
const NETWORK = "tron:728126428";
const DAY_MS = 24 * 3_600_000;
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

function sign(rawHex: string): string {
  const id = createHash("sha256").update(Buffer.from(rawHex, "hex")).digest();
  const sig = secp256k1.Signature.fromBytes(
    secp256k1.sign(id, Buffer.from(ANVIL_0, "hex"), { prehash: false, format: "recovered" }),
    "recovered",
  );
  return Buffer.from(sig.toBytes("compact")).toString("hex") + sig.recovery!.toString(16).padStart(2, "0");
}
const TX_V2 = `0aa202${RAW_V2}1241${sign(RAW_V2)}`;
const body = () => ({
  x402Version: 2,
  paymentPayload: { x402Version: 2, accepted: O, payload: { transaction: TX_V2 } },
  paymentRequirements: O,
});

let db: Awaited<ReturnType<typeof freshDatabase>>;
let node: Stub | undefined;
let closeFacilitator: (() => Promise<void>) | undefined;
/** What the nodes show: a receipt with SUCCESS, or no receipt anywhere. */
let landed = false;
/** The latest solidified block's time, in milliseconds. */
let solidTime = NOW_V2;

async function start(): Promise<string> {
  node = await stub(async (path) => {
    if (path === "/wallet/triggerconstantcontract") return live["triggerSuccess"];
    if (path === "/wallet/broadcasthex") return { result: true, txid: TXID_V2 };
    if (path === "/wallet/gettransactioninfobyid" || path === "/walletsolidity/gettransactioninfobyid") {
      if (!landed) return live["infoNotFound"];
      const v1 = live["infoV1"]!;
      return { ...v1, id: TXID_V2, blockNumber: 86542790, receipt: { ...(v1["receipt"] as object), result: "SUCCESS" } };
    }
    if (path === "/walletsolidity/getnowblock") {
      return { blockID: "00", block_header: { raw_data: { number: 86542800, timestamp: solidTime } } };
    }
    return {};
  });
  const port = await freePort();
  const f = await serveProfileFacilitator({
    listen: `127.0.0.1:${port}`,
    tron: [{ network: NETWORK, fullNode: node.url, solidityNode: node.url }],
    store: { url: db.url },
    settleWaitMs: 1_000,
  });
  closeFacilitator = f.close;
  return `http://127.0.0.1:${port}`;
}

async function sweep(): Promise<void> {
  const store = await openStore(db.url);
  await store.drop();
  await store.close();
}

async function rows(): Promise<{ id: string; answer: unknown }[]> {
  return (await db.pool.query<{ id: string; answer: unknown }>("SELECT id, answer FROM settlement ORDER BY id")).rows;
}

const broadcasts = () => node!.calls.filter((c) => c.path === "/wallet/broadcasthex").length;
const PENDING = { success: false, errorReason: "settlement_pending", transaction: TXID_V2, network: NETWORK };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_V2);
  landed = false;
  solidTime = NOW_V2;
  node = undefined;
  closeFacilitator = undefined;
  db = await freshDatabase();
});

afterEach(async () => {
  await closeFacilitator?.();
  await node?.close();
  await db.drop();
  vi.useRealTimers();
}, 60_000);

describe("the sweep of the dedupe table", () => {
  it("drops the final rows more than 24 h past `until`, and keeps every row whose answer is not final", async () => {
    const store = await openStore(db.url);
    const past = new Date(Date.now() - DAY_MS);
    const rowsBy: [string, Parameters<typeof store.answer>[2] | null][] = [
      ["a-success", { success: true, transaction: "a-success", network: NETWORK, payer: PAYER }],
      ["b-failed", failed("invalid_transaction_state", "b-failed", NETWORK)],
      ["c-pending", pending("c-pending", NETWORK)],
      ["d-claimed", null],
    ];
    for (const [id, answer] of rowsBy) {
      expect(await store.claim(NETWORK, id, past)).toBe(true);
      if (answer !== null) await store.answer(NETWORK, id, answer);
    }
    expect(await store.claim(NETWORK, "e-success-recent", past)).toBe(true);
    await store.answer(NETWORK, "e-success-recent", {
      success: true,
      transaction: "e-success-recent",
      network: NETWORK,
      payer: PAYER,
    });
    await db.pool.query("UPDATE settlement SET until = now() - interval '25 hours' WHERE id <> 'e-success-recent'");
    await db.pool.query("UPDATE settlement SET until = now() - interval '23 hours' WHERE id = 'e-success-recent'");
    await store.drop();
    await store.close();
    expect((await rows()).map((r) => r.id)).toEqual(["c-pending", "d-claimed", "e-success-recent"]);
  });

  it("keeps a pending row past its life; a repeat once the payment lands gives success with the id, and the next sweep drops it", async () => {
    const base = await start();
    expect((await post(`${base}/settle`, body())).json).toEqual(PENDING);
    await db.pool.query("UPDATE settlement SET until = now() - interval '25 hours'");
    await sweep();
    expect(await rows()).toEqual([{ id: TXID_V2, answer: PENDING }]);

    vi.setSystemTime(EXPIRATION_V2 + DAY_MS + 60_000);
    landed = true;
    const success = { success: true, transaction: TXID_V2, network: NETWORK, payer: PAYER };
    expect((await post(`${base}/settle`, body())).json).toEqual(success);
    expect(broadcasts()).toBe(1);
    expect(await rows()).toEqual([{ id: TXID_V2, answer: success }]);

    await sweep();
    expect(await rows()).toEqual([]);
  });

  it("keeps a pending row past its life; a repeat once it can never be included gives invalid_transaction_state with the id, and the next sweep drops it", async () => {
    const base = await start();
    expect((await post(`${base}/settle`, body())).json).toEqual(PENDING);
    await db.pool.query("UPDATE settlement SET until = now() - interval '25 hours'");
    await sweep();
    expect(await rows()).toEqual([{ id: TXID_V2, answer: PENDING }]);

    vi.setSystemTime(EXPIRATION_V2 + DAY_MS + 60_000);
    solidTime = EXPIRATION_V2 + 6_000;
    const never = { success: false, errorReason: "invalid_transaction_state", transaction: TXID_V2, network: NETWORK };
    expect((await post(`${base}/settle`, body())).json).toEqual(never);
    expect(broadcasts()).toBe(1);

    await sweep();
    expect(await rows()).toEqual([]);
  });

  it("keeps a claimed row with no answer past its life; a repeat reads the chain and never broadcasts", async () => {
    const store = await openStore(db.url);
    expect(await store.claim(NETWORK, TXID_V2, new Date(EXPIRATION_V2))).toBe(true);
    await db.pool.query("UPDATE settlement SET until = now() - interval '25 hours'");
    await store.drop();
    await store.close();
    expect(await rows()).toEqual([{ id: TXID_V2, answer: null }]);

    const base = await start();
    vi.setSystemTime(EXPIRATION_V2 + DAY_MS + 60_000);
    landed = true;
    expect((await post(`${base}/settle`, body())).json).toEqual({
      success: true,
      transaction: TXID_V2,
      network: NETWORK,
      payer: PAYER,
    });
    expect(broadcasts()).toBe(0);
  });
});
