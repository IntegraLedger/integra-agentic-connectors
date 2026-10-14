// Writes csp.json after `next build`: the Content-Security-Policy worker.js gives each HTML page of out/. A page's
// policy is the one public/_headers sets for every file, with the SHA-256 hash of each of the page's inline scripts
// added to its script-src, so the page runs its own inline scripts and no other. `default` is that policy with no
// hash, for an HTML response no page here matches; `notFound` is the 404 page's.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const website = join(import.meta.dirname, "..");
const out = join(website, "out");

/** The Content-Security-Policy that public/_headers sets for `/*`. */
function basePolicy() {
  const lines = readFileSync(join(website, "public/_headers"), "utf8").split("\n");
  const rule = lines.indexOf("/*");
  if (rule === -1) throw new Error("public/_headers has no /* rule");
  for (const line of lines.slice(rule + 1)) {
    if (!/^\s/.test(line)) break;
    const match = /^\s+Content-Security-Policy:\s*(.+)$/.exec(line);
    if (match?.[1]) return match[1].trim();
  }
  throw new Error("public/_headers sets no Content-Security-Policy for /*");
}

/** The JavaScript types a script element runs (an empty type is JavaScript); a JSON or other data block runs nothing. */
const RUNS = new Set(["", "text/javascript", "application/javascript", "module"]);

/** The base64 SHA-256 of each inline script the page runs, in page order, without repeats. */
function inlineScriptHashes(html) {
  const hashes = new Set();
  for (const [, attributes, text] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\ssrc\s*=/i.test(` ${attributes}`)) continue;
    const type = /\stype\s*=\s*["']?([^"'\s>]*)/i.exec(` ${attributes}`)?.[1]?.toLowerCase() ?? "";
    if (!RUNS.has(type)) continue;
    hashes.add(`'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`);
  }
  return [...hashes];
}

/** The policy with the hashes added to its script-src directive. */
function withHashes(policy, hashes) {
  const directives = policy.split(";").map((d) => d.trim());
  const at = directives.findIndex((d) => d.split(/\s+/)[0] === "script-src");
  if (at === -1) throw new Error("the policy in public/_headers has no script-src directive");
  if (/'unsafe-inline'/.test(directives[at] ?? "")) throw new Error("script-src in public/_headers allows 'unsafe-inline'");
  directives[at] = [directives[at], ...hashes].join(" ");
  return directives.join("; ");
}

/** The address Cloudflare's static assets serve an HTML file at: a.html at /a, a/index.html at /a/. */
function addressOf(file) {
  const path = relative(out, file).split(sep).join("/");
  if (path === "index.html") return "/";
  if (path.endsWith("/index.html")) return `/${path.slice(0, -"index.html".length)}`;
  return `/${path.slice(0, -".html".length)}`;
}

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

const base = basePolicy();
const pages = {};
let notFound;
let scripts = 0;
for (const file of walk(out).filter((f) => f.endsWith(".html")).sort()) {
  const hashes = inlineScriptHashes(readFileSync(file, "utf8"));
  scripts += hashes.length;
  const policy = withHashes(base, hashes);
  if (relative(out, file) === "404.html") notFound = policy;
  else pages[addressOf(file)] = policy;
}
if (notFound === undefined) throw new Error("out/404.html is missing: run next build first");
writeFileSync(join(website, "csp.json"), `${JSON.stringify({ default: withHashes(base, []), notFound, pages }, null, 2)}\n`);
console.log(
  `csp.json: a Content-Security-Policy for ${Object.keys(pages).length} pages and the 404 page, ${scripts} inline script hashes`,
);
