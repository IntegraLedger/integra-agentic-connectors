/**
 * A reference x402 facilitator for two LCP profiles, `x402/exact/tron/lcp-trc20-memo` and
 * `x402/exact/polkadot/lcp-assets-remark`: `GET /supported`, `POST /verify` and `POST /settle` over `node:http`. It
 * holds no key and pays no fee; it checks, submits what the payer signed, deduplicates, and reports what the network
 * shows.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { LCP_ASSETS_REMARK, type PolkadotNetwork } from "@integraledger/lcp/polkadot";
import { LCP_TRC20_MEMO } from "@integraledger/lcp/tron";
import {
  failed,
  guarded,
  invalid,
  isObject,
  operatorLine,
  readRequest,
  type FacilitatorRequest,
  type SettleAnswer,
  type VerifyAnswer,
} from "./answers.js";
import { readRequestJson, sendJson } from "./http.js";
import { createPolkadot } from "./polkadot.js";
import { openStore, type SettlementStore } from "./store.js";
import { createTron } from "./tron.js";
import { unexpectedSettle, unexpectedVerify } from "./unexpected.js";

export interface ProfileFacilitatorConfig {
  /** "host:port" */
  listen: string;
  tron?: { network: `tron:${number}`; fullNode: string; solidityNode: string }[];
  /** An RPC node that serves `state_call` and `author_submitExtrinsic`. */
  polkadot?: { network: PolkadotNetwork; rpc: string }[];
  /** Postgres, for deduplication only. */
  store: { url: string };
  /** How long `/settle` waits for inclusion before answering `settlement_pending`; default 30 000. */
  settleWaitMs: number;
  /**
   * Receives every entry for the operator: what the facilitator saw that its answer does not carry, with `network`,
   * `payer` and `transaction` naming the payment where they are known. `cause` is the error that caused the entry,
   * when there is one; the answer to the client is the same either way, and carries nothing from it. Called once per
   * entry; what it throws, or a promise it returns that rejects, goes to the default with an `operator-log-failed`
   * entry. Default: one JSON line per entry on standard error, the cause as its `cause` (name, message, stack and its
   * own `cause` chain).
   */
  operatorLog?: (
    entry: { event: string; network?: string; payer?: string; transaction?: string; [field: string]: unknown },
    cause?: unknown,
  ) => void;
}

const DEFAULT_SETTLE_WAIT_MS = 30_000;

/** The body's `paymentRequirements.network` when it is a string, else "". */
function networkOf(body: unknown): string {
  const requirements = isObject(body) ? body["paymentRequirements"] : undefined;
  const network = isObject(requirements) ? requirements["network"] : undefined;
  return typeof network === "string" ? network : "";
}

function hostPort(listen: string): { host: string; port: number } {
  const m = /^\[?([^\]]*)\]?:(\d{1,5})$/.exec(listen);
  const port = m === null ? NaN : Number(m[2]);
  if (m === null || !(port >= 0 && port <= 65_535)) throw new TypeError(`listen must be "host:port": ${listen}`);
  return { host: m[1]!, port };
}

function trimmed(url: string): string {
  return url.replace(/\/+$/, "");
}

export async function serveProfileFacilitator(c: ProfileFacilitatorConfig): Promise<{ close(): Promise<void> }> {
  const { host, port } = hostPort(c.listen);
  const settleWaitMs =
    Number.isFinite(c.settleWaitMs) && c.settleWaitMs > 0 ? c.settleWaitMs : DEFAULT_SETTLE_WAIT_MS;
  const log = guarded(c.operatorLog ?? operatorLine);
  const store: SettlementStore = await openStore(c.store.url, log);
  const tron = createTron(
    (c.tron ?? []).map((n) => ({ ...n, fullNode: trimmed(n.fullNode), solidityNode: trimmed(n.solidityNode) })),
    store,
    settleWaitMs,
    log,
  );
  const polkadot = createPolkadot(
    (c.polkadot ?? []).map((n) => ({ ...n, rpc: trimmed(n.rpc) })),
    store,
    settleWaitMs,
    log,
  );

  const supported = {
    kinds: [
      ...tron.networks.map((network) => ({
        x402Version: 2,
        scheme: "exact",
        network,
        extra: { assetTransferMethod: LCP_TRC20_MEMO },
      })),
      ...polkadot.networks.map((network) => ({
        x402Version: 2,
        scheme: "exact",
        network,
        extra: { assetTransferMethod: LCP_ASSETS_REMARK },
      })),
    ],
    extensions: [],
    signers: {},
  };

  function railOf(r: FacilitatorRequest) {
    const n = r.paymentRequirements.network;
    if (tron.networks.includes(n)) return tron;
    if (polkadot.networks.includes(n)) return polkadot;
    return undefined;
  }

  async function verify(body: unknown): Promise<VerifyAnswer> {
    const r = readRequest(body);
    if (typeof r === "string") return { isValid: false, invalidReason: r };
    const rail = railOf(r);
    if (rail === undefined) return { isValid: false, invalidReason: "invalid_network" };
    try {
      return await rail.verify(r);
    } catch (e) {
      return invalid(unexpectedVerify(log, { event: "verify-error", network: r.paymentRequirements.network }, e));
    }
  }

  async function settle(body: unknown): Promise<SettleAnswer> {
    const r = readRequest(body);
    if (typeof r === "string") return failed(r, "", networkOf(body));
    const network = r.paymentRequirements.network;
    const rail = railOf(r);
    if (rail === undefined) return failed("invalid_network", "", network);
    try {
      return await rail.settle(r);
    } catch (e) {
      return unexpectedSettle(log, { event: "settle-error", network }, e);
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/supported") {
      if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, supported);
    }
    if (path !== "/verify" && path !== "/settle") return sendJson(res, 404, { error: "not found" });
    if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
    const read = await readRequestJson(req);
    if (read !== undefined && "tooLarge" in read) {
      res.setHeader("connection", "close");
      sendJson(res, 413, { error: "the body is larger than 64 KiB" });
      req.destroy();
      return;
    }
    if (read !== undefined && "left" in read) {
      // The client left before its body was complete: there is no one to answer, and nothing failed here to log.
      res.destroy();
      return;
    }
    if (path === "/verify") {
      if (read === undefined) return sendJson(res, 400, { isValid: false, invalidReason: "invalid_payload" });
      return sendJson(res, 200, await verify(read.json));
    }
    if (read === undefined) return sendJson(res, 400, failed("invalid_payload", "", ""));
    return sendJson(res, 200, await settle(read.json));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      log({ event: "request-error", path: (req.url ?? "").split("?")[0] }, e);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.destroy();
    });
  });
  server.requestTimeout = settleWaitMs + 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await polkadot.close();
      await store.close();
    },
  };
}
