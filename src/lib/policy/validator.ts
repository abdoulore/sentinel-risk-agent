import type { Action, Guardian, GuardianStatus } from "@/lib/policy/types";
import { isActionType } from "@/lib/policy/types";
import type { SymbolFilters } from "@/lib/binance/filters";
import type { PositionState } from "@/lib/binance/account";
import { computeReductionQuantity, type QuantityBreakdown } from "@/lib/execution/quantity";

/**
 * The Validator owns permissions and bounds (BUILD_PLAN section 6).
 *
 *   Invalid intent                 -> REJECT
 *   Valid intent, unsafe magnitude -> CLAMP
 *   Valid intent within bounds     -> EXECUTE
 *
 * Clamping is deliberate: rejecting a valid protective action over a bad
 * parameter leaves the user exposed. Reducing by the permitted maximum still
 * protects the position.
 */

export type Resolution = "EXECUTE" | "CLAMPED" | "REJECTED";

export type RejectReason =
  | "ACTION_NOT_ALLOWED"
  | "INVALID_PARAMETER"
  | "GUARDIAN_NOT_ACTIVE"
  | "NO_POSITION"
  | "QUANTITY_BELOW_MIN"
  | "POSITION_INSUFFICIENT"
  | "SYMBOL_MISMATCH";

export interface ValidationCheck {
  label: string;
  passed: boolean;
  detail?: string;
}

export interface ValidationResult {
  /**
   * Whether the action was permitted *as requested*. A clamped action reports
   * allowed: false and still executes, at the clamped magnitude — matching the
   * contract in BUILD_PLAN section 6.
   */
  allowed: boolean;
  resolution: Resolution;
  reason?: RejectReason | "MAX_REDUCTION_EXCEEDED";
  requestedPercent?: number;
  maxAllowedPercent?: number;
  executedPercent?: number;
  /** The concrete order, present only when the action will execute. */
  quantity?: QuantityBreakdown;
  side?: "BUY" | "SELL";
  /** Ordered pre-execution checks, for the feed to render. */
  checks: ValidationCheck[];
}

/** True when the Execution Adapter should submit an order for this result. */
export function willExecute(result: ValidationResult): boolean {
  return result.resolution === "EXECUTE" || result.resolution === "CLAMPED";
}

export interface ValidationContext {
  guardian: Guardian;
  status: GuardianStatus;
  position: PositionState;
  filters: SymbolFilters;
}

function reject(reason: RejectReason, checks: ValidationCheck[]): ValidationResult {
  return { allowed: false, resolution: "REJECTED", reason, checks };
}

/**
 * Validates a proposed action against the Guardian and the live exchange
 * constraints. Runs on every action before execution, including actions the
 * policy engine produced itself.
 */
export function validateAction(
  action: Action,
  context: ValidationContext,
): ValidationResult {
  const { guardian, status, position, filters } = context;
  const checks: ValidationCheck[] = [];

  // --- Intent validity ---------------------------------------------------
  if (!isActionType(action.type)) {
    return reject("ACTION_NOT_ALLOWED", [
      {
        label: "Action type permitted",
        passed: false,
        detail: `${String(action.type)} is not a Guardian action`,
      },
    ]);
  }

  // watch and hold touch nothing; they are always permitted.
  if (action.type === "watch" || action.type === "hold") {
    return {
      allowed: true,
      resolution: "EXECUTE",
      checks: [{ label: "Action type permitted", passed: true, detail: action.type }],
    };
  }

  checks.push({
    label: "Action type permitted",
    passed: true,
    detail: `${action.type} is a defensive action`,
  });

  if (status !== "ACTIVE") {
    return reject("GUARDIAN_NOT_ACTIVE", [
      ...checks,
      {
        label: "Guardian active",
        passed: false,
        detail: status === "OBSERVING" ? "observe-only after emergency stop" : "guardian paused",
      },
    ]);
  }
  checks.push({ label: "Guardian active", passed: true });

  if (position.symbol !== guardian.symbol) {
    return reject("SYMBOL_MISMATCH", [
      ...checks,
      {
        label: "Symbol matches Guardian",
        passed: false,
        detail: `${position.symbol} vs ${guardian.symbol}`,
      },
    ]);
  }

  if (position.side === "FLAT" || position.positionAmt === 0) {
    return reject("NO_POSITION", [
      ...checks,
      { label: "Position open", passed: false, detail: "nothing to reduce" },
    ]);
  }
  checks.push({
    label: "Position open",
    passed: true,
    detail: `${position.side} ${Math.abs(position.positionAmt)}`,
  });

  // --- Magnitude ---------------------------------------------------------
  // close_position is a 100% reduction, still subject to maxReductionPercent.
  const requestedPercent = action.type === "close_position" ? 100 : (action.percent ?? NaN);

  if (!Number.isFinite(requestedPercent) || requestedPercent <= 0) {
    return reject("INVALID_PARAMETER", [
      ...checks,
      {
        label: "Percentage is a positive number",
        passed: false,
        detail: `received ${String(action.percent)}`,
      },
    ]);
  }

  const maxAllowedPercent = guardian.maxReductionPercent;
  const clamped = requestedPercent > maxAllowedPercent;
  const executedPercent = clamped ? maxAllowedPercent : requestedPercent;

  checks.push({
    label: "Percentage within Guardian maximum",
    passed: !clamped,
    detail: clamped
      ? `${requestedPercent}% exceeds ${maxAllowedPercent}% — clamped`
      : `${requestedPercent}% of ${maxAllowedPercent}% maximum`,
  });

  // --- Exchange constraints ----------------------------------------------
  // Market orders obey MARKET_LOT_SIZE, which can be stricter than LOT_SIZE.
  const quantity = computeReductionQuantity(
    position.positionAmt,
    executedPercent,
    filters.marketStepSize,
  );
  const qty = Number(quantity.steppedQty);

  checks.push({
    label: "Quantity valid after flooring to stepSize",
    passed: qty > 0,
    detail: `${quantity.rawQty.toFixed(8)} -> ${quantity.steppedQty} (step ${filters.marketStepSize})`,
  });

  if (qty < Number(filters.marketMinQty) || qty <= 0) {
    return reject("QUANTITY_BELOW_MIN", [
      ...checks,
      {
        label: "Quantity at or above minQty",
        passed: false,
        detail: `${quantity.steppedQty} < ${filters.marketMinQty}`,
      },
    ]);
  }
  checks.push({
    label: "Quantity at or above minQty",
    passed: true,
    detail: `${quantity.steppedQty} >= ${filters.marketMinQty}`,
  });

  if (qty > Math.abs(position.positionAmt)) {
    return reject("POSITION_INSUFFICIENT", [
      ...checks,
      {
        label: "Position sufficient for the reduction",
        passed: false,
        detail: `${quantity.steppedQty} > ${Math.abs(position.positionAmt)}`,
      },
    ]);
  }
  checks.push({
    label: "Position sufficient for the reduction",
    passed: true,
    detail: `${quantity.steppedQty} of ${Math.abs(position.positionAmt)}`,
  });

  // reduceOnly is not conditional. It is set on every Guardian action, which is
  // also what exempts the order from the minimum-notional filter.
  checks.push({ label: "reduceOnly", passed: true, detail: "set on every Guardian action" });

  return {
    allowed: !clamped,
    resolution: clamped ? "CLAMPED" : "EXECUTE",
    reason: clamped ? "MAX_REDUCTION_EXCEEDED" : undefined,
    requestedPercent,
    maxAllowedPercent,
    executedPercent,
    quantity,
    side: position.positionAmt > 0 ? "SELL" : "BUY",
    checks,
  };
}
