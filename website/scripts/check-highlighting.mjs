#!/usr/bin/env node
// Checks the site's code highlighting, run with the options source.config.ts gives rehype-code, as the site's build
// compiles them into .source/:
// - one block gives one result, however long tokenizing takes. Each block is highlighted with the clock as it is, and
//   again with a clock that moves 600 ms at every read while the block is tokenized and its Twoslash popups are
//   highlighted, as a busy machine can show it. The two results are the same HTML;
// - two tokens take github-light-default's light colours, whose `storage.type` scope is #CF222E and whose
//   `variable.other.constant` scope is #0550AE (primer/github-vscode-theme): `const` in a checked TypeScript block
//   and `myObject` in a JavaScript one.
//
// Usage, from website/, after `pnpm build` there (the TypeScript block is checked against @integraledger/lcp as the
// contract package resolves it):
//   node scripts/check-highlighting.mjs
import { rehypeCode } from "fumadocs-core/mdx-plugins";
import { toHtml } from "hast-util-to-html";
import config from "../.source/source.config.mjs";

const options = config.mdxOptions?.rehypeCodeOptions;
if (!options) {
  console.error(".source/source.config.mjs gives no rehypeCodeOptions: run pnpm build in website/ first");
  process.exit(1);
}

// A clock that moves 600 ms at every read while `slow` is set. Shiki's tokenizer reads Date.now() at each step of a
// line to enforce `tokenizeTimeLimit`.
const now = Date.now;
let slow = false;
let offset = 0;
Date.now = () => now() + (slow ? (offset += 600) : offset);
let slowBlock = false;
const clock = {
  name: "check-highlighting:clock",
  enforce: "post",
  // After every other transformer's preprocess (Twoslash's included), before tokenizing.
  preprocess() {
    slow = slowBlock;
  },
  // After the code hooks, where Twoslash highlights its popups.
  root() {
    slow = false;
  },
};

const blocks = [
  {
    // contract/README.md's sample that lists the pairings lcp registers.
    lang: "ts",
    code: [
      'import { BINDINGS } from "@integraledger/lcp";',
      "",
      "const ids = BINDINGS.map((b) => b.id);",
      'console.log(ids.length, ids.includes("x402/exact/eip155/eip3009"), ids.includes("card/seller-reference"));',
    ].join("\n"),
    token: "const",
    light: "#CF222E",
  },
  {
    lang: "js",
    code: ["const myObject = {};", "Error.captureStackTrace(myObject);", "myObject.stack;"].join("\n"),
    token: "myObject",
    light: "#0550AE",
  },
];

/** The block as rehype-code renders it, as HTML. */
async function highlight({ lang, code }, slowClock) {
  const tree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "pre",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "code",
            properties: { className: [`language-${lang}`] },
            children: [{ type: "text", value: code }],
          },
        ],
      },
    ],
  };
  slowBlock = slowClock;
  await rehypeCode({ ...options, transformers: [...(options.transformers ?? []), clock] })(tree, {});
  slowBlock = false;
  return toHtml(tree);
}

const failures = [];
for (const block of blocks) {
  const html = await highlight(block, false);
  const slowHtml = await highlight(block, true);
  if (slowHtml !== html) {
    let at = 0;
    while (html[at] === slowHtml[at]) at++;
    failures.push(
      `${block.lang}: the block highlights differently when tokenizing is slow, from character ${at}:\n` +
        `  ${html.slice(Math.max(0, at - 80), at + 120)}\n  ${slowHtml.slice(Math.max(0, at - 80), at + 120)}`,
    );
  }
  for (const [name, out] of [
    ["", html],
    [" when tokenizing is slow", slowHtml],
  ]) {
    const found = new RegExp(`--shiki-light:(#[0-9A-Fa-f]{6})[^>]*>\\s*${block.token}<`).exec(out);
    if (found?.[1].toUpperCase() !== block.light) {
      const colour = found?.[1] ?? "(not found)";
      failures.push(`${block.lang}: \`${block.token}\` is light ${colour}${name}, not ${block.light}`);
    }
  }
}
Date.now = now;
if (failures.length > 0) {
  for (const f of failures) console.log(f);
  process.exit(1);
}
console.log(
  `${blocks.length} blocks (${blocks.map((b) => b.lang).join(", ")}) highlight the same with a slow clock, ` +
    `and ${blocks.map((b) => `\`${b.token}\` is light ${b.light}`).join(" and ")}`,
);
