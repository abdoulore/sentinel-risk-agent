/**
 * Market pre-screen — the part of a Guardian that can be evaluated without an
 * Agent OS host in the loop.
 *
 * THE PROBLEM THIS SOLVES
 *
 * A Guardian cycle needs the host to relay MCP calls: position, account,
 * filters. That means a full cycle cannot happen unattended. But a Guardian
 * fires roughly once a day, so waiting for a host turn on every evaluation
 * spends the host's attention on the 99% of checks where nothing happens.
 *
 * Most conditions are about the MARKET, not the account — funding, momentum,
 * open interest. Those come from public Binance endpoints and need no
 * credentials and no host at all. So Sentinel can watch continuously on its
 * own, and only ask for a host turn when the market side of a rule actually
 * matches.
 *
 *   watch loop (local, public data, no host)
 *     → market conditions match?
 *        no  → sleep
 *        yes → raise attention; the host runs a full cycle and executes
 *
 * The screen NEVER decides to trade. It decides whether it is worth waking the
 * deterministic runtime. Every real decision still goes through the Policy
 * Engine and the Validator against live account state.
 */
import { METRIC_REGISTRY, type Condition, type Guardian, type MetricName } from "@/lib/policy/types";
import { computeMomentum, BACKFILL_CANDLES } from "@/lib/metrics/momentum";
import { closedOnly, fetchFunding, fetchKlineHistory, fetchOpenInterest } from "@/lib/binance/market";

/** Metrics derived purely from public market data — no account, no host. */
export const MARKET_METRICS: MetricName[] = [
  "momentum",
  "funding_rate",
  "funding_direction",
  "open_interest",
  "oi_change_percent",
];

/** Metrics that require account state, and therefore a host relay. */
export function needsAccount(metric: MetricName): boolean {
  return !MARKET_METRICS.includes(metric);
}

export type ScreenVerdict =
  /** Every market condition matched. A rule may fire — wake the runtime. */
  | "MATCHED"
  /** A market condition definitively failed. Nothing can fire. Stay asleep. */
  | "BLOCKED"
  /** Market side matched but the rule also needs account data to decide. */
  | "NEEDS_ACCOUNT";

export interface RuleScreen {
  ruleId: string;
  verdict: ScreenVerdict;
  /** Conditions evaluated here, with what was observed. */
  checked: { condition: Condition; observed: number | string | null; matched: boolean }[];
  /** Conditions deferred because they need account state. */
  deferred: Condition[];
}

export interface ScreenResult {
  at: number;
  symbol: string;
  /** The public measurements this screen ran against. */
  market: Partial<Record<MetricName, number | string | null>>;
  rules: RuleScreen[];
  /** True when at least one rule could fire and the runtime should be woken. */
  attention: boolean;
  reason: string;
}

function compare(observed: number | string | null, c: Condition): boolean {
  if (observed === null) return false;
  if (typeof observed === "string" || typeof c.value === "string") {
    if (c.operator === "==") return String(observed) === String(c.value);
    if (c.operator === "!=") return String(observed) !== String(c.value);
    return false;
  }
  const a = observed;
  const b = c.value as number;
  switch (c.operator) {
    case ">": return a > b;
    case ">=": return a >= b;
    case "<": return a < b;
    case "<=": return a <= b;
    case "==": return a === b;
    case "!=": return a !== b;
    default: return false;
  }
}

/**
 * Reads public market data and screens the Guardian's rules against it.
 *
 * No MCP, no credentials, no host. Safe to run on a timer forever.
 */
export async function screenMarket(guardian: Guardian): Promise<ScreenResult> {
  const [candles, funding, oi] = await Promise.all([
    fetchKlineHistory(guardian.symbol, "5m", BACKFILL_CANDLES),
    fetchFunding(guardian.symbol),
    fetchOpenInterest(guardian.symbol),
  ]);
  const momentum = computeMomentum(closedOnly(candles));

  const market: ScreenResult["market"] = {
    momentum: momentum?.state ?? null,
    funding_rate: funding.lastFundingRate,
    funding_direction: funding.direction,
    open_interest: oi.openInterest,
    oi_change_percent: oi.changePercent,
  };

  const rules: RuleScreen[] = guardian.rules.map((rule) => {
    const checked: RuleScreen["checked"] = [];
    const deferred: Condition[] = [];
    let blocked = false;

    for (const condition of rule.conditions) {
      if (needsAccount(condition.metric)) {
        deferred.push(condition);
        continue;
      }
      const observed = market[condition.metric] ?? null;
      const matched = compare(observed, condition);
      checked.push({ condition, observed, matched });
      if (!matched) blocked = true;
    }

    const verdict: ScreenVerdict = blocked
      ? "BLOCKED"
      : deferred.length > 0
        ? "NEEDS_ACCOUNT"
        : "MATCHED";
    return { ruleId: rule.id, verdict, checked, deferred };
  });

  const live = rules.filter((r) => r.verdict !== "BLOCKED");
  const attention = live.length > 0;

  const reason = attention
    ? `${live.map((r) => `${r.ruleId} ${r.verdict}`).join(", ")}`
    : "no rule can fire on current market conditions";

  return { at: Date.now(), symbol: guardian.symbol, market, rules, attention, reason };
}

/** One-line summary of what the market looks like right now. */
export function describeMarket(r: ScreenResult): string {
  return Object.entries(r.market)
    .map(([k, v]) => {
      const spec = METRIC_REGISTRY[k as MetricName];
      return `${k}=${v === null ? "—" : spec ? spec.describe(v) : String(v)}`;
    })
    .join("  ");
}
