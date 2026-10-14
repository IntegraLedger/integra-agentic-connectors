// The validity window's end, on Tron. A dedupe row is kept for 24 h after `until` (the transaction's `expiration`), and
// a repeat in that time reads the stored answer, then the chain, before the expiration check and the node reads are
// made again: a pending answer must be able to become final, and a success already answered makes the payment consumed.
// A transaction is final as never included once the latest solidified block, read first, is two 3-second slots past its
// expiration and neither receipt lookup finds it, each naming a latest block at or past that block's time, read from
// its own node before the lookup (the lcp tron entry point's status rule and its reader contract: a node accepts a
// transaction only while `expiration` is after the head block's time, and a lookup naming no time never reads failed).
// Until then the answer stays settlement_pending with the id. An empty `transaction` says nothing was broadcast (x402),
// so it is given for an id the store holds only as the stored answer of a broadcast the node refused or never received.
// Expected values: those rules, and the lcp vectors' V2 (raw_data, id, payer, expiration).
// Every wait the facilitator makes runs on a clock the test moves (support.ts's `controlledClock`): a settle's wait
// ends when the test moves the clock to its end, never because the machine is slow.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serveProfileFacilitator } from "../src/index.js";
import { openStore } from "../src/store.js";
import {
  controlledClock,
  fixture,
  freePort,
  freshDatabase,
  post,
  stub,
  tronChainReads,
  V2_HEAD,
  V2_HEAD_TIME,
  type Clock,
  type Stub,
} from "./support.js";

vi.mock("../src/http.js", async (original) => (await import("./support.js")).countingSleep(await original<typeof import("../src/http.js")>()));

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

let clock: Clock & { restore(): void };
let db: Awaited<ReturnType<typeof freshDatabase>>;
let node: Stub;
let base: string;
let closeFacilitator: (() => Promise<void>) | undefined;
/** What the nodes show: a receipt with SUCCESS, or no receipt anywhere. */
let landed = true;
/** The latest solidified block's time, in milliseconds. */
let solidTime = NOW_V2;
/** The FullNode's latest block's time, in milliseconds, or null for a `/wallet/getnowblock` answer that names none. */
let headTime: number | null = V2_HEAD_TIME;
/**
 * The Solidity node's latest block's time for the read made before its receipt lookup, when it differs from the
 * solidified block a status read reads first; the two reads alternate, the solidified block's first.
 */
let solidLookupTime: number | undefined;
let solidReads = 0;
let broadcast: unknown = { result: true, txid: TXID_V2 };
/** What the facilitator gave its operator log: each entry, with its cause. */
let entries: { entry: Record<string, unknown>; cause: unknown }[] = [];

async function start(settleWaitMs: number): Promise<void> {
  node = await stub(async (path, sent) => {
    if (path === "/wallet/triggerconstantcontract") return live["triggerSuccess"];
    if (path === "/wallet/broadcasthex") return broadcast;
    if (path === "/wallet/gettransactioninfobyid" || path === "/walletsolidity/gettransactioninfobyid") {
      if (!landed) return live["infoNotFound"];
      const v1 = live["infoV1"]!;
      return { ...v1, id: TXID_V2, blockNumber: 86542790, receipt: { ...(v1["receipt"] as object), result: "SUCCESS" } };
    }
    if (path === "/walletsolidity/getnowblock") {
      const time = solidReads++ % 2 === 1 && solidLookupTime !== undefined ? solidLookupTime : solidTime;
      return { blockID: "00", block_header: { raw_data: { number: 86542800, timestamp: time } } };
    }
    if (path === "/wallet/getnowblock") {
      const time = headTime === null ? {} : { timestamp: headTime };
      return { block_header: { raw_data: { number: V2_HEAD, ...time } } };
    }
    return tronChainReads(path, sent) ?? {};
  });
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

const broadcasts = () => node.calls.filter((c) => c.path === "/wallet/broadcasthex").length;
const PENDING = { success: false, errorReason: "settlement_pending", transaction: TXID_V2, network: NETWORK };

/** A /settle's answer, waking its poll whenever it sleeps; a wait that ends pending ends within settleWaitMs. */
const settle = async () => (await clock.answered([post(`${base}/settle`, body())]))[0]!.json;

beforeEach(async () => {
  clock = controlledClock(NOW_V2);
  landed = true;
  solidTime = NOW_V2;
  headTime = V2_HEAD_TIME;
  solidLookupTime = undefined;
  solidReads = 0;
  broadcast = { result: true, txid: TXID_V2 };
  entries = [];
  db = await freshDatabase();
});

afterEach(async () => {
  clock.restore();
  await closeFacilitator?.();
  await node.close();
  await db.drop();
}, 60_000);

describe("the end of a Tron transaction's validity window", () => {
  it("a landed payment repeated after its expiration, inside the 24 h after it, is consumed: invalid_transaction_state with the id", async () => {
    // x402's exact family: "A consumed primitive MUST produce a settlement failure, never a success."
    await start(1_000);
    const success = { success: true, transaction: TXID_V2, network: NETWORK, payer: PAYER };
    expect((await post(`${base}/settle`, body())).json).toEqual(success);
    vi.setSystemTime(EXPIRATION_V2 + 3_600_000);
    await db.pool.query("UPDATE settlement SET until = now() - interval '1 hour'");
    const store = await openStore(db.url);
    await store.drop();
    await store.close();
    expect((await post(`${base}/settle`, body())).json).toEqual({
      success: false,
      errorReason: "invalid_transaction_state",
      transaction: TXID_V2,
      network: NETWORK,
    });
    expect(broadcasts()).toBe(1);
  });

  it("a row is dropped once `until` is more than 24 h past", async () => {
    await start(1_000);
    await post(`${base}/settle`, body());
    await db.pool.query("UPDATE settlement SET until = now() - interval '25 hours'");
    const store = await openStore(db.url);
    await store.drop();
    await store.close();
    expect((await db.pool.query("SELECT id FROM settlement")).rows).toEqual([]);
  });

  it("with nothing included and the solidified block two slots past the expiration, gives invalid_transaction_state with the id", async () => {
    landed = false;
    await start(1_000);
    expect(await settle()).toEqual(PENDING);
    vi.setSystemTime(EXPIRATION_V2 + 10_000);
    solidTime = EXPIRATION_V2 + 6_000;
    expect((await post(`${base}/settle`, body())).json).toEqual({
      success: false,
      errorReason: "invalid_transaction_state",
      transaction: TXID_V2,
      network: NETWORK,
    });
    expect(broadcasts()).toBe(1);
  });

  it("with nothing included and the solidified block two slots past the expiration, gives the operator log settlement-expired, naming the payment", async () => {
    landed = false;
    await start(1_000);
    expect(await settle()).toEqual(PENDING);
    vi.setSystemTime(EXPIRATION_V2 + 10_000);
    solidTime = EXPIRATION_V2 + 6_000;
    expect((await post(`${base}/settle`, body())).json).toEqual({
      success: false,
      errorReason: "invalid_transaction_state",
      transaction: TXID_V2,
      network: NETWORK,
    });
    expect(entries.filter((e) => e.entry["event"] === "settlement-expired")).toEqual([
      { entry: { event: "settlement-expired", network: NETWORK, payer: PAYER, transaction: TXID_V2 }, cause: undefined },
    ]);
  });

  it("reads each level's latest block from its own API before that level's receipt lookup", async () => {
    // The lcp tron entry point's reader contract: a lookup that finds nothing names the time of the latest block at its
    // level, read from the same node before the lookup; its status rule reads the solidified block first, then the
    // Solidity node's receipt, then the FullNode's.
    landed = false;
    await start(1_000);
    expect(await settle()).toEqual(PENDING);
    vi.setSystemTime(EXPIRATION_V2 + 10_000);
    solidTime = EXPIRATION_V2 + 6_000;
    const from = node.calls.length;
    expect((await post(`${base}/settle`, body())).json).toEqual({
      success: false,
      errorReason: "invalid_transaction_state",
      transaction: TXID_V2,
      network: NETWORK,
    });
    expect(
      node.calls
        .slice(from)
        .map((c) => c.path)
        .filter((p) => p.endsWith("/getnowblock") || p.endsWith("/gettransactioninfobyid")),
    ).toEqual([
      "/walletsolidity/getnowblock",
      "/walletsolidity/getnowblock",
      "/walletsolidity/gettransactioninfobyid",
      "/wallet/getnowblock",
      "/wallet/gettransactioninfobyid",
    ]);
  });

  it("with nothing included and the solidified block two slots past the expiration, stays settlement_pending while the FullNode's latest block names no time", async () => {
    // The reader contract: a lookup whose node cannot give its latest block's time names none, and a lookup naming no
    // time never reads failed.
    landed = false;
    await start(1_000);
    expect(await settle()).toEqual(PENDING);
    vi.setSystemTime(EXPIRATION_V2 + 10_000);
    solidTime = EXPIRATION_V2 + 6_000;
    headTime = null;
    expect(await settle()).toEqual(PENDING);
    expect(broadcasts()).toBe(1);
  });

  it("with nothing included and the solidified block two slots past the expiration, stays settlement_pending while the FullNode's latest block is older than it", async () => {
    // The status rule: a lookup whose node lags the solidified block read first is pending not-found.
    landed = false;
    await start(1_000);
    expect(await settle()).toEqual(PENDING);
    vi.setSystemTime(EXPIRATION_V2 + 10_000);
    solidTime = EXPIRATION_V2 + 6_000;
    headTime = solidTime - 3_000;
    expect(await settle()).toEqual(PENDING);
    expect(broadcasts()).toBe(1);
  });

  it("with nothing included and the solidified block two slots past the expiration, stays settlement_pending while the Solidity node's latest block, read before its receipt lookup, is older than it", async () => {
    // The status rule: a lookup whose node lags the solidified block read first is pending not-found, the Solidity
    // node's own lookup included.
    landed = false;
    await start(1_000);
    expect(await settle()).toEqual(PENDING);
    vi.setSystemTime(EXPIRATION_V2 + 10_000);
    solidTime = EXPIRATION_V2 + 6_000;
    solidLookupTime = solidTime - 3_000;
    solidReads = 0;
    const from = node.calls.length;
    expect(await settle()).toEqual(PENDING);
    const lookups = node.calls.slice(from).map((c) => c.path).filter((p) => p.endsWith("/gettransactioninfobyid"));
    expect(lookups.slice(0, 2)).toEqual(["/walletsolidity/gettransactioninfobyid", "/wallet/gettransactioninfobyid"]);
    expect(broadcasts()).toBe(1);
  });

  it("with nothing included and the solidified block not yet past the expiration, stays settlement_pending", async () => {
    landed = false;
    await start(1_000);
    expect(await settle()).toEqual(PENDING);
    vi.setSystemTime(EXPIRATION_V2 + 10_000);
    solidTime = EXPIRATION_V2 - 3_000;
    expect(await settle()).toEqual(PENDING);
    expect(broadcasts()).toBe(1);
  });

  it("a broadcast the node refuses keeps its row with the stored answer: a repeat after the expiration gets it, and the sweep drops it 24 h later", async () => {
    broadcast = live["broadcastExpired"];
    await start(1_000);
    const refused = { success: false, errorReason: "unexpected_settle_error", transaction: "", network: NETWORK };
    expect((await post(`${base}/settle`, body())).json).toEqual(refused);
    expect((await db.pool.query("SELECT id, answer FROM settlement")).rows).toEqual([{ id: TXID_V2, answer: refused }]);
    vi.setSystemTime(EXPIRATION_V2 + 3_600_000);
    expect((await post(`${base}/settle`, body())).json).toEqual(refused);
    expect(broadcasts()).toBe(1);
    await db.pool.query("UPDATE settlement SET until = now() - interval '25 hours'");
    const store = await openStore(db.url);
    await store.drop();
    await store.close();
    expect((await db.pool.query("SELECT id FROM settlement")).rows).toEqual([]);
  });
});
