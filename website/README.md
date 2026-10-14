# Documentation site

The app that renders the repository's documentation as the site at <https://connectors.integraledger.com>: Fumadocs on
Next.js, exported as static files and served by Cloudflare as a Worker's static assets. The content lives in the
Markdown files under `../docs/`; this folder holds only the app. The documentation folder is named once, in
[`src/lib/docs-dir.ts`](src/lib/docs-dir.ts).

This folder has its own lockfile and is not part of the repository's pnpm workspace.

## Run it

The TypeScript samples in the pages are type-checked against the packages' built declarations, so install and build
the packages first, at the repository root:

```sh
pnpm install --frozen-lockfile
pnpm -r --if-present run build
```

The build renders the Mermaid diagrams in Google Chrome. Set `CHROME_PATH` to a Chrome or Chromium executable if
Chrome is not installed where Playwright looks for it.

Then, in this folder:

```sh
pnpm install --frozen-lockfile
pnpm run api     # regenerate the API pages (reference/api/ in the documentation folder) from ../contract/src and ../profile-facilitator/src
pnpm build       # write the static site to out/
pnpm dev         # serve it locally with live reload
```

## What the build does

- Renders every page under the documentation folder, in the order its `meta.json` files give. The home page is
  `index.md`.
- Drops each page's leading `# Title` (the page layout shows the frontmatter title).
- Turns relative links to `.md` pages into site links, and relative links to any other file in the repository into
  links to that file on GitHub. A link to a page that does not exist fails the build.
- Type-checks every ```` ```ts ```` block with Twoslash, against `../contract/dist`, `../profile-facilitator/dist`
  and the `@integraledger/lcp` the contract package resolves; a type error fails the build. A block whose meta carries
  `no-check` is highlighted only. Blocks in the generated API pages are not checked. Twoslash runs on the
  TypeScript 7 that `fumadocs-twoslash` depends on; the TypeScript 6.0.3 in `devDependencies` is for TypeDoc
  (`pnpm run api`), whose supported TypeScript range ends at 6.0.
- Renders each ```` ```mermaid ```` block to SVG with the `mermaid` package, in a headless Google Chrome, once in a
  light and once in a dark theme. Both SVGs are in the page's HTML, and the page shows the one for the reader's
  theme; no diagram code runs in the browser.
- Writes `/llms.txt`, `/llms-full.txt`, each page as Markdown at `/md/<path>.md`, the search index, `sitemap.xml`,
  `robots.txt` and `/.well-known/security.txt`.
