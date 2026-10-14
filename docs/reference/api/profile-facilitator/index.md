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
