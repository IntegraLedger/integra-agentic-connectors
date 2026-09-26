---
title: Status
description: Read a record, its state and what it proves.
---

# Status

`GET /status/{atrHash}` returns the record for an ATR hash, in either case. The record is the payment's state:
a connector keeps none of its own.

## The record

| Field | Meaning |
|---|---|
| `atrHash` | H. |
| `state` | `issued`, `settling`, `paid` or `closed`. See [records](../concepts/records.md). |
| `expiresAt` | When the challenge lapses. |
| `settlement` | `{pairing, network?, reference?}` once a payment is recorded, else `null`. |
| `proves` | `{claimed, pattern, settledBy}`: what the record proves. |
| `agreement` | The agreement leg `{state, network, transaction}`, or `null` when the record needs no agreement step. |
| `channel` | The channel leg `{network, channel, until, closed}`, or `null`. |

A hash the door never issued for this tenant answers `404 door/not-found`.

## Show what the record proves

Vector `CV9` is a card checkout whose agreement payment was recorded before the card payment. Its record reads:

```ts title="proves.ts"
import type { RecordView } from "@integraledger/agentic-connectors";

const door = process.env.SELLER_DOOR_URL ?? "https://seller.example/door";
const credential = process.env.SELLER_CREDENTIAL ?? "";
const atrHash = "0xcfa3a6589bf1e273ab105bb7144a2d5944af1caed14f58b39145d46842f825d8";

const res = await fetch(`${door}/status/${atrHash}`, { headers: { authorization: `Bearer ${credential}` } });
const record = (await res.json()) as RecordView;

/** One line for a receipt page: what was checked, and how the payment is known to be paid. */
function summary(r: RecordView): string {
  const signed = r.proves.claimed ? "the buyer's payment carried this ATR's hash" : "no signed hash was checked";
  const paid = { read: "read on the rail", facilitator: "the facilitator's settle answer", "seller-report": "the seller's report" };
  const how = r.proves.settledBy === null ? "not yet paid" : `paid on ${paid[r.proves.settledBy]}`;
  const agreed = r.agreement?.state === "recorded" ? `; agreement recorded in ${r.agreement.transaction} on ${r.agreement.network}` : "";
  return `${r.state}: ${signed}; ${how}${agreed}`;
}

console.log(summary(record));
```

```text output
paid: no signed hash was checked; paid on the seller's report; agreement recorded in 0x2222222222222222222222222222222222222222222222222222222222222222 on eip155:84532
```

Show `proves.pattern.proves` as the door returns it, and never claim that the buyer signed the hash where `claimed`
is `false`.
