---
title: Getting started
description: Install the contract, then issue an ATR, claim a payment and read a record against a local stand-in door.
---

# Getting started

This page takes one x402 payment through the seller door: issue the ATR, claim the payment, and read the record.
Every step is a complete program you can run.

## 1. Install

```sh
npm install @integraledger/agentic-connectors
```

The package needs Node.js `>=26.10.0` and is ESM only. Node.js 26 runs TypeScript files directly, so each
program below runs with `node <file>.ts`.

## 2. Point at a door

The programs read two variables:

- `SELLER_DOOR_URL`: your door's base URL, such as `https://seller.example/door`;
- `SELLER_CREDENTIAL`: the tenant's seller credential, `isk_` and 43 base64url characters.

Without a door, use the stand-in in this repository. It answers exactly as the contract's vectors say, so the
programs print what is shown here:

```sh
git clone https://github.com/IntegraLedger/integra-agentic-connectors.git
cd integra-agentic-connectors
pnpm install --frozen-lockfile && pnpm -r --if-present run build
node scripts/stand-in-door.mjs 4010 &
export SELLER_DOOR_URL=http://127.0.0.1:4010
export SELLER_CREDENTIAL=isk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
```

The stand-in knows only the requests the vectors hold; anything else answers `501 stand-in/no-vector`.

## 3. Issue the ATR

Before the buyer approves, send the options the 402 will carry, the request they answer, and the parties' content.
The door writes the ATR to the seller's storage, hashes it, and answers with the values to place.

```ts title="issue.ts"
import type { IssueRequest, IssueResponse, Refusal } from "@integraledger/agentic-connectors";

const door = process.env.SELLER_DOOR_URL ?? "https://seller.example/door";
const credential = process.env.SELLER_CREDENTIAL ?? "";

const request: IssueRequest = {
  mintRequestId: "chk_7Q2:v1",
  resource: "quote",
  lifetimeSeconds: 60,
  offers: [
    {
      pairing: "x402/exact/eip155/eip3009",
      option: {
        scheme: "exact",
        network: "eip155:84532",
        amount: "10000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
      },
    },
  ],
  request: {
    method: "GET",
    path: "/v1/report",
    query: "",
    bodyDigest: "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
  content: [{ slot: "terms", bytes: Buffer.from('"Pay 10000 base units of USDC for one report."').toString("base64") }],
};

const res = await fetch(`${door}/issue`, {
  method: "POST",
  headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
  body: JSON.stringify(request),
});
if (!res.ok) {
  const refusal = (await res.json()) as Refusal;
  throw new Error(`${res.status} ${refusal.code}: ${refusal.sentence}`);
}
const issued = (await res.json()) as IssueResponse;
console.log("H:   ", issued.atrHash);
console.log("link:", issued.link);
console.log("x402:", JSON.stringify(issued.carriers.legalContext));
console.log("until", issued.expiresAt);
```

```text output
H:    0x3c2394624c8c9a61ebaf7d8750a6f9ac21bf73e6369b7c0b64c83e34509cc3d3
link: https://atr.seller.example/0x3c2394624c8c9a61ebaf7d8750a6f9ac21bf73e6369b7c0b64c83e34509cc3d3
x402: {"type":"sha256","value":"0x3c2394624c8c9a61ebaf7d8750a6f9ac21bf73e6369b7c0b64c83e34509cc3d3","legalContextUrl":"https://atr.seller.example/0x3c2394624c8c9a61ebaf7d8750a6f9ac21bf73e6369b7c0b64c83e34509cc3d3"}
until 2026-09-21T14:14:20.000Z
```

On x402, `carriers.legalContext` is the `info` of the challenge's `legalContext` extension.
[x402 beside a seller's stack](./guides/x402.md) places it with the LCP package.

## 4. Claim the payment

When the buyer presents its payment, claim it before your facilitator verifies it. The payment below is the one in
vector `CV6`: its EIP-3009 authorization's `nonce` is H.

```ts title="claim.ts"
import type { ClaimRequest, ClaimResponse, Refusal } from "@integraledger/agentic-connectors";
import { VECTORS } from "@integraledger/agentic-connectors";

const door = process.env.SELLER_DOOR_URL ?? "https://seller.example/door";
const credential = process.env.SELLER_CREDENTIAL ?? "";

const body = VECTORS["CV6"]!.steps[1]!.request.body as unknown as ClaimRequest;
const res = await fetch(`${door}/claim`, {
  method: "POST",
  headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const answer = (await res.json()) as ClaimResponse | Refusal;
if ("code" in answer) throw new Error(`${res.status} ${answer.code}`);
console.log(answer.state, answer.atrHash);
console.log("claimed:", answer.proves.claimed, "pattern:", answer.proves.pattern?.pattern);
```

```text output
settling 0x3c2394624c8c9a61ebaf7d8750a6f9ac21bf73e6369b7c0b64c83e34509cc3d3
claimed: true pattern: native-field
```

The record is now `settling`. Send the payment to your facilitator's `/verify` and `/settle`, then report its
`transaction` (see [report](./guides/report.md)).

## 5. Read the record

```ts title="status.ts"
import type { RecordView, Refusal } from "@integraledger/agentic-connectors";

const door = process.env.SELLER_DOOR_URL ?? "https://seller.example/door";
const credential = process.env.SELLER_CREDENTIAL ?? "";

// SHA-256("abc"): a hash this door never issued.
const res = await fetch(`${door}/status/0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`, {
  headers: { authorization: `Bearer ${credential}` },
});
const answer = (await res.json()) as RecordView | Refusal;
console.log(res.status, "code" in answer ? answer.code : answer.state);
```

```text output
404 door/not-found
```

## Next

- [The connector rules](./guides/connector-rules.md): what every connector does, and why.
- [Issue](./guides/issue.md), [claim](./guides/claim.md), [report](./guides/report.md) and [status](./guides/status.md)
  in depth.
- [The seller door API](./reference/seller-door-api.md): every field.
