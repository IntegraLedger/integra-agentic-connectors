// Compiles and runs every TypeScript sample in the READMEs (every README.md in the tree) and in docs/, against the
// packages built in this tree.
//
// Each file is read as CommonMark reads it, by mdast-util-from-markdown: a fenced code block inside a block quote or a
// list item is read where it stands, and the text of an indented code block, an HTML block or a paragraph is never a
// fence. A sample is a fenced code block whose language is `ts` or `typescript`. A block fenced in another TypeScript
// or JavaScript language (`tsx`, `mts`, `js`, `TS`, …) fails, so no sample leaves the run by its label. A fenced `text`
// block whose info string holds `output`, directly after a sample in the same container, with only blank lines between
// them, is that sample's expected standard output; a sample without one fails. A sample whose info string holds
// `server` is sent SIGTERM once it has printed its first line, and must then exit 0. A run that finds no sample fails.
//
// A sample runs inside the package it imports (`@integraledger/profile-facilitator`, else
// `@integraledger/agentic-connectors`), so both it and `@integraledger/lcp` resolve as they do for an installer. It
// is type-checked with the workspace's TypeScript under scripts/tsconfig.docs.json, then run with Node. The samples reach a
// fresh local stand-in door (scripts/stand-in-door.mjs) through SELLER_DOOR_URL and SELLER_CREDENTIAL, and Postgres through
// DATABASE_URL, taken from DATABASE_URL or INTEGRA_DATABASE_URL; a run with neither set stops before any sample runs. Each
// sample sees only those variables, with PATH, HOME and TMPDIR.
//
// Usage: node scripts/samples.mjs [--list]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGES = {
  "@integraledger/agentic-connectors": join(root, "contract"),
  "@integraledger/profile-facilitator": join(root, "profile-facilitator"),
};
const CREDENTIAL = "isk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const RUN_MS = 60_000;

function markdownFiles() {
  const out = [];
  // Every README.md in the tree, outside node_modules, build output and dot-folders; then every page in docs/.
  const readmes = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "out" || e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (p !== join(root, "docs")) readmes(p);
      } else if (e.name === "README.md") out.push(p);
    }
  };
  readmes(root);
  const walk = (d) => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.mdx?$/.test(e)) out.push(p);
    }
  };
  if (existsSync(join(root, "docs"))) walk(join(root, "docs"));
  return out;
}

/**
 * The fenced code blocks of a Markdown file, in document order: language, the rest of the info string, body, line, and
 * the fenced code block that follows it in the same container, if one does. Only a fenced code block has a language, so
 * a code node without one is an indented block or a fence with no info string. Nodes that follow each other in one
 * container have only blank lines between them.
 */
function blocks(file) {
  const out = [];
  const fenced = (node) => (node?.type === "code" && node.lang !== null ? node : undefined);
  const walk = (node) => {
    const children = node.children ?? [];
    children.forEach((child, i) => {
      const code = fenced(child);
      if (code !== undefined) {
        const next = fenced(children[i + 1]);
        out.push({
          lang: code.lang,
          info: code.meta ?? "",
          body: code.value,
          line: code.position.start.line,
          next: next === undefined ? undefined : { lang: next.lang, info: next.meta ?? "", body: next.value },
        });
      }
      walk(child);
    });
  };
  walk(fromMarkdown(readFileSync(file, "utf8")));
  return out;
}

function samples() {
  const out = [];
  for (const file of markdownFiles()) {
    blocks(file).forEach((b) => {
      if (b.lang !== "ts" && b.lang !== "typescript") {
        if (/^(?:[cm]?[jt]sx?|typescript|javascript)$/i.test(b.lang)) out.push({ file: relative(root, file), line: b.line, refused: b.lang });
        return;
      }
      const output = b.next !== undefined && b.next.lang === "text" && /\boutput\b/.test(b.next.info) ? b.next.body : undefined;
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
if (all.length === 0) {
  console.log("no TypeScript sample in the READMEs or docs/, so nothing is checked");
  process.exit(1);
}
if (process.argv.includes("--list")) {
  for (const s of all.filter((s) => s.refused === undefined)) console.log(`${s.file}:${s.line} ${s.pkg}${s.output !== undefined ? " (output)" : ""}${s.server ? " (server)" : ""}`);
  process.exit(0);
}

const database = process.env["DATABASE_URL"] || process.env["INTEGRA_DATABASE_URL"];
if (!database) {
  console.log("set DATABASE_URL or INTEGRA_DATABASE_URL to a Postgres database: the facilitator's samples write to it");
  process.exit(1);
}
const tsc = join(root, "node_modules", ".bin", "tsc");
if (!statSync(tsc, { throwIfNoEntry: false })?.isFile()) {
  console.log("no TypeScript compiler in node_modules/.bin: run pnpm install first");
  process.exit(1);
}
const dirs = new Map();
for (const [i, s] of all.entries()) {
  if (s.refused !== undefined) continue;
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
for (const [dir, files] of dirs) {
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ extends: "../../scripts/tsconfig.docs.json", files: files.map((f) => relative(dir, f)) }, null, 2),
  );
  const r = spawnSync(tsc, ["-p", join(dir, "tsconfig.json")], { encoding: "utf8" });
  if (r.status !== 0) {
    failed++;
    console.log(`typecheck failed in ${relative(root, dir)}:\n${r.stdout}${r.stderr}`);
    for (const s of all) if (s.path !== undefined && r.stdout.includes(relative(dir, s.path))) console.log(`  ${relative(dir, s.path)} is ${s.file}:${s.line}`);
  }
}

try {
  for (const s of all) {
    if (s.refused !== undefined) {
      failed++;
      console.log(`FAIL ${s.file}:${s.line} is fenced \`${s.refused}\`: a sample is fenced \`ts\``);
      continue;
    }
    if (s.output === undefined) {
      failed++;
      console.log(`FAIL ${s.file}:${s.line} has no \`text output\` block after it`);
      continue;
    }
    // Each sample gets a fresh stand-in door, so no sample sees another's requests.
    const door = await startDoor();
    const env = { SELLER_DOOR_URL: door.url, SELLER_CREDENTIAL: CREDENTIAL, DATABASE_URL: database };
    for (const name of ["PATH", "HOME", "TMPDIR"]) if (process.env[name] !== undefined) env[name] = process.env[name];
    const r = await run(s.path, dirname(s.path), env, s.server);
    door.stop();
    const ok = r.code === 0;
    const got = r.stdout.replace(/\s+$/, "");
    const matches = got === s.output.replace(/\s+$/, "");
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
