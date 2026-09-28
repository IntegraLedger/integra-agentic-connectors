---
title: Tron
description: What the profile facilitator verifies and settles for x402/exact/tron/lcp-trc20-memo.
---

# Tron: `x402/exact/tron/lcp-trc20-memo`

On Tron, H rides in the payer's own signed transaction: `raw_data.data` holds the 77 ASCII bytes `lcp:sha256:`
followed by H, beside exactly one TRC-20 `transfer(payTo, amount)`. The payer pays every fee: energy, bandwidth and the
network's memo fee.

| Requirement | Value |
|---|---|
| `scheme` | `exact` |
| `network` | `tron:<chain id in decimal>`, such as `tron:728126428` for mainnet |
| `amount` | The token's atomic units |
| `asset` | The TRC-20 contract, in base58check |
| `payTo` | The payee, in base58check |
| `maxTimeoutSeconds` | At most 86 340 |
| `extra.assetTransferMethod` | `lcp-trc20-memo` |
| `payload.transaction` | The serialized, signed `Transaction`, in lowercase hex |

The facilitator needs a FullNode (it calls `/wallet/getaccount`, `/wallet/getnowblock`, `/wallet/getblock`,
`/wallet/gettransactionbyid`, `/wallet/gettransactionfrompending`, `/wallet/triggerconstantcontract`,
`/wallet/broadcasthex` and `/wallet/gettransactioninfobyid`) and a Solidity node
(`/walletsolidity/gettransactioninfobyid` and `/walletsolidity/getnowblock`). A java-tron node serves both, on HTTP
ports 8090 and 8091 by default.

## What `/verify` checks

In order; the first failure is the answer.

1. The network is configured, and the requirements are ones the profile admits (its rule 1), else
   `invalid_network` or `invalid_payment_requirements`.
2. `payload.transaction` is a serialized Tron `Transaction` in hex that decodes to exactly one
   `TriggerSmartContract` whose `data` is an LCP `sha256` string, else `invalid_payload`.
3. `asset` and `payTo` are Tron addresses, else `invalid_payment_requirements`.
4. The contract called is `asset`, and the call data is exactly `transfer(payTo, amount)`, else `invalid_payload`.
5. The transaction carries exactly one signature, else `unsupported_permission`. That signature recovers to the
   transaction's owner, else `invalid_payload`.
6. The store does not hold the transaction id, else `invalid_transaction_state`.
7. `expiration` is in the future and no later than now plus `maxTimeoutSeconds`, else `invalid_payload`.
8. Five reads of the FullNode, made together. The first refusal in this order is the answer, and a node that does
   not answer gives `unexpected_verify_error`:
   - **The owner's permission.** `/wallet/getaccount` gives the owner permission, and the weight it gives the
     owner's key must be at least its threshold, else `unsupported_permission`. An account with no owner permission
     set, or one the node does not hold, has the network's default: its own key, weight 1, threshold 1. So a
     multi-signature owner, or an owner whose permission does not hold the address's own key, is refused here
     rather than at broadcast.
   - **TaPoS.** The node accepts a transaction only when `ref_block_hash` equals bytes 8–15 of the id of the latest
     block whose number's bytes 6–7 are `ref_block_bytes`. The facilitator reads the head with
     `/wallet/getnowblock`, then that block with `/wallet/getblock`, and makes the same comparison, else
     `invalid_transaction`.
   - **The id.** `/wallet/gettransactionbyid` must not find the transaction in a block, and
     `/wallet/gettransactionfrompending` must not find it in the node's pending pool, else
     `invalid_transaction_state`.
   - **The simulation.** `/wallet/triggerconstantcontract` simulates the transfer without failure, else
     `invalid_transaction`.

The answer is `{isValid: true, payer}`, with `payer` the owner in base58check.

## What `/settle` does

1. Repeats the checks of `/verify` that read neither the store nor the node (steps 1 to 5).
2. Reads the stored answer for the transaction id. A stored success means the payment is consumed: the answer is
   `invalid_transaction_state` with the transaction id, never a second success. Any other final answer is returned
   as it is. A claimed id, or a stored `settlement_pending`, goes on to step 6 and broadcasts nothing.
3. For an id the store does not hold, repeats the expiration check and the node reads of `/verify`. An id the node
   already holds is a consumed payment, answered `invalid_transaction_state` with the id.
4. Claims the transaction id with one conditional insert, so concurrent settles of one payment broadcast once.
5. Broadcasts the signed bytes with `/wallet/broadcasthex`. A `DUP_TRANSACTION_ERROR` counts as broadcast.
6. Reads the transaction's status every second with `@integraledger/lcp`'s `tronStatus`: the Solidity node's
   `gettransactioninfobyid` first, then the FullNode's. Success requires receipt result `SUCCESS` **and** a
   `Transfer` log emitted by `asset`. The value the call returned is not read: a TRC-20 token may return false from
   `transfer` and still transfer, and USDT-TRC20 does. A receipt with another result, or `SUCCESS` with no such log,
   is a failure only once the Solidity node, which serves solidified blocks alone, shows it. A transaction whose
   expiration has passed and that no node shows once the solidified head is two slots past it can never be included.
   Each failure is answered `invalid_transaction_state`.
7. Stores the answer and returns it. A success is returned only by the settle whose write stored it, so of two
   concurrent settles of one payment, one answers success and the other `invalid_transaction_state` with the id. A
   success whose write fails is answered `settlement_pending` with the id.

Success is `{success: true, transaction, network, payer}`, where `transaction` is the transaction id in hex.

## Where H is on chain

H is in `raw_data.data`, inside the bytes whose SHA-256 is the transaction id the payer signed. It is read by
transaction id from a Solidity node. No index searches memos.
