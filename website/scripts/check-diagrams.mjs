#!/usr/bin/env node
// Checks that the site's Mermaid diagrams are drawn in the pinned browser and font alone (src/mdx/mermaid.ts), with the
// site's own rehype plugin as the site's build compiles it into .source/:
// - every diagram of every page gives the same SVGs when this process runs under a font configuration that changes
//   every font's rendering (full hinting by the autohinter, no antialiasing). The browser runs with a font
//   configuration of its own, so nothing of this process's reaches a diagram;
// - a diagram with a character Inter does not draw is refused, naming it: U+4E2D, a Han character (Inter covers the
//   Latin, Greek and Cyrillic scripts);
// - the built site serves the font files the diagrams are drawn in, byte for byte, so a reader sees each diagram in
//   the font it is measured in.
//
// Usage, from website/, after `pnpm run browser` and `pnpm build` there:
//   node scripts/check-diagrams.mjs
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import config from "../.source/source.config.mjs";
import { DOCS_DIR } from "../src/lib/docs-dir.ts";

const plugins = config.mdxOptions?.rehypePlugins?.([]) ?? [];
const rehypeMermaid = plugins.find((p) => typeof p === "function" && p.name === "rehypeMermaid");
if (!rehypeMermaid) {
  console.error(".source/source.config.mjs gives no rehypeMermaid: run pnpm build in website/ first");
  process.exit(1);
}

/** The pages' Markdown files under the documentation folder. */
function pages(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return pages(path);
    return e.name.endsWith(".md") ? [path] : [];
  });
}

/** The SVGs the site's plugin gives for the charts, as `light` and `dark` attribute values. */
async function draw(charts) {
  const tree = {
    type: "root",
    children: charts.map((chart) => ({
      type: "element",
      tagName: "pre",
      properties: {},
      children: [
        {
          type: "element",
          tagName: "code",
          properties: { className: ["language-mermaid"] },
          children: [{ type: "text", value: chart }],
        },
      ],
    })),
  };
  await rehypeMermaid()(tree);
  return tree.children.map((node) => node.attributes?.map((a) => `${a.name}=${a.value}`).join("\n"));
}

const failures = [];
const charts = new Map();
for (const page of pages(DOCS_DIR).sort()) {
  const found = [...readFileSync(page, "utf8").matchAll(/^```mermaid\n([\s\S]*?)\n```/gm)].map((m) => m[1] ?? "");
  if (found.length > 0) charts.set(relative(DOCS_DIR, page), found);
}
if (charts.size === 0) failures.push(`no page under ${DOCS_DIR} has a Mermaid diagram`);

const plain = new Map();
for (const [page, found] of charts) plain.set(page, await draw(found));

const scratch = mkdtempSync(join(tmpdir(), "check-diagrams-"));
const before = process.env.FONTCONFIG_FILE;
try {
  const conf = join(scratch, "fonts.conf");
  writeFileSync(
    conf,
    `<?xml version="1.0"?>
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <match target="font">
    <edit name="hinting" mode="assign"><bool>true</bool></edit>
    <edit name="autohint" mode="assign"><bool>true</bool></edit>
    <edit name="hintstyle" mode="assign"><const>hintfull</const></edit>
    <edit name="antialias" mode="assign"><bool>false</bool></edit>
  </match>
</fontconfig>
`,
  );
  process.env.FONTCONFIG_FILE = conf;
  for (const [page, found] of charts) {
    const changed = await draw(found);
    plain.get(page)?.forEach((svgs, i) => {
      if (changed[i] !== svgs) failures.push(`${page}: diagram ${i + 1} draws differently under another font configuration`);
    });
  }
} finally {
  if (before === undefined) delete process.env.FONTCONFIG_FILE;
  else process.env.FONTCONFIG_FILE = before;
  rmSync(scratch, { recursive: true, force: true });
}

const refused = await draw(['flowchart LR\n  A["中"]']).then(
  () => "drawn",
  (e) => String(e?.message ?? e),
);
if (!refused.includes('U+4E2D "中"')) failures.push(`a diagram with U+4E2D is not refused by name: ${refused}`);

const fonts = dirname(createRequire(import.meta.url).resolve("@fontsource-variable/inter/wght.css"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const served = new Set(
  readdirSync("out/_next/static/media")
    .filter((f) => f.endsWith(".woff2"))
    .map((f) => sha256(readFileSync(join("out/_next/static/media", f)))),
);
const files = readdirSync(join(fonts, "files")).filter((f) => f.endsWith("-wght-normal.woff2"));
for (const f of files) {
  if (!served.has(sha256(readFileSync(join(fonts, "files", f))))) failures.push(`out/_next/static/media serves no copy of ${f}`);
}

if (failures.length > 0) {
  for (const f of failures) console.log(f);
  process.exit(1);
}
const count = [...charts.values()].reduce((n, c) => n + c.length, 0);
console.log(
  `${count} diagrams on ${charts.size} pages draw the same under another font configuration, U+4E2D is refused, ` +
    `and out/ serves the ${files.length} font files they are drawn in`,
);
