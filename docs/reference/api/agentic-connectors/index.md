---
title: "@integraledger/agentic-connectors"
description: "The exports of @integraledger/agentic-connectors."
---

# @integraledger/agentic-connectors

## Interfaces

### AgreementLink

Where the buyer pays the agreement step: the URL to place beside the carriers, its network, and its pairing.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-network"></a> `network` | `string` |
| <a id="property-pairing"></a> `pairing` | `string` |
| <a id="property-url"></a> `url` | `string` |

***

### AgreementView

The agreement step's leg of a record.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-network-1"></a> `network` | `string` \| `null` |
| <a id="property-state"></a> `state` | `"required"` \| `"settling"` \| `"recorded"` |
| <a id="property-transaction"></a> `transaction` | `string` \| `null` |

***

### Carriers

The carrier forms of this hash and link.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-lcp"></a> `lcp` | `string` |
| <a id="property-legal_context"></a> `legal_context` | `object` |
| `legal_context.legal_context_url` | `string` |
| `legal_context.type` | `"sha256"` |
| `legal_context.value` | `` `0x${string}` `` |
| <a id="property-legalcontext"></a> `legalContext` | `object` |
| `legalContext.legalContextUrl` | `string` |
| `legalContext.type` | `"sha256"` |
| `legalContext.value` | `` `0x${string}` `` |

***

### ChannelView

A channel pairing's channel: `until` is the rail's deadline for the channel, or null when the rail gives none.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-channel"></a> `channel` | `string` |
| <a id="property-closed"></a> `closed` | `boolean` |
| <a id="property-network-2"></a> `network` | `string` |
| <a id="property-until"></a> `until` | `string` \| `null` |

***

### ClaimDeclined

A pushed payment that landed and then failed the check: reported, never refused. `atrHash` is the hash the payment
is bound to, or null when it is bound to none; `code` is the check's code; `transaction` is the landed transaction.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-atrhash"></a> `atrHash` | `` `0x${string}` `` \| `null` |
| <a id="property-code"></a> `code` | `string` |
| <a id="property-pairing-1"></a> `pairing` | `string` |
| <a id="property-state-1"></a> `state` | `"declined"` |
| <a id="property-transaction-1"></a> `transaction` | `string` \| `null` |

***

### ClaimRequest

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-chosen"></a> `chosen` | `Json` | - |
| <a id="property-network-3"></a> `network` | `string` | - |
| <a id="property-pairing-2"></a> `pairing` | `string` | - |
| <a id="property-payment"></a> `payment` | `Json` | - |
| <a id="property-request"></a> `request?` | [`RequestCommitment`](#requestcommitment) | - |
| <a id="property-resource"></a> `resource` | `string` | - |
| <a id="property-settleby"></a> `settleBy?` | `number` | Unix seconds, at most now + 604 800. |

***

### ClaimResponse

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-atrhash-1"></a> `atrHash` | `` `0x${string}` `` |
| <a id="property-pairing-3"></a> `pairing` | `string` |
| <a id="property-proves"></a> `proves` | [`Proves`](#proves) |
| <a id="property-state-2"></a> `state` | `"settling"` |

***

### ContentSlot

One content slot: strict RFC 4648 §4 base64 of the slot's exact bytes.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-bytes"></a> `bytes` | `string` |
| <a id="property-slot"></a> `slot` | `string` |

***

### IssueRequest

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-content"></a> `content?` | [`ContentSlot`](#contentslot)[] | 0–56 slots. |
| <a id="property-lifetimeseconds"></a> `lifetimeSeconds` | `number` | Integer 1–604 800: the protocol's challenge lifetime. |
| <a id="property-mintrequestid"></a> `mintRequestId` | `string` | `^[A-Za-z0-9._:-]{1,128}$`: one state of one checkout. |
| <a id="property-offers"></a> `offers` | [`Offer`](#offer)[] | 1–16, in the order the document will carry them. |
| <a id="property-request-1"></a> `request?` | [`RequestCommitment`](#requestcommitment) | Required on an x402 surface. |
| <a id="property-resource-1"></a> `resource` | `string` | The resource id declared through the admin door, 1–512 bytes. |

***

### IssueResponse

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-agreement"></a> `agreement?` | [`AgreementLink`](#agreementlink) | Present exactly when the record requires the agreement step. |
| <a id="property-atrhash-2"></a> `atrHash` | `` `0x${string}` `` | - |
| <a id="property-carriers"></a> `carriers` | [`Carriers`](#carriers) | - |
| <a id="property-expiresat"></a> `expiresAt` | `string` | - |
| <a id="property-link"></a> `link` | `string` | - |
| <a id="property-mintrequestid-1"></a> `mintRequestId` | `string` | - |
| <a id="property-pairings"></a> `pairings` | `object`[] | - |

***

### Offer

One payment option, as the challenge will carry it. `pairing` is a pairing id the LCP package registers.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-option"></a> `option` | `Json` |
| <a id="property-pairing-4"></a> `pairing` | `string` |

***

### Proves

What a record proves: whether the claim read the hash from the payment, the pairing's pattern, and the evidence it was paid on.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-claimed"></a> `claimed` | `boolean` | - |
| <a id="property-pattern"></a> `pattern` | `LcpPattern` \| `null` | - |
| <a id="property-settledby"></a> `settledBy` | `"read"` \| `"facilitator"` \| `"seller-report"` \| `null` | A read of the rail, the facilitator's settle answer, or the seller's report on a pairing with nothing to read; null while unpaid. |

***

### RecordView

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-agreement-1"></a> `agreement` | [`AgreementView`](#agreementview) \| `null` | Null when the record requires no agreement step. |
| <a id="property-atrhash-3"></a> `atrHash` | `` `0x${string}` `` | - |
| <a id="property-channel-1"></a> `channel` | [`ChannelView`](#channelview) \| `null` | - |
| <a id="property-expiresat-1"></a> `expiresAt` | `string` | - |
| <a id="property-proves-1"></a> `proves` | [`Proves`](#proves) | - |
| <a id="property-settlement"></a> `settlement` | \{ `network?`: `string`; `pairing`: `string`; `reference?`: `string`; \} \| `null` | - |
| <a id="property-state-3"></a> `state` | `"closed"` \| `"settling"` \| `"paid"` \| `"issued"` | - |

***

### Refusal

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-code-1"></a> `code` | `string` |
| <a id="property-correlationid"></a> `correlationId` | `string` |
| <a id="property-sentence"></a> `sentence` | `string` |

***

### ReportClosed

A channel pairing's close: the close transaction as `reference`.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-atrhash-4"></a> `atrHash` | `` `0x${string}` `` |
| <a id="property-chosen-1"></a> `chosen?` | `Json` |
| <a id="property-network-4"></a> `network?` | `string` |
| <a id="property-pairing-5"></a> `pairing` | `string` |
| <a id="property-reference"></a> `reference` | `string` |
| <a id="property-state-4"></a> `state` | `"closed"` |

***

### ReportOutcome

A payment's outcome; `reference`: 1–256 characters, no control characters.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-atrhash-5"></a> `atrHash` | `` `0x${string}` `` | - |
| <a id="property-chosen-2"></a> `chosen?` | `Json` | On a record with no claim: the option the payment paid, as issued, from which its read keys are taken. |
| <a id="property-network-5"></a> `network?` | `string` | - |
| <a id="property-outcome"></a> `outcome` | `"declined"` \| `"paid"` | - |
| <a id="property-pairing-6"></a> `pairing` | `string` | - |
| <a id="property-receipt"></a> `receipt?` | `Json` | On a confirm-only channel pairing's paid report: the receipt its opening answered, from which the channel is read. |
| <a id="property-reference-1"></a> `reference?` | `string` | - |
| <a id="property-request-2"></a> `request?` | [`RequestCommitment`](#requestcommitment) | With `chosen`, on a surface whose issued options are tied to the request. |

***

### RequestCommitment

The request an x402 challenge answers.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="property-bodydigest"></a> `bodyDigest` | `` `0x${string}` `` |
| <a id="property-method"></a> `method` | `string` |
| <a id="property-path"></a> `path` | `string` |
| <a id="property-query"></a> `query` | `string` |

***

### Vector

One vector: requests to the door and the answers they must produce.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-fixed"></a> `fixed` | `object` | - |
| `fixed.agreement?` | `object` | The tenant's agreement step: the nominal payment's pairing, network, asset, payee, amount and time bound. |
| `fixed.agreement.amount` | `string` | - |
| `fixed.agreement.asset` | `string` | - |
| `fixed.agreement.extra?` | `object` | - |
| `fixed.agreement.host?` | `string` | The tenant host the agreement URL is on; required when `hosts` has more than one. |
| `fixed.agreement.maxTimeoutSeconds` | `number` | - |
| `fixed.agreement.network` | `string` | - |
| `fixed.agreement.pairing` | `string` | - |
| `fixed.agreement.payTo` | `string` | - |
| `fixed.atrIds` | `string`[] | - |
| `fixed.clock` | `number` | - |
| `fixed.credential` | `string` | - |
| `fixed.credentialDigest` | `string` | - |
| `fixed.hosts?` | `string`[] | The tenant's hosts: an agreement URL is on the agreement's `host`, or on the tenant's only host. |
| `fixed.resources` | `object`[] | - |
| `fixed.storageBase` | `string` | - |
| `fixed.tenant` | `string` | - |
| <a id="property-name"></a> `name` | `string` | - |
| <a id="property-source"></a> `source` | `string` | - |
| <a id="property-steps"></a> `steps` | `object`[] | - |

## Type Aliases

### ReportRequest

> **ReportRequest** = [`ReportOutcome`](#reportoutcome) \| [`ReportClosed`](#reportclosed)

## Variables

### OPENAPI\_BYTES

> `const` **OPENAPI\_BYTES**: `Uint8Array`

The bytes of `openapi.json`.

***

### REFUSALS

> `const` **REFUSALS**: `Readonly`\<`Record`\<`string`, `number`\>\>

The closed refusal table: each code and its status.

***

### VECTORS

> `const` **VECTORS**: `Readonly`\<`Record`\<`string`, [`Vector`](#vector)\>\>

The vector files, parsed, by name (`CV1` …).
