import { METRIC_REGISTRY, type Condition, type Guardian, type Rule } from "@/lib/policy/types";
import type { MetricSnapshot, MetricValues } from "@/lib/metrics/engine";

/**
 * The Policy Engine owns rules (BUILD_PLAN section 1).
 *
 * It evaluates a compiled Guardian against a metric snapshot. The LLM compiled
 * the Guardian and has not been consulted since; nothing here calls a model.
 */

export interface ConditionResult {
  condition: Condition;
  /** The value the engine actually compared against. */
  observed: number | string | null;
  /** True when this value came from an Agent Lab override. */
  simulated: boolean;
  matched: boolean;
  /** Human-readable rendering, e.g. "0.0410% > 0.0300%". */
  rendered: string;
}

export interface RuleResult {
  rule: Rule;
  matched: boolean;
  conditions: ConditionResult[];
}

export interface EvaluationResult {
  at: number;
  guardianId: string;
  rules: RuleResult[];
  /** The first matching rule. Rules are evaluated in order. */
  firedRule: RuleResult | null;
  /** True when a metric a rule needed was unavailable. */
  incomplete: boolean;
}

function compare(observed: number | string | null, condition: Condition): boolean {
  if (observed === null) return false;

  const { operator, value } = condition;

  // Enum metrics support equality only; ordering them would be meaningless.
  if (typeof observed === "string" || typeof value === "string") {
    if (operator === "==") return String(observed) === String(value);
    if (operator === "!=") return String(observed) !== String(value);
    return false;
  }

  switch (operator) {
    case ">":
      return observed > value;
    case ">=":
      return observed >= value;
    case "<":
      return observed < value;
    case "<=":
      return observed <= value;
    case "==":
      return observed === value;
    case "!=":
      return observed !== value;
  }
}

function render(condition: Condition, observed: number | string | null): string {
  const spec = METRIC_REGISTRY[condition.metric];
  const left = observed === null ? "unavailable" : spec.describe(observed);
  const right = spec.describe(condition.value);
  return `${spec.label} ${left} ${condition.operator} ${right}`;
}

function evaluateCondition(
  condition: Condition,
  values: MetricValues,
  overrides: Partial<MetricValues>,
): ConditionResult {
  const observed = values[condition.metric] ?? null;

  return {
    condition,
    observed,
    simulated: Object.prototype.hasOwnProperty.call(overrides, condition.metric),
    matched: compare(observed, condition),
    rendered: render(condition, observed),
  };
}

/**
 * Evaluates every rule against the snapshot's effective values — live metrics
 * with Agent Lab overrides applied. All conditions in a rule must hold.
 */
export function evaluateGuardian(
  guardian: Guardian,
  snapshot: MetricSnapshot,
): EvaluationResult {
  const rules: RuleResult[] = guardian.rules.map((rule) => {
    const conditions = rule.conditions.map((c) =>
      evaluateCondition(c, snapshot.effective, snapshot.overrides),
    );
    return {
      rule,
      matched: conditions.length > 0 && conditions.every((c) => c.matched),
      conditions,
    };
  });

  const incomplete = rules.some((r) => r.conditions.some((c) => c.observed === null));

  return {
    at: snapshot.at,
    guardianId: guardian.id,
    rules,
    firedRule: rules.find((r) => r.matched) ?? null,
    incomplete,
  };
}

/**
 * How close the nearest unmatched condition is to firing. Feeds the "next
 * trigger" line without inventing a risk score — it reports the rule's own
 * declared thresholds, nothing more.
 */
export function describeNextTrigger(result: EvaluationResult): string | null {
  if (result.firedRule) return null;

  const parts: string[] = [];
  for (const rule of result.rules) {
    for (const c of rule.conditions) {
      if (c.matched) continue;
      const spec = METRIC_REGISTRY[c.condition.metric];
      parts.push(`${spec.label} ${c.condition.operator} ${spec.describe(c.condition.value)}`);
    }
  }
  return parts.length > 0 ? parts.join(" OR ") : null;
}
