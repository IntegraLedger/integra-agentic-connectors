/**
 * A reference x402 facilitator for two LCP profiles, `x402/exact/tron/lcp-trc20-memo` and
 * `x402/exact/polkadot/lcp-assets-remark`: `GET /supported`, `POST /verify` and `POST /settle` over `node:http`. It
 * holds no key and pays no fee; it checks, submits what the payer signed, deduplicates, and reports what the network
 * shows.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { LCP_ASSETS_REMARK, type PolkadotNetwork } from "@integraledger/lcp/polkadot";
import { LCP_TRC20_MEMO } from "@integraledger/lcp/tron";
import { failed, readRequest, type FacilitatorRequest, type SettleAnswer, type VerifyAnswer } from "./answers.js";
import { readRequestJson, sendJson } from "./http.js";
import { createPolkadot } from "./polkadot.js";
import { openStore, type SettlementStore } from "./store.js";
import { createTron } from "./tron.js";

export type { SettleAnswer, VerifyAnswer } from "./answers.js";

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
}

const DEFAULT_SETTLE_WAIT_MS = 30_000;

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
  const store: SettlementStore = await openStore(c.store.url);
  const tron = createTron(
    (c.tron ?? []).map((n) => ({ ...n, fullNode: trimmed(n.fullNode), solidityNode: trimmed(n.solidityNode) })),
    store,
    settleWaitMs,
  );
  const polkadot = createPolkadot(
    (c.polkadot ?? []).map((n) => ({ ...n, rpc: trimmed(n.rpc) })),
    store,
    settleWaitMs,
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
    } catch {
      return { isValid: false, invalidReason: "unexpected_verify_error" };
    }
  }

  async function settle(body: unknown): Promise<SettleAnswer> {
    const r = readRequest(body);
    const network = typeof r === "string" ? "" : r.paymentRequirements.network;
    if (typeof r === "string") return failed(r, "", network);
    const rail = railOf(r);
    if (rail === undefined) return failed("invalid_network", "", network);
    try {
      return await rail.settle(r);
    } catch {
      return failed("unexpected_settle_error", "", network);
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
    if (path === "/verify") {
      if (read === undefined) return sendJson(res, 400, { isValid: false, invalidReason: "invalid_payload" });
      return sendJson(res, 200, await verify(read.json));
    }
    if (read === undefined) return sendJson(res, 400, failed("invalid_payload", "", ""));
    return sendJson(res, 200, await settle(read.json));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
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
