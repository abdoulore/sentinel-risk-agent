/**
 * Guardian runtime checks — the policy loop wired to a mocked Execution Adapter.
 * Verifies the domain-event sequences (clamp / reject / normal), that state
 * decisions stay in the Policy Engine, and that every failure maps to its own
 * event (never a generic error). No network, no fixture.
 *
 *   npm run check:runtime
 */
import type { Action, Guardian } from "@/lib/policy/types";
import { evaluateGuardian, type EvaluationResult } from "@/lib/policy/engine";
import { runGuardianCycle, type RuntimeEvent } from "@/lib/policy/runtime";
import {
  ExecutionSafeguardError,
  type ExecutionAdapter,
  type ReducePositionInput,
} from "@/lib/execution/execution-adapter";
import { McpAuthRequiredError, McpToolError } from "@/lib/mcp/contract";
import type { AccountState, PositionState } from "@/lib/binance/account";
import type { SymbolFilters } from "@/lib/binance/filters";
import type { OrderResult } from "@/lib/binance/orders";
import type { MetricSnapshot, MetricValues } from "@/lib/metrics/engine";
import type { FundingState, OpenInterestState } from "@/lib/binance/market";

let failed = false;
function pass(name: string, detail = "") {
  console.log(`  [ok]   ${name}${detail ? ` - ${detail}` : ""}`);
}
function fail(name: string, detail = "") {
  failed = true;
  console.log(`  [FAIL] ${name}${detail ? ` - ${detail}` : ""}`);
}
function check(name: string, cond: boolean, detail = "") {
  if (cond) pass(name, detail);
  else fail(name, detail);
}
function seqCheck(name: string, events: RuntimeEvent[], expected: string[]) {
  const got = events.map((e) => e.type);
  check(name, JSON.stringify(got) === JSON.stringify(expected), got.join(" → "));
}

/* ------------------------------- fixtures -------------------------------- */

const account: AccountState = {
  totalWalletBalance: 6,
  totalMarginBalance: 6,
  totalUnrealizedProfit: 0,
  totalMaintMargin: 0,
  availableBalance: 6,
  marginRatio: null,
};

const filters: SymbolFilters = {
  symbol: "ETHUSDC",
  stepSize: "0.001",
  minQty: "0.001",
  maxQty: "8000",
  marketStepSize: "0.001",
  marketMinQty: "0.001",
  marketMaxQty: "700",
  minNotional: "20",
  tickSize: "0.01",
  quantityPrecision: 3,
  pricePrecision: 2,
  fetchedAt: Date.now(),
};

const funding: FundingState = {
  symbol: "ETHUSDC",
  lastFundingRate: 0.0004,
  markPrice: 2416.41,
  indexPrice: 2416,
  nextFundingTime: 0,
  recentRates: [0.0002, 0.0003, 0.0004],
  direction: "RISING",
};

const openInterest: OpenInterestState = {
  symbol: "ETHUSDC",
  openInterest: 1000,
  openInterestValue: null,
  changePercent: 11,
  windowMinutes: 30,
};

function position(amt: number): PositionState {
  return {
    symbol: "ETHUSDC",
    positionAmt: amt,
    side: amt > 0 ? "LONG" : amt < 0 ? "SHORT" : "FLAT",
    entryPrice: 2416.56,
    markPrice: 2416.41,
    liquidationPrice: 1824.82,
    notional: Math.abs(amt) * 2416.41,
    unrealizedPnl: -0.0015,
    unrealizedPnlPercent: -0.03,
    liquidationDistancePercent: 24.5,
    leverage: 5,
    marginType: "cross",
    positionInitialMargin: (Math.abs(amt) * 2416.41) / 5,
    maintMargin: 0,
    updateTime: 1,
  };
}

const EMPTY: MetricValues = {
  momentum: null,
  funding_rate: null,
  funding_direction: null,
  open_interest: null,
  oi_change_percent: null,
  unrealized_pnl: null,
  unrealized_pnl_percent: null,
  liquidation_distance_percent: null,
  position_size: null,
  leverage: null,
  margin_ratio: null,
};

function snapshot(effective: Partial<MetricValues>, pos: PositionState): MetricSnapshot {
  const values: MetricValues = { ...EMPTY, ...effective };
  return {
    at: Date.now(),
    symbol: pos.symbol,
    live: values,
    effective: values,
    overrides: {},
    sources: { candles: [], momentum: null, funding, openInterest, position: pos, account },
  };
}

const FIRING = { funding_rate: 0.0004, momentum: "BEARISH" as const };
const CALM = { funding_rate: 0.0001, momentum: "NEUTRAL" as const };

function guardianWith(action: Action, max = 30): Guardian {
  return {
    id: "G-ETH-03",
    name: "ETH Defensive Guardian",
    symbol: "ETHUSDC",
    mode: "guarded",
    maxReductionPercent: max,
    rules: [
      {
        id: "R1",
        conditions: [
          { metric: "funding_rate", operator: ">", value: 0.0003 },
          { metric: "momentum", operator: "==", value: "BEARISH" },
        ],
        action,
      },
    ],
  };
}

const order: OrderResult = {
  orderId: 82283985098,
  clientOrderId: "g",
  symbol: "ETHUSDC",
  side: "SELL",
  status: "FILLED",
  origQty: 0.003,
  executedQty: 0.003,
  avgPrice: 2416,
  cumQuote: 7.248,
  reduceOnly: true,
  updateTime: 2,
};

/* ------------------------------ mock adapter ----------------------------- */

interface MockOpts {
  before: number;
  after: number;
  reduceError?: Error;
  getPositionError?: Error;
}

class MockAdapter implements ExecutionAdapter {
  reduceCalls = 0;
  private reduced = false;
  constructor(private readonly opts: MockOpts) {}

  async getPosition(): Promise<PositionState> {
    if (this.opts.getPositionError) throw this.opts.getPositionError;
    return position(this.reduced ? this.opts.after : this.opts.before);
  }
  async getAccountState(): Promise<AccountState> {
    return account;
  }
  async getExchangeFilters(): Promise<SymbolFilters> {
    return filters;
  }
  async reducePosition(_input: ReducePositionInput): Promise<OrderResult> {
    this.reduceCalls += 1;
    if (this.opts.reduceError) throw this.opts.reduceError;
    this.reduced = true;
    return order;
  }
  async getOrder(): Promise<OrderResult> {
    return order;
  }
}

function collector() {
  const events: RuntimeEvent[] = [];
  return { events, emit: (e: RuntimeEvent) => events.push(e) };
}

const reevalCalm = (g: Guardian) => async (pos: PositionState): Promise<EvaluationResult> =>
  evaluateGuardian(g, snapshot(CALM, pos));
const reevalFiring = (g: Guardian) => async (pos: PositionState): Promise<EvaluationResult> =>
  evaluateGuardian(g, snapshot(FIRING, pos));

/* --------------------------------- tests --------------------------------- */

async function main() {
  console.log("Guardian runtime checks (mocked adapter)\n");

  // 1. Clamp path (60% → 30%), conditions still elevated after → TRIGGERED ---
  console.log("1. Clamp path");
  {
    const guardian = guardianWith({ type: "reduce_position", percent: 60 }, 30);
    const adapter = new MockAdapter({ before: 0.01, after: 0.007 });
    const { events, emit } = collector();
    const res = await runGuardianCycle({
      guardian,
      status: "ACTIVE",
      filters,
      snapshot: snapshot(FIRING, position(0.01)),
      adapter,
      reevaluate: reevalFiring(guardian),
      emit,
    });
    seqCheck("clamp event sequence", events, [
      "RULE_MATCHED",
      "ACTION_PROPOSED",
      "ACTION_CLAMPED",
      "EXECUTION_VALIDATED",
      "ORDER_SUBMITTED",
      "ORDER_FILLED",
      "POSITION_REFRESHED",
      "GUARDIAN_REEVALUATING",
      "GUARDIAN_STATE_CHANGED",
    ]);
    const clamp = events.find((e) => e.type === "ACTION_CLAMPED");
    check("clamped 60 → 30", clamp?.type === "ACTION_CLAMPED" && clamp.requestedPercent === 60 && clamp.executedPercent === 30);
    const validated = events.find((e) => e.type === "EXECUTION_VALIDATED");
    check("validated qty floored to 0.003", validated?.type === "EXECUTION_VALIDATED" && validated.roundedQty === "0.003", validated?.type === "EXECUTION_VALIDATED" ? validated.roundedQty : "");
    const stateChange = events.find((e) => e.type === "GUARDIAN_STATE_CHANGED");
    check("still elevated → TRIGGERED", stateChange?.type === "GUARDIAN_STATE_CHANGED" && stateChange.state === "TRIGGERED");
    check("terminal REEVALUATED", res.terminal === "REEVALUATED");
    check("order id captured", res.outcome?.order.orderId === 82283985098);
  }

  // 2. Reject path — action type not allowed, no execution ------------------
  console.log("\n2. Reject path (ACTION_NOT_ALLOWED)");
  {
    const guardian = guardianWith({ type: "increase_position" as Action["type"], percent: 50 });
    const adapter = new MockAdapter({ before: 0.01, after: 0.01 });
    const { events, emit } = collector();
    const res = await runGuardianCycle({
      guardian,
      status: "ACTIVE",
      filters,
      snapshot: snapshot(FIRING, position(0.01)),
      adapter,
      reevaluate: reevalCalm(guardian),
      emit,
    });
    seqCheck("reject event sequence", events, ["RULE_MATCHED", "ACTION_PROPOSED", "ACTION_REJECTED"]);
    const rej = events.find((e) => e.type === "ACTION_REJECTED");
    check("reason ACTION_NOT_ALLOWED", rej?.type === "ACTION_REJECTED" && rej.reason === "ACTION_NOT_ALLOWED", rej?.type === "ACTION_REJECTED" ? rej.reason : "");
    check("no order submitted", adapter.reduceCalls === 0);
    check("terminal ACTION_REJECTED", res.terminal === "ACTION_REJECTED");
  }

  // 3. Normal valid path (30% == max), conditions clear after → WATCH -------
  console.log("\n3. Normal valid path");
  {
    const guardian = guardianWith({ type: "reduce_position", percent: 30 }, 30);
    const adapter = new MockAdapter({ before: 0.01, after: 0.007 });
    const { events, emit } = collector();
    await runGuardianCycle({
      guardian,
      status: "ACTIVE",
      filters,
      snapshot: snapshot(FIRING, position(0.01)),
      adapter,
      reevaluate: reevalCalm(guardian),
      emit,
    });
    seqCheck("normal event sequence (no clamp)", events, [
      "RULE_MATCHED",
      "ACTION_PROPOSED",
      "EXECUTION_VALIDATED",
      "ORDER_SUBMITTED",
      "ORDER_FILLED",
      "POSITION_REFRESHED",
      "GUARDIAN_REEVALUATING",
      "GUARDIAN_STATE_CHANGED",
    ]);
    const stateChange = events.find((e) => e.type === "GUARDIAN_STATE_CHANGED");
    check("cleared → WATCH", stateChange?.type === "GUARDIAN_STATE_CHANGED" && stateChange.state === "WATCH");
    const refreshed = events.find((e) => e.type === "POSITION_REFRESHED");
    check("position refreshed 0.01 → 0.007", refreshed?.type === "POSITION_REFRESHED" && refreshed.before === 0.01 && refreshed.after === 0.007);
  }

  // 4. Failure events -------------------------------------------------------
  console.log("\n4. Failure events (never a generic error)");
  const guardian = guardianWith({ type: "reduce_position", percent: 30 }, 30);

  // MCP_AUTH_REQUIRED → EXECUTION_BLOCKED
  {
    const adapter = new MockAdapter({ before: 0.01, after: 0.01, getPositionError: new McpAuthRequiredError() });
    const { events, emit } = collector();
    const res = await runGuardianCycle({
      guardian, status: "ACTIVE", filters,
      snapshot: snapshot(FIRING, position(0.01)), adapter,
      reevaluate: reevalCalm(guardian), emit,
    });
    const blocked = events.find((e) => e.type === "EXECUTION_BLOCKED");
    check("MCP_AUTH_REQUIRED → EXECUTION_BLOCKED", blocked?.type === "EXECUTION_BLOCKED" && blocked.cause === "MCP_AUTH_REQUIRED");
    check("blocked: no ORDER_SUBMITTED", !events.some((e) => e.type === "ORDER_SUBMITTED"));
    check("blocked terminal", res.terminal === "EXECUTION_BLOCKED");
  }

  // POSITION_INSUFFICIENT (safeguard) → EXECUTION_REJECTED
  {
    const adapter = new MockAdapter({
      before: 0.01, after: 0.01,
      reduceError: new ExecutionSafeguardError("POSITION_INSUFFICIENT", "0.02 > 0.01"),
    });
    const { events, emit } = collector();
    const res = await runGuardianCycle({
      guardian, status: "ACTIVE", filters,
      snapshot: snapshot(FIRING, position(0.01)), adapter,
      reevaluate: reevalCalm(guardian), emit,
    });
    const rej = events.find((e) => e.type === "EXECUTION_REJECTED");
    check("POSITION_INSUFFICIENT → EXECUTION_REJECTED", rej?.type === "EXECUTION_REJECTED" && rej.reason === "POSITION_INSUFFICIENT");
    check("rejected terminal", res.terminal === "EXECUTION_REJECTED");
  }

  // ORDER_REJECTED (exchange) → EXECUTION_FAILED
  {
    const adapter = new MockAdapter({
      before: 0.01, after: 0.01,
      reduceError: new McpToolError("futures_usds_newOrder", "-2022 ReduceOnly Order is rejected"),
    });
    const { events, emit } = collector();
    const res = await runGuardianCycle({
      guardian, status: "ACTIVE", filters,
      snapshot: snapshot(FIRING, position(0.01)), adapter,
      reevaluate: reevalCalm(guardian), emit,
    });
    const f = events.find((e) => e.type === "EXECUTION_FAILED");
    check("ORDER_REJECTED → EXECUTION_FAILED", f?.type === "EXECUTION_FAILED" && f.reason.includes("-2022"));
    check("failed terminal", res.terminal === "EXECUTION_FAILED");
  }

  // POSITION_NOT_REDUCED_AFTER_FILL → EXECUTION_VERIFICATION_FAILED
  {
    const adapter = new MockAdapter({ before: 0.01, after: 0.01 }); // fills but no shrink
    const { events, emit } = collector();
    const res = await runGuardianCycle({
      guardian, status: "ACTIVE", filters,
      snapshot: snapshot(FIRING, position(0.01)), adapter,
      reevaluate: reevalCalm(guardian), emit,
    });
    const v = events.find((e) => e.type === "EXECUTION_VERIFICATION_FAILED");
    check("no shrink → EXECUTION_VERIFICATION_FAILED", v?.type === "EXECUTION_VERIFICATION_FAILED" && v.reason === "POSITION_NOT_REDUCED_AFTER_FILL");
    check("verification failure: order was submitted+filled first", events.some((e) => e.type === "ORDER_FILLED"));
    check("verification failure: no re-eval / state change", !events.some((e) => e.type === "GUARDIAN_STATE_CHANGED"));
    check("verification terminal", res.terminal === "EXECUTION_VERIFICATION_FAILED");
  }

  // 5. No rule fires → NO_ACTION, silent -----------------------------------
  console.log("\n5. No rule fires");
  {
    const adapter = new MockAdapter({ before: 0.01, after: 0.01 });
    const { events, emit } = collector();
    const res = await runGuardianCycle({
      guardian, status: "ACTIVE", filters,
      snapshot: snapshot(CALM, position(0.01)), adapter,
      reevaluate: reevalCalm(guardian), emit,
    });
    check("no events emitted when nothing fires", events.length === 0);
    check("terminal NO_ACTION", res.terminal === "NO_ACTION");
    check("adapter untouched", adapter.reduceCalls === 0);
  }

  console.log(failed ? "\nRUNTIME CHECKS FAILED\n" : "\nAll runtime checks passed.\n");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("\nruntime-check aborted:", err instanceof Error ? err.message : err);
  process.exit(1);
});
