// A /settle answers within `settleWaitMs`, the facilitator's configured wait. It holds for a /settle that finds the id
// claimed and unanswered (a settle that stopped between its claim and its answer), which reads the chain until its wait
// ends. Its wait for the chain ends a quarter of a 1,000 ms settleWaitMs before it, at 750 ms, keeping that quarter for
// storing the answer (store.ts's `answerReserve`). Every wait the facilitator makes runs on a clock the test moves
// (support.ts's `controlledClock`), and the node holds its first receipt read while the test moves the clock: a landed
// receipt the node gives at 749 ms is the answer, and one it gives once the clock is at 750 ms comes too late: the
// settle stores settlement_pending with the id and gives it, before the clock reaches settleWaitMs. The id and bytes are
// the lcp vectors' V2.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serveProfileFacilitator } from "../src/index.js";
import {
  controlledClock,
  fixture,
  freePort,
  freshDatabase,
  gate,
  post,
  reaches,
  stub,
  tronChainReads,
  type Clock,
  type Gate,
  type Stub,
} from "./support.js";

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

const v1 = live["infoV1"]!;
/** A receipt with SUCCESS and the asset's Transfer log, modelled on the live answer for V1's id, carrying V2's id. */
const LANDED = { ...v1, id: TXID_V2, blockNumber: 86542790, receipt: { ...(v1["receipt"] as object), result: "SUCCESS" } };
const PENDING = { success: false, errorReason: "settlement_pending", transaction: TXID_V2, network: NETWORK };

let clock: Clock & { restore(): void };
let db: Awaited<ReturnType<typeof freshDatabase>>;
let node: Stub;
let base: string;
let closeFacilitator: (() => Promise<void>) | undefined;
/** Opened when the node answers the Solidity node's receipt read, with LANDED. */
let receipt: Gate;

beforeEach(async () => {
  receipt = gate();
  clock = controlledClock(NOW_V2);
  db = await freshDatabase();
  node = await stub(async (path, sent) => {
    if (path === "/walletsolidity/gettransactioninfobyid") {
      await receipt.opened;
      return LANDED;
    }
    if (path === "/wallet/gettransactioninfobyid") return live["infoNotFound"];
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
  clock.restore();
  await closeFacilitator?.();
  await node.close();
  await db.drop();
}, 60_000);

/** What a settle leaves when it stops between its claim and its answer. */
async function claimed(): Promise<void> {
  await db.pool.query("INSERT INTO settlement (network, id, answer, until) VALUES ($1, $2, NULL, $3)", [
    NETWORK,
    TXID_V2,
    new Date(EXPIRATION_V2).toISOString(),
  ]);
}

const receiptReads = () => node.calls.filter((c) => c.path === "/walletsolidity/gettransactioninfobyid").length;

describe("the wait of a /settle that finds the id claimed", () => {
  it("gives the receipt the node answers before its wait for the chain ends", async () => {
    await claimed();
    const answer = post(`${base}/settle`, body());
    await reaches(answer, () => receiptReads() === 1);
    await clock.advanceTo(749);
    receipt.open();
    expect((await answer).json).toEqual({ success: true, transaction: TXID_V2, network: NETWORK, payer: PAYER });
    expect(clock.elapsed).toBe(749);
    expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(0);
  });

  it("answers within settleWaitMs when the node does not answer: settlement_pending with the id, stored", async () => {
    await claimed();
    const answer = post(`${base}/settle`, body());
    await reaches(answer, () => receiptReads() === 1);
    await clock.advanceTo(750);
    receipt.open();
    expect((await answer).json).toEqual(PENDING);
    expect(clock.elapsed).toBe(750);
    const stored = await db.pool.query("SELECT answer FROM settlement WHERE network = $1 AND id = $2", [NETWORK, TXID_V2]);
    expect(stored.rows).toEqual([{ answer: PENDING }]);
    expect(node.calls.filter((c) => c.path === "/wallet/broadcasthex")).toHaveLength(0);
  });
});
