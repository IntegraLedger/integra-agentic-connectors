---
title: Report
description: The platform's payment reference, keyed by the ATR hash, read on the rail before it is recorded.
---

# Report

`POST /report` gives the door the platform's payment reference after payment, keyed by the ATR hash. The door reads a
reported payment on the rail before it records it; on a pairing with nothing to read, the seller's report is the
settlement.

## The request

A report is either an **outcome** or a channel's **close**.

| Field | Outcome | Close | What to send |
|---|---|---|---|
| `atrHash` | yes | yes | The record's H, in either case. |
| `pairing` | yes | yes | The record's pairing. Another answers `409 report/pairing-mismatch`. |
| `outcome` | yes | | `paid` or `declined`. |
| `state` | | yes | `closed`. |
| `reference` | on `paid` | yes | The platform's payment reference as it comes, 1 to 256 characters with no control characters: the facilitator's `transaction`, the processor's payment id, the close transaction. |
| `network` | no | no | The payment's network, or `card` for a card payment. |
| `chosen` | on a record with no claim | no | The option the payment paid, as issued. The door takes the payment's read keys from it. |
| `request` | with `chosen`, on x402 | | The request commitment the option was issued for. |
| `receipt` | on a confirm-only channel pairing's `paid` | | The receipt the channel's opening answered. |

## The answers

| Answer | Meaning | What to do |
|---|---|---|
| `200` | The record as it now stands. | Done. |
| `202` with `state: "settling"` | Accepted; the door finishes the record. | Done: this is final for you. |
| `202` with `state: "issued"` | Accepted, and nothing was read yet. | Report again later. |
| `4xx` | Refused. | Do not retry the same body. |
| `503` | Not available now. | Retry after `Retry-After` seconds. |

Retry until a 2xx or a 4xx. A report of money that moved is recorded even when it comes without a claim, and the
record then states what is missing.

## A report with nothing read yet

Vector `CV7` reports a transaction the chain does not yet show as settled. The door records nothing, and the record
stays `issued`:

```ts title="report.ts"
import type { RecordView, ReportOutcome } from "@integraledger/agentic-connectors";
import { VECTORS } from "@integraledger/agentic-connectors";

const door = process.env.SELLER_DOOR_URL ?? "https://seller.example/door";
const credential = process.env.SELLER_CREDENTIAL ?? "";

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${door}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const [issue, reported] = VECTORS["CV7"]!.steps;
await post("/issue", issue!.request.body);
const body = reported!.request.body as unknown as ReportOutcome;
const res = await post("/report", body);
const record = (await res.json()) as RecordView;
console.log(res.status, record.state, record.settlement, record.proves.settledBy);
if (res.status === 202 && record.state === "issued") console.log("nothing read yet: report again later");
```

```text output
202 issued null null
nothing read yet: report again later
```

## Reporting without a claim

Where the pairing reads H from the payment but you did not claim it, send `chosen` (and `request` on x402) with the
report. The door reads the payment with the keys it takes from them, and the record states `claimed: false`.

## Declined

`outcome: "declined"` records that the seller declined the payment. Nothing is read.

## Closing a channel

```json no-check
{ "atrHash": "0x…", "pairing": "mpp/session/tempo", "state": "closed", "reference": "0x…" }
```

The door reads the close with the keys recorded at the opening, and needs no `chosen`. See [channels](./channels.md).
