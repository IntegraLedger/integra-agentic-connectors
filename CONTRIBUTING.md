# Contributing

Thank you for helping. This file says how to build and test the repository, what a change must carry, and how it is
reviewed.

## Before you start

Open an issue for anything beyond a small fix, so the change can be agreed before you write it. A change to the seller
door's contract (`contract/openapi.json`, the types, the refusal table or the vectors) changes what every connector and
every door implementation speaks: describe it in the issue first.

## Build and test

You need Node.js `>=26.10.0`, pnpm (the version in `package.json`'s `packageManager`), and Postgres for the
facilitator's tests.

```sh
pnpm install --frozen-lockfile
pnpm -r --if-present run build
pnpm -r --if-present run typecheck
INTEGRA_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres pnpm -r --if-present run test
```

Each facilitator test file creates and drops its own database on the server `INTEGRA_DATABASE_URL` names.

## Every sample is checked

Every TypeScript sample in a README or in `docs/` is type-checked and run against the packages built in the same
commit, and its printed output is compared with the output shown under it. The documentation site type-checks the
same samples again with Twoslash when it builds. Run the checks after the build:

```sh
node scripts/docs.mjs --check
DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres node scripts/samples.mjs
```

The pages in `docs/reference/` that `scripts/docs.mjs` writes, and the API pages in `docs/reference/api/` that
`pnpm run api` writes in `website/`, are generated: change their sources, then regenerate them.

A sample that talks to the seller door runs against `scripts/stand-in-door.mjs`, which answers from the contract's
vectors. A sample that needs a chain uses a local stand-in or the package's own vectors, and says so.

## What a change carries

- **Tests whose expected values come from outside the code:** a public specification, a published vector, a recorded
  answer from a real network, or a value computed with a standard tool (`sha256sum`, `openssl dgst`). Never a
  snapshot of the code's own output.
- **The vectors, where the contract changes.** Each vector's `source` names the command or specification each
  expected value comes from.
- **No new dependency** unless the issue agreed it. Every version is pinned exactly.
- **Comments that say what the code does.**
- **No business or legal logic.** The door and the facilitator check that a payment is bound to its ATR and carry
  nothing else.

## Sign your commits

Every commit carries a [Developer Certificate of Origin](https://developercertificate.org) sign-off. By signing off
you certify that you wrote the change or have the right to submit it under the project's license.

```sh
git commit -s -m "contract: describe the change"
```

`-s` adds the trailer `Signed-off-by: Your Name <you@example.com>`, matching your Git identity. CI checks every pushed
commit for it and refuses a commit without one. To sign off commits you already made on your branch:

```sh
git rebase --signoff origin/main
```

## Pull requests

Keep a pull request to one change. CI builds, type-checks and tests every package, checks the one-way imports (the
packages here import only `@integraledger/lcp` from the `@integraledger` scope), checks every sample, and checks
every commit's sign-off.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](./LICENSE).
