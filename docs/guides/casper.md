---
title: Casper
description: What the profile facilitator verifies and settles for x402/exact/casper/lcp-runtime-arg.
---

# Casper: `x402/exact/casper/lcp-runtime-arg`

On Casper, H rides in a **named runtime argument** of the payer's own signed `Version1` transaction: `lcp_atr_hash`, a
`ByteArray(32)` holding H's 32 bytes. It is a typed argument of the call, not an opaque memo, and the transaction hash
the payer signs covers it. The executed call's arguments are on chain, so H is read back from the transaction itself.
The payer pays every fee.

| Requirement | Value |
|---|---|
| `scheme` | `exact` |
| `network` | `casper:casper` (mainnet) or `casper:casper-test` (testnet); `casper:` and the chainspec name |
| `amount` | The asset's atomic units: motes for native CSPR, the token's own units for a CEP-18 asset |
| `asset` | `native` for CSPR, else the CEP-18 contract package hash, 64 hex digits |
| `payTo` | The payee, tagged: `00` and an account hash, or `01` and a contract package hash |
| `maxTimeoutSeconds` | At most 64 800, the chainspec's `max_ttl` |
| `extra.assetTransferMethod` | `lcp-runtime-arg` |
| `payload.transaction` | The signed transaction, as `{"Version1": {...}}`, the shape `account_put_transaction` takes |

The facilitator needs a Casper JSON-RPC endpoint over HTTP that serves `speculative_exec`,
`account_put_transaction` and `info_get_transaction`. A node's own RPC serves all three, and so does
[CSPR.cloud](https://docs.cspr.cloud); the Casper Association runs one for x402 at
[x402-facilitator.cspr.cloud](https://x402-facilitator.cspr.cloud).

## Decimals

The facilitator converts nothing. `amount` is compared byte for byte with the `U512` the `amount` argument carries, in
the asset's own atomic units. Native CSPR has 9 decimals, so its atomic unit is the mote; a CEP-18 token has whatever
`decimals` its contract reports. No decimal count is hardcoded anywhere, and none is needed: the seller writes the
requirement in atomic units and the payer signs the same figure.

## What `/verify` checks

In order; the first failure is the answer.

1. The network is configured, and the requirements are ones the profile admits (its rule 1), else `invalid_network` or
   `invalid_payment_requirements`.
2. `payload.transaction` holds a `Version1` transaction with a hash, a payload and approvals, else `invalid_payload`.
3. The payload's `chain_name` is the network's chainspec name, else `invalid_payload`. It is inside what the payer
   signed, so it binds the payment to one network.
4. The call is the one the requirements name, else `invalid_payload`: the native `Transfer` when `asset` is `native`,
   else `transfer` on the CEP-18 package `asset` names. The payee argument (`target`, or `recipient` for CEP-18) is
   `payTo`, and the `amount` argument is `amount` as a `U512`.
5. There is a `lcp_atr_hash` argument, a `ByteArray(32)` whose 32 bytes are a well-formed ATR hash, else
   `invalid_payload`. Its bytes are compared whole, never stopping at the first difference.
6. The transaction carries exactly one approval, else `unsupported_permission`. That approval's signer is the
   initiator and its signature verifies over the transaction hash, ed25519 (`01`) or secp256k1 (`02`), else
   `invalid_payload`. A transaction approved by more than one key is not served.
7. The validity window, the payload's `timestamp` plus its `ttl`, ends in the future and no later than now plus
   `maxTimeoutSeconds`, else `invalid_payload`.
8. `speculative_exec` executes the transaction without an error, else `invalid_transaction`. A node that cannot be
   read gives `unexpected_verify_error`.

The answer is `{isValid: true, payer}`, with `payer` the initiator's public key in tagged hex.

## What `/settle` does

1. Repeats every check of `/verify`.
2. Reads the stored answer for the transaction hash. A final one is returned as it is, so a repeated `/settle` gets the
   first answer.
3. Claims the transaction hash with one conditional insert, so concurrent settles of one payment submit once.
4. Submits the payer's bytes with `account_put_transaction`. A refusal that says the node already holds the
   transaction counts as submitted; any other refusal means nothing was submitted.
5. Reads `info_get_transaction` every second. An `execution_info` with no `error_message` is success, at the height of
   its block. An error is a failure, `invalid_transaction_state`. A transaction no node shows once its validity window
   has passed can never execute, and is answered `invalid_transaction_state` too.
6. Stores the answer and returns it.

Success is `{success: true, transaction, network, payer}`, where `transaction` is the transaction hash in lowercase
hex. While the transaction is submitted and not yet executed, the answer is `settlement_pending` with that hash.

## Where H is on chain

H is the `lcp_atr_hash` argument of the transaction the payer signed, inside the bytes the transaction hash covers. It
is read back from the executed call's arguments by transaction hash. Nothing parses a memo, and nothing has to index
one: the argument is named and typed, so the same read serves verification and later recovery.
