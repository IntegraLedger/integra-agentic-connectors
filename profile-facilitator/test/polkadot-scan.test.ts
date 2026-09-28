// The Polkadot scan's bounds: the block answer bound from the runtime's System.BlockLength, a block the node cannot
// give recorded and skipped, the last block that can include an extrinsic capped by System.BlockHashCount, and a
// success given once, by the settle that stores it.
//
// Expected values:
// - the lcp vectors' V2 (the call) and V3 (the extrinsic, its era bytes a502: period 64 from block 21,054,314, and its
//   BLAKE2b-256, `b2sum -l 256` over its bytes);
// - Polkadot Asset Hub's recorded runtime 2005000 (fixtures/polkadot-asset-hub-2005000.json.gz), decoded with
//   @polkadot/api: System.BlockLength max {normal 4,456,448, operational 5,242,880, mandatory 5,242,880},
//   maxHeaderSize 102,400, and System.BlockHashCount 4,096;
// - frame_system (polkadot-sdk, substrate/frame/system/src/lib.rs): `initialize` inserts block n - 1's hash into
//   System.BlockHash and `finalize` removes block n - BlockHashCount - 1's, so block n's execution holds the hashes of
//   blocks n - BlockHashCount - 1 to n - 1; CheckMortality (extensions/check_mortality.rs) refuses an extrinsic whose
//   birth block's hash is not there, so the last block that can include it is birth + BlockHashCount + 1;
// - x402's `exact` family: "A consumed primitive MUST produce a settlement failure, never a success".
import { ApiPromise } from "@polkadot/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serveProfileFacilitator } from "../src/index.js";
import { fixture, freePort, freshDatabase, post, stub, type Stub } from "./support.js";

const NETWORK = "polkadot:68d56f15f85d3136970ec16946040bc1";
const CALL_V2 =
  "0x2802083209e51400d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d419c000735016c63703a7368613235363a307862613738313662663866303163666561343134313430646535646165323232336230303336316133393631373761396362343130666636316632303031356164";
const XT_V3 =
  "0x91038400f0a9102f0c58b6b1616671d59b86bfe96ab7211ce9f3eec1a3f6b43e24cc957e00f89553773fab874dbdeb508f55b2e87ec93fc489a4ab8b65bf47898ca18824669391a63ca8dbf3de605b18c531ed224c0fdbaebbaa0a7ecd7ece6acf9c3bd400a50200000000" +
  CALL_V2.slice(2);
const HASH_V3 = "0xffdc62b15bc3b766b9915bebe37e6282aa5ea4344e32b495f464d4fa7557e6ab";
/**
 * V3 with its era bytes a502 replaced by 6f43: a mortal era of period 65,536 and phase 17,248 (1,078 times the
 * quantize factor 65,536 >> 12 = 16), so its birth at block 21,054,320 is 21,054,304 and its death 21,119,840. Its
 * signature does not verify over these bytes; the stub's validation answers Ok, and nothing here checks the signature.
 */
const XT_LONG = `${XT_V3.slice(0, 204)}6f43${XT_V3.slice(208)}`;
/** `b2sum -l 256` over XT_LONG's bytes. */
const HASH_LONG = "0xd75b3112af83539d009ecdce9afa3f9a4354888e67ee9a162cc1f704d6a93735";
const LONG_BIRTH = 21_054_304;
/** LONG_BIRTH + BlockHashCount (4,096) + 1. */
const LONG_LAST = 21_058_401;
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
/** V3's era: period 64 from block 21,054,314, so its last block is 21,054,377. */
const ERA_LAST = 21_054_377;
const BEST_HASH = `0x${"bb".repeat(32)}`;
const FINALIZED_HASH = `0x${"cc".repeat(32)}`;
const VALID = `0x00${"00".repeat(8)}0000${"40"}${"00".repeat(7)}01`;
const EVENTS_KEY = "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7";
/**
 * The most bytes a chain_getBlock answer can take for runtime 2005000: 4 MiB for the header's fixed fields and the
 * JSON-RPC envelope, 9/2 of the largest class limit (an extrinsic of n >= 2 bytes is at most 2n + 5 JSON characters,
 * `"0x…",`), and 7 times maxHeaderSize (a digest item of n >= 1 bytes is at most 7n characters):
 * 4,194,304 + 23,592,960 + 716,800.
 */
const BLOCK_ANSWER_BOUND = 28_504_064;
const init = (fixture("polkadot-asset-hub-2005000.json.gz") as { calls: { method: string; params: unknown[]; result: unknown }[] }).calls;

const u32le = (n: number) => Buffer.from(Uint32Array.of(n).buffer).toString("hex");
const record = (index: number, pallet: number, variant: number, data: string) =>
  `00${u32le(index)}${pallet.toString(16).padStart(2, "0")}${variant.toString(16).padStart(2, "0")}${data}00`;
/** Assets.Transferred(1337), System.Remarked(R) and System.ExtrinsicSuccess, each for the extrinsic at index 2. */
const EVENTS = `0x0c${record(2, 50, 2, `${u32le(1337)}${SIGNER}${ALICE}1027${"00".repeat(14)}`)}${record(2, 0, 5, `${SIGNER}${REMARK_HASH}`)}${record(2, 0, 0, "00000000")}`;
const hashOf = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

interface Chain {
  /** The extrinsic the chain may hold. */
  xt: string;
  /** The height of the block that holds it; no block does when this is undefined. */
  holding?: number;
  finalized: () => number;
  head: () => number;
  /** Blocks whose chain_getBlock the node refuses. */
  unreadable: Set<number>;
  /** Whether the node has discarded the state of the holding block, so its events cannot be read. */
  pruned: boolean;
  /** The holding block's chain_getBlock answer, padded to exactly this many bytes. */
  answerBytes?: number;
}

let chain: Chain;
let db: Awaited<ReturnType<typeof freshDatabase>>;
let node: Stub | undefined;
let base: string;
let closeFacilitator: (() => Promise<void>) | undefined;

/** Another extrinsic of 12 MB in the holding block, and the header padded so the answer is exactly `bytes` long. */
const padded = new Map<string, unknown>();
function paddedAnswer(id: number, extrinsics: string[], bytes: number): unknown {
  const key = `${id} ${bytes} ${extrinsics.join()}`;
  const known = padded.get(key);
  if (known !== undefined) return known;
  const filler = `0x${"00".repeat(12_000_000)}`;
  const answer = (pad: string) => ({ jsonrpc: "2.0", id, result: { block: { header: { pad }, extrinsics: [...extrinsics, filler] } } });
  const value = answer("a".repeat(bytes - JSON.stringify(answer("")).length));
  padded.set(key, value);
  return value;
}

function blockAnswer(id: number, n: number): unknown {
  if (n !== chain.holding) return { jsonrpc: "2.0", id, result: { block: { header: {}, extrinsics: ["0x280402000b"] } } };
  const extrinsics = ["0x280402000b", "0x1004", chain.xt];
  if (chain.answerBytes === undefined) return { jsonrpc: "2.0", id, result: { block: { header: {}, extrinsics } } };
  return paddedAnswer(id, extrinsics, chain.answerBytes);
}

async function start(settleWaitMs = 1_500): Promise<void> {
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
      return answer({ number: `0x${chain.finalized().toString(16)}` });
    }
    if (method === "chain_getHeader" && p === "[]") return answer({ number: `0x${chain.head().toString(16)}` });
    if (method === "state_call") return answer(VALID);
    if (method === "author_submitExtrinsic") return answer(HASH_V3);
    if (method === "chain_getBlockHash" && typeof params[0] === "number") return answer(hashOf(params[0]));
    if (method === "chain_getBlock" && typeof params[0] === "string") {
      const n = Number.parseInt(params[0].slice(2), 16);
      if (chain.unreadable.has(n)) return { jsonrpc: "2.0", id, error: { code: 4003, message: `Client error: UnknownBlock: ${params[0]}` } };
      return blockAnswer(id, n);
    }
    if (method === "state_getStorage" && chain.holding !== undefined && p === JSON.stringify([EVENTS_KEY, hashOf(chain.holding)])) {
      if (chain.pruned) {
        return { jsonrpc: "2.0", id, error: { code: 4003, message: `Client error: UnknownBlock: State already discarded for ${params[1]}` } };
      }
      return answer(EVENTS);
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `no stub for ${method} ${p}` } };
  });
  const port = await freePort();
  const f = await serveProfileFacilitator({
    listen: `127.0.0.1:${port}`,
    polkadot: [{ network: NETWORK, rpc: node.url }],
    store: { url: db.url },
    settleWaitMs,
  });
  closeFacilitator = f.close;
  base = `http://127.0.0.1:${port}`;
  // A /verify loads the runtime metadata, so each /settle's wait is spent on the chain.
  expect((await post(`${base}/verify`, body(chain.xt))).json).toEqual({ isValid: true, payer: PAYER });
}

const body = (extrinsic = XT_V3) => ({
  x402Version: 2,
  paymentPayload: { x402Version: 2, accepted: O_P, payload: { extrinsic, call: CALL_V2 } },
  paymentRequirements: O_P,
});
const settle = async (extrinsic = XT_V3) => (await post(`${base}/settle`, body(extrinsic))).json;
const methodCalls = (method: string) =>
  node!.calls.map((c) => c.body as { method: string; params: unknown[] }).filter((b) => b.method === method);
const submitted = () => node !== undefined && methodCalls("author_submitExtrinsic").length > 0;
const pendingV3 = { success: false, errorReason: "settlement_pending", transaction: HASH_V3, network: NETWORK };
const successAt = (n: number) => ({ success: true, transaction: `${hashOf(n)}-2`, network: NETWORK, payer: PAYER });
const row = async (id = HASH_V3) =>
  (await db.pool.query("SELECT answer, since, unread, until FROM settlement WHERE network = $1 AND id = $2", [NETWORK, id]))
    .rows[0] as { answer: unknown; since: string; unread: string[]; until: Date } | undefined;

/** The operator log lines written while `f` runs. */
async function logged(f: () => Promise<void>): Promise<Record<string, unknown>[]> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array, ...rest: unknown[]) => {
    lines.push(String(chunk));
    return (write as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
  });
  try {
    await f();
  } finally {
    spy.mockRestore();
  }
  return lines.flatMap((l) => l.split("\n")).filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(async () => {
  chain = { xt: XT_V3, finalized: () => BEST - 2, head: () => BEST + 1, unreadable: new Set(), pruned: false };
  db = await freshDatabase();
});

afterEach(async () => {
  await closeFacilitator?.();
  closeFacilitator = undefined;
  await node?.close();
  node = undefined;
  await db.drop();
}, 60_000);

describe("the recorded runtime's bounds", () => {
  it("decode, with @polkadot/api, as System.BlockLength and System.BlockHashCount", async () => {
    const provider = {
      hasSubscriptions: false,
      isClonable: false,
      isConnected: true,
      clone() {
        return provider;
      },
      async connect() {},
      async disconnect() {},
      on() {
        return () => {};
      },
      async send(method: string, params: unknown[]) {
        return init.find((c) => c.method === method && JSON.stringify(c.params) === JSON.stringify(params))?.result;
      },
      async subscribe() {
        return 0;
      },
      async unsubscribe() {
        return false;
      },
    };
    const api = await ApiPromise.create({ provider: provider as never, noInitWarn: true, initWasm: false });
    try {
      expect(api.consts["system"]!["blockLength"]!.toJSON()).toEqual({
        max: { normal: 4_456_448, operational: 5_242_880, mandatory: 5_242_880 },
        maxHeaderSize: 102_400,
      });
      expect(api.consts["system"]!["blockHashCount"]!.toString()).toBe("4096");
    } finally {
      await api.disconnect();
    }
  });
});

describe("a block answer bounded by System.BlockLength", () => {
  it("reads a block whose chain_getBlock answer is over 4 MiB, up to the bound, and answers success", async () => {
    chain.holding = BEST + 1;
    chain.answerBytes = BLOCK_ANSWER_BOUND;
    await start(5_000);
    expect(await settle()).toEqual(successAt(BEST + 1));
  });

  it("records a finalized block whose answer is one byte over the bound as unread, and answers settlement_pending", async () => {
    chain.holding = BEST + 1;
    chain.answerBytes = BLOCK_ANSWER_BOUND + 1;
    chain.finalized = () => (submitted() ? BEST + 2 : BEST - 2);
    await start(5_000);
    const lines = await logged(async () => {
      expect(await settle()).toEqual(pendingV3);
    });
    expect(lines).toContainEqual(expect.objectContaining({ event: "block-unreadable", transaction: HASH_V3, block: BEST + 1 }));
    await vi.waitFor(async () => expect((await row())?.unread).toEqual([String(BEST + 1)]));
  });
});

describe("a block the node cannot give", () => {
  it("at finality, is recorded and skipped: the scan goes on and finds the extrinsic in a later finalized block", async () => {
    chain.holding = BEST + 3;
    chain.unreadable = new Set([BEST - 1]);
    chain.finalized = () => (submitted() ? BEST + 5 : BEST - 2);
    chain.head = () => BEST + 6;
    await start();
    const lines = await logged(async () => {
      expect(await settle()).toEqual(successAt(BEST + 3));
    });
    expect(lines).toContainEqual(expect.objectContaining({ event: "block-unreadable", transaction: HASH_V3, block: BEST - 1 }));
    expect(methodCalls("author_submitExtrinsic")).toHaveLength(1);
  });

  it("at finality, is recorded and skipped: a success above the finalized head is still found", async () => {
    chain.holding = BEST + 2;
    chain.unreadable = new Set([BEST - 1]);
    chain.finalized = () => (submitted() ? BEST : BEST - 2);
    chain.head = () => BEST + 3;
    await start();
    expect(await settle()).toEqual(successAt(BEST + 2));
  });

  it("above the finalized head, is skipped: a success at the head is still found", async () => {
    chain.holding = BEST + 1;
    chain.unreadable = new Set([BEST]);
    chain.head = () => BEST + 2;
    await start();
    expect(await settle()).toEqual(successAt(BEST + 1));
  });

  it("keeps the answer settlement_pending past the era's end while it is unread, and is read again on each repeat", async () => {
    chain.unreadable = new Set([BEST]);
    chain.finalized = () => (submitted() ? ERA_LAST + 2 : BEST - 2);
    chain.head = () => ERA_LAST + 10;
    await start();
    expect(await settle()).toEqual(pendingV3);
    await vi.waitFor(async () => expect((await row())?.unread).toEqual([String(BEST)]));
    expect(await settle()).toEqual(pendingV3);
    // The node gives the block: none of the era's blocks holds the extrinsic, so it can never be included.
    chain.unreadable = new Set();
    expect(await settle()).toEqual({ ...pendingV3, errorReason: "invalid_transaction_state" });
    expect(methodCalls("author_submitExtrinsic")).toHaveLength(1);
  }, 30_000);

  it("whose state is discarded, when it holds the extrinsic, keeps the answer settlement_pending until its events are read", async () => {
    chain.holding = BEST + 1;
    chain.pruned = true;
    chain.finalized = () => (submitted() ? BEST + 3 : BEST - 2);
    chain.head = () => BEST + 4;
    await start();
    expect(await settle()).toEqual(pendingV3);
    await vi.waitFor(async () => {
      const r = await row();
      expect(r?.unread).toEqual([String(BEST + 1)]);
      expect(Number(r?.since)).toBe(BEST + 4);
    });
    chain.finalized = () => ERA_LAST + 2;
    chain.head = () => ERA_LAST + 10;
    expect(await settle()).toEqual(pendingV3);
    // A node that keeps the block's state gives its events.
    chain.pruned = false;
    expect(await settle()).toEqual(successAt(BEST + 1));
    expect(methodCalls("author_submitExtrinsic")).toHaveLength(1);
  }, 30_000);
});

describe("an era longer than System.BlockHashCount", () => {
  it("keeps the dedupe row until birth + BlockHashCount + 1, not the era's own end", async () => {
    chain.xt = XT_LONG;
    await start();
    const before = Date.now();
    expect(await settle(XT_LONG)).toEqual({ ...pendingV3, transaction: HASH_LONG });
    const after = Date.now();
    // Validated at block 21,054,320: 21,058,402 - 21,054,320 = 4,082 blocks of 12 s.
    const until = (await row(HASH_LONG))!.until.getTime();
    expect(until).toBeGreaterThanOrEqual(before + 4_082 * 12_000);
    expect(until).toBeLessThanOrEqual(after + 4_082 * 12_000);
  });

  it("ends the scan at birth + BlockHashCount + 1: final once that block is, and no later block is read", async () => {
    chain.xt = XT_LONG;
    await start();
    // A claim whose scan has read every block before 21,058,395 at finality.
    await db.pool.query("INSERT INTO settlement (network, id, answer, until, since) VALUES ($1, $2, NULL, $3, $4)", [
      NETWORK,
      HASH_LONG,
      new Date(Date.now() + 600_000).toISOString(),
      LONG_LAST - 6,
    ]);
    chain.finalized = () => LONG_LAST - 1;
    chain.head = () => LONG_LAST + 30;
    expect(await settle(XT_LONG)).toEqual({ ...pendingV3, transaction: HASH_LONG });
    chain.finalized = () => LONG_LAST;
    expect(await settle(XT_LONG)).toEqual({ ...pendingV3, errorReason: "invalid_transaction_state", transaction: HASH_LONG });
    const read = methodCalls("chain_getBlockHash").map((b) => b.params[0]).filter((n) => typeof n === "number") as number[];
    expect(read).toContain(LONG_LAST);
    expect(read.filter((n) => n > LONG_LAST)).toEqual([]);
    expect(LONG_LAST - LONG_BIRTH).toBe(4_096 + 1);
    expect(methodCalls("author_submitExtrinsic")).toHaveLength(0);
  });
});

describe("a success given once", () => {
  it("is not given when it cannot be stored: the answer is settlement_pending, and the settle that stores it gives it", async () => {
    chain.holding = BEST + 1;
    await start();
    await db.pool.query(`CREATE FUNCTION refuse_answer() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'answer refused'; END $$`);
    await db.pool.query("CREATE TRIGGER refuse_answer BEFORE UPDATE OF answer ON settlement FOR EACH ROW EXECUTE FUNCTION refuse_answer()");
    const lines = await logged(async () => {
      expect(await settle()).toEqual(pendingV3);
    });
    expect(lines).toContainEqual(expect.objectContaining({ event: "answer-not-stored", transaction: HASH_V3 }));
    await db.pool.query("DROP TRIGGER refuse_answer ON settlement");
    expect(await settle()).toEqual(successAt(BEST + 1));
    expect(await settle()).toEqual({ success: false, errorReason: "invalid_transaction_state", transaction: `${hashOf(BEST + 1)}-2`, network: NETWORK });
    expect(methodCalls("author_submitExtrinsic")).toHaveLength(1);
  });
});
