/** The x402 facilitator API's bodies, as this facilitator reads and writes them. */

/** `POST /verify` and `POST /settle` take the same body. */
export interface FacilitatorRequest {
  x402Version: 2;
  paymentPayload: {
    x402Version: 2;
    accepted?: unknown;
    payload: Record<string, unknown>;
    [k: string]: unknown;
  };
  paymentRequirements: {
    scheme: string;
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra?: Record<string, unknown>;
  };
}

/**
 * The reasons a payment is refused. The x402 codes are the x402 specification's (§9); `unsupported_permission` and
 * `invalid_transaction` are this facilitator's, for a multi-signature Tron owner and for a transaction the node
 * refuses in simulation or validation.
 */
export type InvalidReason =
  | "invalid_x402_version"
  | "unsupported_scheme"
  | "invalid_network"
  | "invalid_payment_requirements"
  | "invalid_payload"
  | "unsupported_permission"
  | "invalid_transaction"
  | "unexpected_verify_error";

export type VerifyAnswer = { isValid: true; payer: string } | { isValid: false; invalidReason: InvalidReason; payer?: string };

export type SettleAnswer =
  | { success: true; transaction: string; network: string; payer: string }
  | { success: false; errorReason: string; transaction: string; network: string };

export function invalid(invalidReason: InvalidReason, payer?: string): VerifyAnswer {
  return payer === undefined ? { isValid: false, invalidReason } : { isValid: false, invalidReason, payer };
}

/** x402 requires a non-empty `transaction` on `settlement_pending`. */
export function pending(transaction: string, network: string): SettleAnswer {
  return { success: false, errorReason: "settlement_pending", transaction, network };
}

export function failed(errorReason: string, transaction: string, network: string): SettleAnswer {
  return { success: false, errorReason, transaction, network };
}

export function isPending(a: SettleAnswer): boolean {
  return !a.success && a.errorReason === "settlement_pending";
}

/** One JSON line on standard error, for the operator: what the node reported that the answer does not carry. */
export function operatorLog(entry: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The shared shape checks of a request: the versions, the scheme, and the objects the rails read. Returns the typed
 * request, or the reason it is refused.
 */
export function readRequest(body: unknown): FacilitatorRequest | InvalidReason {
  if (!isObject(body)) return "invalid_payload";
  if (body["x402Version"] !== 2) return "invalid_x402_version";
  const p = body["paymentPayload"];
  const r = body["paymentRequirements"];
  if (!isObject(p) || !isObject(r)) return "invalid_payload";
  if (p["x402Version"] !== 2) return "invalid_x402_version";
  if (!isObject(p["payload"])) return "invalid_payload";
  if (r["scheme"] !== "exact") return "unsupported_scheme";
  if (typeof r["network"] !== "string") return "invalid_network";
  return body as unknown as FacilitatorRequest;
}
