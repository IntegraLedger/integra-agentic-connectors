// The Casper profile's rule 5 (x402/exact/casper/lcp-runtime-arg), as a facilitator's /verify and /settle. The
// fixture's values come from outside the code: H is the SHA-256 of "abc", the FIPS 180-4 vector
// (printf 'abc' | sha256sum); the transaction hash stands in as the BLAKE2b-256 of "abc", the BLAKE2 vector
// (printf 'abc' | b2sum -l 256); the payer's key is RFC 8032 section 7.1 TEST 1, whose public key the first test
// checks; and the Ed25519 signature over that hash is the one @noble/curves writes for that key, checked against the
// value recorded below. The node is a local stub whose answers have Casper 2.0's JSON-RPC shapes.
import { ed25519 } from "@noble/curves/ed25519.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serveProfileFacilitator } from "../src/index.js";
import { freePort, freshDatabase, HANG, post, stub, type Stub } from "./support.js";

/** RFC 8032 section 7.1, TEST 1: the secret key, whose public key the first test checks. */
const RFC8032_TEST1_SECRET = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
/** RFC 8032 section 7.1, TEST 1: the public key for that secret key. */
const RFC8032_TEST1_PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
/** `01` for ed25519, then the public key: the initiator's `PublicKey` and the answer's `payer`. */
const PAYER = `01${RFC8032_TEST1_PUBLIC}`;
/** SHA-256 of "abc" (FIPS 180-4), standing in for the ATR hash H. */
const H = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
/** BLAKE2b-256 of "abc" (the BLAKE2 vectors), standing in for the transaction hash the payer signs. */
const TX_HASH = "bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319";
/** Ed25519 over TX_HASH with the RFC 8032 TEST 1 key, as written by a standard implementation. */
const SIGNATURE_HEX =
  "ffb9744722e625f6bf6628a1fd9838b3cb3631d1ff1ffc2f989edf0778938bdde267e4846a2a9624b1794df8d8785386cb82e6ee577dabe956d61c8aa1dc7c0d";

const NETWORK = "casper:casper-test";
const CHAIN_NAME = "casper-test";
/** The wCSPR CEP-18 contract package hash on the test network, as the requirements name the asset. */
const WCSPR = "6d3dd9c63f4de7f1d45a76a9ff5f26e4c0b7f1e8bfae4e2c6bd0e9e2a7f1c3b5";
/** `00` for an account hash, then the payee's 32 bytes. */
const PAY_TO = "0011223344556677889900aabbccddeeff00112233445566778899aabbccddeeff";
const TIMESTAMP = "2026-09-27T12:00:00.000Z";
const NOW = Date.parse(TIMESTAMP);
const TTL_MS = 30 * 60 * 1000;

const O = {
  scheme: "exact",
  network: NETWORK,
  amount: "10000",
  asset: WCSPR,
  payTo: PAY_TO,
  maxTimeoutSeconds: 1_800,
  extra: { assetTransferMethod: "lcp-runtime-arg" },
};

/** A `U512` CLValue's bytes: one length byte, then the value little-endian. */
function u512(value: bigint): string {
  const out: number[] = [];
  let rest = value;
  while (rest > 0n) {
    out.push(Number(rest & 0xffn));
    rest >>= 8n;
  }
  return Buffer.from([out.length, ...out]).toString("hex");
}

function sign(hash: string, secret = RFC8032_TEST1_SECRET): string {
  const sig = ed25519.sign(Buffer.from(hash, "hex"), Buffer.from(secret, "hex"));
  return Buffer.from(sig).toString("hex");
}

interface Parts {
  /** `NATIVE` pays in motes; any other value is the CEP-18 package hash. */
  asset?: string;
  amount?: bigint;
  to?: string;
  /** The bytes of the `lcp_atr_hash` argument; the empty string leaves the argument out. */
  atrHash?: string;
  atrHashType?: unknown;
  chainName?: string;
  timestamp?: string;
  ttl?: string;
  hash?: string;
  approvals?: { signer: string; signature: string }[];
}

const NATIVE = "native";

/** A signed `Version1` transaction, as `account_put_transaction` takes it. */
function transaction(p: Parts = {}) {
  const asset = p.asset ?? WCSPR;
  const native = asset === NATIVE;
  const hash = p.hash ?? TX_HASH;
  const args: [string, { cl_type: unknown; bytes: string }][] = [
    [
      native ? "target" : "recipient",
      { cl_type: native ? "PublicKey" : "Key", bytes: (p.to ?? PAY_TO).toLowerCase() },
    ],
    ["amount", { cl_type: "U512", bytes: u512(p.amount ?? 10_000n) }],
  ];
  const atrHash = p.atrHash ?? H;
  if (atrHash !== "") args.push(["lcp_atr_hash", { cl_type: p.atrHashType ?? { ByteArray: 32 }, bytes: atrHash }]);
  return {
    Version1: {
      hash,
      payload: {
        initiator_addr: { PublicKey: PAYER },
        timestamp: p.timestamp ?? TIMESTAMP,
        ttl: p.ttl ?? "30m",
        chain_name: p.chainName ?? CHAIN_NAME,
        pricing_mode: { Fixed: { gas_price_tolerance: 1, additional_computation_factor: 0 } },
        fields: {
          args: { Named: args },
          target: native ? "Native" : { Stored: { id: { ByPackageHash: { addr: asset, version: null } }, runtime: "VmCasperV1" } },
          entry_point: native ? "Transfer" : { Custom: "transfer" },
          scheduling: "Standard",
        },
      },
      approvals: p.approvals ?? [{ signer: PAYER, signature: `01${sign(hash)}` }],
    },
  };
}

function body(tx: unknown, requirements: Record<string, unknown> = O) {
  return {
    x402Version: 2,
    paymentPayload: { x402Version: 2, accepted: O, payload: { transaction: tx } },
    paymentRequirements: requirements,
  };
}

/** A `speculative_exec` or `info_get_transaction` execution result: no error, or the error the test names. */
function executionResult(error: string | null) {
  return { Version2: { limit: "100000000", consumed: "82500000", error_message: error, payment: [] } };
}

interface Node {
  /** The answer to `speculative_exec`; the default is an execution without an error. */
  speculative?: unknown;
  /** How long the dry run takes to answer. */
  speculativeMs?: number;
  put?: unknown;
  /** Called before `account_put_transaction` answers. */
  onPut?: () => Promise<void>;
  info?: () => unknown;
}

/** `info_get_transaction` for a transaction executed at `blockHeight` with the given error. */
function info(error: string | null, blockHeight = 3_420_117) {
  return {
    api_version: "2.0.0",
    transaction: { Version1: transaction() },
    execution_info: { block_hash: `0x${"11".repeat(32)}`, block_height: blockHeight, execution_result: executionResult(error) },
  };
}

/** `info_get_transaction` for a transaction the node holds but has not executed. */
const NOT_EXECUTED = { api_version: "2.0.0", transaction: { Version1: transaction() }, execution_info: null };
/** The JSON-RPC error the node answers for a transaction it does not know. */
const UNKNOWN = { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "transaction not found" } };

let db: Awaited<ReturnType<typeof freshDatabase>>;
let node: Stub;
let base: string;
let closeFacilitator: () => Promise<void>;

async function start(n: Node = {}, settleWaitMs = 3_000): Promise<void> {
  node = await stub(async (_path, requestBody) => {
    const method = (requestBody as { method?: string } | undefined)?.method;
    if (method === "speculative_exec") {
      if (n.speculativeMs !== undefined) await new Promise((resolve) => setTimeout(resolve, n.speculativeMs));
      return n.speculative ?? { jsonrpc: "2.0", id: 1, result: { api_version: "2.0.0", execution_result: executionResult(null) } };
    }
    if (method === "account_put_transaction") {
      await n.onPut?.();
      return n.put ?? { jsonrpc: "2.0", id: 1, result: { api_version: "2.0.0", transaction_hash: { Version1: TX_HASH } } };
    }
    if (method === "info_get_transaction") {
      const answer = n.info ? n.info() : info(null);
      return answer === HANG || (answer as { jsonrpc?: string }).jsonrpc === "2.0"
        ? answer
        : { jsonrpc: "2.0", id: 1, result: answer };
    }
    return { jsonrpc: "2.0", id: 1, result: {} };
  });
  const port = await freePort();
  const f = await serveProfileFacilitator({
    listen: `127.0.0.1:${port}`,
    casper: [{ network: NETWORK, rpc: node.url }],
    store: { url: db.url },
    settleWaitMs,
  });
  closeFacilitator = f.close;
  base = `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  db = await freshDatabase();
});

afterEach(async () => {
  await closeFacilitator?.();
  await node?.close();
  await db.drop();
  vi.useRealTimers();
}, 60_000);

describe("the fixture's values come from published vectors", () => {
  it("the payer's key is RFC 8032 TEST 1, and the signature over the hash is the recorded one", () => {
    const pub = Buffer.from(ed25519.getPublicKey(Buffer.from(RFC8032_TEST1_SECRET, "hex"))).toString("hex");
    expect(pub).toBe(RFC8032_TEST1_PUBLIC);
    expect(sign(TX_HASH)).toBe(SIGNATURE_HEX);
    expect(ed25519.verify(Buffer.from(SIGNATURE_HEX, "hex"), Buffer.from(TX_HASH, "hex"), Buffer.from(pub, "hex"))).toBe(true);
  });

  it("H is 32 bytes and is the SHA-256 of \"abc\"", () => {
    expect(H).toHaveLength(64);
    expect(H).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("a U512 CLValue is a length byte then the value little-endian: 10000 is 0x2710", () => {
    expect(u512(10_000n)).toBe("021027");
    expect(u512(0n)).toBe("00");
    expect(u512(255n)).toBe("01ff");
  });
});

describe("GET /supported", () => {
  it("lists one kind per configured Casper network", async () => {
    await start();
    const res = await fetch(`${base}/supported`);
    expect(await res.json()).toEqual({
      kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK, extra: { assetTransferMethod: "lcp-runtime-arg" } }],
      extensions: [],
      signers: {},
    });
  });
});

describe("/verify", () => {
  it("accepts the CEP-18 transfer carrying H, with the initiator as payer", async () => {
    await start();
    const res = await post(`${base}/verify`, body(transaction()));
    expect(res.json).toEqual({ isValid: true, payer: PAYER });
  });

  it("accepts a native CSPR transfer in motes, whose amount is never rescaled", async () => {
    await start();
    // Native CSPR has 9 decimals; the amount is the motes the argument carries, and the facilitator converts nothing.
    const requirements = { ...O, asset: "native", amount: "2500000000" };
    const tx = transaction({ asset: NATIVE, amount: 2_500_000_000n });
    expect((await post(`${base}/verify`, body(tx, requirements))).json).toEqual({ isValid: true, payer: PAYER });
    // A wCSPR requirement for the same figure is refused by the CEP-18 path: nothing reads a decimal constant.
    expect((await post(`${base}/verify`, body(tx, { ...O, amount: "2500000000" }))).json).toEqual({
      isValid: false,
      invalidReason: "invalid_payload",
    });
  });

  it("refuses a transaction whose lcp_atr_hash is another hash, is absent, or is not a 32-byte array", async () => {
    await start();
    const wrongH = `${H.slice(0, 62)}ff`;
    for (const parts of [{ atrHash: wrongH }, { atrHash: "" }, { atrHash: H.slice(0, 62) }, { atrHashType: "String" }]) {
      const res = await post(`${base}/verify`, body(transaction(parts)));
      // A different H decodes, so the payment is refused only against the H the seller issued (rule 6); the facilitator
      // refuses here what cannot be an LCP hash at all.
      if ("atrHash" in parts && parts.atrHash === wrongH) {
        expect(res.json).toEqual({ isValid: true, payer: PAYER });
      } else {
        expect(res.json).toEqual({ isValid: false, invalidReason: "invalid_payload" });
      }
    }
  });

  it("refuses requirements whose payTo, asset or amount differ from the call", async () => {
    await start();
    const changes = [
      { payTo: `00${"ab".repeat(32)}` },
      { asset: `${WCSPR.slice(0, 62)}ff` },
      { amount: "10001" },
    ];
    for (const change of changes) {
      const res = await post(`${base}/verify`, body(transaction(), { ...O, ...change }));
      expect(res.json).toEqual({ isValid: false, invalidReason: "invalid_payload" });
    }
  });

  it("refuses a call to another entry point on the asset", async () => {
    await start();
    const tx = transaction();
    tx.Version1.payload.fields.entry_point = { Custom: "transfer_from" };
    expect((await post(`${base}/verify`, body(tx))).json).toEqual({ isValid: false, invalidReason: "invalid_payload" });
  });

  it("refuses a transaction whose chain_name is another network's", async () => {
    await start();
    // chain_name is inside what the payer signed, so it binds the payment to one network.
    const res = await post(`${base}/verify`, body(transaction({ chainName: "casper" })));
    expect(res.json).toEqual({ isValid: false, invalidReason: "invalid_payload" });
  });

  it("answers a network it does not serve as invalid_network, and mainnet's id is a served one", async () => {
    await start();
    expect((await post(`${base}/verify`, body(transaction(), { ...O, network: "casper:casper" }))).json).toEqual({
      isValid: false,
      invalidReason: "invalid_network",
    });
    // Both network ids are admitted by the profile; only the configured one is served.
    const both = await serveProfileFacilitator({
      listen: `127.0.0.1:${await freePort()}`,
      casper: [
        { network: "casper:casper", rpc: node.url },
        { network: "casper:casper-test", rpc: node.url },
      ],
      store: { url: db.url },
      settleWaitMs: 1_000,
    });
    await both.close();
  });

  it("refuses requirements the profile does not admit as invalid_payment_requirements", async () => {
    await start();
    const changes = [
      { extra: { assetTransferMethod: "lcp-trc20-memo" } },
      { extra: {} },
      { payTo: "not-an-address" },
      { amount: "-1" },
      { maxTimeoutSeconds: 0 },
      { asset: "zz" },
    ];
    for (const change of changes) {
      const res = await post(`${base}/verify`, body(transaction(), { ...O, ...change }));
      expect(res.json).toEqual({ isValid: false, invalidReason: "invalid_payment_requirements" });
    }
  });

  it("refuses two approvals as unsupported_permission", async () => {
    await start();
    const approval = { signer: PAYER, signature: `01${sign(TX_HASH)}` };
    const res = await post(`${base}/verify`, body(transaction({ approvals: [approval, approval] })));
    expect(res.json).toEqual({ isValid: false, invalidReason: "unsupported_permission" });
  });

  it("refuses a signature by another key, and one over other bytes", async () => {
    await start();
    const other = "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";
    for (const approvals of [
      [{ signer: PAYER, signature: `01${sign(TX_HASH, other)}` }],
      [{ signer: PAYER, signature: `01${sign(H)}` }],
      [{ signer: `01${"00".repeat(32)}`, signature: `01${sign(TX_HASH)}` }],
    ]) {
      const res = await post(`${base}/verify`, body(transaction({ approvals })));
      expect(res.json).toEqual({ isValid: false, invalidReason: "invalid_payload" });
    }
  });

  it("refuses a window that has passed, and one longer than maxTimeoutSeconds", async () => {
    await start();
    vi.setSystemTime(NOW + TTL_MS);
    expect((await post(`${base}/verify`, body(transaction()))).json).toEqual({
      isValid: false,
      invalidReason: "invalid_payload",
      payer: PAYER,
    });
    vi.setSystemTime(NOW);
    expect((await post(`${base}/verify`, body(transaction(), { ...O, maxTimeoutSeconds: 60 }))).json).toEqual({
      isValid: false,
      invalidReason: "invalid_payload",
      payer: PAYER,
    });
    expect((await post(`${base}/verify`, body(transaction()))).json).toEqual({ isValid: true, payer: PAYER });
  });

  it("refuses a transaction the node's dry run reverts, as invalid_transaction", async () => {
    await start({
      speculative: { jsonrpc: "2.0", id: 1, result: { api_version: "2.0.0", execution_result: executionResult("User error: 65534") } },
    });
    const res = await post(`${base}/verify`, body(transaction()));
    expect(res.json).toEqual({ isValid: false, invalidReason: "invalid_transaction", payer: PAYER });
  });

  it("refuses a transaction speculative_exec itself refuses, as invalid_transaction", async () => {
    await start({ speculative: { jsonrpc: "2.0", id: 1, error: { code: -32008, message: "invalid transaction" } } });
    const res = await post(`${base}/verify`, body(transaction()));
    expect(res.json).toEqual({ isValid: false, invalidReason: "invalid_transaction", payer: PAYER });
  });

  it("answers a node that cannot be read as unexpected_verify_error", async () => {
    await start({ speculative: HANG });
    const res = await post(`${base}/verify`, body(transaction()));
    expect(res.json).toEqual({ isValid: false, invalidReason: "unexpected_verify_error", payer: PAYER });
  }, 15_000);

  it("dry-runs exactly the transaction the payer signed", async () => {
    await start();
    const tx = transaction();
    await post(`${base}/verify`, body(tx));
    const dry = node.calls.find((c) => (c.body as { method?: string }).method === "speculative_exec");
    expect((dry?.body as { params?: unknown }).params).toEqual({ transaction: tx });
  });
});

describe("/settle", () => {
  it("submits the payer's bytes and answers with the executed transaction hash", async () => {
    await start();
    const res = await post(`${base}/settle`, body(transaction()));
    expect(res.json).toEqual({ success: true, transaction: TX_HASH, network: NETWORK, payer: PAYER });
    const put = node.calls.filter((c) => (c.body as { method?: string }).method === "account_put_transaction");
    expect(put).toHaveLength(1);
    expect((put[0]?.body as { params?: unknown }).params).toEqual({ transaction: transaction() });
  });

  it("two concurrent /settle calls submit once and give two equal answers", async () => {
    // The dry run answers slowly, so both settles have read no stored answer before either claims.
    await start({ speculativeMs: 300 }, 5_000);
    const [a, b] = await Promise.all([post(`${base}/settle`, body(transaction())), post(`${base}/settle`, body(transaction()))]);
    expect(node.calls.filter((c) => (c.body as { method?: string }).method === "account_put_transaction")).toHaveLength(1);
    expect(a.json).toEqual(b.json);
    expect(a.json).toEqual({ success: true, transaction: TX_HASH, network: NETWORK, payer: PAYER });
  });

  it("an execution that reverted gives success: false, as invalid_transaction_state", async () => {
    await start({ info: () => info("User error: 65534") });
    const res = await post(`${base}/settle`, body(transaction()));
    expect(res.json).toEqual({
      success: false,
      errorReason: "invalid_transaction_state",
      transaction: TX_HASH,
      network: NETWORK,
    });
  });

  it("a transaction the node holds unexecuted stays settlement_pending with its hash", async () => {
    await start({ info: () => NOT_EXECUTED }, 2_000);
    const res = await post(`${base}/settle`, body(transaction()));
    expect(res.json).toEqual({ success: false, errorReason: "settlement_pending", transaction: TX_HASH, network: NETWORK });
  });

  it("a window that has already passed is refused before anything is submitted", async () => {
    await start({}, 2_000);
    const past = { timestamp: new Date(NOW - TTL_MS - 1_000).toISOString() };
    const res = await post(`${base}/settle`, body(transaction(past)));
    expect(res.json).toEqual({ success: false, errorReason: "invalid_payload", transaction: "", network: NETWORK });
    expect(node.calls.filter((c) => (c.body as { method?: string }).method === "account_put_transaction")).toHaveLength(0);
  });

  it("a transaction no node shows once its window has passed can never execute: invalid_transaction_state", async () => {
    await start({ info: () => UNKNOWN }, 2_000);
    // The first settle submits inside the window and ends pending, the node never having shown the transaction.
    expect((await post(`${base}/settle`, body(transaction()))).json).toEqual({
      success: false,
      errorReason: "settlement_pending",
      transaction: TX_HASH,
      network: NETWORK,
    });
    // Past the time to live, every node refuses the transaction from now on, so it can never execute.
    vi.setSystemTime(NOW + TTL_MS + 1_000);
    const res = await post(`${base}/settle`, body(transaction()));
    expect(res.json).toEqual({
      success: false,
      errorReason: "invalid_transaction_state",
      transaction: TX_HASH,
      network: NETWORK,
    });
    expect(node.calls.filter((c) => (c.body as { method?: string }).method === "account_put_transaction")).toHaveLength(1);
  });

  it("a submission the node refuses gives success: false with no transaction, and nothing is submitted twice", async () => {
    await start({ put: { jsonrpc: "2.0", id: 1, error: { code: -32009, message: "insufficient balance" } } });
    const res = await post(`${base}/settle`, body(transaction()));
    expect(res.json).toEqual({ success: false, errorReason: "unexpected_settle_error", transaction: "", network: NETWORK });
  });

  it("a submission refused as one the node already holds is read as submitted, and the execution answers", async () => {
    await start({ put: { jsonrpc: "2.0", id: 1, error: { code: -32009, message: "transaction already received" } } });
    const res = await post(`${base}/settle`, body(transaction()));
    expect(res.json).toEqual({ success: true, transaction: TX_HASH, network: NETWORK, payer: PAYER });
  });

  it("a repeated /settle re-reads the chain, submits nothing more, and stores the final answer", async () => {
    let executed = false;
    await start({ info: () => (executed ? info(null) : NOT_EXECUTED) }, 1_500);
    expect((await post(`${base}/settle`, body(transaction()))).json).toEqual({
      success: false,
      errorReason: "settlement_pending",
      transaction: TX_HASH,
      network: NETWORK,
    });
    executed = true;
    const success = { success: true, transaction: TX_HASH, network: NETWORK, payer: PAYER };
    expect((await post(`${base}/settle`, body(transaction()))).json).toEqual(success);
    const reads = node.calls.filter((c) => (c.body as { method?: string }).method === "info_get_transaction").length;
    expect((await post(`${base}/settle`, body(transaction()))).json).toEqual(success);
    expect(node.calls.filter((c) => (c.body as { method?: string }).method === "info_get_transaction")).toHaveLength(reads);
    expect(node.calls.filter((c) => (c.body as { method?: string }).method === "account_put_transaction")).toHaveLength(1);
  });

  it("a node error before anything is submitted gives unexpected_settle_error and no submission", async () => {
    await start({ speculative: HANG });
    const res = await post(`${base}/settle`, body(transaction()));
    expect(res.json).toEqual({ success: false, errorReason: "unexpected_settle_error", transaction: "", network: NETWORK });
    expect(node.calls.filter((c) => (c.body as { method?: string }).method === "account_put_transaction")).toHaveLength(0);
  }, 15_000);

  it("a settle for a network it does not serve is refused before anything is read", async () => {
    await start();
    const res = await post(`${base}/settle`, body(transaction(), { ...O, network: "casper:casper" }));
    expect(res.json).toEqual({ success: false, errorReason: "invalid_network", transaction: "", network: "casper:casper" });
    expect(node.calls).toEqual([]);
  });

  it("a repeat whose store read fails gives settlement_pending with the hash, and submits nothing more", async () => {
    await start();
    expect((await post(`${base}/settle`, body(transaction()))).json).toEqual({
      success: true,
      transaction: TX_HASH,
      network: NETWORK,
      payer: PAYER,
    });
    await db.pool.query("ALTER TABLE settlement RENAME TO settlement_unreadable");
    const res = await post(`${base}/settle`, body(transaction()));
    expect(res.json).toEqual({ success: false, errorReason: "settlement_pending", transaction: TX_HASH, network: NETWORK });
    expect(node.calls.filter((c) => (c.body as { method?: string }).method === "account_put_transaction")).toHaveLength(1);
  });
});
