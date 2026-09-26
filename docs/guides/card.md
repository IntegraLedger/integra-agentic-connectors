---
title: Card checkouts
description: A plain card checkout with the card/seller-reference pairing and the agreement step.
---

# Card checkouts

A plain card checkout uses the pairing `card/seller-reference`. The card payment carries nothing the buyer signs, so
the door checks nothing at `claim`, the seller's report is the settlement, and the [agreement step](./agreement-step.md)
supplies the public proof of H.

| Call | What to send |
|---|---|
| `issue` | A card option `{scheme: "seller-reference", checkout}`; the checkout as shown to the buyer, in `content`; its lifetime. |
| `claim` | Not applicable: it answers `422 claim/nothing-to-check`. |
| `report` | `outcome: "paid"`, the processor's payment reference as it comes, and `network: "card"`, once the agreement is recorded. |

## The whole checkout

Vector `CV9` runs it end to end: issue, the claim that has nothing to check, the report after the agreement is
recorded, and the status.

```ts title="card.ts"
import type { IssueResponse, RecordView } from "@integraledger/agentic-connectors";

const door = process.env.SELLER_DOOR_URL ?? "https://seller.example/door";
const credential = process.env.SELLER_CREDENTIAL ?? "";
const headers = { authorization: `Bearer ${credential}`, "content-type": "application/json" };
const post = (path: string, body: unknown) => fetch(`${door}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

// The checkout exactly as the platform shows it, as one JSON value.
const checkout = '{"id":"chk_1001","total":{"currency":"USD","amount":27999}}';
const option = { scheme: "seller-reference", checkout: "chk_1001" };

const issued = (await (
  await post("/issue", {
    mintRequestId: "chk_1001:v1",
    resource: "checkout",
    lifetimeSeconds: 900,
    offers: [{ pairing: "card/seller-reference", option }],
    content: [{ slot: "checkout", bytes: Buffer.from(checkout).toString("base64") }],
  })
).json()) as IssueResponse;
console.log("agreement URL:", issued.agreement?.url);

const claim = await post("/claim", { resource: "checkout", pairing: "card/seller-reference", payment: {}, chosen: option, network: "card" });
console.log("claim:", claim.status, ((await claim.json()) as { code: string }).code);

// After status shows agreement.state "recorded" and the processor has charged the card:
const reported = await post("/report", {
  atrHash: issued.atrHash,
  pairing: "card/seller-reference",
  outcome: "paid",
  reference: "pi_3Nma8hD7mauJ7ZJt0bKKZkRT",
  network: "card",
});
const record = (await reported.json()) as RecordView;
console.log("report:", reported.status, record.state, record.settlement?.reference, record.proves.settledBy);
```

```text output
agreement URL: https://seller.example/agreement/0xcfa3a6589bf1e273ab105bb7144a2d5944af1caed14f58b39145d46842f825d8
claim: 422 claim/nothing-to-check
report: 200 paid pi_3Nma8hD7mauJ7ZJt0bKKZkRT seller-report
```

Write `atrHash` into the platform's cart and order fields so the report can be keyed by it, and show the buyer the
`link` and the agreement URL beside the checkout.
