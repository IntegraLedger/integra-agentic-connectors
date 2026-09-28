// The end of a Polkadot extrinsic's era. The lcp vectors' V3 has a mortal era of period 64 from block 21,054,314 (era
// bytes a502), so its last block is 21,054,377. Validation at the best block shows the extrinsic absent from that
// block's ancestry, and the finalized head is in every later best chain, so it can be included only after the finalized
// head read before validation (and never before the era's birth). Once every block from there to the era's last is
// read at finality and none holds it, it can never be included (the profile's rule 7: the validity window is the mortal
// era; finalized blocks cannot be reverted), and the answer is final: invalid_transaction_state with the extrinsic's
// hash. Before the era's last block is final, the answer stays settlement_pending with the hash. A best block may be a
// fork that is dropped: a block finalized at the validated height that holds the extrinsic makes the answer success.
// Expected values: those rules, and the lcp vectors' V2 and V3.
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

const HASH_V3 = "0xffdc62b15bc3b766b9915bebe37e6282aa5ea4344e32b495f464d4fa7557e6ab";
const FINALIZED_HASH = `0x${"cc".repeat(32)}`;
const ERA_LAST = 21_054_377;
/** The canonical block at the validated height, a sibling of the best block validation read. */
const CANON_BEST = `0x${BEST.toString(16).padStart(64, "0")}`;
let forked = false;

let db: Awaited<ReturnType<typeof freshDatabase>>;
let node: Stub | undefined;
let base: string;
let closeFacilitator: (() => Promise<void>) | undefined;
let head = BEST + 1;
let finalized = BEST;

async function start(): Promise<void> {
  node = await stub(async (_path, body) => {
    const { id, method, params } = body as { id: number; method: string; params: unknown[] };
    const answer = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const known = init.find((c) => c.method === method && JSON.stringify(c.params) === JSON.stringify(params));
    if (known !== undefined) return answer(known.result);
    const p = JSON.stringify(params);
    if (method === "chain_getBlockHash" && p === "[]") return answer(BEST_HASH);
    if (method === "chain_getHeader" && p === JSON.stringify([BEST_HASH])) return answer({ number: `0x${BEST.toString(16)}` });
    if (method === "chain_getFinalizedHead") return answer(FINALIZED_HASH);
    if (method === "chain_getHeader" && p === JSON.stringify([FINALIZED_HASH])) {
      return answer({ number: `0x${finalized.toString(16)}` });
    }
    if (method === "state_call") return answer(VALID);
    if (method === "author_submitExtrinsic") return answer(`0x${"ff".repeat(32)}`);
    if (method === "chain_getHeader" && p === "[]") return answer({ number: `0x${head.toString(16)}` });
    if (method === "chain_getBlockHash" && typeof params[0] === "number") {
      return answer(`0x${params[0].toString(16).padStart(64, "0")}`);
    }
    if (forked && method === "chain_getBlock" && p === JSON.stringify([CANON_BEST])) {
      return answer({ block: { header: {}, extrinsics: ["0x280402000b", "0x280402000b", XT_V3] } });
    }
    if (forked && method === "state_getStorage" && p === JSON.stringify([EVENTS_KEY, CANON_BEST])) return answer(EVENTS);
    if (method === "chain_getBlock") return answer({ block: { header: {}, extrinsics: ["0x280402000b"] } });
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `no stub for ${method} ${p}` } };
  });
  const port = await freePort();
  const f = await serveProfileFacilitator({
    listen: `127.0.0.1:${port}`,
    polkadot: [{ network: NETWORK, rpc: node.url }],
    store: { url: db.url },
    settleWaitMs: 3_000,
  });
  closeFacilitator = f.close;
  base = `http://127.0.0.1:${port}`;
}

const body = () => ({
  x402Version: 2,
  paymentPayload: { x402Version: 2, accepted: O_P, payload: { extrinsic: XT_V3, call: CALL_V2 } },
  paymentRequirements: O_P,
});
const submits = () => node!.calls.filter((c) => (c.body as { method: string }).method === "author_submitExtrinsic").length;
const PENDING = { success: false, errorReason: "settlement_pending", transaction: HASH_V3, network: NETWORK };

beforeEach(async () => {
  head = BEST + 1;
  finalized = BEST - 2;
  forked = false;
  db = await freshDatabase();
});

afterEach(async () => {
  await closeFacilitator?.();
  await node?.close();
  await db.drop();
}, 60_000);

describe("the end of a Polkadot extrinsic's era", () => {
  it("with no block of the era holding it, read at finality to the era's last block, gives invalid_transaction_state with the hash", async () => {
    await start();
    expect((await post(`${base}/settle`, body())).json).toEqual(PENDING);
    head = ERA_LAST + 44;
    finalized = ERA_LAST + 2;
    expect((await post(`${base}/settle`, body())).json).toEqual({
      success: false,
      errorReason: "invalid_transaction_state",
      transaction: HASH_V3,
      network: NETWORK,
    });
    expect(submits()).toBe(1);
  });

  it("a block finalized at the validated height, not the best block validation read, holds it: the answer is success", async () => {
    await start();
    expect((await post(`${base}/settle`, body())).json).toEqual(PENDING);
    forked = true;
    head = ERA_LAST + 44;
    finalized = ERA_LAST + 2;
    expect((await post(`${base}/settle`, body())).json).toEqual({
      success: true,
      transaction: `${CANON_BEST}-2`,
      network: NETWORK,
      payer: PAYER,
    });
    expect(submits()).toBe(1);
  });

  it("with the era's last block not yet final, stays settlement_pending", async () => {
    await start();
    expect((await post(`${base}/settle`, body())).json).toEqual(PENDING);
    head = ERA_LAST + 44;
    finalized = ERA_LAST - 7;
    expect((await post(`${base}/settle`, body())).json).toEqual(PENDING);
    expect(submits()).toBe(1);
  });
});
