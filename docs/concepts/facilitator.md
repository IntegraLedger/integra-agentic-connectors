---
title: Facilitators
description: The x402 facilitator role, and where the profile facilitator fits beside the seller door.
---

# Facilitators

In x402, a **facilitator** is the role that verifies and settles. A resource server sends it the buyer's payment and
the requirements it answered. `POST /verify` says whether the payment is valid, and `POST /settle` submits it to its
network and answers with the transaction. `GET /supported` lists the kinds of payment it serves. The seller chooses
its facilitator.

## Where it sits

The seller door and the facilitator do different jobs, in this order:

1. `claim` at the seller door: the payment carries the H issued for this request. Every refusal comes here, before
   money moves.
2. `/verify` and `/settle` at the facilitator: the payment is valid for its requirements, and is submitted.
3. `report` at the seller door: the facilitator's `transaction` becomes the record's reference.

## The profile facilitator

x402 specifies neither Tron nor Polkadot. LCP defines one transfer method on each, in which the payer's own signed
transaction carries H:

- `x402/exact/tron/lcp-trc20-memo`: H in a TRC-20 transfer's memo;
- `x402/exact/polkadot/lcp-assets-remark`: H in a remark batched with an Asset Hub transfer.

[`@integraledger/profile-facilitator`](../../profile-facilitator/README.md) is a facilitator for those two profiles.
It holds no key and pays no fee: it checks, submits exactly the bytes the payer signed, deduplicates settlements in
Postgres, and reports what the network shows. It checks that the payment carries H in the profile's form; which H
the seller issued, and whether the seller has seen the payment claimed before, is the seller door's `claim` to check
(each profile's rule 6).

See [Run the profile facilitator](../guides/facilitator.md), and the [Tron](../guides/tron.md) and
[Polkadot](../guides/polkadot.md) guides.
