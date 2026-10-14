// The Polkadot profile's rule 5 (x402/exact/polkadot/lcp-assets-remark), as a facilitator's /verify and /settle.
// Expected values come from the profile's rules, x402's facilitator answers and its `exact` family ("A consumed
// primitive MUST produce a settlement failure, never a success"), and the lcp vectors (V2's call, V3's extrinsic and
// hash, V4's remark hash). The node is a local JSON-RPC stub: its metadata answers are
// Polkadot Asset Hub's live answers (fixtures/polkadot-asset-hub-2005000.json.gz); its events are SCALE bytes written
// here from the SDK's event layouts, and the test decodes them with the live metadata before using them. Every wait the
// facilitator makes runs on a clock the test moves (support.ts's `controlledClock`): a settle's wait ends when the test
// moves the clock to its end, never because the machine is slow.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ApiPromise } from "@polkadot/api";
import { exactPolkadotRemark } from "@integraledger/lcp/polkadot";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeError } from "../src/http.js";
import { serveProfileFacilitator } from "../src/index.js";
import {
  controlledClock,
  fixture,
  freePort,
  freshDatabase,
  gate,
  post,
  reaches,
  resumeLate,
  stub,
  until,
  type Call,
  type Clock,
  type Stub,
} from "./support.js";

vi.mock("../src/http.js", async (original) => {
  const support = await import("./support.js");
  return support.lateResume(support.countingSleep(await original<typeof import("../src/http.js")>()));
});

const NETWORK = "polkadot:68d56f15f85d3136970ec16946040bc1";
/** SHA-256("abc"), FIPS 180-2's first example: the H of the lcp vectors. */
const H = "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
// The lcp vectors' V2 and V3.
const CALL_V2 =
  "0x2802083209e51400d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d419c000735016c63703a7368613235363a307862613738313662663866303163666561343134313430646535646165323232336230303336316133393631373761396362343130666636316632303031356164";
const XT_V3 =
  "0x91038400f0a9102f0c58b6b1616671d59b86bfe96ab7211ce9f3eec1a3f6b43e24cc957e00f89553773fab874dbdeb508f55b2e87ec93fc489a4ab8b65bf47898ca18824669391a63ca8dbf3de605b18c531ed224c0fdbaebbaa0a7ecd7ece6acf9c3bd400a50200000000" +
  CALL_V2.slice(2);
const HASH_V3 = "0xffdc62b15bc3b766b9915bebe37e6282aa5ea4344e32b495f464d4fa7557e6ab";
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
/** V3's era is period 64 from block 21,054,314; the stub's best block is inside it. */
const BEST = 21_054_320;
const BEST_HASH = `0x${"bb".repeat(32)}`;
const BLOCK_HASH = `0x${"aa".repeat(32)}`;
/** `Ok(ValidTransaction { priority: 0, requires: [], provides: [], longevity: 64, propagate: true })` */
const VALID = `0x00${"00".repeat(8)}0000${"40"}${"00".repeat(7)}01`;
/** `Err(Invalid(BadProof))`, the answer the lcp vectors' V3 records for a flipped signature bit. */
const BAD_PROOF = "0x010004";
const FINALIZED_HASH = `0x${"cc".repeat(32)}`;
const EVENTS_KEY = "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7";

const init = (fixture("polkadot-asset-hub-2005000.json.gz") as { calls: { method: string; params: unknown[]; result: unknown }[] }).calls;

function u32le(n: number): string {
  return Buffer.from(Uint32Array.of(n).buffer).toString("hex");
}

/** One EventRecord: phase ApplyExtrinsic(index), the event's pallet and variant indices, its data, no topics. */
function record(index: number, pallet: number, variant: number, data: string): string {
  return `00${u32le(index)}${pallet.toString(16).padStart(2, "0")}${variant.toString(16).padStart(2, "0")}${data}00`;
}

const TRANSFERRED = (asset: number) =>
  record(2, 50, 2, `${u32le(asset)}${SIGNER}${ALICE}${"1027"}${"00".repeat(14)}`);
const REMARKED = record(2, 0, 5, `${SIGNER}${REMARK_HASH}`);
const SUCCESS = record(2, 0, 0, "00000000");
const SUCCESS_AT_1 = record(1, 0, 0, "00000000");

function events(...records: string[]): string {
  return `0x${(records.length << 2).toString(16).padStart(2, "0")}${records.join("")}`;
}

interface Chain {
  /** The best block's hash, as `chain_getBlockHash` gives it; BEST_HASH when not given. */
  best?: string;
  /** Whether block BEST + 1 holds V3; it does unless this says otherwise. */
  included?: () => boolean;
  validity?: string;
  events?: string;
  submitError?: { code: number; message: string; data?: string };
  /** The finalized head's height; the node gives none when this is not set. */
  finalized?: () => number;
  /** When the node stops listening, given the calls it has received (support.ts's `stub`). */
  leaves?: (calls: readonly Call[]) => boolean;
  /** Awaited before the node answers a call: the test holds the answer until what it waits for has happened. */
  hold?: (method: string, params: unknown[]) => Promise<void> | void;
  /** The node's JSON-RPC error for a call it refuses; every other call is answered as above. */
  refuse?: (method: string, params: unknown[]) => { code: number; message: string } | undefined;
}

let clock: Clock & { restore(): void };
let db: Awaited<ReturnType<typeof freshDatabase>>;
let node: Stub;
let base: string;
/** Closes the facilitator the current test started; unset once called, so a test that starts none closes nothing. */
let closeFacilitator: (() => Promise<void>) | undefined;
/** What the facilitator gave its operator log: each entry, with its cause. */
let entries: { entry: Record<string, unknown>; cause: unknown }[] = [];

async function start(chain: Chain = {}, network: string = NETWORK, settleWaitMs = 3_000): Promise<void> {
  node = await stub(async (_path, body) => {
    const { id, method, params } = body as { id: number; method: string; params: unknown[] };
    const answer = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    await chain.hold?.(method, params);
    const refused = chain.refuse?.(method, params);
    if (refused !== undefined) return { jsonrpc: "2.0", id, error: refused };
    const known = init.find((c) => c.method === method && JSON.stringify(c.params) === JSON.stringify(params));
    if (known !== undefined) return answer(known.result);
    const p = JSON.stringify(params);
    if (method === "chain_getBlockHash" && p === "[]") return answer(chain.best ?? BEST_HASH);
    if (method === "chain_getFinalizedHead" && chain.finalized) return answer(FINALIZED_HASH);
    if (method === "chain_getHeader" && p === JSON.stringify([FINALIZED_HASH]) && chain.finalized) {
      return answer({ number: `0x${chain.finalized().toString(16)}` });
    }
    if (method === "chain_getHeader" && p === JSON.stringify([BEST_HASH])) return answer({ number: `0x${BEST.toString(16)}` });
    if (method === "state_call") return answer(chain.validity ?? VALID);
    if (method === "author_submitExtrinsic") {
      return chain.submitError ? { jsonrpc: "2.0", id, error: chain.submitError } : answer(HASH_V3);
    }
    if (method === "chain_getHeader" && p === "[]") return answer({ number: `0x${(BEST + 1).toString(16)}` });
    if (method === "chain_getBlockHash" && p === JSON.stringify([BEST + 1])) return answer(BLOCK_HASH);
    if (method === "chain_getBlockHash" && typeof params[0] === "number") {
      return answer(`0x${params[0].toString(16).padStart(64, "0")}`);
    }
    if (method === "chain_getBlock" && p === JSON.stringify([BLOCK_HASH])) {
      const xts = ["0x280402000b", "0x1004", ...((chain.included?.() ?? true) ? [XT_V3] : [])];
      return answer({ block: { header: {}, extrinsics: xts } });
    }
    if (method === "chain_getBlock") return answer({ block: { header: {}, extrinsics: ["0x280402000b"] } });
    if (method === "state_getStorage" && p === JSON.stringify([EVENTS_KEY, BLOCK_HASH])) {
      return answer(chain.events ?? events(TRANSFERRED(1337), REMARKED, SUCCESS));
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `no stub for ${method} ${p}` } };
  }, chain.leaves);
  const port = await freePort();
  const f = await serveProfileFacilitator({
    listen: `127.0.0.1:${port}`,
    polkadot: [{ network: network as typeof NETWORK, rpc: node.url }],
    store: { url: db.url },
    settleWaitMs: clock.settleWait(settleWaitMs),
    operatorLog: (entry, cause) => entries.push({ entry, cause }),
  });
  closeFacilitator = f.close;
  base = `http://127.0.0.1:${port}`;
}

/** The calls the node has received for `method`, or for validate_transaction. */
const calls = (method: string) => node.calls.map((c) => c.body as { method: string; params: unknown[] }).filter((b) => b.method === method);
const isValidation = (method: string, params: unknown[]) =>
  method === "state_call" && params[0] === "TaggedTransactionQueue_validate_transaction";
const validations = () => calls("state_call").filter((b) => isValidation(b.method, b.params)).length;

/** A /settle's answer, waking its poll whenever it sleeps; a wait that ends pending ends within settleWaitMs. */
async function settle(sent = body()): Promise<unknown> {
  const [res] = await clock.answered([post(`${base}/settle`, sent)]);
  return res!.json;
}

function body(extrinsic = XT_V3, call = CALL_V2, requirements: Record<string, unknown> = O_P) {
  return {
    x402Version: 2,
    paymentPayload: { x402Version: 2, accepted: O_P, payload: { extrinsic, call } },
    paymentRequirements: requirements,
  };
}

beforeEach(async () => {
  clock = controlledClock();
  entries = [];
  db = await freshDatabase();
});

afterEach(async () => {
  clock.restore();
  const close = closeFacilitator;
  closeFacilitator = undefined;
  await close?.();
  await node?.close();
  await db.drop();
}, 60_000);

describe("the test's event bytes", () => {
  let api: ApiPromise;
  beforeAll(async () => {
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
    api = await ApiPromise.create({ provider: provider as never, noInitWarn: true, initWasm: false });
  });
  afterAll(async () => {
    await api.disconnect();
  });

  it("decode, with the live metadata, as the events they are named for", () => {
    const decoded = api.createType("Vec<EventRecord>", events(TRANSFERRED(1337), REMARKED, SUCCESS)) as unknown as {
      phase: { asApplyExtrinsic: { toNumber(): number } };
      event: { section: string; method: string; data: { toString(): string }[] };
    }[];
    expect(decoded.map((r) => [r.phase.asApplyExtrinsic.toNumber(), r.event.section, r.event.method])).toEqual([
      [2, "assets", "Transferred"],
      [2, "system", "Remarked"],
      [2, "system", "ExtrinsicSuccess"],
    ]);
    expect(decoded[0]!.event.data.map((d) => d.toString())).toEqual([
      "1337",
      PAYER,
      "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
      "10000",
    ]);
    expect(decoded[1]!.event.data[1]!.toString()).toBe(`0x${REMARK_HASH}`);
    expect(api.query["system"]!["events"]!.key()).toBe(EVENTS_KEY);
  });
});

describe("GET /supported", () => {
  it("lists the Polkadot network with the profile's method", async () => {
    await start();
    expect(await (await fetch(`${base}/supported`)).json()).toEqual({
      kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK, extra: { assetTransferMethod: "lcp-assets-remark" } }],
      extensions: [],
      signers: {},
    });
  });
});

describe("/verify", () => {
  it("accepts V3's extrinsic when validate_transaction answers Ok", async () => {
    await start();
    expect((await post(`${base}/verify`, body())).json).toEqual({ isValid: true, payer: PAYER });
  });

  it("refuses it when payload.call is one byte different", async () => {
    await start();
    const call = `${CALL_V2.slice(0, -2)}${CALL_V2.endsWith("64") ? "65" : "64"}`;
    expect((await post(`${base}/verify`, body(XT_V3, call))).json).toEqual({ isValid: false, invalidReason: "invalid_payload" });
  });
});

describe("a remark whose hash digits are upper case", () => {
  // The profile's rule 3: R is the 77 ASCII bytes `lcp:sha256:` followed by H, which its rule 1 writes as `0x` and
  // lowercase hex. System.Remarked carries the BLAKE2b-256 of the remark's bytes as signed, so R must be exactly
  // utf8(toLcpString(H)).
  const lower = Buffer.from(`lcp:sha256:${H}`).toString("hex");
  const upper = Buffer.from(`lcp:sha256:0x${H.slice(2).toUpperCase()}`).toString("hex");
  const xt = XT_V3.replace(lower, upper);
  const call = CALL_V2.replace(lower, upper);
  // @integraledger/lcp 0.2.0, docs/reference/refusals.md: "`polkadot/remark-not-lcp`: The Polkadot remark is not
  // exactly an ATR hash's LCP string form with lowercase hex, byte for byte."
  const REMARK_NOT_LCP = "polkadot/remark-not-lcp";

  it("is the lcp vectors' V3 refusal row for that case, with the refusal refusals.md names", () => {
    const lcpDir = dirname(dirname(createRequire(import.meta.url).resolve("@integraledger/lcp")));
    const V = JSON.parse(readFileSync(join(lcpDir, "vectors", "x402-exact-polkadot-lcp-assets-remark.json"), "utf8")) as {
      V3: { refusals: { case: string; extrinsic: string; call: string; expect: string }[] };
    };
    const row = V.V3.refusals.find((r) => r.case === "a remark whose hash digits are upper case");
    expect(xt).not.toBe(XT_V3);
    expect(row).toMatchObject({ extrinsic: xt, call, expect: REMARK_NOT_LCP });
  });

  it("is refused by lcp's bound as polkadot/remark-not-lcp", async () => {
    const presented = { x402Version: 2, accepted: O_P, payload: { extrinsic: xt, call } };
    expect(await exactPolkadotRemark.bound(presented as never)).toEqual({ refused: true, code: REMARK_NOT_LCP });
  });

  it("is refused at /verify as invalid_payload, and /settle asks the node nothing and stores nothing", async () => {
    await start();
    expect((await post(`${base}/verify`, body(xt, call))).json).toEqual({ isValid: false, invalidReason: "invalid_payload" });
    expect((await post(`${base}/settle`, body(xt, call))).json).toEqual({
      success: false,
      errorReason: "invalid_payload",
      transaction: "",
      network: NETWORK,
    });
    expect(node.calls).toEqual([]);
    const rows = await db.pool.query("SELECT id FROM settlement");
    expect(rows.rows).toEqual([]);
  });
});

describe("/verify, further", () => {
  it("asks validate_transaction at the best block with source External, the extrinsic, and the block hash", async () => {
    await start();
    await post(`${base}/verify`, body());
    const call = node.calls.map((c) => c.body as { method: string; params: unknown[] }).find((b) => b.method === "state_call" && b.params[0] === "TaggedTransactionQueue_validate_transaction");
    expect(call?.params).toEqual(["TaggedTransactionQueue_validate_transaction", `0x02${XT_V3.slice(2)}${BEST_HASH.slice(2)}`, BEST_HASH]);
  });

  it("refuses an extrinsic the node's validation refuses, as invalid_transaction", async () => {
    await start({ validity: BAD_PROOF });
    expect((await post(`${base}/verify`, body())).json).toEqual({
      isValid: false,
      invalidReason: "invalid_transaction",
      payer: PAYER,
    });
  });

  it("refuses requirements naming another transfer method, or none, as invalid_payment_requirements", async () => {
    // The profile's scope: extra.assetTransferMethod "lcp-assets-remark" (required).
    await start();
    for (const change of [{ extra: { assetTransferMethod: "lcp-assets" } }, { extra: {} }]) {
      expect((await post(`${base}/verify`, body(XT_V3, CALL_V2, { ...O_P, ...change }))).json).toEqual({
        isValid: false,
        invalidReason: "invalid_payment_requirements",
      });
    }
  });

  it("refuses requirements whose asset, payTo or amount differ from the call", async () => {
    await start();
    for (const change of [{ asset: "1984" }, { payTo: "16SYiSu5tWgdV4sWiaxir7GYEiFfTc9GYnRd34PDGCUMgkmP" }, { amount: "10001" }]) {
      expect((await post(`${base}/verify`, body(XT_V3, CALL_V2, { ...O_P, ...change }))).json).toEqual({
        isValid: false,
        invalidReason: "invalid_payload",
      });
    }
  });

  it("refuses an immortal era", async () => {
    await start();
    // V3 with its era bytes a502, 101 bytes in (after the prefix, 0x84, the address and the signature), replaced by
    // 00 (immortal): one byte shorter, so the length prefix is 0x8d03.
    expect(XT_V3.slice(204, 208)).toBe("a502");
    const immortal = `0x8d03${XT_V3.slice(6, 204)}00${XT_V3.slice(208)}`;
    expect((await post(`${base}/verify`, body(immortal))).json).toEqual({ isValid: false, invalidReason: "invalid_payload" });
  });

  it("serves no network whose node answers another genesis", async () => {
    await start({}, "polkadot:67f9723393ef76214df0118c34bbbd3d");
    const res = await post(`${base}/verify`, body(XT_V3, CALL_V2, { ...O_P, network: "polkadot:67f9723393ef76214df0118c34bbbd3d" }));
    expect(res.json).toEqual({ isValid: false, invalidReason: "unexpected_verify_error" });
  });
});

describe("/settle", () => {
  it("answers success once the extrinsic is in a block with ExtrinsicSuccess, Remarked and Transferred", async () => {
    await start();
    expect((await post(`${base}/settle`, body())).json).toEqual({
      success: true,
      transaction: `${BLOCK_HASH}-2`,
      network: NETWORK,
      payer: PAYER,
    });
  });

  it("two concurrent settles submit once, and exactly one of them answers success", async () => {
    // The node holds each validation until both settles have asked for it, so both have read no stored answer before
    // either claims; and it holds each read of the events of the block holding the extrinsic until both settles have
    // made it, so both find the success on chain before either stores it.
    const eventReads = () => calls("state_getStorage").filter((b) => JSON.stringify(b.params) === JSON.stringify([EVENTS_KEY, BLOCK_HASH]));
    await start({
      hold: async (method, params) => {
        if (isValidation(method, params)) await until(() => validations() === 2);
        if (method === "state_getStorage" && JSON.stringify(params) === JSON.stringify([EVENTS_KEY, BLOCK_HASH])) {
          await until(() => eventReads().length === 2);
        }
      },
    });
    const [a, b] = await Promise.all([post(`${base}/settle`, body()), post(`${base}/settle`, body())]);
    expect(validations()).toBe(2);
    expect(eventReads()).toHaveLength(2);
    const submits = calls("author_submitExtrinsic");
    expect(submits).toHaveLength(1);
    const success = { success: true, transaction: `${BLOCK_HASH}-2`, network: NETWORK, payer: PAYER };
    const consumed = { success: false, errorReason: "invalid_transaction_state", transaction: `${BLOCK_HASH}-2`, network: NETWORK };
    expect([a.json, b.json]).toEqual(expect.arrayContaining([success, consumed]));
  });

  it("a Transferred event of another asset, read above the finalized head, stays settlement_pending", async () => {
    await start({ events: events(TRANSFERRED(1984), REMARKED, SUCCESS), finalized: () => BEST - 2 }, NETWORK, 1_500);
    expect(await settle()).toEqual({
      success: false,
      errorReason: "settlement_pending",
      transaction: HASH_V3,
      network: NETWORK,
    });
  });

  // A submission the pool refuses as one it has already seen (Substrate's author RPC: 1013 already imported, 1012
  // temporarily banned, 1010 with an outdated nonce) is a consumed payment: the profile's replay primitive is the payer's
  // account nonce, and x402's exact family: "A consumed primitive MUST produce a settlement failure, never a success."
  // The answer is invalid_transaction_state with the extrinsic's hash, stored final; no block is read for it.
  for (const [what, submitError] of [
    ["already imported", { code: 1013, message: "Transaction Already Imported", data: "The transaction is already in the pool." }],
    ["temporarily banned", { code: 1012, message: "Transaction is temporarily banned" }],
    ["outdated, its nonce spent", { code: 1010, message: "Invalid Transaction", data: "Transaction is outdated" }],
  ] as const) {
    it(`an extrinsic the node refuses as ${what} answers invalid_transaction_state with its hash, stored final`, async () => {
      await start({ submitError });
      const consumed = { success: false, errorReason: "invalid_transaction_state", transaction: HASH_V3, network: NETWORK };
      expect((await post(`${base}/settle`, body())).json).toEqual(consumed);
      expect(node.calls.filter((c) => (c.body as { method: string }).method === "chain_getBlock")).toHaveLength(0);
      const stored = await db.pool.query("SELECT answer FROM settlement WHERE network = $1 AND id = $2", [NETWORK, HASH_V3]);
      expect(stored.rows[0]?.answer).toEqual(consumed);
      expect((await post(`${base}/settle`, body())).json).toEqual(consumed);
      const submits = node.calls.filter((c) => (c.body as { method: string }).method === "author_submitExtrinsic");
      expect(submits).toHaveLength(1);
    });
  }

  it("a Transferred event of another asset is never a success, and is final once its block is", async () => {
    // The finalized head is below the best block when the extrinsic is validated, and at its block afterwards.
    await start({
      events: events(TRANSFERRED(1984), REMARKED, SUCCESS),
      finalized: () =>
        node.calls.some((c) => (c.body as { method: string }).method === "author_submitExtrinsic") ? BEST + 1 : BEST - 2,
    });
    expect((await post(`${base}/settle`, body())).json).toEqual({
      success: false,
      errorReason: "invalid_transaction_state",
      transaction: `${BLOCK_HASH}-2`,
      network: NETWORK,
    });
  });

  it("a repeated /settle whose stored answer is settlement_pending scans the era again, submits nothing more, and stores the final answer; a later repeat of the consumed payment fails", async () => {
    let landed = false;
    await start({ included: () => landed }, NETWORK, 1_500);
    expect(await settle()).toEqual({
      success: false,
      errorReason: "settlement_pending",
      transaction: HASH_V3,
      network: NETWORK,
    });
    landed = true;
    expect((await post(`${base}/settle`, body())).json).toEqual({
      success: true,
      transaction: `${BLOCK_HASH}-2`,
      network: NETWORK,
      payer: PAYER,
    });
    expect((await post(`${base}/settle`, body())).json).toEqual({
      success: false,
      errorReason: "invalid_transaction_state",
      transaction: `${BLOCK_HASH}-2`,
      network: NETWORK,
    });
    const submits = node.calls.filter((c) => (c.body as { method: string }).method === "author_submitExtrinsic");
    expect(submits).toHaveLength(1);
  });

  it("a settle whose wait ends pending, with the node's head read unanswered, stores its pending answer before it answers", async () => {
    // The node holds the head read (`chain_getHeader` with no block), the scan's first read after the submission. Its
    // bound is the end of the wait for the chain, which keeps a quarter of a 1,500 ms wait for storing the answer:
    // 1,125 ms. Once the clock is there the node answers, with the extrinsic in the block after the best block: too
    // late, so the answer is settlement_pending, stored and given with the clock at 1,125 ms.
    let landed = false;
    const head = gate();
    await start(
      {
        included: () => landed,
        hold: async (method, params) => {
          if (method === "chain_getHeader" && params.length === 0) await head.opened;
        },
      },
      NETWORK,
      1_500,
    );
    const pendingAnswer = { success: false, errorReason: "settlement_pending", transaction: HASH_V3, network: NETWORK };
    const answer = post(`${base}/settle`, body());
    await reaches(answer, () => calls("chain_getHeader").some((b) => b.params.length === 0));
    await clock.advanceTo(1_125);
    landed = true;
    head.open();
    expect((await answer).json).toEqual(pendingAnswer);
    expect(clock.elapsed).toBe(1_125);
    const stored = await db.pool.query("SELECT answer FROM settlement WHERE network = $1 AND id = $2", [NETWORK, HASH_V3]);
    expect(stored.rows[0]?.answer).toEqual(pendingAnswer);
    expect(entries.filter((e) => e.entry["event"] === "answer-not-stored")).toEqual([]);
  });

  it("events of another extrinsic in the block are not this one's", async () => {
    await start({ events: events(SUCCESS_AT_1, REMARKED, TRANSFERRED(1337)) });
    expect(await settle()).toMatchObject({ success: false });
  });

  it("a claimed id whose answer was never written is read again from the chain, submitting nothing", async () => {
    // What a settle leaves when it stops between its claim and its answer: the row, and the first block after the best
    // block at which the extrinsic was validated.
    await start({}, NETWORK, 1_500);
    await db.pool.query("INSERT INTO settlement (network, id, answer, until, since) VALUES ($1, $2, NULL, $3, $4)", [
      NETWORK,
      HASH_V3,
      new Date(Date.now() + 600_000).toISOString(),
      BEST + 1,
    ]);
    expect((await post(`${base}/settle`, body())).json).toEqual({
      success: true,
      transaction: `${BLOCK_HASH}-2`,
      network: NETWORK,
      payer: PAYER,
    });
    const submits = node.calls.filter((c) => (c.body as { method: string }).method === "author_submitExtrinsic");
    expect(submits).toHaveLength(0);
  });

  /**
   * A /settle of V3 with settleWaitMs 1,500 ms, whose wait for the chain ends at 1,125 ms (it keeps a quarter of the
   * wait for storing the answer). The node holds the head read (`chain_getHeader` with no block, the scan's first read
   * after the finalized head) until the clock is at `at` ms, then answers with the extrinsic in the block after the best
   * block. With `claimed`, the store holds what a settle leaves when it stops between its claim and its answer.
   */
  async function headAnsweredAt(at: number, claimed: boolean): Promise<unknown> {
    let landed = false;
    const head = gate();
    await start(
      {
        included: () => landed,
        hold: async (method, params) => {
          if (method === "chain_getHeader" && params.length === 0) await head.opened;
        },
      },
      NETWORK,
      1_500,
    );
    if (claimed) {
      await db.pool.query("INSERT INTO settlement (network, id, answer, until, since) VALUES ($1, $2, NULL, $3, $4)", [
        NETWORK,
        HASH_V3,
        new Date(Date.now() + 600_000).toISOString(),
        BEST + 1,
      ]);
    }
    const answer = post(`${base}/settle`, body());
    await reaches(answer, () => calls("chain_getHeader").some((b) => b.params.length === 0));
    await clock.advanceTo(at);
    landed = true;
    head.open();
    return (await answer).json;
  }

  it("a settle whose head read the node answers 1 ms before its wait for the chain ends reads the block, and gives the success", async () => {
    expect(await headAnsweredAt(1_124, false)).toEqual({ success: true, transaction: `${BLOCK_HASH}-2`, network: NETWORK, payer: PAYER });
    expect(calls("author_submitExtrinsic")).toHaveLength(1);
  });

  it("a claimed id whose head read the node answers 1 ms before the wait for the chain ends gives the success, submitting nothing", async () => {
    expect(await headAnsweredAt(1_124, true)).toEqual({ success: true, transaction: `${BLOCK_HASH}-2`, network: NETWORK, payer: PAYER });
    expect(calls("author_submitExtrinsic")).toHaveLength(0);
  });

  it("a claimed id whose head read the node answers once the wait for the chain has ended stores settlement_pending and gives it, submitting nothing", async () => {
    const pendingAnswer = { success: false, errorReason: "settlement_pending", transaction: HASH_V3, network: NETWORK };
    expect(await headAnsweredAt(1_125, true)).toEqual(pendingAnswer);
    const stored = await db.pool.query("SELECT answer FROM settlement WHERE network = $1 AND id = $2", [NETWORK, HASH_V3]);
    expect(stored.rows).toEqual([{ answer: pendingAnswer }]);
    expect(calls("author_submitExtrinsic")).toHaveLength(0);
  });

  it("waits for the node's validation until settleWaitMs, and gives the node's answer when it comes before then", async () => {
    // The node holds the validation; the clock moves to 1 ms before settleWaitMs (1,000 ms), and the node then refuses
    // the extrinsic: the settle is waiting for that answer, and gives the node's refusal.
    const refuse = gate();
    await start(
      {
        validity: BAD_PROOF,
        hold: async (method, params) => {
          if (isValidation(method, params)) await refuse.opened;
        },
      },
      NETWORK,
      1_000,
    );
    const answer = post(`${base}/settle`, body());
    await reaches(answer, () => validations() === 1);
    await clock.advanceTo(999);
    refuse.open();
    expect((await answer).json).toEqual({ success: false, errorReason: "invalid_transaction", transaction: "", network: NETWORK });
    expect(calls("author_submitExtrinsic")).toHaveLength(0);
  });

  it("waits at most settleWaitMs when the node's validation does not answer, and submits nothing", async () => {
    // /settle waits at most settleWaitMs, and a node timeout before anything is submitted gives unexpected_settle_error
    // with an empty transaction (x402: nothing was broadcast). The node holds the validation; the clock moves to
    // settleWaitMs (1,000 ms), and the node's refusal then comes too late to be the answer.
    const refuse = gate();
    await start(
      {
        validity: BAD_PROOF,
        hold: async (method, params) => {
          if (isValidation(method, params)) await refuse.opened;
        },
      },
      NETWORK,
      1_000,
    );
    const answer = post(`${base}/settle`, body());
    await reaches(answer, () => validations() === 1);
    await clock.advanceTo(1_000);
    refuse.open();
    expect((await answer).json).toEqual({ success: false, errorReason: "unexpected_settle_error", transaction: "", network: NETWORK });
    expect(clock.elapsed).toBe(1_000);
    expect(calls("author_submitExtrinsic")).toHaveLength(0);
  });

  it("an extrinsic the node refuses at submission gives unexpected_settle_error with no transaction, stored final: a repeat gets it and submits nothing", async () => {
    // A refused submission keeps its row with the stored answer, so the payment is submitted at most once: every answer
    // to a repeated /settle for the same id is the stored one.
    await start({ submitError: { code: 1010, message: "Invalid Transaction", data: "Inability to pay some fees (e.g. account balance too low)" } });
    const refused = { success: false, errorReason: "unexpected_settle_error", transaction: "", network: NETWORK };
    expect((await post(`${base}/settle`, body())).json).toEqual(refused);
    const stored = await db.pool.query("SELECT answer FROM settlement WHERE network = $1 AND id = $2", [NETWORK, HASH_V3]);
    expect(stored.rows[0]?.answer).toEqual(refused);
    expect((await post(`${base}/settle`, body())).json).toEqual(refused);
    const submits = node.calls.filter((c) => (c.body as { method: string }).method === "author_submitExtrinsic");
    expect(submits).toHaveLength(1);
  });

  it("a submission refused at connect gives unexpected_settle_error with no transaction, stored final: a repeat once the node listens again gets it and submits nothing", async () => {
    // x402: `transaction` is "empty string if no transaction was broadcast", and a connection the node refuses at
    // connect carries no byte of the submission to it. The node stops listening once it has received the validation,
    // the last call /settle makes before the submission. Every answer to a repeated /settle for the same id is the
    // stored one, so the claim keeps that answer, and a repeat gets it even once the node listens again.
    const validation = (c: Call) =>
      (c.body as { params: unknown[] }).params[0] === "TaggedTransactionQueue_validate_transaction";
    await start({ leaves: (calls) => calls.some(validation) });
    const refused = { success: false, errorReason: "unexpected_settle_error", transaction: "", network: NETWORK };
    const submissions = () => node.calls.filter((c) => (c.body as { method: string }).method === "author_submitExtrinsic");
    expect((await post(`${base}/settle`, body())).json).toEqual(refused);
    expect(submissions()).toHaveLength(0);
    const stored = await db.pool.query("SELECT answer FROM settlement WHERE network = $1 AND id = $2", [NETWORK, HASH_V3]);
    expect(stored.rows[0]?.answer).toEqual(refused);
    await node.listen();
    expect((await post(`${base}/settle`, body())).json).toEqual(refused);
    expect(submissions()).toHaveLength(0);
  });

  it("two concurrent settles of an extrinsic the node refuses at submission submit once, and both give the stored refusal", async () => {
    // The node holds each validation until both settles have asked for it, so both have read no stored answer before
    // either claims. It holds the submission until the settle that lost the claim has begun its scan, so that settle
    // has read the row before the refusal is stored, and reads it again, on its poll, until it is; a second submission
    // is let through, and counted.
    let scanning = false;
    await start(
      {
        included: () => false,
        submitError: { code: 1010, message: "Invalid Transaction", data: "Inability to pay some fees (e.g. account balance too low)" },
        hold: async (method, params) => {
          if (isValidation(method, params)) await until(() => validations() === 2);
          if (method === "chain_getFinalizedHead" && validations() === 2) scanning = true;
          if (method === "author_submitExtrinsic") await until(() => scanning || calls(method).length > 1);
        },
      },
      NETWORK,
      5_000,
    );
    const refused = { success: false, errorReason: "unexpected_settle_error", transaction: "", network: NETWORK };
    const [a, b] = await clock.answered([post(`${base}/settle`, body()), post(`${base}/settle`, body())]);
    expect([a!.json, b!.json]).toEqual([refused, refused]);
    expect(calls("author_submitExtrinsic")).toHaveLength(1);
  });

  it("an extrinsic the node refuses at submission, whose answer cannot be stored, gives settlement_pending with its hash and keeps the claim", async () => {
    await start({ submitError: { code: 1010, message: "Invalid Transaction", data: "Inability to pay some fees (e.g. account balance too low)" } });
    await db.pool.query(`CREATE FUNCTION refuse_answer() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'answer refused'; END $$`);
    await db.pool.query("CREATE TRIGGER refuse_answer BEFORE UPDATE OF answer ON settlement FOR EACH ROW EXECUTE FUNCTION refuse_answer()");
    expect((await post(`${base}/settle`, body())).json).toEqual({
      success: false,
      errorReason: "settlement_pending",
      transaction: HASH_V3,
      network: NETWORK,
    });
    const rows = await db.pool.query("SELECT answer FROM settlement WHERE network = $1 AND id = $2", [NETWORK, HASH_V3]);
    expect(rows.rows).toEqual([{ answer: null }]);
  });
});

describe("the operator log", () => {
  // The operator gets the cause of every error the facilitator answers for, and each final answer the chain gives
  // that is not a success; the client's answer is x402's and carries nothing from it. The fields name the payment:
  // network, payer once the extrinsic is decoded, and the extrinsic's hash.
  const ABOUT = { network: NETWORK, payer: PAYER, transaction: HASH_V3 };
  const PENDING_V3 = { success: false, errorReason: "settlement_pending", transaction: HASH_V3, network: NETWORK };
  /** JSON-RPC 2.0's internal error (§5.1), as the node refuses a call with it. */
  const INTERNAL = { code: -32603, message: "Internal error" };
  const logged = (event: string) => entries.filter((e) => e.entry["event"] === event);
  /** The finalized head: below the best block when the extrinsic is validated, at its block once it is submitted. */
  const finalizedAfterSubmit = () => (calls("author_submitExtrinsic").length > 0 ? BEST + 1 : BEST - 2);

  it("a block read at finality whose events show another asset's transfer reaches the log as settlement-failed, with the events", async () => {
    // The events are the test's own bytes, as "the test's event bytes" decodes them with the live metadata.
    await start({ events: events(TRANSFERRED(1984), REMARKED, SUCCESS), finalized: finalizedAfterSubmit });
    expect((await post(`${base}/settle`, body())).json).toEqual({
      success: false,
      errorReason: "invalid_transaction_state",
      transaction: `${BLOCK_HASH}-2`,
      network: NETWORK,
    });
    expect(logged("settlement-failed").map((e) => e.entry)).toEqual([
      {
        event: "settlement-failed",
        ...ABOUT,
        transaction: `${BLOCK_HASH}-2`,
        events: ["assets.Transferred", "system.Remarked", "system.ExtrinsicSuccess"],
      },
    ]);
  });

  it("a node call that fails reaches the log with the payment's fields and the call, and the answer is unchanged", async () => {
    await start({ refuse: (method, params) => (isValidation(method, params) ? INTERNAL : undefined) });
    expect((await post(`${base}/verify`, body())).json).toEqual({
      isValid: false,
      invalidReason: "unexpected_verify_error",
      payer: PAYER,
    });
    expect(logged("node-call-failed").map((e) => e.entry)).toEqual([{ event: "node-call-failed", ...ABOUT, call: "state_call" }]);
    expect((logged("node-call-failed")[0]!.cause as Error).message).toBe(INTERNAL.message);
  });

  it("a store call that fails reaches the log with the network, the hash and the call, and the answer is pending with the hash", async () => {
    // The store is read before the extrinsic is decoded, so the entry names no payer.
    await start();
    await db.pool.query("ALTER TABLE settlement RENAME TO settlement_elsewhere");
    expect((await post(`${base}/settle`, body())).json).toEqual(PENDING_V3);
    expect(logged("store-call-failed").map((e) => e.entry)).toEqual([
      { event: "store-call-failed", network: NETWORK, transaction: HASH_V3, call: "read" },
    ]);
    expect((logged("store-call-failed")[0]!.cause as Error).message).toContain("settlement");
  });

  it("a block the node does not give, read at finality, reaches the log as block-unreadable with the block and the reason, and the answer is pending with the hash", async () => {
    await start({
      finalized: finalizedAfterSubmit,
      refuse: (method, params) => (method === "chain_getBlock" && params[0] === BLOCK_HASH ? INTERNAL : undefined),
    });
    expect(await settle()).toEqual(PENDING_V3);
    const unreadable = logged("block-unreadable");
    expect(unreadable.length).toBeGreaterThan(0);
    expect(unreadable[0]!.entry).toEqual({ event: "block-unreadable", ...ABOUT, block: BEST + 1, final: true, reason: INTERNAL.message });
    expect((unreadable[0]!.cause as Error).message).toBe(INTERNAL.message);
  });

  // An unexpected answer that no error caused has its entry too: a node answer the facilitator cannot read, and a
  // settle whose deadline passed.

  it("a node answer it cannot read reaches the log as the call that failed, its cause naming the part, and the answer is unchanged", async () => {
    // A block hash is 32 bytes (Substrate's H256); the best block hash this node gives is 31.
    await start({ best: `0x${"bb".repeat(31)}` });
    expect((await post(`${base}/verify`, body())).json).toEqual({
      isValid: false,
      invalidReason: "unexpected_verify_error",
      payer: PAYER,
    });
    expect(entries.map((e) => e.entry)).toEqual([{ event: "node-call-failed", ...ABOUT, call: "chain_getBlockHash" }]);
    const cause = entries[0]!.cause;
    expect(cause).toBeInstanceOf(NodeError);
    expect((cause as NodeError).code).toBe("malformed");
    expect((cause as NodeError).message).toBe("malformed: chain_getBlockHash: the block hash");
  });

  it("a settle whose deadline passes once the node's validation has answered reaches the log as settle-deadline-passed with the bound, and claims and submits nothing", async () => {
    // The validation's answer arrives within its bound, and the facilitator goes on with it once the clock is at
    // settleWaitMs (1,000 ms), as after time spent elsewhere: the deadline has passed before the claim.
    await start({ finalized: () => BEST - 2 }, NETWORK, 1_000);
    const validation = resumeLate((_url, sent) => {
      const { method, params } = sent as { method: string; params: unknown[] };
      return isValidation(method, params);
    });
    const answer = post(`${base}/settle`, body());
    await reaches(answer, validation.arrived);
    await clock.advanceTo(1_000);
    validation.resume();
    expect((await answer).json).toEqual({ success: false, errorReason: "unexpected_settle_error", transaction: "", network: NETWORK });
    expect(entries.map((e) => e.entry)).toEqual([
      { event: "settle-deadline-passed", ...ABOUT, before: "claim", settleWaitMs: 1_000 },
    ]);
    expect(entries[0]!.cause).toBeUndefined();
    expect((await db.pool.query("SELECT id FROM settlement")).rowCount).toBe(0);
    expect(calls("author_submitExtrinsic")).toHaveLength(0);
  });
});
