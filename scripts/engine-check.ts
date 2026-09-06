/**
 * Deterministic-core check: the plan's own examples, run against real code.
 *
 * Exercises the Policy Engine and Validator with a synthetic snapshot so the
 * allow / clamp / reject contract is provable before any credentials exist.
 *
 *   npm run check:engine
 */
import type { Guardian, Action } from "@/lib/policy/types";
import type { PositionState, AccountState } from "@/lib/binance/account";
import type { SymbolFilters } from "@/lib/binance/filters";
import type { MetricSnapshot, MetricValues } from "@/lib/metrics/engine";
import { evaluateGuardian, describeNextTrigger } from "@/lib/policy/engine";
import { validateAction, willExecute } from "@/lib/policy/validator";

// The Guardian from BUILD_PLAN section 5, verbatim.
const GUARDIAN: Guardian = {
  id: "G-ETH-03",
  name: "ETH Defensive Guardian",
  symbol: "ETHUSDT",
  mode: "guarded",
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
};

// Live ETHUSDT filters, as fetched from the exchange on 2026-09-03.
const FILTERS: SymbolFilters = {
  symbol: "ETHUSDT",
  stepSize: "0.001",
  minQty: "0.001",
  maxQty: "10000",
  marketStepSize: "0.001",
  marketMinQty: "0.001",
  marketMaxQty: "2000",
  minNotional: "20",
  tickSize: "0.01",
  quantityPrecision: 3,
  pricePrecision: 2,
  fetchedAt: Date.now(),
};

const POSITION: PositionState = {
  symbol: "ETHUSDT",
  positionAmt: 0.041,
  side: "LONG",
  entryPrice: 2410.0,
  markPrice: 2402.0,
  liquidationPrice: 1960.0,
  notional: 98.48,
  unrealizedPnl: -0.328,
  unrealizedPnlPercent: -1.66,
  liquidationDistancePercent: 18.4,
  leverage: 5,
  marginType: "CROSSED",
  positionInitialMargin: 19.7,
  maintMargin: 0.39,
  updateTime: Date.now(),
};

const ACCOUNT: AccountState = {
  totalWalletBalance: 20.0,
  totalMarginBalance: 19.67,
  totalUnrealizedProfit: -0.328,
  totalMaintMargin: 0.39,
  availableBalance: 0.3,
  marginRatio: 0.0198,
};

function snapshot(overrides: Partial<MetricValues>): MetricSnapshot {
  const live: MetricValues = {
    momentum: "NEUTRAL",
    funding_rate: 0.00012,
    funding_direction: "RISING",
    open_interest: 2_300_942,
    oi_change_percent: 1.8,
    unrealized_pnl: POSITION.unrealizedPnl,
    unrealized_pnl_percent: POSITION.unrealizedPnlPercent,
    liquidation_distance_percent: POSITION.liquidationDistancePercent,
    position_size: Math.abs(POSITION.positionAmt),
    leverage: POSITION.leverage,
    margin_ratio: ACCOUNT.marginRatio,
  };

  return {
    at: Date.now(),
    symbol: "ETHUSDT",
    live,
    effective: { ...live, ...overrides },
    overrides,
    // sources are not read by the policy engine; the snapshot shape needs them.
    sources: {
      candles: [],
      momentum: null,
      funding: {
        symbol: "ETHUSDT",
        lastFundingRate: Number(live.funding_rate),
        markPrice: POSITION.markPrice,
        indexPrice: POSITION.markPrice,
        nextFundingTime: Date.now() + 3_600_000,
        recentRates: [0.00008, 0.0001, 0.00012],
        direction: "RISING",
      },
      openInterest: {
        symbol: "ETHUSDT",
        openInterest: 2_300_942,
        openInterestValue: 5_529_740_435,
        changePercent: 1.8,
        windowMinutes: 30,
      },
      position: POSITION,
      account: ACCOUNT,
    },
  };
}

let failures = 0;

function expect(label: string, actual: unknown, wanted: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (wanted ${JSON.stringify(wanted)})`}`);
}

console.log("Deterministic core check\n");

// ---- 1. Live conditions: rule must NOT fire ----------------------------
console.log("1. Live conditions (funding 0.012%, momentum NEUTRAL)");
{
  const evaluation = evaluateGuardian(GUARDIAN, snapshot({}));
  expect("rule fired", evaluation.firedRule !== null, false);
  console.log(`       next trigger: ${describeNextTrigger(evaluation)}`);
}

// ---- 2. Agent Lab overrides drive the real engine ----------------------
console.log("\n2. Simulated conditions (funding 0.041%, momentum BEARISH)");
const simulated = snapshot({ funding_rate: 0.00041, momentum: "BEARISH", oi_change_percent: 11.0 });
{
  const evaluation = evaluateGuardian(GUARDIAN, simulated);
  expect("rule fired", evaluation.firedRule?.rule.id, "R1");
  for (const c of evaluation.firedRule?.conditions ?? []) {
    console.log(`       ${c.matched ? "match" : "     "}  ${c.rendered}${c.simulated ? "  [simulated]" : "  [live]"}`);
  }
}

// ---- 3. The clamp (BUILD_PLAN section 6) -------------------------------
console.log("\n3. Agent proposes 60%, Guardian permits 30%");
{
  const result = validateAction({ type: "reduce_position", percent: 60 }, {
    guardian: GUARDIAN,
    status: "ACTIVE",
    position: POSITION,
    filters: FILTERS,
  });
  expect("allowed", result.allowed, false);
  expect("reason", result.reason, "MAX_REDUCTION_EXCEEDED");
  expect("requestedPercent", result.requestedPercent, 60);
  expect("maxAllowedPercent", result.maxAllowedPercent, 30);
  expect("resolution", result.resolution, "CLAMPED");
  expect("executedPercent", result.executedPercent, 30);
  expect("still executes", willExecute(result), true);
  expect("quantity", result.quantity?.steppedQty, "0.012");
  expect("side", result.side, "SELL");
  console.log("       checks:");
  for (const c of result.checks) {
    console.log(`         ${c.passed ? "+" : "-"} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
  }
}

// ---- 4. Rejects (BUILD_PLAN section 6) ---------------------------------
console.log("\n4. Rejects");
{
  const bogus = { type: "increase_position", percent: 50 } as unknown as Action;
  const r1 = validateAction(bogus, {
    guardian: GUARDIAN,
    status: "ACTIVE",
    position: POSITION,
    filters: FILTERS,
  });
  expect("increase_position(50%) resolution", r1.resolution, "REJECTED");
  expect("increase_position(50%) reason", r1.reason, "ACTION_NOT_ALLOWED");

  const r2 = validateAction({ type: "reduce_position", percent: -20 }, {
    guardian: GUARDIAN,
    status: "ACTIVE",
    position: POSITION,
    filters: FILTERS,
  });
  expect("reduce_position(-20%) resolution", r2.resolution, "REJECTED");
  expect("reduce_position(-20%) reason", r2.reason, "INVALID_PARAMETER");
}

// ---- 5. Emergency stop switches Guardians to observe -------------------
console.log("\n5. Emergency stop");
{
  const r = validateAction({ type: "reduce_position", percent: 30 }, {
    guardian: GUARDIAN,
    status: "OBSERVING",
    position: POSITION,
    filters: FILTERS,
  });
  expect("resolution", r.resolution, "REJECTED");
  expect("reason", r.reason, "GUARDIAN_NOT_ACTIVE");
}

// ---- 6. A reduction too small to be legal -----------------------------
console.log("\n6. Reduction that floors below minQty");
{
  const tiny: PositionState = { ...POSITION, positionAmt: 0.002 };
  const r = validateAction({ type: "reduce_position", percent: 30 }, {
    guardian: GUARDIAN,
    status: "ACTIVE",
    position: tiny,
    filters: FILTERS,
  });
  // 0.002 x 30% = 0.0006, floors to 0.000 — below minQty 0.001.
  expect("resolution", r.resolution, "REJECTED");
  expect("reason", r.reason, "QUANTITY_BELOW_MIN");
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
