---
title: The seller door
description: The server-to-server API a connector calls to issue an ATR, claim a payment, report a settlement and read a record.
---

# The seller door

The **seller door** is the HTTP API a seller's own systems call when they, not the door, face the buyer. A
**connector** is the software on the seller's side that calls it: a commerce platform's plugin, a payment app, or a
seller's own checkout backend.

## The four operations

| Operation | Call | When |
|---|---|---|
| `issue` | `POST /issue` | Before the buyer approves: assemble the ATR, write it to the seller's storage, hash it, and return the values to place in the payment request. |
| `claim` | `POST /claim` | When the buyer presents a payment, before your facilitator's `/verify`: the one check that the payment carries this ATR's hash. |
| `report` | `POST /report` | After payment: the platform's payment reference, keyed by the ATR hash. |
| `status` | `GET /status/{atrHash}` | Any time: the record and what it proves. |

`GET /openapi.json` serves the contract itself, without a credential. The contract is the
[`@integraledger/agentic-connectors`](../../contract/README.md) package; its reference is the
[seller door API](../reference/seller-door-api.md).

## Tenants, credentials and resources

- A **tenant** is one seller. Every record belongs to one tenant.
- A **seller credential** is `isk_` and 43 base64url characters, sent as `Authorization: Bearer isk_…`. It decides
  which tenant's records a call touches. It is issued through the door's admin interface, and it is a secret: keep
  it where your platform keeps secrets, never in a browser.
- A **resource** is something the tenant sells, declared through the admin interface with the pairings it serves.
  Every `issue` and `claim` names one. An offer naming a pairing the resource does not serve answers
  `422 issue/pairing-not-served`.

## Server to server

The door refuses any request that carries an `Origin` header (`403 door/browser-origin`). Browsers send `Origin` on
every cross-origin request, so a browser can never call the door, and the credential never reaches one. A checkout
extension or site plugin calls the connector's own backend, which calls the door.

## One mint request id per checkout state

`mintRequestId` names one state of one checkout, such as `chk_7Q2:v1` (a cart id and its version). The door answers a
retry of the same id and the same input with the same answer, byte for byte, and writes no second file. A different
input under a used id answers `409 issue/mint-request-reused`: a changed checkout gets a new id, so it never reuses an
ATR that records other terms.

## What the door checks, and what it does not

`claim` is the door's one check: the payment carries this ATR's hash, for the options and request it was issued for.
It never checks amount, payee, asset, timing or payer. A discrepancy is between the parties, and the ATR records what
they agreed.

The door carries no business or legal logic. Where it needs the seller's decision, it relays the seller's own systems'
answer, and if they cannot answer, the transaction does not proceed. It never refuses a payment that has moved.

## Refusals

A refusal is `{code, sentence, correlationId}` with an HTTP status from a closed table of 47 codes. The `code` is
stable; the `sentence` is for people. Every `503` carries `Retry-After: 1`. See [the refusal codes](../reference/refusals.md).
