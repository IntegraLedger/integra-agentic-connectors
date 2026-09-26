// A repeat of a pending answer re-reads the chain and never re-broadcasts, so a pending answer can become final. In a
// block with ExtrinsicSuccess, Remarked and Transferred the answer is success (the profile's rule 5). V3's mortal era is
// period 64 from block 21,054,314 (the lcp vectors' V3, era bytes a502), so it ends at 21,054,378. The extrinsic lands in block
// 21,054,321, inside the era; the repeat comes when the head is at 21,054,421, after the era has ended and before the
// dedupe row's own end. Expected values: the profile's rule 5, and the lcp vectors' V2 and V3.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serveProfileFacilitator } from "../src/index.js";
import { fixture, freePort, freshDatabase, post, stub, type Stub } from "./support.js";

const NETWORK = "polkadot:68d56f15f85d3136970ec16946040bc1";
const CALL_V2 =
  "0x2802083209e51400d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d419c000735016c63703a7368613235363a307862613738313662663866303163666561343134313430646535646165323232336230303336316133393631373761396362343130666636316632303031356164";
const XT_V3 =
  "0x91038400f0a9102f0c58b6b1616671d59b86bfe96ab7211ce9f3eec1a3f6b43e24cc957e00f89553773fab874dbdeb508f55b2e87ec93fc489a4ab8b65bf47898ca18824669391a63ca8dbf3de605b18c531ed224c0fdbaebbaa0a7ecd7ece6acf9c3bd400a50200000000" +
  CALL_V2.slice(2);
const REMARK_HASH = "b8a688f3c46616928a460fb8e39ad581d5686ffdde5e1710d0614ae4a34480c1";
const SIGNER = "f0a9102f0c58b6b1616671d59b86bfe96ab7211ce9f3eec1a3f6b43e24cc957e";
const PAYER = "16SYiSu5tWgdV4sWiaxir7GYEiFfTc9GYnRd34PDGCUMgkmP";
const ALICE = "d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";
const O_P = {
  scheme: "exact",
  network: NETWORK,
  amount: "10000",
  asset: "1337",
  payTo: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
  maxTimeoutSeconds: 60,
  extra: { assetTransferMethod: "lcp-assets-remark" },
};
const BEST = 21_054_320;
const BEST_HASH = `0x${"bb".repeat(32)}`;
const BLOCK_HASH = `0x${"aa".repeat(32)}`;
const VALID = `0x00${"00".repeat(8)}0000${"40"}${"00".repeat(7)}01`;
const EVENTS_KEY = "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7";
const init = (fixture("polkadot-asset-hub-2005000.json.gz") as { calls: { method: string; params: unknown[]; result: unknown }[] }).calls;

const u32le = (n: number) => Buffer.from(Uint32Array.of(n).buffer).toString("hex");
const record = (index: number, pallet: number, variant: number, data: string) =>
  `00${u32le(index)}${pallet.toString(16).padStart(2, "0")}${variant.toString(16).padStart(2, "0")}${data}00`;
const EVENTS = `0x0c${record(2, 50, 2, `${u32le(1337)}${SIGNER}${ALICE}1027${"00".repeat(14)}`)}${record(2, 0, 5, `${SIGNER}${REMARK_HASH}`)}${record(2, 0, 0, "00000000")}`;

let db: Awaited<ReturnType<typeof freshDatabase>>;
let node: Stub | undefined;
let base: string;
let closeFacilitator: (() => Promise<void>) | undefined;
let landed = false;
let head = BEST + 1;

async function start(): Promise<void> {
  node = await stub(async (_path, body) => {
    const { id, method, params } = body as { id: number; method: string; params: unknown[] };
    const answer = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const known = init.find((c) => c.method === method && JSON.stringify(c.params) === JSON.stringify(params));
    if (known !== undefined) return answer(known.result);
    const p = JSON.stringify(params);
    if (method === "chain_getBlockHash" && p === "[]") return answer(BEST_HASH);
    if (method === "chain_getHeader" && p === JSON.stringify([BEST_HASH])) return answer({ number: `0x${BEST.toString(16)}` });
    if (method === "state_call") return answer(VALID);
    if (method === "author_submitExtrinsic") return answer(`0x${"ff".repeat(32)}`);
    if (method === "chain_getHeader" && p === "[]") return answer({ number: `0x${head.toString(16)}` });
    if (method === "chain_getBlockHash" && p === JSON.stringify([BEST + 1])) return answer(BLOCK_HASH);
    if (method === "chain_getBlockHash" && typeof params[0] === "number") {
      return answer(`0x${params[0].toString(16).padStart(64, "0")}`);
    }
    if (method === "chain_getBlock" && p === JSON.stringify([BLOCK_HASH])) {
      return answer({ block: { header: {}, extrinsics: ["0x280402000b", "0x1004", ...(landed ? [XT_V3] : [])] } });
    }
    if (method === "chain_getBlock") return answer({ block: { header: {}, extrinsics: ["0x280402000b"] } });
    if (method === "state_getStorage" && p === JSON.stringify([EVENTS_KEY, BLOCK_HASH])) return answer(EVENTS);
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `no stub for ${method} ${p}` } };
  });
  const port = await freePort();
  const f = await serveProfileFacilitator({
    listen: `127.0.0.1:${port}`,
    polkadot: [{ network: NETWORK, rpc: node.url }],
    store: { url: db.url },
    settleWaitMs: 1_500,
  });
  closeFacilitator = f.close;
  base = `http://127.0.0.1:${port}`;
}

const body = () => ({
  x402Version: 2,
  paymentPayload: { x402Version: 2, accepted: O_P, payload: { extrinsic: XT_V3, call: CALL_V2 } },
  paymentRequirements: O_P,
});

beforeEach(async () => {
  landed = false;
  head = BEST + 1;
  db = await freshDatabase();
});

afterEach(async () => {
  await closeFacilitator?.();
  await node?.close();
  await db.drop();
}, 60_000);

describe("a pending Polkadot answer re-read after the era has ended", () => {
  it("control: re-read while the head is still inside the era, it answers success", async () => {
    await start();
    expect(((await post(`${base}/settle`, body())).json as { errorReason?: string }).errorReason).toBe("settlement_pending");
    landed = true;
    head = BEST + 1 + 10;
    expect(((await post(`${base}/settle`, body())).json as { success: boolean }).success).toBe(true);
  });

  it("finds the extrinsic in the block that holds it and answers success, submitting nothing more", async () => {
    await start();
    const first = (await post(`${base}/settle`, body())).json as { errorReason?: string };
    expect(first.errorReason).toBe("settlement_pending");
    landed = true;
    head = BEST + 1 + 100;
    expect((await post(`${base}/settle`, body())).json).toEqual({
      success: true,
      transaction: `${BLOCK_HASH}-2`,
      network: NETWORK,
      payer: PAYER,
    });
    const submits = node!.calls.filter((c) => (c.body as { method: string }).method === "author_submitExtrinsic");
    expect(submits).toHaveLength(1);
  });
});
