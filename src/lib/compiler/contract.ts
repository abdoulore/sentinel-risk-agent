/**
 * The Guardian authoring contract — what Sentinel will accept, published for
 * whichever host is doing the interpreting.
 *
 * This exists so the contract lives in ONE place, next to the registries it is
 * derived from, rather than being copied into a skill file per host. Any Agent
 * OS host (Claude Code, Codex, an IDE agent) can read it with
 * `sentinel guardian:schema` and author against it. When a metric is added to
 * METRIC_REGISTRY, this updates with it and no skill file goes stale.
 *
 * Nothing here validates. `validate.ts` decides.
 */
import {
  ACTION_TYPES,
  METRIC_REGISTRY,
  METRIC_NAMES,
  OPERATORS,
  type MetricName,
} from "@/lib/policy/types";

export interface MetricContract {
  name: MetricName;
  kind: "number" | "enum";
  label: string;
  /** Permitted comparison values, for enum metrics. */
  values?: readonly string[];
  /** Operators this metric supports. Enums compare by equality only. */
  operators: readonly string[];
  /** How the value must be expressed. */
  units?: string;
}

/**
 * Unit notes for metrics where the natural phrasing and the stored value differ.
 * Getting these wrong is the single most likely authoring mistake: "0.03%" is
 * 0.0003, not 0.03.
 */
const UNITS: Partial<Record<MetricName, string>> = {
  funding_rate: 'DECIMAL, not a percentage. "0.03%" is 0.0003; "0.05%" is 0.0005.',
  margin_ratio: 'DECIMAL. "50% margin ratio" is 0.5.',
  oi_change_percent: 'PERCENT. "+11%" is 11.',
  unrealized_pnl_percent: 'PERCENT. "down more than 5%" is a value of -5.',
  liquidation_distance_percent: 'PERCENT. "within 20% of liquidation" is 20.',
  unrealized_pnl: "Absolute quote currency (USDC on this account).",
  open_interest: "Absolute contracts.",
  position_size: "Absolute base units (ETH).",
  leverage: "Plain multiplier: 5 means 5x.",
};

export function metricContracts(): MetricContract[] {
  return METRIC_NAMES.map((name) => {
    const spec = METRIC_REGISTRY[name];
    const isEnum = spec.kind === "enum";
    return {
      name,
      kind: spec.kind as "number" | "enum",
      label: spec.label,
      ...(isEnum ? { values: (spec as { values: readonly string[] }).values } : {}),
      operators: isEnum ? (["==", "!="] as const) : OPERATORS,
      ...(UNITS[name] ? { units: UNITS[name] } : {}),
    };
  });
}

export interface GuardianContract {
  symbol: string;
  metrics: MetricContract[];
  operators: readonly string[];
  actions: readonly string[];
  /** Constraints deterministic validation enforces. */
  rules: string[];
  /** A complete, valid example. */
  example: unknown;
}

export function guardianContract(symbol: string): GuardianContract {
  return {
    symbol,
    metrics: metricContracts(),
    operators: OPERATORS,
    actions: ACTION_TYPES,
    rules: [
      "Every condition in a rule must hold for the rule to fire. Rules are evaluated in order; the first match wins.",
      "Give each rule a short id: R1, R2, R3.",
      "reduce_position requires a positive percent. Every other action omits percent or sets it to null.",
      "maxReductionPercent is the hard ceiling on any single reduction, 0 < x <= 100. If the user states one, use it; otherwise use the largest reduction percent in the rules.",
      "This Guardian is DEFENSIVE ONLY. There is no action that opens, increases or flips a position. If the instruction asks for one, do not invent an action — record it in `unsupported`.",
      "Anything you cannot express as a rule goes in `unsupported` as a short phrase. Never approximate it with a rule the user did not ask for.",
      `symbol must be ${symbol} if you include it at all; id is optional and Sentinel will generate one.`,
    ],
    example: {
      id: "G-ETH-03",
      name: "ETH Defensive Guardian",
      symbol,
      maxReductionPercent: 30,
      rules: [
        {
          id: "R1",
          conditions: [
            { metric: "funding_rate", operator: ">", value: 0.0003 },
            { metric: "momentum", operator: "==", value: "BEARISH" },
          ],
          action: { type: "reduce_position", percent: 30 },
        },
      ],
      unsupported: [],
    },
  };
}

/** Human-readable rendering of the contract, for a host that prefers prose. */
export function renderContract(c: GuardianContract): string {
  const L: string[] = [];
  L.push(`GUARDIAN AUTHORING CONTRACT — ${c.symbol}`);
  L.push("");
  L.push("METRICS — you may reference no others:");
  for (const m of c.metrics) {
    const vals = m.values ? `  one of: ${m.values.join(", ")}` : "";
    L.push(`  ${m.name} (${m.kind})${vals}`);
    L.push(`      operators: ${m.operators.join(" ")}`);
    if (m.units) L.push(`      units: ${m.units}`);
  }
  L.push("");
  L.push(`ACTIONS — only these: ${c.actions.join(", ")}`);
  L.push("");
  L.push("RULES:");
  for (const r of c.rules) L.push(`  - ${r}`);
  L.push("");
  L.push("EXAMPLE:");
  L.push(JSON.stringify(c.example, null, 2));
  return L.join("\n");
}
