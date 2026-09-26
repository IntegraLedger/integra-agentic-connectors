---
title: Proof of agreement
description: The ATR, its hash, the Legal Context Protocol, pairings, bindings and the buyer gate, as a seller's systems meet them.
---

# Proof of agreement

Every payment a connector handles carries one proof: the hash of the record the buyer and the seller agreed to. This
page defines the terms the rest of the documentation uses.

## The Agentic Transaction Record (ATR)

The **Agentic Transaction Record (ATR)** is the agreement's record: one JSON document the seller serves at an
`https` link. Its bytes are written once, in a fixed order:

1. `atrVersion`, the format marker;
2. `id`, a per-transaction identifier;
3. the binding's slot, which ties the record to this payment (on x402, the `x402` slot records every option the
   challenge offers, exactly as issued, and the request it answers);
4. the parties' slots, each written as the exact bytes received.

Here is the ATR the seller door stores for vector `CV1`: 506 bytes, shown as they are.

```json no-check
{"atrVersion":"1","id":"6f1c2b0e-8d4a-4c3b-9e2f-1a7d5c9b3e50","x402":{"accepts":[{"scheme":"exact","network":"eip155:84532","amount":"10000","asset":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","payTo":"0x209693Bc6afc0C5328bA36FaF03C514EF312287C","maxTimeoutSeconds":60,"extra":{"name":"USDC","version":"2"}}],"request":{"method":"GET","path":"/v1/report","query":"","bodyDigest":"0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}},"terms":"Pay 10000 base units of USDC for one report."}
```

The seller door does not require, supply or read any party content. What goes into `content` is the parties'
choice: terms, a checkout, a signed quote, a credential. The door carries it as given.

## The ATR hash (H)

The **ATR hash (H)** is SHA-256 over the ATR's exact bytes, written `0x` and 64 lowercase hex digits. The bytes are
never canonicalised or re-serialised: the hash is over the bytes written, and the buyer hashes the bytes it fetches.

```ts title="hash.ts"
import { createHash } from "node:crypto";
import { VECTORS } from "@integraledger/agentic-connectors";

const stored = VECTORS["CV1"]!.steps[0]!.stored!;
const h = `0x${createHash("sha256").update(stored.bytes, "utf8").digest("hex")}`;
console.log(Buffer.byteLength(stored.bytes, "utf8"), h);
console.log(h === stored.sha256);
```

```text output
506 0x3c2394624c8c9a61ebaf7d8750a6f9ac21bf73e6369b7c0b64c83e34509cc3d3
true
```

## The Legal Context Protocol (LCP)

The **Legal Context Protocol (LCP)** is the pattern these packages serve: the payment carries H, so paying is
agreeing to that exact record. Whatever the protocol and rail, the pattern is the same:

1. The seller assembles the ATR, stores it where the buyer can fetch it, and puts H and the link in the payment
   request.
2. The buyer fetches the ATR, hashes the bytes it received, and compares the result with H before it signs anything.
3. The buyer's payment carries H, in the field the protocol or rail provides.
4. The seller checks that the payment carries the H it issued for this request.

## Pairings and bindings

A **pairing** is a payment protocol, scheme and rail combination, such as `x402/exact/eip155/eip3009`. The seller
door accepts every pairing `@integraledger/lcp` registers; [the pairings reference](../reference/pairings.md) lists
them.

A **binding** is how H rides in a pairing's payment: the field its specification defines. On
`x402/exact/eip155/eip3009`, H is the EIP-3009 authorization's `nonce`, which the payer signs and which lands on chain
in the token contract's `AuthorizationUsed` event. On a card payment, nothing the buyer signs carries H, and the
record says so.

Each pairing has a **pattern**: how it carries H, and what a record of it proves. The door returns the pattern with
every record, so a record never claims more than its pairing shows.

## The buyer gate

The **buyer gate** is the buyer-side check that compares the served bytes with H before anything is signed. A buyer
whose gate finds a mismatch, or cannot fetch the ATR, does not pay. That is why the seller door writes the ATR to the
seller's storage before `issue` answers: a storage failure means no challenge goes out. The buyer's side lives in
[integra-agentic-terms](https://github.com/IntegraLedger/integra-agentic-terms).

## Delivery, not storage

The ATR lives in the seller's storage, at the link `issue` returns. The buyer keeps its own copy. The door keeps
hashes and the few facts its check needs, and holds the bytes only while assembling them.
