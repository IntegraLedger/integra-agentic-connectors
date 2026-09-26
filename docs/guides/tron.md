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

The facilitator needs a FullNode (it calls `/wallet/triggerconstantcontract`, `/wallet/broadcasthex` and
`/wallet/gettransactioninfobyid`) and a Solidity node (`/walletsolidity/gettransactioninfobyid` and
`/walletsolidity/getnowblock`). A java-tron node serves both, on HTTP ports 8090 and 8091 by default.

## What `/verify` checks

In order; the first failure is the answer.

1. The network is configured, and the requirements are ones the profile admits (its rule 1), else
   `invalid_network` or `invalid_payment_requirements`.
2. `payload.transaction` is a serialized Tron `Transaction` in hex that decodes to exactly one
   `TriggerSmartContract` whose `data` is an LCP `sha256` string, else `invalid_payload`.
3. `asset` and `payTo` are Tron addresses, else `invalid_payment_requirements`.
4. The contract called is `asset`, and the call data is exactly `transfer(payTo, amount)`, else `invalid_payload`.
5. The transaction carries exactly one signature, else `unsupported_permission`. That signature recovers to the
   transaction's owner, else `invalid_payload`. A multi-signature owner permission is not served.
6. `expiration` is in the future and no later than now plus `maxTimeoutSeconds`, else `invalid_payload`.
7. The FullNode's `/wallet/triggerconstantcontract` simulates the transfer without failure, else
   `invalid_transaction`. A node that does not answer gives `unexpected_verify_error`.

The answer is `{isValid: true, payer}`, with `payer` the owner in base58check.

## What `/settle` does

1. Repeats every check of `/verify`.
2. Reads the stored answer for the transaction id. A final one is returned as it is, so a repeated `/settle` gets the
   first answer.
3. Claims the transaction id with one conditional insert, so concurrent settles of one payment broadcast once.
4. Broadcasts the signed bytes with `/wallet/broadcasthex`. A `DUP_TRANSACTION_ERROR` counts as broadcast.
5. Reads the receipt with `gettransactioninfobyid` every second. `SUCCESS` at the FullNode is success. Any other
   result is a failure only once the Solidity node, which serves solidified blocks alone, shows it. A transaction
   whose expiration has passed and that no node shows once the solidified head is two slots past it can never be
   included, and is answered `invalid_transaction_state`.
6. Stores the answer and returns it.

Success is `{success: true, transaction, network, payer}`, where `transaction` is the transaction id in hex.

## Where H is on chain

H is in `raw_data.data`, inside the bytes whose SHA-256 is the transaction id the payer signed. It is read by
transaction id from a Solidity node. No index searches memos.
