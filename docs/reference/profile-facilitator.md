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

The generated declarations are in [the API reference](./api/profile-facilitator/index.md).

## HTTP API

| Request | Answer |
|---|---|
| `GET /supported` | `200` `{kinds, extensions: [], signers: {}}`, one kind per configured network. |
| `POST /verify` | `200` `{isValid: true, payer}` or `{isValid: false, invalidReason, payer?}`; `400` `{isValid: false, invalidReason: "invalid_payload"}` when the body is not JSON. |
| `POST /settle` | `200` `{success: true, transaction, network, payer}` or `{success: false, errorReason, transaction, network}`; `400` with `errorReason` `invalid_payload` when the body is not JSON. |
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
| `unexpected_settle_error` | no | yes | The node could not be read before submission, or refused the submission, or the settle's `settleWaitMs` passed before its claim (on Tron, also before its node reads). |
| `settlement_pending` | no | yes | Submitted, or possibly submitted (the store could not be read), and not yet final or not yet stored when the wait ended. |
| `invalid_transaction_state` | yes | yes | `/settle`: included and failed, or it can never be included. On Tron also a consumed payment: its success was already answered, or the node already holds its id. `/verify` (Tron): the node, in a block or its pending pool, or the store already holds the transaction id. On Polkadot, also a repeat of a payment whose success has been answered, or a submission the node refuses as one it has already seen (already imported, temporarily banned, or an outdated nonce). |

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
  unread bigint[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (network, id)
);
CREATE INDEX IF NOT EXISTS settlement_final_until ON settlement (until)
  WHERE answer IS NOT NULL AND answer->>'errorReason' IS DISTINCT FROM 'settlement_pending'
```

- One row per settled payment, keyed by network and transaction id (Tron) or extrinsic hash (Polkadot).
- `answer` is null while the row is claimed and the answer is not yet written. A final answer is never replaced; a
  pending one is replaced by what a later read of the chain shows, or by the stored answer to a broadcast or
  submission the node refused or never received.
- `until` is the end of the payment's validity window: Tron's `expiration`, or, for Polkadot, the end of the last
  block that can include the extrinsic (the era's last, and no later than `System.BlockHashCount` + 1 blocks after its
  birth), counted from the best block at 12 seconds a block.
- A row whose answer is final (`success: true`, or a failure other than `settlement_pending`) is kept for 24 hours
  after `until`, so a repeat in that time reads the stored answer before the expiration check and the node reads are
  made again.
- A row whose answer is not final (claimed with no answer, or `settlement_pending`) is kept, whatever its age, until a
  repeated `/settle` reads the chain and writes a final answer, or the answer to a refused or unsent broadcast or
  submission makes it final. A repeat therefore always finds the id of a payment this facilitator submitted, and never
  answers with an empty `transaction` for it.
- A claim is never removed. A broadcast or submission the node refuses, or that cannot have reached it, stores its
  answer, final, in the claimed row: `invalid_transaction_state` with the id when the node says it already holds the
  transaction, and `unexpected_settle_error` with an empty `transaction` for any other refusal or a request that cannot
  have reached the node. Every repeat gets that stored answer, so a payment is submitted at most once.
- A sweep every minute drops the rows whose answer is final and whose `until` is more than 24 hours past. It reads
  them through `settlement_final_until`, an index that holds only rows with a final answer, so the rows it keeps add
  nothing to its work.
- `since` is, for Polkadot, the first block the scan has not yet read at finality.
- `unread` is, for Polkadot, the finalized blocks below `since` that the node could not give. None of them is shown to
  lack the extrinsic, so each is read again, and the answer that the extrinsic can never be included waits until the
  list is empty. A scan's write keeps every block of the list that the scan did not read, so concurrent repeats lose
  none. It holds at most one entry per block of the validity window.
- The pool holds at most 10 connections. Acquiring a connection, each query and each statement are bounded by 5
  seconds.

## Bounds and logs

- Each node call has a timeout of at most 5 seconds and an answer of at most 4 MiB, except Polkadot's
  `chain_getBlock`. Its bound is sized from the runtime's `System.BlockLength`, read from the metadata: 4 MiB, plus
  9/2 of the largest class limit (an extrinsic of n encoded bytes is at most 2n + 5 JSON characters), plus 7 times
  `maxHeaderSize`. For Polkadot Asset Hub's runtime 2005000 that is 28,504,064 bytes. At most 4 of these reads run at
  once in one process, so block answers take at most 114,016,256 bytes for that runtime. A read waits for a free slot
  until the scan's deadline; one that cannot start by then is recorded as unread, like a block the node cannot give,
  and read again later. Every other node call has no such limit. On Tron, `/verify` makes six FullNode calls:
  the account, the two id reads, the simulation and the head read at once, then the reference block read.
- A Polkadot node that keeps the state of every block (an archive node) gives the events of any block; a pruning
  node discards the state of older blocks, and a block that holds the extrinsic and whose state is discarded keeps the
  answer `settlement_pending`.
- A request body is at most 64 KiB. The server's request timeout is `settleWaitMs` plus 60 seconds.
- The table holds a row with a final answer until 24 hours after its validity window ends. A row with no final answer
  stays until a repeated `/settle` for it gives one. Each such row is a payment that passed every check and was
  claimed for submission; it is one row of fixed columns, the sweep's index does not hold it, and each repeat reads the
  chain within `settleWaitMs`. On Tron, one repeat made once the latest solidified block is two slots past the
  expiration gives a final answer whenever the nodes answer its reads, each naming a latest block at or past that one.
- The facilitator gives its operator log (`operatorLog`; by default one JSON line on standard error) what the operator
  should see and the answer does not carry, each entry with `network`, `payer` and `transaction` where they are known:
  `settlement-failed` (with the events, or the receipt result and why the transfer does not count, that the chain
  shows), `settlement-expired`, `answer-not-stored`, `block-unreadable` (a Polkadot block the node does not give, with
  the node's reason; `final` when it was read at finality and is recorded as unread), `block-read-stopped` (a block read
  the settle's deadline ended) and `settlement-consumed` (a repeated `/settle` of a Polkadot payment whose success has
  been answered). Each error the facilitator turns into an answer or a retry is an entry with the error as its cause:
  `verify-error`, `settle-error` and `request-error` (an error the request's handling threw), `node-call-failed` and
  `store-call-failed` (with the `call`), and `store-connection-error`. Every `unexpected_verify_error` and
  `unexpected_settle_error` answer has an entry that names why, with the call or the bound: an error's entry above;
  `node-call-failed` for a node answer the facilitator cannot read, its cause a `malformed` error naming the part, and
  for a Tron broadcast the node does not accept, its cause the node's `code` and `message`; and
  `settle-deadline-passed` for a settle whose deadline passed before its node reads or its claim, with `before`, the
  step it did not start, and `settleWaitMs`. A request refused for its own bytes (a body that is not JSON, a signature
  that recovers no key, an extrinsic that does not decode) is answered to its client and not logged, and a client that
  leaves before its request body is complete writes no entry: the connection is destroyed.
  `@polkadot/api`, which loads each Polkadot network's metadata, also writes its own lines (not JSON) on standard error
  when that load fails; the facilitator's entry for it is `node-call-failed` with `call: metadata`.
