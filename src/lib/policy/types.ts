/**
 * The compiled Guardian schema (BUILD_PLAN section 5).
 *
 * A Guardian is data. The LLM produces one, the user reviews and activates it,
 * and from that point nothing interprets it but deterministic code.
 */

/**
 * Every metric the Metric Engine actually produces. A compiled policy may
 * reference nothing outside this registry — that constraint is what stops the
 * LLM from inventing a measurement.
 */
export const METRIC_REGISTRY = {
  momentum: {
    kind: "enum",
    values: ["BEARISH", "BULLISH", "NEUTRAL"],
    label: "Momentum",
    describe: (v: unknown) => String(v),
  },
  funding_rate: {
    kind: "number",
    label: "Funding rate",
    // Stored as a decimal: 0.0003 is 0.03%.
    describe: (v: unknown) => `${(Number(v) * 100).toFixed(4)}%`,
  },
  funding_direction: {
    kind: "enum",
    values: ["RISING", "FALLING", "FLAT"],
    label: "Funding direction",
    describe: (v: unknown) => String(v),
  },
  open_interest: {
    kind: "number",
    label: "Open interest",
    describe: (v: unknown) => Number(v).toLocaleString(),
  },
  oi_change_percent: {
    kind: "number",
    label: "OI change",
    describe: (v: unknown) => `${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(2)}%`,
  },
  unrealized_pnl: {
    kind: "number",
    label: "Unrealized PnL",
    describe: (v: unknown) => `${Number(v).toFixed(2)} USDT`,
  },
  unrealized_pnl_percent: {
    kind: "number",
    label: "Unrealized PnL",
    describe: (v: unknown) => `${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(2)}%`,
  },
  liquidation_distance_percent: {
    kind: "number",
    label: "Liquidation distance",
    describe: (v: unknown) => `${Number(v).toFixed(2)}%`,
  },
  position_size: {
    kind: "number",
    label: "Position size",
    describe: (v: unknown) => String(v),
  },
  leverage: {
    kind: "number",
    label: "Leverage",
    describe: (v: unknown) => `${Number(v)}x`,
  },
  margin_ratio: {
    kind: "number",
    label: "Margin ratio",
    describe: (v: unknown) => `${(Number(v) * 100).toFixed(2)}%`,
  },
} as const;

export type MetricName = keyof typeof METRIC_REGISTRY;

export const METRIC_NAMES = Object.keys(METRIC_REGISTRY) as MetricName[];

export function isMetricName(value: string): value is MetricName {
  return Object.prototype.hasOwnProperty.call(METRIC_REGISTRY, value);
}

export const OPERATORS = [">", ">=", "<", "<=", "==", "!="] as const;
export type Operator = (typeof OPERATORS)[number];

export function isOperator(value: string): value is Operator {
  return (OPERATORS as readonly string[]).includes(value);
}

/** The only actions a Guardian may take. Anything else is rejected. */
export const ACTION_TYPES = ["reduce_position", "close_position", "watch", "hold"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export function isActionType(value: string): value is ActionType {
  return (ACTION_TYPES as readonly string[]).includes(value);
}

export interface Condition {
  metric: MetricName;
  operator: Operator;
  value: number | string;
}

export interface Action {
  type: ActionType;
  /** Required for reduce_position; absent otherwise. */
  percent?: number;
}

export interface Rule {
  id: string;
  /** All conditions must hold. */
  conditions: Condition[];
  action: Action;
}

export interface Guardian {
  id: string;
  name: string;
  symbol: string;
  mode: "guarded";
  /** The hard ceiling on any single reduction, enforced by the Validator. */
  maxReductionPercent: number;
  rules: Rule[];
}

/**
 * A Guardian in observe-only mode still evaluates and still emits events, but
 * the Validator refuses every action. This is what the emergency stop sets.
 */
export type GuardianStatus = "ACTIVE" | "OBSERVING" | "PAUSED";
