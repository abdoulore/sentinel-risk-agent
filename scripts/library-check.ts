/**
 * Guardian library checks.
 *
 *   npm run check:library
 *
 * Every policy shipped in guardians/ must validate against the real compiler
 * and behave as its name claims. A library whose examples are wrong is worse
 * than no library — someone will copy one, activate it, and trust it.
 *
 * Also asserts the general claim these files exist to demonstrate: Sentinel is
 * a policy engine, not a funding bot. If the metric registry ever narrows, this
 * catches it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { validateGuardianInput, CompileError } from "@/lib/compiler/validate";
import { evaluateGuardian } from "@/lib/policy/engine";
import { validateAction } from "@/lib/policy/validator";
import type { MetricSnapshot, MetricValues } from "@/lib/metrics/engine";
import type { SymbolFilters } from "@/lib/binance/filters";
import type { PositionState } from "@/lib/binance/account";
import type { Guardian } from "@/lib/policy/types";

let failed = false;
const pass = (n: string, d = "") => console.log(`  [ok]   ${n}${d ? ` - ${d}` : ""}`);
function fail(n: string, d = "") { failed = true; console.log(`  [FAIL] ${n}${d ? ` - ${d}` : ""}`); }
const check = (n: string, c: boolean, d = "") => (c ? pass(n, d) : fail(n, d));
const section = (t: string) => console.log(`\n${t}`);

const DIR = "guardians";
const SYMBOL = "ETHUSDC";

const FILTERS: SymbolFilters = {
  symbol: SYMBOL, tickSize: "0.01", stepSize: "0.001", minQty: "0.001", maxQty: "8000",
  marketStepSize: "0.001", marketMinQty: "0.001", marketMaxQty: "700", minNotional: "20",
  pricePrecision: 2, quantityPrecision: 3, fetchedAt: Date.now(),
};
const POSITION: PositionState = {
  symbol: SYMBOL, positionAmt: 0.100, side: "LONG", entryPrice: 2500, markPrice: 2500,
  liquidationPrice: 1800, notional: 250, unrealizedPnl: 0, unrealizedPnlPercent: 0,
  liquidationDistancePercent: 28, leverage: 5, marginType: "cross",
  positionInitialMargin: 50, maintMargin: 1, updateTime: Date.now(),
};

function snap(v: Partial<MetricValues>): MetricSnapshot {
  const base: MetricValues = {
    momentum: "NEUTRAL", funding_rate: 0.00001, funding_direction: "FLAT",
    open_interest: 1e6, oi_change_percent: 0, unrealized_pnl: 0, unrealized_pnl_percent: 0,
    liquidation_distance_percent: 30, position_size: 0.1, leverage: 5, margin_ratio: 0.05, ...v,
  };
  return { at: Date.now(), symbol: SYMBOL, live: base, effective: base,
    overrides: {}, sources: {} } as unknown as MetricSnapshot;
}

function fires(g: Guardian, v: Partial<MetricValues>): string | null {
  return evaluateGuardian(g, snap(v)).firedRule?.rule.id ?? null;
}

function main() {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();

  /* ==================================================================== */
  section("1. Every shipped Guardian compiles");

  const loaded: Record<string, Guardian> = {};
  for (const f of files) {
    try {
      const r = validateGuardianInput(readFileSync(join(DIR, f), "utf8"), { symbol: SYMBOL });
      loaded[f] = r.guardian;
      const warn = r.warnings.length ? ` (${r.warnings.length} warning)` : "";
      pass(`${f} validates`, `${r.guardian.rules.length} rule(s), ceiling ${r.guardian.maxReductionPercent}%${warn}`);
    } catch (e) {
      fail(`${f} validates`, e instanceof CompileError ? e.issues.join("; ") || e.message : String(e));
    }
  }
  check("the library is not empty", files.length >= 5, `${files.length} files`);
  check("every file loaded", Object.keys(loaded).length === files.length);

  /* ==================================================================== */
  section("2. Each does what its name says");

  {
    const g = loaded["liquidation-defence.json"];
    if (g) {
      check("liquidation-defence fires hard when liquidation is near",
        fires(g, { liquidation_distance_percent: 6 }) === "R1");
      check("  …and mildly at moderate distance",
        fires(g, { liquidation_distance_percent: 12 }) === "R2");
      check("  …and not at all when far away",
        fires(g, { liquidation_distance_percent: 30 }) === null);
    }
  }

  {
    const g = loaded["drawdown.json"];
    if (g) {
      check("drawdown fires on a deep loss alone",
        fires(g, { unrealized_pnl_percent: -12 }) === "R1");
      check("  …on a smaller loss only when momentum is bearish",
        fires(g, { unrealized_pnl_percent: -6, momentum: "BEARISH" }) === "R2");
      check("  …and not on a small loss in a calm market",
        fires(g, { unrealized_pnl_percent: -6 }) === null);
      check("  …and never in profit", fires(g, { unrealized_pnl_percent: 8 }) === null);
    }
  }

  {
    const g = loaded["leverage-discipline.json"];
    if (g) {
      check("leverage-discipline fires when margin tightens at leverage",
        fires(g, { leverage: 8, margin_ratio: 0.45 }) === "R1");
      check("  …and not at low leverage", fires(g, { leverage: 3, margin_ratio: 0.45 }) === null);
    }
  }

  {
    const g = loaded["profit-lock.json"];
    if (g) {
      check("profit-lock fires on a big gain turning bearish",
        fires(g, { unrealized_pnl_percent: 15, momentum: "BEARISH" }) === "R1");
      check("  …and not while the gain is still trending",
        fires(g, { unrealized_pnl_percent: 15 }) === null);
      const r = validateGuardianInput(readFileSync(join(DIR, "profit-lock.json"), "utf8"), { symbol: SYMBOL });
      check("  …and is honest that true trailing needs state",
        r.unsupported.length === 1 && /remembered peak/i.test(r.unsupported[0]));
    }
  }

  /* ==================================================================== */
  section("3. Staged de-risk escalates in the right order");

  {
    const g = loaded["staged-derisk.json"];
    if (g) {
      check("mild funding stress -> the mildest rule",
        fires(g, { funding_rate: 0.0004, momentum: "BEARISH" }) === "R4");
      check("OI stress -> the OI rule",
        fires(g, { oi_change_percent: 18, momentum: "BEARISH" }) === "R3");
      check("funding plus a real loss -> a bigger cut",
        fires(g, { funding_rate: 0.0006, unrealized_pnl_percent: -5 }) === "R2");
      check("liquidation close -> the severest rule",
        fires(g, { liquidation_distance_percent: 6 }) === "R1");
      check("SEVERITY WINS: liquidation pre-empts funding when both hold",
        fires(g, { liquidation_distance_percent: 6, funding_rate: 0.0006, unrealized_pnl_percent: -5 }) === "R1",
        "first match wins, so severe rules must come first");
    }
  }

  /* ==================================================================== */
  section("4. Ceilings are real, and close_position obeys them");

  {
    for (const [f, g] of Object.entries(loaded)) {
      for (const rule of g.rules) {
        const req = rule.action.type === "close_position" ? 100 : rule.action.percent ?? 0;
        const v = validateAction(rule.action, { guardian: g, status: "ACTIVE", position: POSITION, filters: FILTERS });
        const capped = (v.executedPercent ?? 0) <= g.maxReductionPercent;
        if (!capped) fail(`${f} ${rule.id} respects its ceiling`, `${v.executedPercent}% > ${g.maxReductionPercent}%`);
        void req;
      }
    }
    pass("every rule in every file executes within its own ceiling");

    const staged = loaded["staged-derisk.json"];
    if (staged) {
      const v = validateAction({ type: "close_position" }, {
        guardian: staged, status: "ACTIVE", position: POSITION, filters: FILTERS });
      check("staged-derisk can genuinely close out (ceiling is 100)",
        v.executedPercent === 100 && v.quantity?.steppedQty === "0.100");
    }
    const liq = loaded["liquidation-defence.json"];
    if (liq) {
      const v = validateAction({ type: "close_position" }, {
        guardian: liq, status: "ACTIVE", position: POSITION, filters: FILTERS });
      check("a 50% ceiling clamps close_position — it CANNOT close you out",
        v.resolution === "CLAMPED" && v.executedPercent === 50);
    }
  }

  /* ==================================================================== */
  section("5. The library proves the engine is general");

  {
    const used = new Set<string>();
    for (const g of Object.values(loaded)) {
      for (const r of g.rules) for (const c of r.conditions) used.add(c.metric);
    }
    check("policies span market AND account metrics", used.size >= 6, `${used.size} distinct metrics`);
    for (const m of ["funding_rate", "momentum", "unrealized_pnl_percent",
                     "liquidation_distance_percent", "oi_change_percent", "leverage", "margin_ratio"]) {
      check(`  ${m} is used by at least one policy`, used.has(m));
    }
    const docs = readFileSync(join(DIR, "README.md"), "utf8");
    check("the library documents first-match-wins ordering", /first match wins/i.test(docs));
    check("and warns that a 100% ceiling can close you out", /100% ceiling[\s\S]{0,80}can/i.test(docs));
    check("and states the funding_rate unit trap", /0\.03%[\s\S]{0,40}0\.0003/.test(docs));
  }

  console.log(failed ? "\nLIBRARY CHECKS FAILED.\n" : "\nAll library checks passed.\n");
  process.exitCode = failed ? 1 : 0;
}

try { main(); } catch (e) { console.error(e); process.exitCode = 1; }
