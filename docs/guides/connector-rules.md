---
title: The connector rules
description: The fourteen rules every connector follows, each with its reason.
---

# The connector rules

A connector is the software between a commerce platform (or a seller's own payment stack) and the seller door. It
speaks the contract out of process, and these rules fix its behaviour. Each rule carries its reason.

## 1. Server to server

Only the connector's backend calls the door, over HTTPS. A browser piece (a checkout UI extension, a site plugin)
calls the connector's own backend. The door refuses any request that carries an `Origin` header
(`403 door/browser-origin`).

*Why:* the door's credential must never reach a browser, and browsers send `Origin` on every cross-origin request.

## 2. One credential per tenant, kept as a secret

A backend serving many sellers holds one seller credential (`isk_` and 43 base64url characters) per tenant, issued
through the door's admin interface. Store it where the platform keeps secrets, never in page data, client code or
options loaded on every request.

*Why:* the credential decides which seller's records a call touches.

## 3. Issue before approval, once per checkout state

`mintRequestId` names one state of one checkout: `<checkout id>:<version>` (for example a cart id and its version).
Retries of that state reuse it; any change to what `issue` receives (cart, offers, content) is a new id. An id outside
the allowed characters (`^[A-Za-z0-9._:-]{1,128}$`) is replaced by the SHA-256 hex of the platform's id. On
`issue/mint-request-lapsed`, append `:<n>` with a new `n`.

*Why:* a retry must return the same ATR, and a changed checkout must never reuse an ATR that records other terms.

## 4. The request commitment is the LCP package's rule

On an x402 surface, send `request` = `{method, path, query, bodyDigest}`: the method token, the request-target up to
its first `?`, what follows it (or `""`), and SHA-256 over the body bytes as received.

*Why:* the ATR records the request its payment options answer, and the claim checks the same commitment.

## 5. Place the values where the buyer's agent approves, before approval; fail closed

Put `carriers` and `link` in the field the pairing provides, using the LCP package's entry point for that protocol
(x402: the published profile `x402-exact-eip155-eip3009`; UCP and ACP: `links[]`, `messages[]` and `metadata` through
their entry points). A connector that is not configured, or whose `issue` failed, stops that checkout path: it never
completes a sale on it unbound.

*Why:* the proof is the hash inside what the buyer's agent approves; a sale without it has no proof.

## 6. Carry the hash to the order

Write `atrHash` into the platform's cart and order fields (for example cart attributes or metafields carried to the
order, cart custom attributes copied to the order, custom fields, or basket attributes), so `report` can be keyed by
it.

*Why:* the payment reference arrives on the order, and the door knows the record only by its hash.

## 7. Claim wherever the pairing records read keys; report after

Where a pairing reads the hash from the payment or records read keys for it, call `claim` with the presented payment
before your facilitator's `/verify`, so every refusal comes before money moves. Name the pairing the record offered: a
claim or report naming another is refused, and a report answers `report/pairing-mismatch`.

After payment, call `report` with the platform's payment reference as it comes, and retry until a 2xx or a 4xx. The
door reads a reported payment on the rail before it records it:

- a `202` whose `state` is `settling` is final for the connector, because the door finishes it;
- a `202` whose `state` is `issued` means nothing was read yet: report again later.

A report of money that moved is recorded even when it comes without a claim, and the record then states what is
missing. A `claim/in-progress` answer to a retry of the same presentation means the first attempt won.

*Why:* the claim is the one check that the payment carries this ATR's hash, and it must come before money moves; a
payment that has moved is never refused, and its record never claims more than was checked.

## 8. Keep no payment state of your own

The door's record is the state; read it with `status`.

*Why:* two state machines for one payment drift apart.

## 9. Show the link `issue` returned

Never build it from configuration, and never fetch the ATR on a page view; the ATR lives in the seller's storage.

*Why:* the link is the one the ATR was written to, and each party keeps its own copy.

## 10. Carry the platform's own values, unconverted

Currency, amounts and units go into content exactly as the platform states them. The door requires no price.

*Why:* the ATR records what the parties agreed, as they stated it.

## 11. Every record states what it proves

Show the buyer and the seller `proves` as the door returns it; never claim that the buyer signed the hash where
`claimed` is false. `settledBy` says what made the payment paid: a read of the rail, the facilitator's settle answer,
or, on a pairing with nothing to read, the seller's report.

*Why:* a record that claims more than it shows is not a proof.

## 12. Place the agreement URL beside the carriers, and wait for the agreement

Where `issue` answers with `agreement`, the record needs the agreement step: before the full payment, the buyer's
agent pays a nominal amount at `agreement.url`, on `agreement.network`, in a payment whose signed payload carries the
ATR hash. Place `agreement.url` where the buyer's agent can see it, beside the carriers: on MPP as
`opaque.legalContextAgreementUrl`; elsewhere as `legalContextAgreementUrl` beside `legalContextUrl`, or the
protocol's own place beside the link. Never start or accept the full payment before the agreement is recorded:
`status` shows `agreement.state` `recorded`, and until then `claim` answers `claim/agreement-first`. A payment reported
before the agreement is recorded is recorded, and its record states that no agreement was recorded before it and that
nothing public carries this ATR's hash.

*Why:* where the payment itself carries no public proof of the hash, the agreement payment is that proof, and it must
be on record before the payment it covers.

## 13. For a channel pairing, claim the opening only

Serve later requests yourself, never claim them, and report the close. The opening carries the hash; later requests
in the channel, session or subscription are paid under that ATR. Every later 402 in a channel repeats the legal
context of the channel's ATR. Report the close with `{atrHash, pairing, state: "closed", reference}`, the reference
being the close transaction; the door reads it with the close keys recorded at the opening, and needs no `chosen`.
For a subscription whose payment carries nothing to claim, the opening's `report` `paid` records the channel, the
reference being the subscription's own identifier.

*Why:* one agreement covers the whole channel, and its record ends when the channel closes.

## 14. A pushed payment that fails the check is declined, not refused

Where the buyer broadcast the payment before `claim` (a push-mode pairing), the money has moved when the door checks
it. A check that fails then answers `200` with `state` `declined`, the check's `code`, the hash the payment is bound
to (or `null`) and the landed `transaction`, and the record's declined notice carries the same. Tell the buyer the
payment was not accepted for this record, with that code; never answer it as a refusal to pay. A retry of the
presentation that was claimed answers as the claim did.

*Why:* the door never refuses a payment that has moved; what happens to the money is between the parties.
