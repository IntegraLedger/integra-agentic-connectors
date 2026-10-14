/**
 * x402's `unexpected_verify_error` and `unexpected_settle_error`: a failure inside the facilitator, its node or its
 * store stopped a check or a settlement, and the client gets nothing it can act on. Each is given only here, once its
 * entry is in the operator log, so the operator sees why whenever a client gets one.
 */
import { failed, type InvalidReason, type OperatorEntry, type OperatorLog, type SettleAnswer } from "./answers.js";

/** `unexpected_verify_error`, once `entry` is in the operator log, with `cause` when there is one. */
export function unexpectedVerify(log: OperatorLog, entry: OperatorEntry, cause?: unknown): InvalidReason {
  log(entry, cause);
  return "unexpected_verify_error";
}

/**
 * `unexpected_settle_error` on `entry.network`, with no transaction, once `entry` is in the operator log, with `cause`
 * when there is one.
 */
export function unexpectedSettle(
  log: OperatorLog,
  entry: OperatorEntry & { network: string },
  cause?: unknown,
): SettleAnswer {
  log(entry, cause);
  return failed("unexpected_settle_error", "", entry.network);
}

/**
 * A verify reason as a settle answer's: a node or store that could not be read before submission is a settle error.
 * Its entry is the one written where the verify reason is given.
 */
export function settleReason(r: InvalidReason): string {
  return r === "unexpected_verify_error" ? "unexpected_settle_error" : r;
}
