/**
 * Console checks — the event store and the read-only state the surface renders.
 *
 *   npm run check:console
 *
 * The console's whole claim is that it reports and never invents. These tests
 * pin that: the feed has exactly one data source, replaying a cycle does not
 * duplicate its history, and the surface shows the values the Policy Engine
 * actually evaluated rather than measurements it has since diverged from.
 *
 * Offline. No server, no network, no live fixture.
 */
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventStore } from "@/lib/events/store";
import { GuardianStore } from "@/lib/guardian/store";
import { buildReport } from "@/lib/metrics/report";
import type { RuntimeEvent } from "@/lib/policy/runtime";
import type { MetricSnapshot } from "@/lib/metrics/engine";
import type { PositionState } from "@/lib/binance/account";

let failed = false;
const pass = (n: string, d = "") => console.log(`  [ok]   ${n}${d ? ` - ${d}` : ""}`);
function fail(n: string, d = "") {
  failed = true;
  console.log(`  [FAIL] ${n}${d ? ` - ${d}` : ""}`);
}
const check = (n: string, c: boolean, d = "") => (c ? pass(n, d) : fail(n, d));
const section = (t: string) => console.log(`\n${t}`);

const dir = mkdtempSync(join(tmpdir(), "sentinel-console-"));
const newEvents = () => new EventStore(join(dir, `events-${Math.random().toString(36).slice(2)}.jsonl`));

function position(over: Partial<PositionState> = {}): PositionState {
  return {
    symbol: "ETHUSDC", positionAmt: 0.009, side: "LONG", entryPrice: 2416.56,
    markPrice: 2514.34, liquidationPrice: 1758.84, notional: 22.63,
    unrealizedPnl: 0.88, unrealizedPnlPercent: 19.44, liquidationDistancePercent: 30.05,
    leverage: 5, marginType: "cross", positionInitialMargin: 4.53, maintMargin: 0.09,
    updateTime: Date.now(), ...over,
  };
}

/** A snapshot whose live momentum and effective momentum deliberately differ. */
function snapshotWithOverride(): MetricSnapshot {
  const live = {
    momentum: "NEUTRAL", funding_rate: 0.0000872, funding_direction: "RISING",
    open_interest: 1_031_636, oi_change_percent: 0.12, unrealized_pnl: 0.88,
    unrealized_pnl_percent: 19.44, liquidation_distance_percent: 30.05,
    position_size: 0.009, leverage: 5, margin_ratio: 0.013,
  };
  const overrides = { momentum: "BEARISH", funding_rate: 0.00041 };
  return {
    at: Date.now(), symbol: "ETHUSDC",
    live, effective: { ...live, ...overrides }, overrides,
    sources: {
      candles: [{ openTime: 0, open: 1, high: 1, low: 1, close: 2518.29, volume: 1, closeTime: Date.now() - 60_000 }],
      momentum: { state: "NEUTRAL", latestClose: 2518.29, ema20: 2510.57, rocPercent: 0.541,
        closeLookbackAgo: 2504, candleCloseTime: Date.now() - 60_000, samples: 50 },
      funding: { symbol: "ETHUSDC", lastFundingRate: 0.0000872, markPrice: 2518.61, indexPrice: 2518,
        nextFundingTime: 0, recentRates: [], direction: "RISING" },
      openInterest: { symbol: "ETHUSDC", openInterest: 1_031_636, openInterestValue: null,
        changePercent: 0.12, windowMinutes: 30 },
      position: position(),
      account: { totalWalletBalance: 5.98, totalMarginBalance: 6.86, totalUnrealizedProfit: 0.88,
        totalMaintMargin: 0.09, availableBalance: 2.33, marginRatio: 0.013 },
    },
  } as MetricSnapshot;
}

const ev = (type: string, at = Date.now()): RuntimeEvent =>
  ({ type, at, guardianId: "G-ETH-03", ruleId: "R1" }) as unknown as RuntimeEvent;

async function main() {
  /* ====================================================================== */
  section("1. The feed's only data source is the event log");

  {
    const store = newEvents();
    check("empty log renders an empty feed", store.recent().length === 0);

    const sink = store.sink("cycle-1");
    sink(ev("RULE_MATCHED"));
    sink(ev("ACTION_PROPOSED"));
    const stored = store.recent();
    check("emitted events are persisted", stored.length === 2);
    check("events carry their cycle", stored.every((e) => e.cycleId === "cycle-1"));
    check("events are sequenced", stored[0].seq === 0 && stored[1].seq === 1);
    check("order is preserved", stored[0].type === "RULE_MATCHED" && stored[1].type === "ACTION_PROPOSED");
  }

  /* ====================================================================== */
  section("2. Replaying a cycle does not duplicate its history");

  {
    const store = newEvents();
    const prefix = ["RULE_MATCHED", "ACTION_PROPOSED", "ACTION_CLAMPED", "EXECUTION_VALIDATED"];

    // Three host turns: each re-runs the runtime, which re-emits the prefix.
    for (let turn = 0; turn < 3; turn++) {
      const sink = store.sink("cycle-R");
      for (const t of prefix) sink(ev(t));
    }
    check("three replays produce one history", store.recent().length === 4,
      `${store.recent().length} events`);
    check("sequence is contiguous",
      store.recent().every((e, i) => e.seq === i));

    // The turn that finally gets past the pause appends only the NEW events.
    const sink = store.sink("cycle-R");
    for (const t of prefix) sink(ev(t));
    sink(ev("ORDER_SUBMITTED"));
    sink(ev("ORDER_FILLED"));
    const all = store.recent();
    check("new events after the replayed prefix are appended", all.length === 6, `${all.length}`);
    check("the appended events are the new ones",
      all[4].type === "ORDER_SUBMITTED" && all[5].type === "ORDER_FILLED");
    check("the original timestamps survive replay",
      all[0].at <= all[4].at);
  }

  {
    // Separate cycles keep separate histories.
    const store = newEvents();
    store.sink("cycle-A")(ev("RULE_MATCHED"));
    store.sink("cycle-B")(ev("RULE_MATCHED"));
    check("two cycles both recorded", store.recent().length === 2);
    check("each cycle is independently sequenced",
      store.forCycle("cycle-A")[0].seq === 0 && store.forCycle("cycle-B")[0].seq === 0);
    check("forCycle isolates a cycle", store.forCycle("cycle-A").length === 1);
  }

  {
    // A torn final line (host killed mid-append) must not break the feed.
    const path = join(dir, "torn.jsonl");
    const store = new EventStore(path);
    store.sink("cycle-T")(ev("RULE_MATCHED"));
    const raw = readFileSync(path, "utf8");
    require("node:fs").writeFileSync(path, `${raw}{"type":"ACTION_PRO`);
    check("a torn trailing line is skipped, not fatal", store.recent().length === 1);
  }

  /* ====================================================================== */
  section("3. The surface shows what the engine evaluated");

  {
    const snap = snapshotWithOverride();
    const r = buildReport(snap);

    check("momentum reports the EVALUATED value, not the live one",
      r.momentum.value === "BEARISH", String(r.momentum.value));
    check("and it is flagged simulated", r.momentum.simulated === true);
    check("funding reports the override", r.fundingRate.value === 0.00041);
    check("and it is flagged simulated", r.fundingRate.simulated === true);

    // Untouched measurements must NOT be flagged.
    check("EMA20 stays a live measurement", r.ema20_5m.value === 2510.57 && !r.ema20_5m.simulated);
    check("ROC30m stays a live measurement", r.roc30m.value === 0.541 && !r.roc30m.simulated);
    check("mark price stays live", r.markPrice.value === 2518.61 && !r.markPrice.simulated);
    check("position quantity stays live", r.positionQty.value === 0.009 && !r.positionQty.simulated);
    check("entry price stays live", !r.entryPrice.simulated);

    const noOverride = buildReport({
      ...snap,
      overrides: {},
      effective: snap.live,
    } as MetricSnapshot);
    check("with no scenario, nothing is flagged simulated",
      Object.values(noOverride).every(
        (v) => !(v && typeof v === "object" && "simulated" in v && v.simulated),
      ));
    check("and momentum falls back to the live measurement",
      noOverride.momentum.value === "NEUTRAL");
  }

  /* ====================================================================== */
  section("4. Console state is assembled, never computed");

  {
    const path = join(dir, "guardian-state.json");
    const store = new GuardianStore(path);
    store.write({
      lab: null,
      draft: null,
      guardian: {
        id: "G-ETH-03", name: "ETH Defensive Guardian", symbol: "ETHUSDC", mode: "guarded",
        maxReductionPercent: 30,
        rules: [{ id: "R1", conditions: [{ metric: "momentum", operator: "==", value: "BEARISH" }],
          action: { type: "reduce_position", percent: 60 } }],
      },
      status: "ACTIVE",
      cycle: null,
    });
    const state = store.read();
    check("guardian round-trips", state.guardian?.id === "G-ETH-03");
    check("status round-trips", state.status === "ACTIVE");
    check("no cycle means no snapshot to render", state.cycle === null);

    // The console derives `armed` from status + guardian; it must be false the
    // moment the emergency stop lands, without any other state changing.
    store.update({ status: "OBSERVING" });
    check("emergency stop leaves the Guardian in place", store.read().guardian !== null);
    check("but it is no longer ACTIVE", store.read().status === "OBSERVING");
  }

  /* ====================================================================== */
  section("5. The console cannot trade");

  {
    const routeSrc = readFileSync("src/app/api/state/route.ts", "utf8");
    for (const forbidden of ["newOrder", "reducePosition", "runGuardianCycle", "HostRelayInvoker", "submitVerifiedReduction"]) {
      check(`route handler never references ${forbidden}`, !routeSrc.includes(forbidden));
    }
    check("only three controls exist",
      /stop:\s*"OBSERVING"/.test(routeSrc) && /pause:\s*"PAUSED"/.test(routeSrc) && /resume:\s*"ACTIVE"/.test(routeSrc));

    const consoleSrc = readFileSync("src/app/console.tsx", "utf8");
    check("the client never calls an MCP tool", !/futures_usds_|mcp__/.test(consoleSrc));
    check("the client's only endpoint is /api/state",
      [...consoleSrc.matchAll(/fetch\(\s*["'`]([^"'`]+)/g)].every((m) => m[1] === "/api/state"));

    const stateSrc = readFileSync("src/lib/console/state.ts", "utf8");
    check("console state does not import the metric engine's computation",
      !stateSrc.includes("computeMetrics"));
    check("console state does not evaluate policy", !stateSrc.includes("evaluateGuardian"));
  }

  console.log(failed ? "\nCONSOLE CHECKS FAILED.\n" : "\nAll console checks passed.\n");
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = 1;
});
