// A local stand-in for the seller door that answers from the contract's vectors.
//
// A request is matched by its method, path, JSON body (in any member order), bearer credential and whether it carries an Origin header.
// The answer is the one the first vector holding that request expects; a request that appears more than once in that
// vector gets the vector's answers in order, and the last one after that. GET /openapi.json serves the contract's
// document. Any other request is answered 501 with the code "stand-in/no-vector".
//
// Usage: node scripts/stand-in-door.mjs [port]   (prints "listening <url>" once it accepts requests)
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("../contract/package.json", import.meta.url));
const { OPENAPI_BYTES, VECTORS } = await import(pathToFileURL(require.resolve("@integraledger/agentic-connectors")).href);

/** A JSON value with every object's members in sorted order, so member order does not change a match. */
function sorted(v) {
  if (Array.isArray(v)) return v.map(sorted);
  if (typeof v === "object" && v !== null) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]));
  return v;
}

/** The key a request is matched by. */
function keyOf(method, path, body, authorization, hasOrigin) {
  return JSON.stringify([method.toUpperCase(), path, sorted(body ?? null), authorization ?? null, hasOrigin]);
}

function headerOf(headers, name) {
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
}

const answers = new Map();
for (const vector of Object.values(VECTORS)) {
  const inThis = new Map();
  for (const step of vector.steps) {
    const r = step.request;
    const key = keyOf(r.method, r.path, r.body, headerOf(r.headers, "authorization"), headerOf(r.headers, "origin") !== undefined);
    if (!inThis.has(key)) inThis.set(key, []);
    inThis.get(key).push(step.expect);
  }
  for (const [key, list] of inThis) if (!answers.has(key)) answers.set(key, list);
}

const served = new Map();
let correlation = 0;

function send(res, status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(text);
}

const server = createServer(async (req, res) => {
  const parts = [];
  for await (const chunk of req) parts.push(chunk);
  const path = (req.url ?? "").split("?")[0];
  if (req.method === "GET" && path === "/openapi.json") return send(res, 200, Buffer.from(OPENAPI_BYTES).toString("utf8"));
  let body;
  if (parts.length > 0) {
    try {
      body = JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch {
      body = Symbol("not JSON");
    }
  }
  const key = typeof body === "symbol" ? undefined : keyOf(req.method ?? "", path, body, req.headers.authorization, req.headers.origin !== undefined);
  const list = key === undefined ? undefined : answers.get(key);
  if (list === undefined) {
    return send(res, 501, { code: "stand-in/no-vector", sentence: "No vector holds this request.", correlationId: String(++correlation) });
  }
  const n = served.get(key) ?? 0;
  served.set(key, n + 1);
  const expect = list[Math.min(n, list.length - 1)];
  const out = typeof expect.body === "object" && expect.body !== null && "code" in expect.body
    ? { ...expect.body, sentence: `Refused: ${expect.body.code}.`, correlationId: String(++correlation) }
    : expect.body;
  const headers = { ...(expect.headers ?? {}) };
  if (expect.status === 503) headers["retry-after"] = "1";
  send(res, expect.status, out, headers);
});

const port = Number(process.argv[2] ?? 0);
server.listen(port, "127.0.0.1", () => {
  const { port: bound } = server.address();
  console.log(`listening http://127.0.0.1:${bound}`);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
