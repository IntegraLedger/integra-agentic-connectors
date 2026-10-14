---
title: "@integraledger/profile-facilitator"
description: "The exports of @integraledger/profile-facilitator."
---

# @integraledger/profile-facilitator

## Interfaces

### ProfileFacilitatorConfig

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-listen"></a> `listen` | `string` | "host:port" |
| <a id="property-operatorlog"></a> `operatorLog?` | (`entry`, `cause?`) => `void` | Receives every entry for the operator: what the facilitator saw that its answer does not carry, with `network`, `payer` and `transaction` naming the payment where they are known. `cause` is the error that caused the entry, when there is one; the answer to the client is the same either way, and carries nothing from it. Called once per entry; what it throws, or a promise it returns that rejects, goes to the default with an `operator-log-failed` entry. Default: one JSON line per entry on standard error, the cause as its `cause` (name, message, stack and its own `cause` chain). |
| <a id="property-polkadot"></a> `polkadot?` | `object`[] | An RPC node that serves `state_call` and `author_submitExtrinsic`. |
| <a id="property-settlewaitms"></a> `settleWaitMs` | `number` | How long `/settle` waits for inclusion before answering `settlement_pending`; default 30 000. |
| <a id="property-store"></a> `store` | `object` | Postgres, for deduplication only. |
| `store.url` | `string` | - |
| <a id="property-tron"></a> `tron?` | `object`[] | - |

## Functions

### serveProfileFacilitator()

> **serveProfileFacilitator**(`c`): `Promise`\<\{ `close`: `Promise`\<`void`\>; \}\>

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `c` | [`ProfileFacilitatorConfig`](#profilefacilitatorconfig) |

#### Returns

`Promise`\<\{ `close`: `Promise`\<`void`\>; \}\>
