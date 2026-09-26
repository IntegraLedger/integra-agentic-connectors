/** Bounded JSON over HTTP: outbound node calls, and reading and writing the facilitator's own requests. */
import type { IncomingMessage, ServerResponse } from "node:http";

export const NODE_TIMEOUT_MS = 5_000;
export const NODE_MAX_BYTES = 4 * 1024 * 1024;
export const REQUEST_MAX_BYTES = 64 * 1024;

/** Connection errors after which no byte of the request can have reached the node. */
const UNSENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Why a node call gave no answer. `sent` is false only when the request cannot have reached the node. */
export class NodeError extends Error {
  constructor(
    readonly code: "timeout" | "transport" | "http-status" | "too-large" | "malformed",
    readonly sent: boolean,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

/** POSTs a JSON body and reads a JSON answer within the timeout (at most 5 s) and the size bound. */
export async function postJson(url: string, body: unknown, timeoutMs = NODE_TIMEOUT_MS): Promise<unknown> {
  const ms = Number.isFinite(timeoutMs) ? Math.max(1, Math.ceil(Math.min(timeoutMs, NODE_TIMEOUT_MS))) : NODE_TIMEOUT_MS;
  const signal = AbortSignal.timeout(ms);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal.aborted) throw new NodeError("timeout", true, url);
    const cause = e instanceof Error && isObject(e.cause) ? e.cause["code"] : undefined;
    const unsent = typeof cause === "string" && UNSENT.has(cause);
    throw new NodeError("transport", !unsent, e instanceof Error ? e.message : String(e));
  }
  const bytes = await readBounded(res, signal);
  if (res.status < 200 || res.status > 299) throw new NodeError("http-status", true, `status ${res.status}`);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new NodeError("malformed", true, "the answer is not JSON");
  }
}

async function readBounded(res: Response, signal: AbortSignal): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > NODE_MAX_BYTES) {
    await res.body?.cancel();
    throw new NodeError("too-large", true, `content-length ${declared}`);
  }
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > NODE_MAX_BYTES) {
        await reader.cancel();
        throw new NodeError("too-large", true, `more than ${NODE_MAX_BYTES} bytes`);
      }
      parts.push(value);
    }
  } catch (e) {
    if (e instanceof NodeError) throw e;
    if (signal.aborted) throw new NodeError("timeout", true, "reading the answer");
    throw new NodeError("transport", true, e instanceof Error ? e.message : String(e));
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** Reads a request body of at most 64 KiB as JSON; undefined when it is larger or is not JSON. */
export async function readRequestJson(req: IncomingMessage): Promise<{ json: unknown } | { tooLarge: true } | undefined> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > REQUEST_MAX_BYTES) return { tooLarge: true };
  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    total += b.byteLength;
    if (total > REQUEST_MAX_BYTES) return { tooLarge: true };
    parts.push(b);
  }
  try {
    return { json: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts))) };
  } catch {
    return undefined;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `p`'s outcome, or a `timeout` NodeError once `ms` has passed first. */
export async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new NodeError("timeout", true, `no answer within ${ms} ms`)), Math.max(0, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
