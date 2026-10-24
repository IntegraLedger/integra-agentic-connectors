---
title: Issue
description: Assemble, store and hash the ATR for one checkout state, and get the values to place.
---

# Issue

`POST /issue` runs before the buyer approves. The door assembles the ATR from what you send, writes its bytes to the
seller's storage, hashes them, and answers with the values to place in the payment request.

## The request

| Field | Required | What to send |
|---|---|---|
| `mintRequestId` | yes | One state of one checkout: `<checkout id>:<version>`, matching `^[A-Za-z0-9._:-]{1,128}$`. |
| `resource` | yes | The resource id declared for the tenant, 1 to 512 UTF-8 bytes. |
| `lifetimeSeconds` | yes | The challenge's lifetime, 1 to 604 800. On x402, the largest `maxTimeoutSeconds` of the offers. |
| `offers` | yes | 1 to 16 `{pairing, option}`, each option exactly as the challenge will carry it, all of one protocol. Outside that count, `422 issue/input-bounds`. |
| `content` | no | 0 to 56 `{slot, bytes}`: the parties' content, each slot one JSON value as padded base64 of its exact bytes. More slots, `422 issue/input-bounds`. |
| `request` | on x402 | `{method, path, query, bodyDigest}`: the request the challenge answers. |

Slot names match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, else `422 core/slot-name`. `atrVersion`, `id` and the binding's
slot (such as `x402`) are reserved. A slot's bytes must be exactly one JSON value (RFC 8259): the door writes them into
the ATR as received.

## The request commitment

On x402, `request` commits the ATR to the HTTP request its options answer. Its request-target, `path` + `?` + `query`
(`path` alone where the target had no `?`), is at most 8192 characters.

- `method`: the method token, such as `GET`;
- `path`: the request-target up to its first `?`;
- `query`: what follows the first `?`, or `""`;
- `bodyDigest`: `0x` and the SHA-256 hex of the body bytes as received. An empty body gives
  `0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

Compute it with `requestCommitment` from `@integraledger/lcp/x402`: the request commitment is the LCP package's rule
([rule 4](./connector-rules.md#4-the-request-commitment-is-the-lcp-packages-rule)). It is async, and answers the
commitment, or a refusal for a request it cannot commit to, such as a target that is not origin-form. The sample
imports `@integraledger/lcp`, the peer of `@integraledger/agentic-connectors`, so install both, lcp at the peer's
range:

```sh
npm install @integraledger/agentic-connectors @integraledger/lcp@~0.5.0
```

```ts title="commitment.ts"
import type { RequestCommitment } from "@integraledger/agentic-connectors";
import { isRefusal } from "@integraledger/lcp/core";
import { requestCommitment } from "@integraledger/lcp/x402";

const answers = [
  await requestCommitment({ method: "GET", target: "/v1/report", body: new Uint8Array() }),
  await requestCommitment({ method: "POST", target: "/v1/quote?region=eu", body: new TextEncoder().encode('{"n":1}') }),
  await requestCommitment({ method: "GET", target: "v1/report", body: new Uint8Array() }),
];
for (const answer of answers) {
  if (isRefusal(answer)) {
    console.log(answer.code);
  } else {
    const request: RequestCommitment = answer;
    console.log(JSON.stringify(request));
  }
}
```

```text output
{"method":"GET","path":"/v1/report","query":"","bodyDigest":"0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}
{"method":"POST","path":"/v1/quote","query":"region=eu","bodyDigest":"0x2bfd14f43d17fc7cea24e0917a8879b4b2f880b8baeec1b9d90fbaad655e71bd"}
x402/request-target-invalid
```

## The answer

| Field | Meaning |
|---|---|
| `atrHash` | H: `0x` and 64 lowercase hex digits. |
| `link` | The `https` URL where the seller's storage serves the ATR. Show this link; never build one. |
| `expiresAt` | When the challenge lapses. |
| `mintRequestId` | The id you sent. |
| `carriers` | H and the link in each carrier form: `lcp` (`lcp:sha256:0x…`), `legalContext` (`{type, value, legalContextUrl}`) and `legal_context` (`{type, value, legal_context_url}`). |
| `pairings` | Each offered pairing with its pattern: how it carries H, and what a record of it proves. |
| `agreement` | Present when the record needs the agreement step: `{url, network, pairing}`. See [the agreement step](./agreement-step.md). |

## Retries and changes

A repeat of a `mintRequestId` answers the record as it stands: its `expiresAt` is the first issue's, or later once a
claim raised it; the repeat's own `lifetimeSeconds` and `content` are not applied. Before a claim the repeat's answer
is the first one byte for byte (vector `CV2`). A repeat that finds the record writes no file. A reused id with other
offers or another request answers `409 issue/mint-request-reused` (vector `CV3`):

```ts title="retry.ts"
import { VECTORS } from "@integraledger/agentic-connectors";

const door = process.env.SELLER_DOOR_URL ?? "https://seller.example/door";
const credential = process.env.SELLER_CREDENTIAL ?? "";

async function issue(body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`${door}/issue`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

const [first, second] = VECTORS["CV2"]!.steps;
const a = await issue(first!.request.body);
const b = await issue(second!.request.body);
console.log(a.status, b.status, a.text === b.text);

// CV3: the same id with a changed amount is refused.
const changed = await issue(VECTORS["CV3"]!.steps[1]!.request.body);
console.log(changed.status, (JSON.parse(changed.text) as { code: string }).code);
```

```text output
200 200 true
409 issue/mint-request-reused
```

A changed checkout gets a new id. When an id's record has lapsed, the door answers `409 issue/mint-request-lapsed`:
append `:<n>` with a new `n` and issue again.

## Failure modes

- `422`: the request cannot be served as sent. The most common are `issue/pairing-not-served` (an offer names a
  pairing this resource does not serve), `issue/offer-refused` (the offer is on a network the door does not serve for
  this tenant, its pairing is not its option's own, or the pairing cannot place H in that option; the sentence names
  the pairing and the code of the cause), `issue/mixed-protocols`, and the `core/…` codes for content.
- `503`: `issue/storage-unavailable` means the ATR could not be written, so no challenge may go out. Every `503`
  carries `Retry-After: 1`; retry the same request, with the same `mintRequestId`.

Whatever the failure, the checkout path stops: a connector never completes a sale without the values `issue` returns
([rule 5](./connector-rules.md#5-place-the-values-where-the-buyers-agent-approves-before-approval-fail-closed)).
