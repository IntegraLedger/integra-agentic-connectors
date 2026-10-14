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
  (`pnpm run api`), whose supported TypeScript range ends at 6.0. Hovering, focusing or clicking an identifier in a
  checked block shows its type and documentation: the build writes each page's distinct popups to
  `/twoslash/<path>.json`, which the page fetches when a reader first opens one.
- Renders each ```` ```mermaid ```` block to SVG with the `mermaid` package, in a headless Google Chrome, once in a
  light and once in a dark theme. Both SVGs are in the page's HTML, and the page shows the one for the reader's
  theme; no diagram code runs in the browser.
- Writes `/llms.txt`, `/llms-full.txt`, each page as Markdown at `/md/<path>.md`, each page's social card (1200×630)
  at `/og/<path>/image.png` (`/og/image.png` for the home page), the search index, `sitemap.xml`, `robots.txt` and
  `/.well-known/security.txt`.

## How it is served

`wrangler.toml` serves `out/` as a Worker's static assets, with `worker.js` in front of the page addresses and their
`.md` addresses only:

- `/<path>.md`, and `/index.md` for the home page, answer with the page's Markdown copy (the address
  [llmstxt.org](https://llmstxt.org) proposes). `/llms.txt` links each page there.
- A request for a page whose `Accept` header ranks `text/markdown` (or `text/x-markdown`) at least as high as
  `text/html` gets the same Markdown at the page's own address; `text/plain` is not a Markdown type and gets HTML. A
  page address that ends in a slash redirects to the address without it, for Markdown as for HTML. Every response for
  a page address carries `Vary: Accept`, and a conditional request for a Markdown copy can be answered 304.
- Every other file is served directly, without the Worker: the Markdown copies, the scripts, and every `.txt` file,
  the RSC payload each page fetches among them. Every response the Worker returns is a static assets response, so the
  rules in `public/_headers` apply to all of them.

Each page names `/llms.txt` with `<link rel="describedby">` and its Markdown with `<link rel="alternate"
type="text/markdown">`. `pnpm dev` does not run `worker.js`.
