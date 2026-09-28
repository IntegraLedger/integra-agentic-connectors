// A settle that claims the id and stops before its answer is written (a crash, or an answer write that fails) leaves
// the dedupe row claimed with no answer. A repeat reads the chain again and never broadcasts. A receipt reading SUCCESS
// gives success: true, with transaction = the id and payer = the owner (the profile's rule 5). Expected values: that
// rule, and the lcp vectors' V2 (raw_data, id, payer).
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serveProfileFacilitator } from "../src/index.js";
import { fixture, freePort, freshDatabase, post, stub, tronChainReads, type Stub } from "./support.js";

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
let node: Stub;
let base: string;
let closeFacilitator: (() => Promise<void>) | undefined;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_V2);
  db = await freshDatabase();
  node = await stub(async (path, sent) => {
    if (path === "/wallet/triggerconstantcontract") return live["triggerSuccess"];
    if (path === "/wallet/broadcasthex") return { result: true, txid: TXID_V2 };
    if (path === "/wallet/gettransactioninfobyid") {
      const v1 = live["infoV1"]!;
      return { ...v1, id: TXID_V2, blockNumber: 86542790, receipt: { ...(v1["receipt"] as object), result: "SUCCESS" } };
    }
    return tronChainReads(path, sent) ?? {};
  });
  const port = await freePort();
  const f = await serveProfileFacilitator({
    listen: `127.0.0.1:${port}`,
    tron: [{ network: NETWORK, fullNode: node.url, solidityNode: node.url }],
    store: { url: db.url },
    settleWaitMs: 1_000,
  });
  closeFacilitator = f.close;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await closeFacilitator?.();
  await node.close();
  await db.drop();
  vi.useRealTimers();
}, 60_000);

describe("a claimed id whose answer was never written", () => {
  it("is re-read from the chain on the next /settle, and answers the landed transaction's success without broadcasting", async () => {
    // What a settle leaves when it stops between its claim and its answer.
    await db.pool.query("INSERT INTO settlement (network, id, answer, until) VALUES ($1, $2, NULL, $3)", [
      NETWORK,
      TXID_V2,
      new Date(EXPIRATION_V2).toISOString(),
    ]);
    const res = await post(`${base}/settle`, body());
    expect(res.json).toEqual({ success: true, transaction: TXID_V2, network: NETWORK, payer: PAYER });
    expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(0);
  }, 30_000);
});
