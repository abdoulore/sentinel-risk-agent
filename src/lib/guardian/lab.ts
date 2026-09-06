/**
 * Agent Lab — simulated MARKET CONDITIONS, and nothing else.
 *
 * A lab scenario may replace measurements the Metric Engine produces. It can
 * never replace an exchange response, an order id, a fill, a position change, a
 * validator outcome, or an execution quantity. Those come from Binance and from
 * deterministic code, and a scenario has no reach into either.
 *
 *   "We're simulating the market event, not the trade."
 *
 * There is no separate demo policy path. Overrides are folded into the same
 * MetricSnapshot the live path builds (`effective = live + overrides`), and the
 * same Policy Engine evaluates it.
 *
 * THE PROPOSAL OVERRIDE
 *
 * `proposedPercent` is the one non-metric input, and it is deliberately narrow.
 * It changes the percentage a matched rule *proposes*, before validation, so the
 * clamp path can be exercised on demand. It does NOT touch:
 *
 *   - the compiled Guardian (its action stays whatever the user activated)
 *   - maxReductionPercent
 *   - the Validator's decision
 *   - the final quantity, step rounding, exchange filters, or position size
 *
 * The Validator receives a larger proposal and independently decides to clamp
 * it. That is the point: the clamp must be earned, not staged.
 */
import { METRIC_REGISTRY, isMetricName, type MetricName } from "@/lib/policy/types";
import type { MetricValues } from "@/lib/metrics/engine";

export interface LabScenario {
  /** Preset id, or null for a hand-built scenario. */
  preset: string | null;
  /** Metric overrides folded into the cycle's effective snapshot. */
  overrides: Partial<MetricValues>;
  /**
   * Percentage a matched reduce_position rule proposes, before validation.
   * Null leaves the Guardian's own action untouched.
   */
  proposedPercent: number | null;
  armedAt: string;
}

export class LabScenarioError extends Error {
  constructor(
    readonly reason:
      | "UNKNOWN_METRIC"
      | "INVALID_VALUE"
      | "INVALID_PROPOSAL"
      | "UNKNOWN_PRESET"
      | "MALFORMED",
    detail: string,
  ) {
    super(`LAB_${reason}: ${detail}`);
    this.name = "LabScenarioError";
  }
}

/**
 * The demo scenario. Funding crosses G-ETH-03's 0.03% threshold while momentum
 * turns bearish — the two conditions the Guardian actually contains.
 *
 * OI change is included because the operator watches it, NOT because the
 * Guardian matches on it. G-ETH-03 has no open-interest condition and this does
 * not add one.
 */
export const LAB_PRESETS: Record<
  string,
  { label: string; overrides: Partial<MetricValues>; proposedPercent: number | null; note: string }
> = {
  "funding-stress-bearish": {
    label: "Funding Stress + Bearish Momentum",
    overrides: {
      funding_rate: 0.00041,
      momentum: "BEARISH",
      oi_change_percent: 11,
    },
    proposedPercent: 60,
    note:
      "Funding 0.041% clears the 0.03% condition and momentum turns bearish. " +
      "OI is shown for context — G-ETH-03 does not match on it.",
  },
};

/** Metrics Agent Lab exposes as controls. Others may still be set explicitly. */
export const LAB_CONTROLS: MetricName[] = ["funding_rate", "oi_change_percent", "momentum"];

/* -------------------------------- validation ------------------------------- */

function validateOverrides(raw: unknown): Partial<MetricValues> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new LabScenarioError("MALFORMED", "overrides must be an object");
  }

  const out: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isMetricName(key)) {
      throw new LabScenarioError(
        "UNKNOWN_METRIC",
        `"${key}" is not a declared metric. Agent Lab may only simulate: ${Object.keys(METRIC_REGISTRY).join(", ")}`,
      );
    }
    const spec = METRIC_REGISTRY[key];

    if (spec.kind === "number") {
      const n = typeof value === "number" ? value : Number(value);
      if (typeof value === "boolean" || value === null || value === "" || !Number.isFinite(n)) {
        throw new LabScenarioError("INVALID_VALUE", `${key} must be a finite number, got ${JSON.stringify(value)}`);
      }
      out[key] = n;
      continue;
    }

    // Enum metric: only the declared states exist.
    const allowed = spec.values as readonly string[];
    if (typeof value !== "string" || !allowed.includes(value)) {
      throw new LabScenarioError(
        "INVALID_VALUE",
        `${key} must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`,
      );
    }
    out[key] = value;
  }
  return out as Partial<MetricValues>;
}

function validateProposal(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (typeof raw === "boolean" || !Number.isFinite(n)) {
    throw new LabScenarioError("INVALID_PROPOSAL", `proposedPercent must be a number, got ${JSON.stringify(raw)}`);
  }
  if (n <= 0 || n > 100) {
    throw new LabScenarioError("INVALID_PROPOSAL", `proposedPercent must be within (0, 100], got ${n}`);
  }
  return n;
}

/** Builds a scenario from untrusted input (the browser). Throws on anything odd. */
export function buildLabScenario(input: unknown): LabScenario {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new LabScenarioError("MALFORMED", "scenario must be an object");
  }
  const body = input as Record<string, unknown>;

  if (typeof body.preset === "string" && body.preset) {
    const preset = LAB_PRESETS[body.preset];
    if (!preset) {
      throw new LabScenarioError(
        "UNKNOWN_PRESET",
        `"${body.preset}" is not a preset. Available: ${Object.keys(LAB_PRESETS).join(", ")}`,
      );
    }
    return {
      preset: body.preset,
      overrides: { ...preset.overrides },
      proposedPercent: preset.proposedPercent,
      armedAt: new Date().toISOString(),
    };
  }

  return {
    preset: null,
    overrides: validateOverrides(body.overrides),
    proposedPercent: validateProposal(body.proposedPercent),
    armedAt: new Date().toISOString(),
  };
}
