# Security policy

## Reporting a vulnerability

Report a vulnerability privately, through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository: open the **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a
vulnerability.

Include what you can of:

- the package and version affected;
- what an attacker can do, and under what conditions;
- the steps or code that show it.

We acknowledge a report, keep you informed as we investigate, and credit you in the advisory unless you ask us not
to.

## Bugs

Report a bug that is not a vulnerability in a
[public issue](https://github.com/IntegraLedger/integra-agentic-connectors/issues).

## Supported versions

Fixes are made on the latest release of each package.

## Scope

- `@integraledger/agentic-connectors`: the seller door's contract, its types and its vectors.
- `@integraledger/profile-facilitator`: the x402 facilitator for the Tron and Polkadot LCP profiles. It holds no key
  and pays no fee. It has no authentication of its own, and is meant to be served on a private interface to the
  resource servers that use it.
