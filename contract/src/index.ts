/**
 * The seller door's wire contract: the request and answer types, the OpenAPI description's bytes, and the vectors.
 */
import type { AtrHash, Json, LcpPattern } from "@integraledger/lcp";
import { OPENAPI_TEXT, VECTOR_TEXTS } from "./embedded.js";

/** One payment option, as the challenge will carry it. `pairing` is a pairing id the LCP package registers. */
export interface Offer {
  pairing: string;
  option: Json;
}
/** One content slot: strict RFC 4648 §4 base64 of the slot's exact bytes. */
export interface ContentSlot {
  slot: string;
  bytes: string;
}
/** The request an x402 challenge answers. */
export interface RequestCommitment {
  method: string;
  path: string;
  query: string;
  bodyDigest: AtrHash;
}
export interface IssueRequest {
  /** `^[A-Za-z0-9._:-]{1,128}$`: one state of one checkout. */
  mintRequestId: string;
  /** The resource id declared through the admin door, 1–512 bytes. */
  resource: string;
  /** Integer 1–604 800: the protocol's challenge lifetime. */
  lifetimeSeconds: number;
  /** 1–16, in the order the document will carry them. */
  offers: Offer[];
  /** 0–56 slots. */
  content?: ContentSlot[];
  /** Required on an x402 surface. */
  request?: RequestCommitment;
}
/** The carrier forms of this hash and link. */
export interface Carriers {
  lcp: string;
  legalContext: { type: "sha256"; value: AtrHash; legalContextUrl: string };
  legal_context: { type: "sha256"; value: AtrHash; legal_context_url: string };
}
/** Where the buyer pays the agreement step: the URL to place beside the carriers, its network, and its pairing. */
export interface AgreementLink {
  url: string;
  network: string;
  pairing: string;
}
export interface IssueResponse {
  atrHash: AtrHash;
  link: string;
  expiresAt: string;
  mintRequestId: string;
  carriers: Carriers;
  pairings: { pairing: string; pattern: LcpPattern }[];
  /** Present exactly when the record requires the agreement step. */
  agreement?: AgreementLink;
}
export interface ClaimRequest {
  resource: string;
  pairing: string;
  payment: Json;
  chosen: Json;
  network: string;
  request?: RequestCommitment;
  /** Unix seconds, at most now + 604 800. */
  settleBy?: number;
}
/** What a record proves: whether the claim read the hash from the payment, the pairing's pattern, and the evidence it was paid on. */
export interface Proves {
  claimed: boolean;
  pattern: LcpPattern | null;
  /** A read of the rail, the facilitator's settle answer, or the seller's report on a pairing with nothing to read; null while unpaid. */
  settledBy: "read" | "facilitator" | "seller-report" | null;
}
export interface ClaimResponse {
  atrHash: AtrHash;
  state: "settling";
  pairing: string;
  proves: Proves;
}
/**
 * A pushed payment that landed and then failed the check: reported, never refused. `atrHash` is the hash the payment
 * is bound to, or null when it is bound to none; `code` is the check's code; `transaction` is the landed transaction.
 */
export interface ClaimDeclined {
  atrHash: AtrHash | null;
  state: "declined";
  pairing: string;
  code: string;
  transaction: string | null;
}
/** A payment's outcome; `reference`: 1–256 characters, no control characters. */
export interface ReportOutcome {
  atrHash: AtrHash;
  pairing: string;
  outcome: "paid" | "declined";
  reference?: string;
  network?: string;
  /** On a record with no claim: the option the payment paid, as issued, from which its read keys are taken. */
  chosen?: Json;
  /** With `chosen`, on a surface whose issued options are tied to the request. */
  request?: RequestCommitment;
  /** On a confirm-only channel pairing's paid report: the receipt its opening answered, from which the channel is read. */
  receipt?: Json;
}
/** A channel pairing's close: the close transaction as `reference`. */
export interface ReportClosed {
  atrHash: AtrHash;
  pairing: string;
  state: "closed";
  reference: string;
  network?: string;
  chosen?: Json;
}
export type ReportRequest = ReportOutcome | ReportClosed;
/** A channel pairing's channel: `until` is the rail's deadline for the channel, or null when the rail gives none. */
export interface ChannelView {
  network: string;
  channel: string;
  until: string | null;
  closed: boolean;
}
/** The agreement step's leg of a record. */
export interface AgreementView {
  state: "required" | "settling" | "recorded";
  network: string | null;
  transaction: string | null;
}
export interface RecordView {
  atrHash: AtrHash;
  state: "issued" | "settling" | "paid" | "closed";
  expiresAt: string;
  settlement: { pairing: string; network?: string; reference?: string } | null;
  proves: Proves;
  /** Null when the record requires no agreement step. */
  agreement: AgreementView | null;
  channel: ChannelView | null;
}
export interface Refusal {
  code: string;
  sentence: string;
  correlationId: string;
}

/** The closed refusal table: each code and its status. */
export const REFUSALS: Readonly<Record<string, number>> = Object.freeze({
  "door/malformed": 400,
  "door/unauthenticated": 401,
  "door/browser-origin": 403,
  "door/not-found": 404,
  "door/resource-unknown": 404,
  "claim/unknown": 404,
  "door/method": 405,
  "door/too-large": 413,
  "door/media-type": 415,
  "issue/mint-request-reused": 409,
  "issue/mint-request-lapsed": 409,
  "claim/in-progress": 409,
  "claim/paid": 409,
  "claim/not-this-request": 409,
  "claim/channel-open": 409,
  "claim/channel-not-open": 409,
  "claim/agreement-first": 409,
  "claim/instrument-claimed": 409,
  "report/pairing-mismatch": 409,
  "settle/other-reference": 409,
  "settle/not-settling": 409,
  "claim/lapsed": 410,
  "door/request-required": 422,
  "door/chosen-required": 422,
  "door/receipt-required": 422,
  "door/reference-required": 422,
  "issue/input-bounds": 422,
  "issue/pairing-not-served": 422,
  "issue/offer-refused": 422,
  "issue/mixed-protocols": 422,
  "core/slot-name": 422,
  "core/slot-reserved": 422,
  "core/slot-duplicate": 422,
  "core/content-not-json": 422,
  "core/binding-not-json": 422,
  "core/too-large": 422,
  "claim/pairing-unknown": 422,
  "claim/not-bound": 422,
  "claim/nothing-to-check": 422,
  "issue/deadline": 503,
  "issue/contributor-unavailable": 503,
  "issue/storage-unavailable": 503,
  "issue/store-unavailable": 503,
  "issue/capacity": 503,
  "claim/store-unavailable": 503,
  "claim/read-unavailable": 503,
  "settle/store-unavailable": 503,
});

/** One vector: requests to the door and the answers they must produce. */
export interface Vector {
  name: string;
  fixed: {
    tenant: string;
    credential: string;
    credentialDigest: string;
    resources: { id: string; pairings: string[] }[];
    storageBase: string;
    clock: number;
    atrIds: string[];
    /** The tenant's hosts: an agreement URL is on the agreement's `host`, or on the tenant's only host. */
    hosts?: string[];
    /** The tenant's agreement step: the nominal payment's pairing, network, asset, payee, amount and time bound. */
    agreement?: {
      pairing: string;
      network: string;
      asset: string;
      payTo: string;
      amount: string;
      maxTimeoutSeconds: number;
      extra?: { [k: string]: Json };
      /** The tenant host the agreement URL is on; required when `hosts` has more than one. */
      host?: string;
    };
  };
  steps: {
    /** Before the request, the buyer's agreement payment for this step's record was recorded on chain as stated. */
    agreed?: { atrHash: AtrHash; network: string; transaction: string };
    request: { method: string; path: string; headers: Record<string, string>; body?: Json };
    expect: { status: number; body: Json; headers?: Record<string, string> };
    stored?: { bytes: string; sha256: string };
    storedFiles?: number;
  }[];
  source: string;
}

/** The bytes of `openapi.json`. */
export const OPENAPI_BYTES: Uint8Array = new TextEncoder().encode(OPENAPI_TEXT);

/** The vector files, parsed, by name (`CV1` …). */
export const VECTORS: Readonly<Record<string, Vector>> = Object.freeze(
  Object.fromEntries(VECTOR_TEXTS.map(([name, text]) => [name, JSON.parse(text) as Vector])),
);
