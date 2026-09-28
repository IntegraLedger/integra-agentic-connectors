---
title: "@integraledger/profile-facilitator"
description: The facilitator's exports, HTTP API, reason codes, storage schema, bounds and logs.
---

# `@integraledger/profile-facilitator`

## Exports

The package's entry point exports:

| Export | Kind | What it is |
|---|---|---|
| `serveProfileFacilitator(config)` | `(c: ProfileFacilitatorConfig) => Promise<{ close(): Promise<void> }>` | Opens the store, starts the HTTP server and resolves once it listens. |
| `ProfileFacilitatorConfig` | interface | The configuration: see [Run the profile facilitator](../guides/facilitator.md#configuration). |
| `VerifyAnswer` | type | `{isValid: true, payer}` or `{isValid: false, invalidReason, payer?}`. |
| `SettleAnswer` | type | `{success: true, transaction, network, payer}` or `{success: false, errorReason, transaction, network}`. |

The generated declarations are in [the API reference](./api/profile-facilitator/index.md).

## HTTP API

| Request | Answer |
|---|---|
| `GET /supported` | `200` `{kinds, extensions: [], signers: {}}`, one kind per configured network. |
| `POST /verify` | `200` with a `VerifyAnswer`; `400` `{isValid: false, invalidReason: "invalid_payload"}` when the body is not JSON. |
| `POST /settle` | `200` with a `SettleAnswer`; `400` with `errorReason` `invalid_payload` when the body is not JSON. |
| A body over 64 KiB | `413`, and the connection is closed. |
| Another method on a served path | `405` `{error}`. |
| Any other path | `404` `{error}`. |

The facilitator has no authentication of its own. Serve it on a private interface, or behind your own network
controls, to the resource servers that use it.

## Reasons

| Reason | `/verify` | `/settle` | Meaning |
|---|---|---|---|
| `invalid_x402_version` | yes | yes | `x402Version` is not 2 in the request or the payload. |
| `unsupported_scheme` | yes | yes | `scheme` is not `"exact"`. |
| `invalid_network` | yes | yes | The network is not one this facilitator is configured with. |
| `invalid_payment_requirements` | yes | yes | The requirements are not ones the profile admits. |
| `invalid_payload` | yes | yes | The payload does not match the profile or the requirements, or its signature or expiration fails. |
| `unsupported_permission` | yes | yes | Tron: the transaction carries more than one signature, or the owner's permission does not accept its one signature (the key's weight is below the threshold). |
| `invalid_transaction` | yes | yes | The node refuses the transaction in simulation or validation. On Tron this includes a reference block (TaPoS) that does not match the node's. |
| `unexpected_verify_error` | yes | no | The node or the store could not be read. |
| `unexpected_settle_error` | no | yes | The node could not be read before submission, or refused the submission. |
| `settlement_pending` | no | yes | Submitted, and not yet final when the wait ended. |
| `invalid_transaction_state` | yes | yes | `/settle`: included and failed, or it can never be included. On Tron also a consumed payment: its success was already answered, or the node already holds its id. `/verify` (Tron): the node or the store already holds the transaction id. |

`unsupported_permission` and `invalid_transaction` are this facilitator's, for a Tron owner permission that does not
accept the transaction's one signature and for a transaction the node refuses in simulation or validation. The
others are the x402 specification's.

## Storage

Postgres holds one table, created at start:

```sql
CREATE TABLE IF NOT EXISTS settlement (
  network text NOT NULL,
  id text NOT NULL,
  answer jsonb,
  until timestamptz NOT NULL,
  since bigint,
  PRIMARY KEY (network, id)
)
```

- One row per settled payment, keyed by network and transaction id (Tron) or extrinsic hash (Polkadot).
- `answer` is null while the row is claimed and the answer is not yet written. A final answer is never replaced; a
  pending one is replaced by what a later read of the chain shows.
- `until` is the end of the payment's validity window: Tron's `expiration`, or the end of the Polkadot era. A row is
  kept for 24 hours after it, so a repeat in that time reads the stored answer before anything is verified again. A
  sweep every minute drops older rows.
- `since` is, for Polkadot, the first block not yet shown at finality to lack the extrinsic.
- The pool holds at most 10 connections. Acquiring a connection, each query and each statement are bounded by 5
  seconds.

## Bounds and logs

- Each node call has a timeout of at most 5 seconds and an answer of at most 4 MiB. On Tron, `/verify` makes five
  FullNode calls: the account, id and simulation reads and the head read at once, then the reference block read.
- A request body is at most 64 KiB. The server's request timeout is `settleWaitMs` plus 60 seconds.
- The facilitator writes one JSON line on standard error for what the operator should see and the answer does not
  carry: `settlement-failed` (with the events, or the receipt result and why the transfer does not count, that the
  chain shows), `settlement-expired` and
  `answer-not-stored`.
