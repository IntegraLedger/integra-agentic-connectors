# Security policy

## Reporting a vulnerability

Report a vulnerability privately, through GitHub's
[private vulnerability reporting](https://github.com/IntegraLedger/integra-agentic-connectors/security/advisories/new)
on this repository. Do not open a public issue or pull request for it.

Include:

- the package and version affected;
- the smallest request or input that shows the problem, and what the package returned;
- what the problem allows, and under which conditions.

The maintainers acknowledge the report in the advisory, work on a fix with you there, and publish the advisory with
the fixed release. Credit is given to the reporter unless you ask otherwise.

## Supported versions

Security fixes are released for the latest published version of each package.

## What counts

- `@integraledger/agentic-connectors`: the seller door's contract, its types and its vectors. A vulnerability is a
  vector, schema or type that, followed as written, has the door's `claim` pass a payment that does not carry the
  record's ATR hash, or has `status` report a record or a proof that the stored ATR and the payment do not show.
- `@integraledger/profile-facilitator`: the x402 facilitator for the Tron and Polkadot LCP profiles. A vulnerability
  is anything that breaks its duties:
  - `/verify` answering `isValid: true` for a transaction that carries no ATR hash where its profile places it (the
    Tron memo, the Polkadot remark), that does not transfer the required `amount` of `asset` to `payTo` on the
    required `network`, or that the payer did not sign;
  - `/settle` submitting bytes other than the ones the payer signed, settling one payment more than once, or answering
    `success: true` for a transaction the network does not show as settled;
  - a crafted request that makes it use unbounded memory or time.

## What does not

By design, neither package checks amount, payee, asset, timing or payer against the ATR's content. The facilitator
holds no key and pays no fee. It has no authentication of its own, and is meant to be served on a private interface to
the resource servers that use it. A report that relies on one of these is not a vulnerability in these packages.

## Bugs that are not vulnerabilities

Open a [public issue](https://github.com/IntegraLedger/integra-agentic-connectors/issues).
