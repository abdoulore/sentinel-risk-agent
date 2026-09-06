/**
 * Agent Lab checks.
 *
 *   npm run check:lab
 *
 * Agent Lab's whole claim is that it simulates the market event and nothing
 * else. These tests hold it to that: the same Policy Engine runs, the Validator
 * still owns the clamp, the browser has no execution authority, and no live
 * write occurs anywhere in this suite.
 *
 * Runs entirely offline against mocked positions and a stubbed upstream. The
 * live ETHUSDC fixture is never touched.
 */
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildLabScenario, LabScenarioError, LAB_PRESETS } from "@/lib/guardian/lab";
import { GuardianStore } from "@/lib/guardian/store";
import { EventStore } from "@/lib/events/store";
import { RelayJournal } from "@/lib/mcp/journal";
import { HostRelayInvoker, RelayRequired } from "@/lib/mcp/host-relay";
import { McpExecutionAdapter } from "@/lib/execution/execution-adapter";
import { runGuardianCycle, type RuntimeEvent } from "@/lib/policy/runtime";
import { evaluateGuardian } from "@/lib/policy/engine";
import { computeMetrics } from "@/lib/metrics/engine";
import { buildReport } from "@/lib/metrics/report";
import type { Guardian } from "@/lib/policy/types";
import type { SymbolFilters } from "@/lib/binance/filters";
import type { PositionState, AccountState } from "@/lib/binance/account";

let failed = false;
const pass = (n: string, d = "") => console.log(`  [ok]   ${n}${d ? ` - ${d}` : ""}`);
function fail(n: string, d = "") {
  failed = true;
  console.log(`  [FAIL] ${n}${d ? ` - ${d}` : ""}`);
}
const check = (n: string, c: boolean, d = "") => (c ? pass(n, d) : fail(n, d));
const section = (t: string) => console.log(`\n${t}`);

const dir = mkdtempSync(join(tmpdir(), "sentinel-lab-"));
let n = 0;
const tmpPath = (name: string) => join(dir, `${name}-${n++}.jsonl`);

/* -------------------------------- fixtures -------------------------------- */

const SYMBOL = "ETHUSDC";
const FIVE_MIN = 5 * 60_000;

const GUARDIAN: Guardian = {
  id: "G-ETH-03",
  name: "ETH Defensive Guardian",
  symbol: SYMBOL,
  mode: "guarded",
  maxReductionPercent: 30,
  rules: [
    {
      id: "R1",
      conditions: [
        { metric: "funding_rate", operator: ">", value: 0.0003 },
        { metric: "momentum", operator: "==", value: "BEARISH" },
      ],
      // The Guardian's OWN action. Agent Lab must never rewrite this.
      action: { type: "reduce_position", percent: 30 },
    },
  ],
};

const FILTERS: SymbolFilters = {
  symbol: SYMBOL, tickSize: "0.01", stepSize: "0.001", minQty: "0.001", maxQty: "8000",
  marketStepSize: "0.001", marketMinQty: "0.001", marketMaxQty: "700", minNotional: "20",
  pricePrecision: 2, quantityPrecision: 3, fetchedAt: Date.now(),
};

function position(amt = 0.009): PositionState {
  return {
    symbol: SYMBOL, positionAmt: amt, side: amt > 0 ? "LONG" : amt < 0 ? "SHORT" : "FLAT",
    entryPrice: 2416.56, markPrice: 2514.34, liquidationPrice: 1758.84,
    notional: Math.abs(amt) * 2514.34, unrealizedPnl: 0.88, unrealizedPnlPercent: 19.44,
    liquidationDistancePercent: 30.05, leverage: 5, marginType: "cross",
    positionInitialMargin: 4.53, maintMargin: 0.09, updateTime: Date.now(),
  };
}
const account: AccountState = {
  totalWalletBalance: 5.98, totalMarginBalance: 6.86, totalUnrealizedProfit: 0.88,
  totalMaintMargin: 0.09, availableBalance: 2.33, marginRatio: 0.013,
};

/* ------------------------------ upstream stub ------------------------------ */

const realFetch = globalThis.fetch;
/** Live market: funding well BELOW the threshold, momentum NEUTRAL. */
let liveFunding = 0.00008724;
let liveClose = 2500;

function stubUpstream() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (o: unknown) =>
      new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });

    if (url.includes("/fapi/v1/klines")) {
      const end = Date.now() - FIVE_MIN;
      return json(
        Array.from({ length: 50 }, (_, i) => {
          const t = end - (49 - i) * FIVE_MIN;
          const c = String(liveClose);
          return [t - FIVE_MIN + 1, c, c, c, c, "1", t, "0", 1, "0", "0", "0"];
        }),
      );
    }
    if (url.includes("/fapi/v1/premiumIndex"))
      return json({ symbol: SYMBOL, markPrice: "2514.5", indexPrice: "2513.5",
        lastFundingRate: String(liveFunding), nextFundingTime: Date.now() + 3600_000 });
    if (url.includes("/fapi/v1/fundingRate")) return json([{ fundingRate: String(liveFunding) }]);
    if (url.includes("/fapi/v1/openInterest")) return json({ openInterest: "1031636.583" });
    if (url.includes("/futures/data/openInterestHist"))
      return json(Array.from({ length: 7 }, () => ({ sumOpenInterest: "1030000", sumOpenInterestValue: "1" })));
    return new Response("not stubbed", { status: 404 });
  }) as typeof fetch;
}
const restore = () => {
  globalThis.fetch = realFetch;
};

/* ------------------------------- fake host --------------------------------- */

class FakeHost {
  readonly relayed: { tool: string; args: Record<string, unknown> }[] = [];
  constructor(private readonly journal: RelayJournal) {}
  drain(): void {
    for (const req of this.journal.pending()) {
      this.relayed.push({ tool: req.tool, args: req.args });
      // READS are fulfilled. A WRITE is deliberately left pending — this suite
      // never completes an order, not even a mocked one.
      if (req.kind === "WRITE") continue;
      if (req.tool === "futures_usds_positionInformationV2") {
        const p = position();
        this.journal.fulfill(req.requestId, [{
          symbol: SYMBOL, positionAmt: String(p.positionAmt), entryPrice: String(p.entryPrice),
          markPrice: String(p.markPrice), liquidationPrice: String(p.liquidationPrice),
          unRealizedProfit: String(p.unrealizedPnl), notional: String(p.notional),
          leverage: "5", marginType: "cross", updateTime: p.updateTime,
        }]);
      } else if (req.tool === "futures_usds_accountInformationV3") {
        this.journal.fulfill(req.requestId, { totalWalletBalance: "0", assets: [
          { asset: "USDC", walletBalance: "5.98", marginBalance: "6.86", unrealizedProfit: "0.88",
            maintMargin: "0.09", initialMargin: "4.53", availableBalance: "2.33" }] });
      } else {
        this.journal.fail(req.requestId, `unexpected tool ${req.tool}`);
      }
    }
  }
  writes() {
    return this.relayed.filter((r) => r.tool.includes("newOrder"));
  }
}

/** Run a cycle to its first pause, exactly as the host would. */
async function runCycle(opts: {
  journal: RelayJournal;
  events: EventStore;
  cycleId: string;
  overrides: Record<string, number | string>;
  proposedPercent: number | null;
  host: FakeHost;
}): Promise<{ events: RuntimeEvent[]; pendingWrite: Record<string, unknown> | null }> {
  const emitted: RuntimeEvent[] = [];

  for (let turn = 0; turn < 8; turn++) {
    const relay = new HostRelayInvoker({ cycleId: opts.cycleId, journal: opts.journal });
    const adapter = new McpExecutionAdapter(relay, SYMBOL);
    emitted.length = 0;

    try {
      const reads = await Promise.allSettled([
        adapter.getPosition(SYMBOL, "POSITION_BEFORE"),
        adapter.getAccountState("ACCOUNT"),
      ]);
      if (reads.some((r) => r.status === "rejected" && r.reason instanceof RelayRequired)) {
        opts.host.drain();
        continue;
      }
      const pos = (reads[0] as PromiseFulfilledResult<PositionState>).value;
      const acct = (reads[1] as PromiseFulfilledResult<AccountState>).value;

      const snapshot = await computeMetrics({
        symbol: SYMBOL, position: pos, account: acct, overrides: opts.overrides,
      });

      await runGuardianCycle({
        guardian: GUARDIAN,
        status: "ACTIVE",
        cycleId: opts.cycleId,
        lab: { preset: null, overrides: opts.overrides, proposedPercent: opts.proposedPercent },
        filters: FILTERS,
        snapshot,
        adapter,
        reevaluate: async () => evaluateGuardian(GUARDIAN, snapshot),
        emit: opts.events.sink(opts.cycleId, (e) => emitted.push(e)),
      });
      break;
    } catch (e) {
      if (e instanceof RelayRequired) {
        if (e.request.kind === "WRITE") {
          return { events: emitted, pendingWrite: e.request.args };
        }
        opts.host.drain();
        continue;
      }
      throw e;
    }
  }
  const write = opts.journal.pending().find((r) => r.kind === "WRITE");
  return { events: emitted, pendingWrite: write ? write.args : null };
}

async function main() {
  stubUpstream();

  /* ====================================================================== */
  section("1-4. Overrides change only the effective metric they name");

  {
    const snapLive = await computeMetrics({ symbol: SYMBOL, position: position(), account });
    const snapLab = await computeMetrics({
      symbol: SYMBOL, position: position(), account,
      overrides: { funding_rate: 0.00041, momentum: "BEARISH", oi_change_percent: 11 },
    });

    // 1. Same Policy Engine, both paths.
    const liveEval = evaluateGuardian(GUARDIAN, snapLive);
    const labEval = evaluateGuardian(GUARDIAN, snapLab);
    check("live metrics do not fire the rule", liveEval.firedRule === null);
    check("simulated metrics DO fire the same rule", labEval.firedRule?.rule.id === "R1");
    {
      // The real claim is that there is no second, lab-only evaluation path:
      // the runtime evaluates the same way whether or not a scenario is armed.
      const rt = readFileSync("src/lib/policy/runtime.ts", "utf8");
      check("the cycle evaluates unconditionally — no lab branch",
        /const evaluation = evaluateGuardian\(guardian, snapshot\);/.test(rt));
      check("no lab flag gates the evaluation",
        !/if\s*\([^)]*lab[^)]*\)\s*\{[^}]*evaluateGuardian/.test(rt));
      check("the lab never decides a match — overrides arrive via the snapshot",
        !/lab[^\n]*firedRule|firedRule[^\n]*lab/.test(rt));
    }

    // 2. Funding override.
    check("effective funding is the override", snapLab.effective.funding_rate === 0.00041);
    check("LIVE funding source value is untouched",
      snapLab.live.funding_rate === liveFunding && snapLab.sources.funding.lastFundingRate === liveFunding,
      String(snapLab.sources.funding.lastFundingRate));

    // 3. Momentum override leaves the candles and their indicators alone.
    check("effective momentum is the override", snapLab.effective.momentum === "BEARISH");
    check("live momentum classification is untouched", snapLab.live.momentum === "NEUTRAL");
    check("EMA20 is unchanged by the override",
      snapLab.sources.momentum?.ema20 === snapLive.sources.momentum?.ema20);
    check("ROC30m is unchanged by the override",
      snapLab.sources.momentum?.rocPercent === snapLive.sources.momentum?.rocPercent);
    check("the candle series is unchanged",
      snapLab.sources.candles.length === snapLive.sources.candles.length);

    // 4. OI override touches only the OI metric.
    check("effective OI change is the override", snapLab.effective.oi_change_percent === 11);
    check("live OI change is untouched",
      snapLab.sources.openInterest.changePercent === snapLive.sources.openInterest.changePercent);
    check("OI override does not move funding or momentum sources",
      snapLab.sources.funding.lastFundingRate === liveFunding && snapLab.sources.momentum?.state === "NEUTRAL");

    // 18. The console marks simulated values.
    const r = buildReport(snapLab);
    check("report marks funding simulated", r.fundingRate.simulated === true);
    check("report marks momentum simulated", r.momentum.simulated === true);
    check("report marks OI change simulated", r.openInterestChange.simulated === true);
    check("report does NOT mark EMA/ROC simulated",
      !r.ema20_5m.simulated && !r.roc30m.simulated);
    check("report shows the evaluated momentum", r.momentum.value === "BEARISH");
  }

  /* ====================================================================== */
  section("5-7. Freezing, fresh cycles, and reset");

  {
    const store = new GuardianStore(join(dir, "state-freeze.json"));
    store.write({ lab: null, draft: null, guardian: GUARDIAN, status: "ACTIVE", cycle: null });

    store.armLab(buildLabScenario({ preset: "funding-stress-bearish" }));
    check("arming stores the scenario", store.read().lab?.preset === "funding-stress-bearish");

    const c1 = store.beginCycle();
    check("a new cycle consumes the armed overrides", c1.overrides.funding_rate === 0.00041);
    check("the cycle captures the scenario", c1.lab?.proposedPercent === 60);

    const frozen = await computeMetrics({
      symbol: SYMBOL, position: position(), account, overrides: c1.overrides,
    });
    store.recordSnapshot(frozen);

    // 5. Replay across host turns sees the identical effective snapshot.
    liveFunding = 0.5; // upstream moves dramatically
    liveClose = 9999;
    const replay = store.beginCycle();
    check("replay returns the same cycle", replay.cycleId === c1.cycleId);
    check("the frozen snapshot is byte-identical on replay",
      JSON.stringify(store.read().cycle?.snapshot) === JSON.stringify(frozen));
    check("effective funding is unchanged across replay",
      store.read().cycle?.snapshot?.effective.funding_rate === 0.00041);
    check("live funding in the frozen snapshot is still the ORIGINAL measurement",
      store.read().cycle?.snapshot?.live.funding_rate === 0.00008724);

    // 6. A new cycle takes fresh live measurements.
    store.endCycle();
    const c2 = store.beginCycle({}, true);
    check("new cycle has a new id", c2.cycleId !== c1.cycleId);
    const fresh = await computeMetrics({ symbol: SYMBOL, position: position(), account, overrides: c2.overrides });
    check("the new cycle measured the moved market", fresh.live.funding_rate === 0.5,
      String(fresh.live.funding_rate));
    check("and still applies the armed override on top", fresh.effective.funding_rate === 0.00041);
    liveFunding = 0.00008724;
    liveClose = 2500;

    // 7. RESET TO LIVE clears it for the NEXT cycle only.
    const historical = store.read().cycle;
    store.resetLab();
    check("reset clears the armed scenario", store.read().lab === null);
    check("the in-flight cycle keeps its own overrides",
      JSON.stringify(store.read().cycle?.overrides) === JSON.stringify(historical?.overrides));
    store.endCycle();
    const c3 = store.beginCycle({}, true);
    check("the next cycle after reset has no overrides", Object.keys(c3.overrides).length === 0);
    check("and no lab scenario", c3.lab === null);
  }

  /* ====================================================================== */
  section("8-9. Invalid scenarios are rejected");

  {
    const rejects = (name: string, input: unknown, reason: string) => {
      try {
        buildLabScenario(input);
        fail(name, "accepted, should have thrown");
      } catch (e) {
        check(name, e instanceof LabScenarioError && e.reason === reason,
          e instanceof LabScenarioError ? e.reason : String(e));
      }
    };

    rejects("unknown metric is rejected", { overrides: { price_of_tea: 1 } }, "UNKNOWN_METRIC");
    rejects("non-registry field is rejected", { overrides: { orderId: 123 } }, "UNKNOWN_METRIC");
    rejects("non-numeric value for a number metric", { overrides: { funding_rate: "abc" } }, "INVALID_VALUE");
    rejects("null value is rejected", { overrides: { funding_rate: null } }, "INVALID_VALUE");
    rejects("boolean value is rejected", { overrides: { funding_rate: true } }, "INVALID_VALUE");
    rejects("invalid enum state is rejected", { overrides: { momentum: "VERY_BEARISH" } }, "INVALID_VALUE");
    rejects("numeric value for an enum metric", { overrides: { momentum: 3 } }, "INVALID_VALUE");
    rejects("proposal above 100 is rejected", { proposedPercent: 150 }, "INVALID_PROPOSAL");
    rejects("proposal of zero is rejected", { proposedPercent: 0 }, "INVALID_PROPOSAL");
    rejects("negative proposal is rejected", { proposedPercent: -20 }, "INVALID_PROPOSAL");
    rejects("non-numeric proposal is rejected", { proposedPercent: "lots" }, "INVALID_PROPOSAL");
    rejects("unknown preset is rejected", { preset: "moon" }, "UNKNOWN_PRESET");
    rejects("array is rejected", [], "MALFORMED");

    const ok = buildLabScenario({ overrides: { funding_rate: 0.00041, momentum: "BEARISH" }, proposedPercent: 60 });
    check("a valid scenario is accepted", ok.overrides.funding_rate === 0.00041 && ok.proposedPercent === 60);
    check("the default preset is the documented one",
      LAB_PRESETS["funding-stress-bearish"].label === "Funding Stress + Bearish Momentum");
    check("the preset does not add an OI CONDITION to the Guardian",
      GUARDIAN.rules[0].conditions.every((c) => c.metric !== "oi_change_percent"));
  }

  /* ====================================================================== */
  section("10-11. The browser has no execution authority");

  {
    const routeSrc = readFileSync("src/app/api/state/route.ts", "utf8");
    for (const forbidden of ["newOrder", "reducePosition", "runGuardianCycle", "HostRelayInvoker",
      "submitVerifiedReduction", "McpExecutionAdapter", "computeMetrics", "validateAction"]) {
      check(`route handler never references ${forbidden}`, !routeSrc.includes(forbidden));
    }
    check("lab_arm only arms state", /armLab\(/.test(routeSrc) && !/runGuardianCycle/.test(routeSrc));
    check("lab_arm refuses while a cycle is in flight", routeSrc.includes("CYCLE_IN_FLIGHT"));

    const consoleSrc = readFileSync("src/app/console.tsx", "utf8");
    check("the client never names an MCP tool", !/futures_usds_|mcp__/.test(consoleSrc));
    check("the client's only endpoint is /api/state",
      [...consoleSrc.matchAll(/fetch\(\s*["'`]([^"'`]+)/g)].every((m) => m[1] === "/api/state"));
    {
      // Strip comments first: a comment mentioning "quantity" is not the client
      // setting one. What matters is that no quantity is ever assigned or sent.
      const code = consoleSrc
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      check("the client never assigns a quantity", !/quantity\s*[:=]/i.test(code));
      check("the client never sends a quantity to the server", !/quantity/i.test(
        (code.match(/JSON\.stringify\([^)]*\)/g) ?? []).join(" "),
      ));
    }
    check("the client cannot set maxReductionPercent",
      !/maxReductionPercent\s*[:=]/.test(consoleSrc));

    // Arming cannot bypass the Validator: it stores data, nothing more.
    const labSrc = readFileSync("src/lib/guardian/lab.ts", "utf8");
    check("the lab module cannot decide a validation outcome",
      !/validateAction|Resolution|CLAMPED/.test(labSrc));
  }

  /* ====================================================================== */
  section("12-14. The Validator independently owns the clamp");

  {
    const journal = new RelayJournal(tmpPath("journal"));
    const events = new EventStore(tmpPath("events"));
    const host = new FakeHost(journal);

    const { events: emitted, pendingWrite } = await runCycle({
      journal, events, cycleId: "cycle-LAB", host,
      overrides: { funding_rate: 0.00041, momentum: "BEARISH", oi_change_percent: 11 },
      proposedPercent: 60,
    });

    const types = emitted.map((e) => e.type);
    const injected = emitted.find((e) => e.type === "LAB_PROPOSAL_INJECTED");
    const proposed = emitted.find((e) => e.type === "ACTION_PROPOSED");
    const clamped = emitted.find((e) => e.type === "ACTION_CLAMPED");
    const validated = emitted.find((e) => e.type === "EXECUTION_VALIDATED");

    check("a lab scenario event was emitted by the RUNTIME",
      types.includes("LAB_SCENARIO_STARTED"));
    check("the proposal injection is a runtime event, not UI text",
      injected !== undefined);
    check("12. the 60% proposal reached the validator",
      proposed?.type === "ACTION_PROPOSED" && proposed.requestedPercent === 60,
      String(proposed?.type === "ACTION_PROPOSED" ? proposed.requestedPercent : "?"));
    check("12. the Validator clamped 60 -> 30",
      clamped?.type === "ACTION_CLAMPED" && clamped.requestedPercent === 60 && clamped.executedPercent === 30);
    check("the injection event records the Guardian's own percentage separately",
      injected?.type === "LAB_PROPOSAL_INJECTED" && injected.guardianPercent === 30 && injected.labPercent === 60);

    // 13. Only the clamped 30% reaches quantity calculation.
    check("13. quantity was computed from 30%, not 60%",
      validated?.type === "EXECUTION_VALIDATED" && validated.roundedQty === "0.002",
      validated?.type === "EXECUTION_VALIDATED" ? validated.roundedQty : "?");
    check("13. the raw quantity is 30% of the position",
      validated?.type === "EXECUTION_VALIDATED" && Math.abs(validated.requestedQty - 0.0027) < 1e-9,
      validated?.type === "EXECUTION_VALIDATED" ? String(validated.requestedQty) : "?");
    check("13. the WRITE envelope carries only the clamped quantity",
      pendingWrite?.quantity === "0.002", String(pendingWrite?.quantity));
    check("13. a 60% quantity (0.005) never appears in the envelope",
      pendingWrite?.quantity !== "0.005");
    check("the envelope is reduceOnly MARKET on the right side",
      pendingWrite?.reduceOnly === "true" && pendingWrite?.type === "MARKET" && pendingWrite?.side === "SELL");

    // 14. The Guardian is untouched by all of this.
    check("14. Guardian maxReductionPercent is still 30", GUARDIAN.maxReductionPercent === 30);
    check("14. the Guardian's own rule action is still 30%",
      GUARDIAN.rules[0].action.percent === 30);

    // 16. No write was ever completed.
    check("16. no order was submitted anywhere in this cycle", host.writes().length === 0);
    check("16. the write is still pending, never fulfilled",
      journal.pending().some((r) => r.kind === "WRITE"));

    // 17. Replay dedup still holds with lab events in the stream.
    const prefixBefore = events.recent().map((e) => e.type);
    await runCycle({
      journal, events, cycleId: "cycle-LAB", host,
      overrides: { funding_rate: 0.00041, momentum: "BEARISH", oi_change_percent: 11 },
      proposedPercent: 60,
    });
    const after = events.recent().map((e) => e.type);

    // The deterministic prefix must appear exactly once, no matter how many
    // times the cycle is re-run. (A genuinely new event may still be appended:
    // the write is still pending, so the re-run correctly reports the ambiguous
    // window — that is a new fact, not a duplicate.)
    const counts = (list: string[]) =>
      list.reduce<Record<string, number>>((acc, t) => ({ ...acc, [t]: (acc[t] ?? 0) + 1 }), {});
    const c = counts(after);
    const duplicated = prefixBefore.filter((t) => c[t] > 1);
    check("17. replaying the lab cycle duplicates nothing",
      duplicated.length === 0, duplicated.length ? `duplicated: ${[...new Set(duplicated)].join(", ")}` : "prefix intact");
    check("17. every prefix event still appears exactly once",
      prefixBefore.every((t) => c[t] === 1), JSON.stringify(c));
    check("17. any appended event is a NEW fact, not a repeat",
      after.length === prefixBefore.length ||
        after.slice(prefixBefore.length).every((t) => !prefixBefore.includes(t)),
      after.slice(prefixBefore.length).join(",") || "none appended");
  }

  /* ====================================================================== */
  section("15. Without a scenario the live path is unchanged");

  {
    const journal = new RelayJournal(tmpPath("journal"));
    const events = new EventStore(tmpPath("events"));
    const host = new FakeHost(journal);

    const { events: emitted, pendingWrite } = await runCycle({
      journal, events, cycleId: "cycle-LIVE", host, overrides: {}, proposedPercent: null,
    });

    const types = emitted.map((e) => e.type);
    check("15. no lab events on the live path", !types.includes("LAB_SCENARIO_STARTED") && !types.includes("LAB_PROPOSAL_INJECTED"));
    check("15. live funding does not fire the rule", !types.includes("RULE_MATCHED"), types.join(",") || "no events");
    check("15. nothing was proposed", !types.includes("ACTION_PROPOSED"));
    check("15. no write envelope produced", pendingWrite === null);
    check("16. still no order submitted", host.writes().length === 0);
  }

  /* ====================================================================== */
  section("Guardian action is never rewritten by a scenario");

  {
    // The clamp must come from the Validator, not from a mutated Guardian.
    const journal = new RelayJournal(tmpPath("journal"));
    const events = new EventStore(tmpPath("events"));
    const host = new FakeHost(journal);
    const snapshotOfGuardian = JSON.stringify(GUARDIAN);

    await runCycle({
      journal, events, cycleId: "cycle-IMMUT", host,
      overrides: { funding_rate: 0.00041, momentum: "BEARISH" }, proposedPercent: 60,
    });
    check("the Guardian object is byte-identical after a lab run",
      JSON.stringify(GUARDIAN) === snapshotOfGuardian);

    const runtimeSrc = readFileSync("src/lib/policy/runtime.ts", "utf8");
    check("the runtime never assigns into the guardian",
      !/guardian\.(maxReductionPercent|rules)\s*=/.test(runtimeSrc));
    check("the injected action is a copy, not a mutation",
      /\{\s*\.\.\.guardianAction,\s*percent:\s*labPercent\s*\}/.test(runtimeSrc));
  }

  restore();
  console.log(failed ? "\nAGENT LAB CHECKS FAILED.\n" : "\nAll Agent Lab checks passed.\n");
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  restore();
  console.error(e);
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = 1;
});
