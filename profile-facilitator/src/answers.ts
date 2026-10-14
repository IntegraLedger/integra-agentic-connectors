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
 * The reasons a payment is refused. The x402 codes are the x402 specification's (§9); `invalid_transaction_state` in
 * a verify answer is a Tron transaction id the node or the store already holds. `unsupported_permission` and
 * `invalid_transaction` are this facilitator's: a Tron owner permission that does not accept the transaction's one
 * signature, and a transaction the node refuses in simulation or validation.
 */
export type InvalidReason =
  | "invalid_x402_version"
  | "unsupported_scheme"
  | "invalid_network"
  | "invalid_payment_requirements"
  | "invalid_payload"
  | "unsupported_permission"
  | "invalid_transaction"
  | "invalid_transaction_state"
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

/**
 * An entry for the operator: what the facilitator saw that the answer does not carry. `network`, `payer` and
 * `transaction` name the payment it concerns, each where it is known.
 */
export interface OperatorEntry {
  event: string;
  network?: string;
  payer?: string;
  transaction?: string;
  [field: string]: unknown;
}

/** Receives each operator entry, with the error that caused it when there is one. */
export type OperatorLog = (entry: OperatorEntry, cause?: unknown) => void;

/** An error as a JSON value: its name, message and stack, and its `cause` the same way, at most 8 deep. */
function described(e: unknown, depth = 0): unknown {
  if (!(e instanceof Error)) return { message: String(e) };
  const out: Record<string, unknown> = { name: e.name, message: e.message, stack: e.stack };
  if (e.cause !== undefined && depth < 8) out["cause"] = described(e.cause, depth + 1);
  return out;
}

/**
 * The default operator log: one JSON line per entry on standard error. An entry with a cause carries it as `cause`:
 * the error's name, message and stack, and its own `cause` chain.
 */
export function operatorLine(entry: OperatorEntry, cause?: unknown): void {
  const line = cause === undefined ? entry : { ...entry, cause: described(cause) };
  process.stderr.write(`${JSON.stringify(line)}\n`);
}

/**
 * `log` as the facilitator calls it: what it throws, or a promise it returns that rejects, never reaches an answer.
 * The entry is then written by `operatorLine`, with an `operator-log-failed` entry whose cause is what `log` threw.
 */
export function guarded(log: OperatorLog): OperatorLog {
  if (log === operatorLine) return log;
  return (entry, cause) => {
    const fallBack = (e: unknown) => {
      operatorLine(entry, cause);
      const failure: OperatorEntry = { event: "operator-log-failed" };
      for (const field of ["network", "payer", "transaction"] as const) {
        if (entry[field] !== undefined) failure[field] = entry[field];
      }
      operatorLine(failure, e);
    };
    try {
      const returned: unknown = log(entry, cause);
      if (returned instanceof Promise) returned.catch(fallBack);
    } catch (e) {
      fallBack(e);
    }
  };
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
