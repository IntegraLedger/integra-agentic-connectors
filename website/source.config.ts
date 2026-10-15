import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { rehypeCodeDefaultOptions } from "fumadocs-core/mdx-plugins";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { transformerTwoslash } from "fumadocs-twoslash";
import { DOCS_DIR } from "./src/lib/docs-dir";
import { hasMetaFlag, rehypeMermaid, rehypeTwoslashPopups, rehypeUncheckedUnder } from "./src/mdx/rehype-docs";
import { remarkDocLinks, remarkHtmlAnchors, remarkStripLeadingTitle } from "./src/mdx/remark-docs";

// `next build`, `next dev` and `fumadocs-mdx` run in website/.
const repoRoot = resolve(process.cwd(), "..");
const docsDir = resolve(process.cwd(), DOCS_DIR);
const apiDir = resolve(docsDir, "reference/api");
const contractTypes = resolve(repoRoot, "contract/dist");
const facilitatorTypes = resolve(repoRoot, "profile-facilitator/dist");
// @integraledger/lcp as the contract package resolves it: the workspace's link or the installed package.
const lcpTypes = resolve(repoRoot, "contract/node_modules/@integraledger/lcp/dist");

for (const [dir, name] of [
  [contractTypes, "@integraledger/agentic-connectors"],
  [facilitatorTypes, "@integraledger/profile-facilitator"],
  [lcpTypes, "@integraledger/lcp"],
] as const) {
  if (!existsSync(resolve(dir, "index.d.ts"))) {
    throw new Error(
      `${dir}/index.d.ts is missing: install and build the packages first (pnpm install --frozen-lockfile && pnpm -r --if-present run build at the repository root); it is ${name}'s`,
    );
  }
}

export const docs = defineDocs({
  dir: DOCS_DIR,
  docs: {
    lastModified: true,
    postprocess: {
      // Each page's Markdown after the remark plugins, served by /md, /llms-full.txt and the
      // page's copy button.
      includeProcessedMarkdown: { headingIds: false },
    },
  },
});

// The TypeScript samples are checked as ES modules (top-level await allowed) under these strict
// options, in tsconfig.json form, with each package's imports resolved to its built declarations.
const compilerOptions = {
  module: "nodenext",
  moduleResolution: "nodenext",
  target: "es2024",
  lib: ["es2024", "dom"],
  types: ["node"],
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  verbatimModuleSyntax: true,
  skipLibCheck: true,
  paths: {
    "@integraledger/agentic-connectors": [`${contractTypes}/index.d.ts`],
    "@integraledger/profile-facilitator": [`${facilitatorTypes}/index.d.ts`],
    "@integraledger/lcp": [`${lcpTypes}/index.d.ts`],
    "@integraledger/lcp/*": [`${lcpTypes}/*.d.ts`],
  },
};

/** Whether a code block is type-checked: a `ts` block whose meta does not carry `no-check`. */
function isChecked(lang: string, meta: unknown): boolean {
  return (lang === "ts" || lang === "typescript") && !hasMetaFlag(meta, "no-check");
}

export default defineConfig({
  mdxOptions: {
    remarkPlugins: (plugins) => [
      remarkStripLeadingTitle,
      remarkHtmlAnchors,
      [
        remarkDocLinks,
        {
          docsDir,
          repoRoot,
          githubUrl: "https://github.com/IntegraLedger/integra-agentic-connectors",
          branch: "main",
        },
      ],
      ...plugins,
    ],
    rehypePlugins: (plugins) => [
      [rehypeUncheckedUnder, [apiDir]],
      rehypeMermaid,
      ...plugins,
      rehypeTwoslashPopups,
    ],
    rehypeCodeOptions: {
      // Every text colour of these two themes is at least 4.5:1 on its code background (global.css):
      // white in light mode, the card colour in dark mode.
      themes: { light: "github-light-default", dark: "github-dark-default" },
      // Every line is tokenized to its end. With a time limit (Shiki's default is 500 ms), a line that takes longer,
      // as a first line does while the grammar compiles on a busy machine, stops early and the rest of it takes one
      // colour, so one page could build with different colours. The Twoslash popups highlight with these options.
      tokenizeTimeLimit: 0,
      transformers: [
        ...(rehypeCodeDefaultOptions.transformers ?? []),
        transformerTwoslash({
          // Every `ts` block is checked unless its meta carries `no-check`; a type error
          // fails the build.
          filter: (lang, _code, options) => isChecked(lang, options.meta?.__raw),
          throws: true,
          twoslashOptions: { compilerOptions },
        }),
      ],
    },
  },
});
