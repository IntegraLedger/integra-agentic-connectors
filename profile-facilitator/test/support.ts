// Test support: a fresh Postgres database per test file, local node stubs over node:http, a free port below the
// kernel's outgoing range, and JSON POSTs.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as netServer } from "node:net";
import { gunzipSync } from "node:zlib";
import pg from "pg";

export function databaseUrl(): string {
  const url = process.env["INTEGRA_DATABASE_URL"];
  if (url === undefined || url === "") throw new Error("INTEGRA_DATABASE_URL is not set: the Postgres tests need it");
  return url;
}

export async function freshDatabase(): Promise<{ url: string; pool: pg.Pool; drop(): Promise<void> }> {
  const admin = new pg.Pool({ connectionString: databaseUrl(), max: 1 });
  admin.on("error", () => {});
  const name = `facilitator_${randomBytes(6).toString("hex")}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(databaseUrl());
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  pool.on("error", () => {});
  return {
    url: url.toString(),
    pool,
    async drop() {
      await pool.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/** The lowest local port the kernel gives an outgoing connection, or a listen on port 0; 32768 where it cannot be read. */
function ephemeralLow(): number {
  try {
    const low = Number(readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0]);
    return Number.isInteger(low) ? low : 32_768;
  } catch {
    return 32_768;
  }
}

/**
 * A port on 127.0.0.1, free when chosen. It lies below the kernel's range for outgoing connections, so no client
 * socket, and no socket in TIME_WAIT, holds it when the facilitator binds it.
 */
export async function freePort(): Promise<number> {
  const low = 10_000;
  const high = Math.min(ephemeralLow(), 32_768);
  if (high - low < 1_000) throw new Error(`no port range below the kernel's outgoing range (it starts at ${high})`);
  for (;;) {
    const port = low + Math.floor(Math.random() * (high - low));
    const s = netServer();
    const bound = await new Promise<boolean>((resolve) => {
      s.once("error", () => resolve(false));
      s.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (!bound) continue;
    await new Promise<void>((resolve) => s.close(() => resolve()));
    return port;
  }
}

export interface Call {
  path: string;
  body: unknown;
}

export interface Stub {
  url: string;
  calls: Call[];
  close(): Promise<void>;
}

/** A local node: each POST's JSON body goes to `answer`, whose value is sent back as JSON; `hang` never answers. */
export async function stub(answer: (path: string, body: unknown) => unknown | Promise<unknown>): Promise<Stub> {
  const calls: Call[] = [];
  const open = new Set<ServerResponse>();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    const text = Buffer.concat(parts).toString("utf8");
    const body: unknown = text === "" ? undefined : JSON.parse(text);
    const path = req.url ?? "";
    calls.push({ path, body });
    const value = await answer(path, body);
    if (value === HANG) {
      open.add(res);
      return;
    }
    const out = JSON.stringify(value);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(out);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    async close() {
      for (const r of open) r.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export const HANG = Symbol("hang");

export async function post(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

export function fixture(name: string): unknown {
  const bytes = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse((name.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"));
}

/** The lcp vectors' V2 payer, as the 21 bytes a FullNode prints for an address. */
export const V2_PAYER_HEX = "41f39fd6e51aad88f6f4ce6ab8827279cfffb92266";
/** The lcp vectors' V2 reference block: solidified block 86542765 and its id, read live from Tron mainnet. */
export const V2_REF_BLOCK = { number: 86542765, id: "00000000052889ad7d1ddbe0b0adbe87d02b3cdbba73a6d485ff0392ab0e5003" };
/** The FullNode's head in these stubs: a block 25 after V2's reference block. */
export const V2_HEAD = 86542790;

/**
 * A FullNode's answers to the reads `/verify` makes before it simulates, for V2's payer and reference block, in
 * java-tron's HTTP shapes: `/wallet/getaccount` gives the default owner permission java-tron gives an account
 * (`AccountCapsule.createDefaultOwnerPermission`: the address's own key, weight 1, threshold 1); `/wallet/getnowblock`
 * the head; `/wallet/getblock` V2's reference block by number, and `{}` for a block it does not hold;
 * `/wallet/gettransactionbyid` and `/wallet/gettransactionfrompending` `{}`, the answer for an id the node does not
 * hold in its blocks or its pending pool. Undefined for any other path.
 */
export function tronChainReads(path: string, body: unknown): unknown {
  if (path === "/wallet/getaccount") {
    return {
      address: V2_PAYER_HEX,
      owner_permission: { permission_name: "owner", threshold: 1, keys: [{ address: V2_PAYER_HEX, weight: 1 }] },
    };
  }
  if (path === "/wallet/getnowblock") return { block_header: { raw_data: { number: V2_HEAD } } };
  if (path === "/wallet/getblock") {
    const wanted = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["id_or_num"] : undefined;
    return wanted === String(V2_REF_BLOCK.number)
      ? { blockID: V2_REF_BLOCK.id, block_header: { raw_data: { number: V2_REF_BLOCK.number } } }
      : {};
  }
  if (path === "/wallet/gettransactionbyid" || path === "/wallet/gettransactionfrompending") return {};
  return undefined;
}
