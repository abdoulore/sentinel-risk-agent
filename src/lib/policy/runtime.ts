/**
 * Guardian runtime loop — ties the deterministic engines together and emits
 * domain events. The Agent Feed renders these events; it never manufactures
 * them (BUILD_PLAN §8).
 *
 *   evaluate rule → validate (EXECUTE/CLAMP/REJECT) → submitVerifiedReduction
 *   → emit fill/position events → Policy Engine re-evaluates → state change
 *
 * Ownership contract (BUILD_PLAN §1) is preserved strictly:
 *   - The Validator decides EXECUTE / CLAMP / REJECT and owns the quantity.
 *   - submitVerifiedReduction submits, verifies the fill, and confirms the
 *     position shrank. It does NOT decide policy state.
 *   - This loop (Policy Engine) ingests the verified outcome, re-runs policy
 *     against the new position, and determines WATCH / TRIGGERED.
 */
import type { MetricSnapshot, MetricValues } from "@/lib/metrics/engine";
import { computeMetrics } from "@/lib/metrics/engine";
import type { AccountState, PositionState } from "@/lib/binance/account";
import type { Candle } from "@/lib/binance/market";
import type { SymbolFilters } from "@/lib/binance/filters";
import type { ActionType, Guardian, GuardianStatus } from "@/lib/policy/types";
import {
  describeNextTrigger,
  evaluateGuardian,
  type EvaluationResult,
} from "@/lib/policy/engine";
import { validateAction, type ValidationResult } from "@/lib/policy/validator";
import {
  submitVerifiedReduction,
  type ExecutionAdapter,
  type ReducePositionInput,
  type ReductionOutcome,
  ExecutionSafeguardError,
} from "@/lib/execution/execution-adapter";
import { McpAuthRequiredError, McpToolError } from "@/lib/mcp/contract";
import {
  ExecutionStateUnknownError,
  IdempotencyConflictError,
  RelayNondeterminismError,
  RelayRequired,
} from "@/lib/mcp/host-relay";

/** Runtime activity of a Guardian, distinct from its control status. */
export type GuardianActivity = "ACTIVE" | "WATCH" | "TRIGGERED";

export type RuntimeEvent =
  | { type: "RULE_MATCHED"; at: number; guardianId: string; ruleId: string }
  | { type: "ACTION_PROPOSED"; at: number; actionType: ActionType; requestedPercent: number | null }
  | { type: "ACTION_CLAMPED"; at: number; requestedPercent: number; executedPercent: number }
  | { type: "ACTION_REJECTED"; at: number; reason: string }
  | {
      type: "EXECUTION_VALIDATED";
      at: number;
      positionQty: number;
      requestedQty: number;
      roundedQty: string;
      reduceOnly: true;
    }
  | { type: "ORDER_SUBMITTED"; at: number; orderId: number }
  | { type: "ORDER_FILLED"; at: number; orderId: number; executedQty: number }
  | { type: "POSITION_REFRESHED"; at: number; before: number; after: number }
  | { type: "GUARDIAN_REEVALUATING"; at: number }
  | { type: "GUARDIAN_STATE_CHANGED"; at: number; state: GuardianActivity; nextTrigger: string | null }
  // Failure events — never collapsed into a generic "error".
  | { type: "EXECUTION_BLOCKED"; at: number; cause: "MCP_AUTH_REQUIRED"; detail: string }
  | { type: "EXECUTION_REJECTED"; at: number; reason: string }
  | { type: "EXECUTION_FAILED"; at: number; reason: string }
  | {
      type: "EXECUTION_VERIFICATION_FAILED";
      at: number;
      reason: "POSITION_NOT_REDUCED_AFTER_FILL";
      before: number;
      after: number;
    }
  /**
   * The crash-after-submit window: order intent was journaled but no Binance
   * result ever was. Never retried automatically — reconciliation must
   * establish the truth from Binance before any further write is permitted.
   */
  | {
      type: "EXECUTION_STATE_UNKNOWN";
      at: number;
      executionId: string;
      clientOrderId: string | null;
      detail: string;
    }
  /** Same logical action re-issued with different arguments. Always a hard stop. */
  | { type: "IDEMPOTENCY_CONFLICT"; at: number; executionId: string; detail: string }
  /**
   * Agent Lab events. Emitted by the runtime so the feed renders stored facts;
   * the console never manufactures a lab line of its own.
   */
  | {
      type: "LAB_SCENARIO_STARTED";
      at: number;
      preset: string | null;
      overrides: Record<string, number | string>;
    }
  /**
   * A lab test proposal replaced the percentage the matched rule proposes,
   * before validation. The Guardian's own action and its maxReductionPercent
   * are untouched — this only makes the Validator's decision observable.
   */
  | {
      type: "LAB_PROPOSAL_INJECTED";
      at: number;
      guardianPercent: number | null;
      labPercent: number;
      maxReductionPercent: number;
    };

export type CycleTerminal =
  | "NO_ACTION"
  | "ACTION_REJECTED"
  | "EXECUTION_BLOCKED"
  | "EXECUTION_REJECTED"
  | "EXECUTION_FAILED"
  | "EXECUTION_VERIFICATION_FAILED"
  | "EXECUTION_STATE_UNKNOWN"
  | "IDEMPOTENCY_CONFLICT"
  | "REEVALUATED";

export interface GuardianCycleInput {
  guardian: Guardian;
  status: GuardianStatus;
  /**
   * Identifies this evaluation. Combined with the guardian and the rule that
   * fired it forms the executionId — the logical identity of the action, which
   * is what the relay uses for write idempotency. A replayed cycle keeps its id
   * (and must not resubmit); a genuinely new trigger gets a new one (and must).
   */
  cycleId?: string;
  /**
   * Agent Lab inputs for this cycle. Metric overrides already live in the
   * snapshot; this carries only what cannot: the scenario's identity and the
   * test proposal percentage.
   *
   * `proposedPercent` changes what a matched rule PROPOSES. It never reaches
   * the Validator's decision, maxReductionPercent, the quantity, the exchange
   * filters, or the position — the Validator still decides, independently,
   * whether to clamp it.
   */
  lab?: {
    preset?: string | null;
    overrides?: Record<string, number | string>;
    proposedPercent?: number | null;
  };
  filters: SymbolFilters;
  /** Current-cycle metrics; its sources.position is the live position. */
  snapshot: MetricSnapshot;
  adapter: ExecutionAdapter;
  /**
   * Re-run policy against the post-fill position. This is the Policy Engine
   * re-evaluating (injected so the loop stays testable and the ownership
   * boundary stays explicit).
   */
  reevaluate: (positionAfter: PositionState) => Promise<EvaluationResult>;
  /** Domain event sink. The UI subscribes; this loop only emits. */
  emit: (event: RuntimeEvent) => void;
}

export interface GuardianCycleResult {
  evaluation: EvaluationResult;
  validation: ValidationResult | null;
  outcome: ReductionOutcome | null;
  reevaluation: EvaluationResult | null;
  terminal: CycleTerminal;
}

export async function runGuardianCycle(
  input: GuardianCycleInput,
): Promise<GuardianCycleResult> {
  const { guardian, status, filters, snapshot, adapter, reevaluate, emit } = input;
  const position = snapshot.sources.position;

  // Announce the scenario before anything is evaluated, so the feed shows the
  // simulated inputs preceding the decision they produced.
  const labOverrides = input.lab?.overrides ?? (snapshot.overrides as Record<string, number | string>);
  if (labOverrides && Object.keys(labOverrides).length > 0) {
    emit({
      type: "LAB_SCENARIO_STARTED",
      at: Date.now(),
      preset: input.lab?.preset ?? null,
      overrides: labOverrides,
    });
  }

  const evaluation = evaluateGuardian(guardian, snapshot);
  const fired = evaluation.firedRule;
  if (!fired) {
    return { evaluation, validation: null, outcome: null, reevaluation: null, terminal: "NO_ACTION" };
  }

  emit({ type: "RULE_MATCHED", at: Date.now(), guardianId: guardian.id, ruleId: fired.rule.id });

  const guardianAction = fired.rule.action;

  // A lab test proposal may enlarge the PROPOSED percentage of a reduction, and
  // nothing else. The Guardian in force is unchanged; validateAction below is
  // handed the larger proposal and reaches its own conclusion about it.
  const labPercent = input.lab?.proposedPercent ?? null;
  const injecting =
    labPercent !== null && labPercent !== undefined && guardianAction.type === "reduce_position";

  const action = injecting ? { ...guardianAction, percent: labPercent } : guardianAction;

  if (injecting) {
    emit({
      type: "LAB_PROPOSAL_INJECTED",
      at: Date.now(),
      guardianPercent: guardianAction.percent ?? null,
      labPercent,
      maxReductionPercent: guardian.maxReductionPercent,
    });
  }

  const requestedPercent =
    action.type === "close_position" ? 100 : action.type === "reduce_position" ? action.percent ?? null : null;
  emit({ type: "ACTION_PROPOSED", at: Date.now(), actionType: action.type, requestedPercent });

  const validation = validateAction(action, { guardian, status, position, filters });

  if (validation.resolution === "REJECTED") {
    emit({ type: "ACTION_REJECTED", at: Date.now(), reason: validation.reason ?? "REJECTED" });
    return { evaluation, validation, outcome: null, reevaluation: null, terminal: "ACTION_REJECTED" };
  }

  if (validation.resolution === "CLAMPED") {
    emit({
      type: "ACTION_CLAMPED",
      at: Date.now(),
      requestedPercent: validation.requestedPercent ?? requestedPercent ?? 0,
      executedPercent: validation.executedPercent ?? 0,
    });
  }

  // watch / hold validate as EXECUTE but carry no order — nothing to submit.
  if (!validation.quantity || !validation.side) {
    return { evaluation, validation, outcome: null, reevaluation: null, terminal: "NO_ACTION" };
  }

  emit({
    type: "EXECUTION_VALIDATED",
    at: Date.now(),
    positionQty: Math.abs(position.positionAmt),
    requestedQty: validation.quantity.rawQty,
    roundedQty: validation.quantity.steppedQty,
    reduceOnly: true,
  });

  const reduceInput: ReducePositionInput = {
    symbol: guardian.symbol,
    side: validation.side,
    quantity: validation.quantity.steppedQty,
    executionId: input.cycleId
      ? `${guardian.id}:${fired.rule.id}:${input.cycleId}`
      : undefined,
  };

  let outcome: ReductionOutcome;
  try {
    outcome = await submitVerifiedReduction(adapter, reduceInput);
  } catch (err) {
    // Control flow, not failure: the runtime needs the host to relay a call.
    // Re-thrown so the caller can hand the envelope over and re-run; collapsing
    // it into EXECUTION_FAILED would turn a normal pause into a fake error.
    if (err instanceof RelayRequired) throw err;

    if (err instanceof ExecutionStateUnknownError) {
      emit({
        type: "EXECUTION_STATE_UNKNOWN",
        at: Date.now(),
        executionId: err.executionId,
        clientOrderId: err.clientOrderId ?? null,
        detail: err.message,
      });
      return {
        evaluation,
        validation,
        outcome: null,
        reevaluation: null,
        terminal: "EXECUTION_STATE_UNKNOWN",
      };
    }
    if (err instanceof IdempotencyConflictError) {
      emit({
        type: "IDEMPOTENCY_CONFLICT",
        at: Date.now(),
        executionId: err.executionId,
        detail: err.message,
      });
      return {
        evaluation,
        validation,
        outcome: null,
        reevaluation: null,
        terminal: "IDEMPOTENCY_CONFLICT",
      };
    }
    // Replay diverged from the journal — the runtime is no longer deterministic
    // against its own record, so it must stop rather than guess.
    if (err instanceof RelayNondeterminismError) {
      emit({ type: "EXECUTION_FAILED", at: Date.now(), reason: err.message });
      return { evaluation, validation, outcome: null, reevaluation: null, terminal: "EXECUTION_FAILED" };
    }
    if (err instanceof McpAuthRequiredError) {
      emit({ type: "EXECUTION_BLOCKED", at: Date.now(), cause: "MCP_AUTH_REQUIRED", detail: err.message });
      return { evaluation, validation, outcome: null, reevaluation: null, terminal: "EXECUTION_BLOCKED" };
    }
    if (err instanceof ExecutionSafeguardError) {
      emit({ type: "EXECUTION_REJECTED", at: Date.now(), reason: err.reason });
      return { evaluation, validation, outcome: null, reevaluation: null, terminal: "EXECUTION_REJECTED" };
    }
    if (err instanceof McpToolError) {
      emit({ type: "EXECUTION_FAILED", at: Date.now(), reason: err.message });
      return { evaluation, validation, outcome: null, reevaluation: null, terminal: "EXECUTION_FAILED" };
    }
    emit({ type: "EXECUTION_FAILED", at: Date.now(), reason: err instanceof Error ? err.message : String(err) });
    return { evaluation, validation, outcome: null, reevaluation: null, terminal: "EXECUTION_FAILED" };
  }

  // Real engine facts, read from the exchange's own response — not manufactured.
  emit({ type: "ORDER_SUBMITTED", at: outcome.submittedAt, orderId: outcome.order.orderId });
  emit({
    type: "ORDER_FILLED",
    at: outcome.order.updateTime || outcome.verifiedAt,
    orderId: outcome.order.orderId,
    executedQty: outcome.order.executedQty,
  });
  emit({
    type: "POSITION_REFRESHED",
    at: outcome.verifiedAt,
    before: outcome.positionBefore.positionAmt,
    after: outcome.positionAfter.positionAmt,
  });

  if (!outcome.quantityChanged) {
    emit({
      type: "EXECUTION_VERIFICATION_FAILED",
      at: Date.now(),
      reason: "POSITION_NOT_REDUCED_AFTER_FILL",
      before: outcome.positionBefore.positionAmt,
      after: outcome.positionAfter.positionAmt,
    });
    return { evaluation, validation, outcome, reevaluation: null, terminal: "EXECUTION_VERIFICATION_FAILED" };
  }

  // Policy Engine ingests the new position and re-runs. State is decided here,
  // never inside the execution layer.
  emit({ type: "GUARDIAN_REEVALUATING", at: Date.now() });
  const reevaluation = await reevaluate(outcome.positionAfter);
  const state: GuardianActivity = reevaluation.firedRule ? "TRIGGERED" : "WATCH";
  emit({
    type: "GUARDIAN_STATE_CHANGED",
    at: Date.now(),
    state,
    nextTrigger: describeNextTrigger(reevaluation),
  });

  return { evaluation, validation, outcome, reevaluation, terminal: "REEVALUATED" };
}

/**
 * Production re-evaluator: rebuilds metrics from the post-fill position and
 * re-runs the Policy Engine. Reuses the cycle's candles (no refetch) so only the
 * position-derived metrics move; funding/OI/momentum are unchanged within a
 * cycle. Account may be refreshed by the caller and passed in.
 */
export function metricsReevaluator(params: {
  guardian: Guardian;
  symbol: string;
  account: AccountState;
  candles: Candle[];
  overrides?: Partial<MetricValues>;
}): (positionAfter: PositionState) => Promise<EvaluationResult> {
  return async (positionAfter) => {
    const snapshot = await computeMetrics({
      symbol: params.symbol,
      position: positionAfter,
      account: params.account,
      candles: params.candles,
      overrides: params.overrides,
    });
    return evaluateGuardian(params.guardian, snapshot);
  };
}
