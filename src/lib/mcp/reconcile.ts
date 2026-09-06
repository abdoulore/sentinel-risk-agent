/**
 * Reconciliation for the crash-after-submit window.
 *
 * The hardest failure in the relay is not an error — it is silence:
 *
 *     Binance accepts the order
 *              ↓
 *     host dies before the result is journaled
 *              ↓
 *     journal holds REQUESTED, forever ambiguous
 *
 * Retrying there could double the trade. Assuming failure could leave a position
 * unprotected. The only safe move is to go and ask Binance what actually
 * happened, which is possible because the clientOrderId was derived
 * deterministically from the executionId before the order was ever sent.
 *
 * This module owns the *decision*, not the I/O: it produces the exact query the
 * host must relay, and it interprets the answer. The host does neither.
 */
import { RelayJournal, clientOrderIdFor, type RelayRecord } from "@/lib/mcp/journal";

export interface ReconciliationQuery {
  executionId: string;
  requestId: string;
  clientOrderId: string;
  /** The exact MCP call the host must relay to settle the ambiguity. */
  tool: string;
  args: Record<string, unknown>;
}

export type ReconciliationOutcome =
  /** Binance has the order: it was submitted. The journal is completed with it. */
  | { state: "ORDER_EXISTS"; record: RelayRecord; order: Record<string, unknown> }
  /** Binance has no such order: nothing was submitted. Safe to act again. */
  | { state: "ORDER_ABSENT"; record: RelayRecord }
  /** Not ambiguous in the first place. */
  | { state: "NOT_PENDING"; record: RelayRecord | undefined };

/** Binance error codes meaning "no such order" rather than "lookup failed". */
const ORDER_NOT_FOUND_CODES = [-2013];

export class ReconciliationError extends Error {
  constructor(detail: string) {
    super(`RECONCILIATION: ${detail}`);
    this.name = "ReconciliationError";
  }
}

/**
 * Build the query that settles an ambiguous write. Returns null when the
 * executionId is not actually in the ambiguous state.
 */
export function planReconciliation(
  journal: RelayJournal,
  executionId: string,
): ReconciliationQuery | null {
  const record = journal.findByExecutionId(executionId);
  if (!record || record.status !== "REQUESTED") return null;

  const clientOrderId =
    typeof record.args.newClientOrderId === "string"
      ? record.args.newClientOrderId
      : clientOrderIdFor(executionId);

  const symbol = record.args.symbol;
  if (typeof symbol !== "string") {
    throw new ReconciliationError(`journaled write ${record.requestId} has no symbol`);
  }

  return {
    executionId,
    requestId: record.requestId,
    clientOrderId,
    // Queried by clientOrderId precisely because we never learned the orderId.
    tool: "futures_usds_queryOrder",
    args: { symbol, origClientOrderId: clientOrderId },
  };
}

/**
 * Interpret the host's answer and settle the journal.
 *
 * An order that exists is recorded as the write's real result, so every replay
 * from here on returns that fill instead of resubmitting. An order that is
 * genuinely absent is recorded as failed, which releases the executionId's
 * ambiguity — the Guardian may then act again under a *new* executionId.
 */
export function applyReconciliation(
  journal: RelayJournal,
  query: ReconciliationQuery,
  hostResult: { ok: true; order: Record<string, unknown> } | { ok: false; error: unknown },
): ReconciliationOutcome {
  const record = journal.findByExecutionId(query.executionId);
  if (!record || record.status !== "REQUESTED") {
    return { state: "NOT_PENDING", record };
  }

  if (hostResult.ok) {
    const order = hostResult.order;
    const returned = order.clientOrderId;
    if (typeof returned === "string" && returned !== query.clientOrderId) {
      throw new ReconciliationError(
        `Binance returned clientOrderId ${returned}, expected ${query.clientOrderId} — ` +
          "refusing to attribute a different order to this execution",
      );
    }
    return {
      state: "ORDER_EXISTS",
      record: journal.fulfill(record.requestId, order),
      order,
    };
  }

  const detail =
    typeof hostResult.error === "string"
      ? hostResult.error
      : JSON.stringify(hostResult.error ?? "");
  const notFound = ORDER_NOT_FOUND_CODES.some((c) => detail.includes(String(c)))
    || /does not exist|unknown order/i.test(detail);

  if (!notFound) {
    // The lookup itself failed. Still ambiguous — leave it REQUESTED.
    throw new ReconciliationError(
      `could not determine order state for ${query.executionId}: ${detail}. ` +
        "Journal left ambiguous; do not submit.",
    );
  }

  return {
    state: "ORDER_ABSENT",
    record: journal.fail(record.requestId, {
      reconciled: true,
      conclusion: "ORDER_NEVER_REACHED_BINANCE",
      detail,
    }),
  };
}
