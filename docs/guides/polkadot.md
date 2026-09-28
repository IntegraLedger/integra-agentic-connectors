---
title: Polkadot
description: What the profile facilitator verifies and settles for x402/exact/polkadot/lcp-assets-remark.
---

# Polkadot: `x402/exact/polkadot/lcp-assets-remark`

On Polkadot Asset Hub, H rides in a remark the payer signs, batched with the transfer:
`utility.batch_all([assets.transfer_keep_alive(asset, Id(payTo), amount), system.remark_with_event(R)])`, where R is
the 77 ASCII bytes `lcp:sha256:` followed by H in lowercase hex. The payer pays every fee, in DOT or in an asset its wallet selects.

| Requirement | Value |
|---|---|
| `scheme` | `exact` |
| `network` | `polkadot:68d56f15f85d3136970ec16946040bc1` (Polkadot Asset Hub) or `polkadot:67f9723393ef76214df0118c34bbbd3d` (Westend Asset Hub) |
| `amount` | The asset's atomic units |
| `asset` | The `pallet-assets` asset id, in decimal |
| `payTo` | The payee, in SS58 |
| `maxTimeoutSeconds` | At most 3 600 |
| `extra.assetTransferMethod` | `lcp-assets-remark` |
| `payload.extrinsic` | The signed v4 extrinsic, with a mortal era, in lowercase hex |
| `payload.call` | Its call, in lowercase hex |

The facilitator needs an RPC node that serves JSON-RPC over HTTP, including `state_call`, `author_submitExtrinsic`,
`chain_getBlock`, `chain_getFinalizedHead` and `state_getStorage`. It loads the network's runtime metadata on the first
payment, and again whenever the node's runtime version changes.

## What `/verify` checks

1. The network is configured, and the requirements are ones the profile admits, else `invalid_network` or
   `invalid_payment_requirements`.
2. `payload.extrinsic` and `payload.call` are lowercase hex; the call is exactly
   `utility.batch_all([assets.transfer_keep_alive(asset, Id(payTo), amount), system.remark_with_event(R)])` for this
   `asset`, `payTo` and `amount`, and R is exactly the 77 bytes `lcp:sha256:` followed by H in lowercase hex, else
   `invalid_payload`. `System.Remarked` carries the BLAKE2b-256 of the remark's bytes as signed, so a remark that
   spells H any other way, such as with upper-case digits, is refused.
3. With the network's runtime metadata, the extrinsic decodes as a signed v4 extrinsic whose call is `payload.call`
   byte for byte, with a mortal era, else `invalid_payload`. The node must serve the chain the network names (its
   genesis hash), else `unexpected_verify_error`.
4. `TaggedTransactionQueue_validate_transaction` at the best block returns `Ok`, else `invalid_transaction`.

The answer is `{isValid: true, payer}`, with `payer` the signer in SS58.

## What `/settle` does

1. Repeats every check of `/verify`.
2. Reads the stored answer for the extrinsic's BLAKE2b-256 hash, and returns a final one as it is.
3. Claims the hash, with the first block to scan: the block after the finalized head read before validation, never
   before the era's birth.
4. Submits with `author_submitExtrinsic`. A refusal that says the node has already seen the extrinsic or its nonce is
   read as possibly included, and the scan runs.
5. Scans every second: first the finalized blocks, then the blocks up to the head. In the block that holds the
   extrinsic, success needs `System.ExtrinsicSuccess`, `System.Remarked` for R's BLAKE2b-256 and `Assets.Transferred`
   for `asset`. A failure counts only in a finalized block. Once every block to the era's last is finalized without
   the extrinsic, it can never be included: `invalid_transaction_state`.
6. Stores the answer and returns it.

Success is `{success: true, transaction, network, payer}`, where `transaction` is `<block hash>-<extrinsic index>`.
While the extrinsic is broadcast but not yet in a block, the answer is `settlement_pending` with `transaction` set to
the extrinsic's hash.

## Where H is on chain

R is inside the extrinsic the payer signed, and the `System.Remarked` event carries its BLAKE2b-256. The extrinsic is
read by block and index. No index searches remarks.
