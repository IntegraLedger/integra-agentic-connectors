// Loads every page of the built site in a headless Google Chrome, served on 127.0.0.1 as wrangler.toml serves it:
// worker.js first for the addresses run_worker_first names, the files of out/ for the rest, with the rules in
// public/_headers. Each page, an address no page has (the 404 page), a page's Twoslash popup and a search are
// checked. The check fails when a response for a page carries any Content-Security-Policy other than the page's own
// in csp.json, when a page reports a policy violation, a script error or an error on the console, or when a page
// carries an `a` element with no accessible name. Run it after `pnpm build`.
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { withChrome } from "../src/lib/chrome.ts";
import worker from "../worker.js";

const website = join(import.meta.dirname, "..");
const out = join(website, "out");
const policies = JSON.parse(readFileSync(join(website, "csp.json"), "utf8"));

/** The rules of public/_headers: each path pattern with the headers it sets. */
function headerRules() {
  const rules = [];
  for (const line of readFileSync(join(website, "public/_headers"), "utf8").split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) rules.push({ pattern: line.trim(), headers: [] });
    else rules.at(-1)?.headers.push(line.trim().split(/:\s*(.*)/s).slice(0, 2));
  }
  return rules;
}

/** Whether a path matches a pattern in which `*` stands for any characters, `/` among them. */
function matches(pattern, path) {
  const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`).test(path);
}

/** The patterns of wrangler.toml's run_worker_first. */
function workerFirst() {
  const toml = readFileSync(join(website, "wrangler.toml"), "utf8");
  const list = /^run_worker_first\s*=\s*\[([^\]]*)\]/m.exec(toml)?.[1];
  if (list === undefined) throw new Error("wrangler.toml has no run_worker_first list");
  return [...list.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

const rules = headerRules();
const firstPatterns = workerFirst();
const runsWorkerFirst = (path) =>
  firstPatterns.some((p) => !p.startsWith("!") && matches(p, path)) &&
  !firstPatterns.some((p) => p.startsWith("!") && matches(p.slice(1), path));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml",
};
const isFile = (path) => statSync(path, { throwIfNoEntry: false })?.isFile() === true;

/**
 * The static assets: a path names its file, `<path>.html` or `<path>/index.html`; a page address ending in a slash
 * redirects to the address without it; any other path answers out/404.html with 404. The _headers rules that match
 * the path are applied.
 */
const ASSETS = {
  async fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname);
    if (path.length > 1 && path.endsWith("/") && isFile(join(out, `${path.slice(0, -1)}.html`))) {
      return new Response(null, { status: 307, headers: { location: path.slice(0, -1) } });
    }
    const candidates = [join(out, path), join(out, `${path}.html`), join(out, path, "index.html")];
    const file = path.includes("..") ? undefined : candidates.find(isFile);
    const served = file ?? join(out, "404.html");
    const headers = new Headers({ "content-type": TYPES[extname(served)] ?? "application/octet-stream" });
    for (const rule of rules.filter((r) => matches(r.pattern, path))) {
      for (const [name, value] of rule.headers) headers.set(name, value);
    }
    const body = request.method === "HEAD" ? null : readFileSync(served);
    return new Response(body, { status: file ? 200 : 404, headers });
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const request = new Request(url, { method: req.method, headers: req.headers });
  const response = runsWorkerFirst(url.pathname) ? await worker.fetch(request, { ASSETS }) : await ASSETS.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const failures = [];
const fail = (address, what) => failures.push(`${address}: ${what}`);
/** The number of `a` elements on each address visited. */
const linkCounts = new Map();

/** The reasons Chrome gives for leaving a node out of the accessibility tree because no reader is shown it. */
const HIDDEN = new Set([
  "notRendered",
  "notVisible",
  "ariaHiddenElement",
  "ariaHiddenSubtree",
  "inertElement",
  "inertSubtree",
]);

/**
 * The number of `a` elements on the open page, and the opening tag of each one that has no accessible name, as
 * Chrome's accessibility tree computes the name. An `a` element the tree leaves out because it is hidden from every reader needs no name; every
 * other `a` element needs one. Chrome computes no name for an element whose layout `content-visibility: auto` skips,
 * so each such element is laid out while the names are read, and set back afterwards.
 */
async function namelessLinks(page) {
  await page.evaluate(async () => {
    window.__skipped = [...document.querySelectorAll("*")]
      .filter((e) => getComputedStyle(e).contentVisibility === "auto")
      .map((e) => [e, e.style.contentVisibility]);
    for (const [e] of window.__skipped) e.style.contentVisibility = "visible";
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const links = new Set();
    const collect = (node) => {
      if (node.nodeName === "A") links.add(node.backendNodeId);
      for (const child of node.children ?? []) collect(child);
    };
    collect(root);
    const nameless = [];
    for (const id of links) {
      const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { backendNodeId: id, fetchRelatives: false });
      const node = nodes.find((n) => n.backendDOMNodeId === id);
      if (node?.ignored && node.ignoredReasons?.some((reason) => HIDDEN.has(reason.name))) continue;
      if (String(node?.name?.value ?? "").trim() !== "") continue;
      const { outerHTML } = await cdp.send("DOM.getOuterHTML", { backendNodeId: id });
      const tag = outerHTML.slice(0, outerHTML.indexOf(">") + 1);
      nameless.push(node ? tag : `${tag} (no accessibility node)`);
    }
    return { checked: links.size, nameless };
  } finally {
    await cdp.detach();
    await page.evaluate(() => {
      for (const [e, inline] of window.__skipped) e.style.contentVisibility = inline;
    });
  }
}

/** Records each policy violation the page reports, from its first script on. */
function recordViolations() {
  window.__violations = [];
  document.addEventListener("securitypolicyviolation", (e) =>
    window.__violations.push(`${e.effectiveDirective} blocked ${e.blockedURI || "inline"}`),
  );
}

try {
  await withChrome("The pages are checked", async (context) => {
    await context.addInitScript(recordViolations);

    /** Opens an address, checks its policy and errors, runs `then` on the open page, and closes it. */
    async function visit(address, policy, status, then) {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(`script error: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        // A 404 page's own load is reported as a failed resource.
        if (status === 404 && m.text().includes("404")) return;
        errors.push(`console: ${m.text()}`);
      });
      try {
        const response = await page.goto(`${origin}${address}`, { waitUntil: "networkidle" });
        if (response?.status() !== status) fail(address, `answered ${response?.status()}, expected ${status}`);
        const csp = await response?.headerValue("content-security-policy");
        if (csp !== policy) fail(address, "served without the page's own Content-Security-Policy");
        const links = await namelessLinks(page);
        linkCounts.set(address, links.checked);
        for (const tag of links.nameless) fail(address, `an a element with no accessible name: ${tag}`);
        if (then) await then(page).catch((e) => fail(address, `${e.message.split("\n")[0]}`));
        for (const v of await page.evaluate(() => window.__violations)) fail(address, `policy violation: ${v}`);
        for (const e of errors) fail(address, e);
      } finally {
        await page.close();
      }
    }

    const addresses = Object.keys(policies.pages).sort();
    for (const address of addresses) await visit(address, policies.pages[address], 200);
    await visit("/no-such-page", policies.notFound, 404);

    // A Twoslash popup: its trigger fetches the page's popups and shows one.
    await visit("/getting-started", policies.pages["/getting-started"], 200, async (page) => {
      await page.locator(".twoslash-hover[data-popup]").first().hover();
      await page.locator("#twoslash-popup").waitFor({ state: "visible", timeout: 10_000 });
    });

    // A search: the dialog loads the index from /api/search and lists the pages that match.
    await visit("/", policies.pages["/"], 200, async (page) => {
      await page.getByRole("button", { name: /search/i }).first().click();
      await page.getByRole("dialog").locator("input").fill("seller door");
      await page.getByRole("dialog").getByRole("option").first().waitFor({ timeout: 10_000 });
    });

    const links = [...linkCounts.values()].reduce((sum, n) => sum + n, 0);
    console.log(
      failures.length === 0
        ? `${addresses.length} pages, the 404 page, a Twoslash popup and a search load under their own Content-Security-Policy with no violation and no error, and each of the ${links} a elements on these pages has a name`
        : failures.join("\n"),
    );
  });
} finally {
  server.close();
}
process.exitCode = failures.length === 0 ? 0 : 1;
