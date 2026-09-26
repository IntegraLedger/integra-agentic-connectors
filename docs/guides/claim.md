---
title: Claim
description: The one check, before money moves - the presented payment carries this ATR's hash, for the options issued.
---

# Claim

`POST /claim` is the door's one check: the payment the buyer presents carries the H issued for this request, for the
options and request that H was issued for. Call it before your facilitator's `/verify`, so every refusal comes before
money moves.

## The request

| Field | Required | What to send |
|---|---|---|
| `resource` | yes | The resource the record was issued for. |
| `pairing` | yes | The pairing the record offered and the payment uses. |
| `payment` | yes | What the buyer presented, exactly as received. On x402, the `PaymentPayload`. |
| `chosen` | yes | The option the payment names, as issued. On x402, the payload's `accepted`. |
| `network` | yes | The payment's network, such as `accepted.network`. |
| `request` | on x402 | The same request commitment `issue` received. |
| `settleBy` | no | Unix seconds by which the payment settles, at most now + 604 800. On x402 with EIP-3009, `validBefore`. |

## The answers

| Answer | Meaning | What to do |
|---|---|---|
| `200` `state: "settling"` | Claimed: the payment carries this ATR's hash. `proves.claimed` is `true`. | Verify and settle with your facilitator, then report. |
| `200` `state: "declined"` | A pushed payment landed and then failed the check. | Tell the buyer the payment was not accepted for this record, with `code`. Do not answer it as a refusal to pay. |
| `409 claim/in-progress` | This ATR's payment is already claimed. | On a retry of the same presentation, the first attempt won. |
| `409 claim/agreement-first` | The record needs the agreement step, and it is not recorded yet. | Wait for `agreement.state` `recorded`, then claim. |
| `410 claim/lapsed` | The challenge lapsed. | Issue again. |
| `422 claim/not-bound` | The payment carries no H the door can read. | Refuse the payment. |
| `404 claim/unknown` | No record matches the H the payment carries. | Refuse the payment. |
| `409 claim/not-this-request` | The payment is not for the options and request this ATR was issued for. | Refuse the payment. |
| `422 claim/nothing-to-check` | The pairing carries nothing the buyer signs. | Report the payment instead. |

Every refusal code is in [the refusal reference](../reference/refusals.md).

## A claim and its retry

Vector `CV6` claims an x402 payment, then presents it again:

```ts title="claim-twice.ts"
import type { ClaimRequest, ClaimResponse, Refusal } from "@integraledger/agentic-connectors";
import { VECTORS } from "@integraledger/agentic-connectors";

const door = process.env.SELLER_DOOR_URL ?? "https://seller.example/door";
const credential = process.env.SELLER_CREDENTIAL ?? "";

async function claim(body: ClaimRequest): Promise<[number, ClaimResponse | Refusal]> {
  const res = await fetch(`${door}/claim`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return [res.status, (await res.json()) as ClaimResponse | Refusal];
}

const steps = VECTORS["CV6"]!.steps;
const body = steps[1]!.request.body as unknown as ClaimRequest;
const payload = body.payment as { payload: { authorization: { nonce: string; validBefore: string } } };
console.log("nonce is H:", payload.payload.authorization.nonce);
console.log("settleBy is validBefore:", String(body.settleBy) === payload.payload.authorization.validBefore);

for (const [status, answer] of [await claim(body), await claim(body)]) {
  console.log(status, "code" in answer ? answer.code : `${answer.state}, claimed ${answer.proves.claimed}`);
}
```

```text output
nonce is H: 0x3c2394624c8c9a61ebaf7d8750a6f9ac21bf73e6369b7c0b64c83e34509cc3d3
settleBy is validBefore: true
200 settling, claimed true
409 claim/in-progress
```

## Pushed payments

On a push-mode pairing, the buyer broadcasts the payment itself, and `payment` names the landed transaction. The door
reads it on the rail before it checks it. If the read is not possible yet, the door answers
`503 claim/read-unavailable`: retry. If the check fails, the money has moved, so the answer is `200`:

```json no-check
{
  "atrHash": "0x…",
  "state": "declined",
  "pairing": "mpp/charge/solana",
  "code": "claim/not-this-request",
  "transaction": "…"
}
```

`atrHash` is the hash the payment is bound to, or `null` when it is bound to none. `code` is the refusal code the same
check gives before money moves. The pairings with push mode are marked in [the pairings reference](../reference/pairings.md).

## Channels

For a channel, session or subscription pairing, claim the opening only. A claim of a later payment in an open channel
answers `409 claim/channel-open`, and a claim in a channel whose opening was never claimed answers
`409 claim/channel-not-open`. See [channels](./channels.md).
