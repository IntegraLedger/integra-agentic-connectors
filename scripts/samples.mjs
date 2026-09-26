// Compiles and runs every TypeScript sample in the READMEs and in docs/, against the packages built in this tree.
//
// A sample is a fenced block whose language is `ts` or `typescript`. A fenced `text` block whose info string holds
// `output`, directly after a sample, is that sample's expected standard output. A sample whose info string holds
// `server` is sent SIGTERM once it has printed its first line, and must then exit 0.
//
// A sample runs inside the package it imports (`@integraledger/profile-facilitator`, else
// `@integraledger/agentic-connectors`), so both it and `@integraledger/lcp` resolve as they do for an installer. It
// is type-checked with the workspace's TypeScript under scripts/tsconfig.docs.json, then run with Node. The samples reach a
// fresh local stand-in door (scripts/stand-in-door.mjs) through SELLER_DOOR_URL and SELLER_CREDENTIAL, and Postgres through
// DATABASE_URL, taken from DATABASE_URL or INTEGRA_DATABASE_URL.
//
// Usage: node scripts/samples.mjs [--list]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGES = {
  "@integraledger/agentic-connectors": join(root, "contract"),
  "@integraledger/profile-facilitator": join(root, "profile-facilitator"),
};
const CREDENTIAL = "isk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const RUN_MS = 60_000;

function markdownFiles() {
  const out = [];
  for (const f of ["README.md", "contract/README.md", "profile-facilitator/README.md"]) out.push(join(root, f));
  const walk = (d) => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.mdx?$/.test(e)) out.push(p);
    }
  };
  if (existsSync(join(root, "docs"))) walk(join(root, "docs"));
  return out.filter((f) => existsSync(f));
}

/** The fenced blocks of a Markdown file: language, info string, body and line. */
function blocks(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)(`{3,})(\S*)\s*(.*)$/.exec(lines[i]);
    if (open === null) continue;
    const [, indent, fence, lang, info] = open;
    const body = [];
    let j = i + 1;
    for (; j < lines.length && !new RegExp(`^${indent}${fence}\\s*$`).test(lines[j]); j++) body.push(lines[j].slice(indent.length));
    out.push({ lang, info, body: body.join("\n"), line: i + 1 });
    i = j;
  }
  return out;
}

function samples() {
  const out = [];
  for (const file of markdownFiles()) {
    const bs = blocks(file);
    bs.forEach((b, i) => {
      if (b.lang !== "ts" && b.lang !== "typescript") return;
      const next = bs[i + 1];
      const output = next !== undefined && next.lang === "text" && /\boutput\b/.test(next.info) ? next.body : undefined;
      const pkg = /["']@integraledger\/profile-facilitator["']/.test(b.body)
        ? "@integraledger/profile-facilitator"
        : "@integraledger/agentic-connectors";
      out.push({ file: relative(root, file), line: b.line, code: b.body, output, server: /\bserver\b/.test(b.info), pkg });
    });
  }
  return out;
}

async function startDoor() {
  const child = spawn(process.execPath, [join(root, "scripts", "stand-in-door.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
  const url = await new Promise((resolve, reject) => {
    let text = "";
    child.stdout.on("data", (d) => {
      text += d;
      const m = /listening (\S+)/.exec(text);
      if (m) resolve(m[1]);
    });
    child.once("exit", (code) => reject(new Error(`the stand-in door exited with ${code}`)));
  });
  return { url, stop: () => child.kill("SIGTERM") };
}

function run(file, cwd, env, server) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let signalled = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_MS);
    child.stdout.on("data", (d) => {
      stdout += d;
      if (server && !signalled && stdout.includes("\n")) {
        signalled = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

const all = samples();
if (process.argv.includes("--list")) {
  for (const s of all) console.log(`${s.file}:${s.line} ${s.pkg}${s.output !== undefined ? " (output)" : ""}${s.server ? " (server)" : ""}`);
  process.exit(0);
}

const database = process.env["DATABASE_URL"] || process.env["INTEGRA_DATABASE_URL"];
const dirs = new Map();
for (const [i, s] of all.entries()) {
  const dir = join(PACKAGES[s.pkg], ".samples");
  if (!dirs.has(dir)) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    dirs.set(dir, []);
  }
  s.path = join(dir, `sample-${String(i + 1).padStart(2, "0")}.ts`);
  writeFileSync(s.path, `${s.code}\n`);
  dirs.get(dir).push(s.path);
}

let failed = 0;
const tsc = [join(root, "node_modules", ".bin", "tsc"), join(root, "..", "node_modules", ".bin", "tsc")].find((f) => {
  try {
    return statSync(f).isFile();
  } catch {
    return false;
  }
});
if (tsc === undefined) throw new Error("no TypeScript compiler in node_modules/.bin: run pnpm install first");
for (const [dir, files] of dirs) {
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ extends: "../../scripts/tsconfig.docs.json", files: files.map((f) => relative(dir, f)) }, null, 2),
  );
  const r = spawnSync(tsc, ["-p", join(dir, "tsconfig.json")], { encoding: "utf8" });
  if (r.status !== 0) {
    failed++;
    console.log(`typecheck failed in ${relative(root, dir)}:\n${r.stdout}${r.stderr}`);
    for (const s of all) if (r.stdout.includes(relative(dir, s.path))) console.log(`  ${relative(dir, s.path)} is ${s.file}:${s.line}`);
  }
}

try {
  for (const s of all) {
    // Each sample gets a fresh stand-in door, so no sample sees another's requests.
    const door = await startDoor();
    const env = { ...process.env, SELLER_DOOR_URL: door.url, SELLER_CREDENTIAL: CREDENTIAL };
    if (database) env["DATABASE_URL"] = database;
    const r = await run(s.path, dirname(s.path), env, s.server);
    door.stop();
    const ok = r.code === 0;
    const got = r.stdout.replace(/\s+$/, "");
    const matches = s.output === undefined || got === s.output.replace(/\s+$/, "");
    if (ok && matches) {
      console.log(`ok   ${s.file}:${s.line}`);
      continue;
    }
    failed++;
    console.log(`FAIL ${s.file}:${s.line} (exit ${r.code}${r.signal ? `, ${r.signal}` : ""})`);
    if (!matches) console.log(`--- expected\n${s.output}\n--- printed\n${got}`);
    if (r.stderr) console.log(`--- stderr\n${r.stderr}`);
  }
} finally {
  for (const dir of dirs.keys()) rmSync(dir, { recursive: true, force: true });
}
console.log(`${all.length} samples, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
