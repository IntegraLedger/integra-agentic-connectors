---
title: Run the profile facilitator
description: Start the x402 facilitator for the Tron and Polkadot LCP profiles, configure its networks and store, and call it.
---

# Run the profile facilitator

[`@integraledger/profile-facilitator`](../../profile-facilitator/README.md) is an x402 facilitator for
`x402/exact/tron/lcp-trc20-memo` and `x402/exact/polkadot/lcp-assets-remark`. It verifies and settles payments whose
payer-signed transaction carries the ATR hash (H), holds no key and pays no fee. This guide runs it.

## Install

```sh
npm install @integraledger/profile-facilitator
```

It needs Node.js `>=26.10.0`, Postgres (the tests run on Postgres 18), and an HTTP endpoint for each network you
serve: a Tron FullNode and Solidity node, or a Polkadot Asset Hub RPC node.

## Start it and read what it supports

Start the facilitator for Tron mainnet and read what it supports. The node URLs below are java-tron's default HTTP
ports on your own node; the facilitator calls them only when a payment arrives. `DATABASE_URL` is your Postgres
connection string.

```ts title="supported.ts"
import { serveProfileFacilitator } from "@integraledger/profile-facilitator";

const facilitator = await serveProfileFacilitator({
  listen: "127.0.0.1:4020",
  tron: [{ network: "tron:728126428", fullNode: "http://127.0.0.1:8090", solidityNode: "http://127.0.0.1:8091" }],
  polkadot: [{ network: "polkadot:68d56f15f85d3136970ec16946040bc1", rpc: "http://127.0.0.1:9944" }],
  store: { url: process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/postgres" },
  settleWaitMs: 30_000,
});

const supported = await (await fetch("http://127.0.0.1:4020/supported")).json();
console.log(JSON.stringify(supported, null, 2));
await facilitator.close();
```

```text output
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "tron:728126428",
      "extra": {
        "assetTransferMethod": "lcp-trc20-memo"
      }
    },
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "polkadot:68d56f15f85d3136970ec16946040bc1",
      "extra": {
        "assetTransferMethod": "lcp-assets-remark"
      }
    }
  ],
  "extensions": [],
  "signers": {}
}
```

## Run it as a service

The package exports one function that starts the server; it has no command-line entry. A service is a short module
that reads its configuration and stops cleanly on a signal:

```ts title="facilitator.ts" server
import { serveProfileFacilitator } from "@integraledger/profile-facilitator";

const listen = process.env.LISTEN ?? "127.0.0.1:4021";
const facilitator = await serveProfileFacilitator({
  listen,
  tron: [
    {
      network: "tron:728126428",
      fullNode: process.env.TRON_FULL_NODE ?? "http://127.0.0.1:8090",
      solidityNode: process.env.TRON_SOLIDITY_NODE ?? "http://127.0.0.1:8091",
    },
  ],
  store: { url: process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/postgres" },
  settleWaitMs: Number(process.env.SETTLE_WAIT_MS ?? 30_000),
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void facilitator.close().then(() => process.exit(0));
  });
}
console.log(`facilitator listening on ${listen}`);
```

```text output
facilitator listening on 127.0.0.1:4021
```

Run it with `node facilitator.ts`: Node.js 26 runs TypeScript directly. `close()` stops accepting requests, closes
open connections, disconnects from the Polkadot nodes and closes the Postgres pool.

## Configuration

`serveProfileFacilitator(config)` takes a `ProfileFacilitatorConfig`:

| Field | Type | Meaning |
|---|---|---|
| `listen` | `string` | `"host:port"`; an IPv6 host may be written in brackets. |
| `tron` | `{ network, fullNode, solidityNode }[]`, optional | One entry per Tron network. `network` is `tron:<chain id in decimal>`. `fullNode` serves `/wallet/…` and `solidityNode` serves `/walletsolidity/…`; give each its base URL. |
| `polkadot` | `{ network, rpc }[]`, optional | One entry per network, `polkadot:68d56f15f85d3136970ec16946040bc1` or `polkadot:67f9723393ef76214df0118c34bbbd3d`. `rpc` is an HTTP JSON-RPC endpoint that serves `state_call` and `author_submitExtrinsic`. |
| `store` | `{ url }` | The Postgres connection string. Postgres holds the deduplication table only. |
| `settleWaitMs` | `number` | How long `/settle` waits for inclusion before it answers `settlement_pending`. A value that is not a positive finite number means 30 000. |

The facilitator serves only the networks it is configured with. A request for any other network is answered
`invalid_network`. At start it creates its table if it does not exist; a Polkadot node's runtime metadata is loaded on
the first payment for that network, and loaded again whenever the node's runtime version changes.

## Call it

Both `POST /verify` and `POST /settle` take the x402 facilitator request:
`{x402Version: 2, paymentPayload, paymentRequirements}`, with `paymentPayload.x402Version` 2 and
`paymentRequirements.scheme` `"exact"`.

```ts title="verify.ts"
import { serveProfileFacilitator } from "@integraledger/profile-facilitator";

const facilitator = await serveProfileFacilitator({
  listen: "127.0.0.1:4022",
  tron: [{ network: "tron:728126428", fullNode: "http://127.0.0.1:8090", solidityNode: "http://127.0.0.1:8091" }],
  store: { url: process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/postgres" },
  settleWaitMs: 30_000,
});

const request = {
  x402Version: 2,
  paymentPayload: { x402Version: 2, payload: { transaction: "0a02" } },
  paymentRequirements: {
    scheme: "exact",
    network: "tron:3448148188",
    amount: "10000",
    asset: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    payTo: "TCwX1UeSkVfu43HD5xNMmFqDR2Xgjdxihx",
    maxTimeoutSeconds: 60,
    extra: { assetTransferMethod: "lcp-trc20-memo" },
  },
};
for (const path of ["/verify", "/settle"]) {
  const res = await fetch(`http://127.0.0.1:4022${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  console.log(path, res.status, JSON.stringify(await res.json()));
}
await facilitator.close();
```

```text output
/verify 200 {"isValid":false,"invalidReason":"invalid_network"}
/settle 200 {"success":false,"errorReason":"invalid_network","transaction":"","network":"tron:3448148188"}
```

The rail specifics are in the [Tron](./tron.md) and [Polkadot](./polkadot.md) guides, and every answer and reason in
[the facilitator reference](../reference/profile-facilitator.md).

## Pending and repeated settles

When the wait ends first, `/settle` answers `{success: false, errorReason: "settlement_pending", transaction}` with
the transaction id or extrinsic hash; x402 requires that `transaction` not be empty. Call `/settle` again with the
same request: it reads the chain from where it stopped, never submits twice, and returns the final answer once there
is one. On Tron a payment is answered success once: every later `/settle` of it answers `invalid_transaction_state`
with the transaction id, because x402's `exact` family requires that a consumed payment produce a settlement failure,
never a success. An answer with an empty `transaction` means nothing was submitted. When the store cannot be read,
the facilitator cannot know whether the payment was submitted, so it answers `settlement_pending` with the id.

## Security

- **No key, no fee.** The facilitator signs nothing. It submits exactly the bytes the payer signed, and the payer pays
  every fee, as both profiles require.
- **Settled once.** Settlements are deduplicated by transaction id or extrinsic hash, atomically, until the validity
  window ends and for 24 hours after. On Tron a payment is answered success once, across every process that shares
  the store, and a transaction id the node already holds is refused.
- **Success only from the chain.** `success: true` is given only when a node shows the transaction in a block with
  the profile's success conditions: on Tron, receipt result `SUCCESS` and a `Transfer` log from the token.
- **What it does not check.** It checks that the payment carries H in the profile's form, not which H the seller
  issued. Its store claims a payment's id once, so the payment is submitted once. On Tron, a success is answered only
  by the settle whose write stored it, and a repeated `/settle` of that payment answers `invalid_transaction_state`
  with the transaction; on Polkadot, a repeated `/settle` gets the stored answer. Each profile's rule 6 puts the
  remaining checks on the resource server: it accepts a payment only when the payment's H is one it issued for that
  request and has not seen claimed. The seller door's `claim` makes both checks. It answers `404 claim/unknown` for an
  H it holds no record of, `409 claim/not-this-request` for a payment of another request, and `409 claim/in-progress`
  or `409 claim/paid` once the ATR's payment has been claimed. The facilitator checks the amount, asset and payee
  against the requirements it is given because x402 requires that of a facilitator, and carries no business or legal
  logic beyond that.
