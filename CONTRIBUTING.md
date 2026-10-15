# Contributing

Thank you for helping. This file says how to build and test the repository, what a change must carry, and how it is
reviewed.

## Before you start

Open an issue for anything beyond a small fix, so the change can be agreed before you write it. A change to the seller
door's contract (`contract/openapi.json`, the types, the refusal table or the vectors) changes what every connector and
every door implementation speaks: describe it in the issue first.

## Build and test

You need Node.js `26.11.1` (see `.node-version`), pnpm (the version in `package.json`'s `packageManager`), and
Postgres for the facilitator's tests. CI and the publish workflow take Node.js as `node-v26.11.1-linux-x64.tar.xz` from
`nodejs.org/dist`, checked against the SHA-256 the workflow holds, and pnpm as two tarballs checked against their
SHA-512.

```sh
pnpm install --frozen-lockfile
pnpm -r --if-present run build
pnpm -r --if-present run typecheck
INTEGRA_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres pnpm -r --if-present run test
```

Each facilitator test file creates and drops its own database on the server `INTEGRA_DATABASE_URL` names.

## Every sample is checked

`scripts/samples.mjs` reads every README and every page in `docs/` as CommonMark reads them, with
`mdast-util-from-markdown`. Every TypeScript sample there, a code block fenced `ts` wherever it stands, in a list item
or a block quote too, is type-checked and run against the packages built in the same commit, and its printed output is
compared with the fenced `text output` block that follows it in the same container; a sample without that block fails,
and so does a block fenced in a TypeScript or JavaScript language other than `ts` (`tsx`, `js`, …). The documentation
site type-checks the same samples again with Twoslash when it builds. Run the checks after the build, with
`DATABASE_URL` naming a Postgres database, which the facilitator's samples write to:

```sh
node scripts/docs.mjs --check
DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres node scripts/samples.mjs
```

The pages in `docs/reference/` that `scripts/docs.mjs` writes, and the API pages in `docs/reference/api/` that
`pnpm run api` writes in `website/`, are generated: change their sources, then regenerate them.

A sample that talks to the seller door runs against `scripts/stand-in-door.mjs`, which answers from the contract's
vectors. A sample that needs a chain uses a local stand-in or the package's own vectors, and says so.

The documentation site in `website/` builds with `pnpm install --frozen-lockfile && pnpm run browser && pnpm build`
inside that folder, on Linux x64. `pnpm run browser` fetches the browser build the Mermaid diagrams are drawn in and
the pages are checked in, Chrome Headless Shell, which `website/scripts/browser.mjs` pins by version and by the SHA-256
of its archive, and the build refuses any other. The build is pinned for Linux x64 alone, since a browser build for
another platform measures text through that platform's own font engine, so the site is built in CI or on a
maintainer's Linux x64 machine.

The site checks its own build. In `website/`, after `pnpm build` there:

- `node scripts/check-highlighting.mjs` highlights a TypeScript sample and a JavaScript sample with the options
  `source.config.ts` gives the code highlighter: once with the clock as it is, and once with a clock that moves 600 ms
  at every read while a sample is tokenized and its Twoslash popups are highlighted. It checks that both give the same
  HTML, and that `const` and `myObject` take github-light-default's colours. Each line is tokenized to its end however
  long that takes (`tokenizeTimeLimit: 0`), so a busy machine colours the code as an idle one does. It also checks
  that no other source under `website/` imports a module that highlights code.
- `node scripts/check-diagrams.mjs` draws every Mermaid diagram in the pages twice, the second time under a font
  configuration that changes every font's rendering, and checks that both give the same SVGs. It checks that a
  diagram with a character Inter does not draw is refused, and that the site serves the Inter files the diagrams are
  drawn in.
- Two builds of one commit are byte-equal. The build ID, which every page carries and which names the folder of the
  build's manifests under `/_next/static/`, is the commit's sha (`website/next.config.ts`); with uncommitted changes
  it is the sha and a digest of those changes. The Mermaid diagrams are drawn in the browser build and the font the
  repository pins, with no font of the machine's. CI's site job checks it with the step "Two builds of one commit are
  byte-equal", which fetches the browser again, builds again and compares the two `website/out` trees with `diff -r`.
  To check it, in `website/`:

  ```sh
  first=$(mktemp -d) && pnpm build && mv out "$first/out" && rm -rf .next && pnpm build && diff -r --brief "$first/out" out
  ```

## What a change carries

- **Tests whose expected values come from outside the code:** a public specification, a published vector, a recorded
  answer from a real network, or a value computed with a standard tool (`sha256sum`, `openssl dgst`). Never a
  snapshot of the code's own output.
- **The vectors, where the contract changes.** Each vector's `source` names the command or specification each
  expected value comes from.
- **No new dependency** unless the issue agreed it. Every dependency and devDependency is pinned exactly. Peer
  dependencies are ranges: `@integraledger/lcp` is a peer of both packages, with an exact devDependency for their own
  tests, so an application and these packages share one copy of lcp.
- **Comments that say what the code does.**
- **No business or legal logic.** The door checks that a payment is bound to its ATR, and the facilitator that it
  carries an ATR hash in its profile's form; neither judges amount, payee, asset, timing or payer against the ATR's
  content.

## Sign your commits

Every commit carries a [Developer Certificate of Origin](https://developercertificate.org) sign-off. By signing off
you certify that you wrote the change or have the right to submit it under the project's license.

```sh
git commit -s -m "contract: describe the change"
```

`-s` adds the trailer `Signed-off-by: Your Name <you@example.com>`, matching your Git identity. On every push to
`main`, CI reads every commit in `main`'s history and fails if a commit has no `Signed-off-by:` trailer or its message
matches the agent pattern in `.github/workflows/ci.yml` (`Co-authored-by`, `generated with` and the names it lists, in
upper or lower case). It runs after the push and cannot hold a commit back, so sign off every commit before you open a
pull request. To sign off commits you already made on your branch:

```sh
git rebase --signoff origin/main
```

## Pull requests

Keep a pull request to one change. On every push to `main`, when dispatched by hand, and before the publish workflow
packs, CI builds, type-checks and tests every package, and fails on a package in the workspace without a `build`,
`typecheck` or `test` script. It checks the one-way imports (the packages here depend on and name only
`@integraledger/lcp` from the `@integraledger` scope), that every job that runs a step fetches the version
`.node-version` names before it and checks its SHA-256, the install policy in both `pnpm-workspace.yaml` files, both
lockfiles and the workflows, every sample, and every commit's sign-off. The Node.js check reads the jobs' steps only
outside a block scalar (`run: |`), and refuses a workflow line that is not in YAML's plain block style, such as a quoted
value that does not close on its own line or a block scalar whose header holds more than its indicators and a comment.
The install-policy check reads the committed files and the workflows' lines. A workflow step that rewrites a checked
file before the install, such as a `sed -i` on `pnpm-workspace.yaml`, or that builds a setting's name at run time, is
code, like a step that deletes the check, and the check does not read it. No workflow runs on `pull_request`, and no
check is required before a merge, so CI reads a change once it is on `main`.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](./LICENSE).
