/**
 * Metric Engine checks — the measurements the Policy Engine acts on.
 *
 *   npm run check:metrics
 *
 * Runs offline. Upstream HTTP is stubbed so funding/OI fallbacks, malformed
 * bodies and stale feeds can be exercised deterministically; the live fixture
 * is never touched and no order is placed.
 *
 * The momentum definition is frozen (BUILD_PLAN §4) and these tests pin it:
 *   5m candles, EMA20 over closes, ROC over 6 candles (30m),
 *   BEARISH = price < EMA20 AND ROC30m < -1.0%
 *   BULLISH = price > EMA20 AND ROC30m > +1.0%
 */
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ema,
  rateOfChangePercent,
  classifyMomentum,
  computeMomentum,
  EMA_PERIOD,
  ROC_LOOKBACK,
  MIN_CANDLES,
  BACKFILL_CANDLES,
  ROC_THRESHOLD_PERCENT,
} from "@/lib/metrics/momentum";
import { computeMetrics } from "@/lib/metrics/engine";
import { buildReport, STALE_AFTER_MS, OI_CHANGE_WINDOW_MINUTES, provenanceOf } from "@/lib/metrics/report";
import { GuardianStore } from "@/lib/guardian/store";
import type { Candle } from "@/lib/binance/market";
import type { PositionState, AccountState } from "@/lib/binance/account";

let failed = false;
const pass = (n: string, d = "") => console.log(`  [ok]   ${n}${d ? ` - ${d}` : ""}`);
function fail(n: string, d = "") {
  failed = true;
  console.log(`  [FAIL] ${n}${d ? ` - ${d}` : ""}`);
}
const check = (n: string, c: boolean, d = "") => (c ? pass(n, d) : fail(n, d));
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const section = (t: string) => console.log(`\n${t}`);

/* -------------------------------- fixtures -------------------------------- */

const FIVE_MIN = 5 * 60_000;

/** Candles from an explicit close series, oldest first, ending `endAt`. */
function candlesFrom(closes: number[], endAt = Date.now() - FIVE_MIN): Candle[] {
  return closes.map((close, i) => {
    const closeTime = endAt - (closes.length - 1 - i) * FIVE_MIN;
    return {
      openTime: closeTime - FIVE_MIN + 1,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1,
      closeTime,
    };
  });
}

function position(over: Partial<PositionState> = {}): PositionState {
  return {
    symbol: "ETHUSDC",
    positionAmt: 0.009,
    side: "LONG",
    entryPrice: 2416.56,
    markPrice: 2514.34,
    liquidationPrice: 1758.84,
    notional: 22.629,
    unrealizedPnl: 0.88,
    unrealizedPnlPercent: 19.44,
    liquidationDistancePercent: 30.05,
    leverage: 5,
    marginType: "cross",
    positionInitialMargin: 4.5258,
    maintMargin: 0.0905,
    updateTime: Date.now(),
    ...over,
  };
}
const account: AccountState = {
  totalWalletBalance: 5.98,
  totalMarginBalance: 6.86,
  totalUnrealizedProfit: 0.878,
  totalMaintMargin: 0.0905,
  availableBalance: 2.33,
  marginRatio: 0.0132,
};

/* ------------------------------ fetch stubbing ----------------------------- */

type Route = (url: string) => unknown | Error;
const realFetch = globalThis.fetch;

function stubFetch(route: Route) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const out = route(url);
    if (out instanceof Error) throw out;
    if (out === undefined) {
      return new Response("not stubbed", { status: 404 });
    }
    if (typeof out === "string") return new Response(out, { status: 200 });
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}
const restoreFetch = () => {
  globalThis.fetch = realFetch;
};

/** Klines shaped as Binance returns them. */
function rawKlines(closes: number[], endAt: number) {
  return closes.map((c, i) => {
    const closeTime = endAt - (closes.length - 1 - i) * FIVE_MIN;
    return [closeTime - FIVE_MIN + 1, String(c), String(c), String(c), String(c), "1", closeTime,
      "0", 1, "0", "0", "0"];
  });
}

async function main() {
  /* ====================================================================== */
  section("1. Warmup — 50 closed candles before indicators");

  check("BACKFILL_CANDLES is 50", BACKFILL_CANDLES === 50, String(BACKFILL_CANDLES));
  check(`MIN_CANDLES is EMA_PERIOD + ROC_LOOKBACK (${EMA_PERIOD}+${ROC_LOOKBACK})`,
    MIN_CANDLES === EMA_PERIOD + ROC_LOOKBACK, String(MIN_CANDLES));
  check("backfill exceeds the minimum", BACKFILL_CANDLES > MIN_CANDLES);

  check("momentum is null below the minimum",
    computeMomentum(candlesFrom(Array.from({ length: MIN_CANDLES - 1 }, () => 2500))) === null);
  check("momentum computes at exactly the minimum",
    computeMomentum(candlesFrom(Array.from({ length: MIN_CANDLES }, (_, i) => 2500 + i))) !== null);
  check("momentum is null with no candles", computeMomentum([]) === null);

  /* ====================================================================== */
  section("2. EMA20");

  {
    // Flat series: EMA equals the constant.
    const flat = ema(Array.from({ length: 30 }, () => 100), 20);
    check("flat series -> EMA equals the level", near(flat[flat.length - 1], 100, 1e-9));

    // Seeded with the SMA of the first `period` values.
    const ramp = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20, SMA = 10.5
    const seeded = ema(ramp, 20);
    check("seeded with SMA of the first period", near(seeded[0], 10.5), String(seeded[0]));
    check("one output per step after the seed", seeded.length === 1);

    // One more sample: EMA += (x - EMA) * 2/(n+1)
    const stepped = ema([...ramp, 30], 20);
    const expected = 10.5 + (30 - 10.5) * (2 / 21);
    check("smoothing multiplier is 2/(period+1)",
      near(stepped[stepped.length - 1], expected, 1e-9), String(stepped[stepped.length - 1]));

    check("too few values -> empty series", ema([1, 2, 3], 20).length === 0);
  }

  /* ====================================================================== */
  section("3. ROC30m");

  {
    const closes = [100, 0, 0, 0, 0, 0, 110]; // 6 candles back = 100
    check("ROC over 6 candles = 30 minutes", ROC_LOOKBACK * 5 === 30);
    check("(110-100)/100 = +10%", near(rateOfChangePercent(closes, 6), 10), String(rateOfChangePercent(closes, 6)));

    const down = [100, 0, 0, 0, 0, 0, 97.5];
    check("(97.5-100)/100 = -2.5%", near(rateOfChangePercent(down, 6), -2.5));
    check("zero base is guarded", rateOfChangePercent([0, 1, 2, 3, 4, 5, 6], 6) === 0);
  }

  /* ====================================================================== */
  section("4. Classification and the exact -1.0% boundary");

  check("threshold is 1.0", ROC_THRESHOLD_PERCENT === 1.0);

  check("BEARISH: below EMA and ROC < -1%", classifyMomentum(99, 100, -1.5) === "BEARISH");
  check("BULLISH: above EMA and ROC > +1%", classifyMomentum(101, 100, 1.5) === "BULLISH");
  check("NEUTRAL: below EMA but ROC not low enough", classifyMomentum(99, 100, -0.5) === "NEUTRAL");
  check("NEUTRAL: ROC low but price above EMA", classifyMomentum(101, 100, -1.5) === "NEUTRAL");
  check("NEUTRAL: above EMA but ROC not high enough", classifyMomentum(101, 100, 0.5) === "NEUTRAL");

  // The boundary is strict: exactly -1.0% does NOT fire.
  check("EXACTLY -1.0% is NEUTRAL, not BEARISH", classifyMomentum(99, 100, -1.0) === "NEUTRAL");
  check("EXACTLY +1.0% is NEUTRAL, not BULLISH", classifyMomentum(101, 100, 1.0) === "NEUTRAL");
  check("just past -1.0% is BEARISH", classifyMomentum(99, 100, -1.0001) === "BEARISH");
  check("just past +1.0% is BULLISH", classifyMomentum(101, 100, 1.0001) === "BULLISH");
  check("price equal to EMA is NEUTRAL either way",
    classifyMomentum(100, 100, -5) === "NEUTRAL" && classifyMomentum(100, 100, 5) === "NEUTRAL");

  /* ====================================================================== */
  section("5. End-to-end momentum states");

  {
    // Flat for 20, then a sharp drop over the last 6 candles.
    const bear = computeMomentum(candlesFrom([...Array.from({ length: 20 }, () => 2500), 2495, 2490, 2480, 2470, 2460, 2450]));
    check("engineered decline -> BEARISH", bear?.state === "BEARISH", `${bear?.state} roc=${bear?.rocPercent.toFixed(3)}%`);
    check("BEARISH has price below EMA20", (bear?.latestClose ?? 0) < (bear?.ema20 ?? 0));

    const bull = computeMomentum(candlesFrom([...Array.from({ length: 20 }, () => 2500), 2505, 2510, 2520, 2530, 2540, 2550]));
    check("engineered advance -> BULLISH", bull?.state === "BULLISH", `${bull?.state} roc=${bull?.rocPercent.toFixed(3)}%`);

    const flat = computeMomentum(candlesFrom(Array.from({ length: 26 }, () => 2500)));
    check("flat market -> NEUTRAL", flat?.state === "NEUTRAL", String(flat?.state));
    check("NEUTRAL flat has ROC 0", near(flat?.rocPercent ?? 1, 0));
  }

  /* ====================================================================== */
  section("6. Public fallbacks: funding, OI, mark price");

  const now = Date.now();
  const closes = Array.from({ length: BACKFILL_CANDLES }, () => 2500);

  const okRoutes: Route = (url) => {
    if (url.includes("/fapi/v1/klines")) return rawKlines(closes, now - FIVE_MIN);
    if (url.includes("/fapi/v1/premiumIndex"))
      return { symbol: "ETHUSDC", markPrice: "2514.5", indexPrice: "2513.5",
        lastFundingRate: "0.00008724", nextFundingTime: now + 3600_000 };
    if (url.includes("/fapi/v1/fundingRate"))
      return [{ fundingRate: "0.00008" }, { fundingRate: "0.000085" }, { fundingRate: "0.00008724" }];
    if (url.includes("/fapi/v1/openInterest")) return { openInterest: "1031636.583" };
    if (url.includes("/futures/data/openInterestHist"))
      return Array.from({ length: 7 }, (_, i) => ({
        sumOpenInterest: String(1030000 + i * 100),
        sumOpenInterestValue: "2583838496",
      }));
    return undefined;
  };

  {
    stubFetch(okRoutes);
    const snap = await computeMetrics({ symbol: "ETHUSDC", position: position(), account });
    const r = buildReport(snap, now);
    restoreFetch();

    check("funding rate read from premiumIndex (public)",
      near(r.fundingRate.value ?? 0, 0.00008724), String(r.fundingRate.value));
    check("funding source is BINANCE_PUBLIC", r.fundingRate.source === "BINANCE_PUBLIC");
    check("scalar mark price from premiumIndex", near(r.markPrice.value ?? 0, 2514.5));
    check("open interest read (public)", near(r.openInterest.value ?? 0, 1031636.583));
    check("OI source is BINANCE_PUBLIC", r.openInterest.source === "BINANCE_PUBLIC");
    check("position fields are sourced from MCP", r.positionQty.source === "MCP" && r.entryPrice.source === "MCP");
    check("momentum is derived from public klines",
      r.momentum.source === "BINANCE_PUBLIC" && r.momentum.derived === true);

    const prov = provenanceOf(r);
    check("every reported field carries provenance",
      Object.keys(prov).length === 15, `${Object.keys(prov).length} fields`);
    check("no field is sourced from authenticated REST",
      Object.values(prov).every((s) => s.startsWith("MCP") || s.startsWith("BINANCE_PUBLIC")));
  }

  /* ====================================================================== */
  section(`7. OI change is exactly ${OI_CHANGE_WINDOW_MINUTES}m`);

  {
    check("declared window is 30 minutes", OI_CHANGE_WINDOW_MINUTES === 30);
    // 7 samples at 5m: index 0 is 30 minutes before the newest.
    stubFetch((url) => {
      if (url.includes("/futures/data/openInterestHist"))
        return Array.from({ length: 7 }, (_, i) => ({
          sumOpenInterest: i === 0 ? "1000000" : "1005000",
          sumOpenInterestValue: "1",
        }));
      if (url.includes("/fapi/v1/openInterest")) return { openInterest: "1010000" };
      return okRoutes(url);
    });
    const snap = await computeMetrics({ symbol: "ETHUSDC", position: position(), account });
    const r = buildReport(snap, now);
    restoreFetch();
    // (1010000 - 1000000) / 1000000 = +1.00%
    check("OI_CHANGE_30M = (current - oi30mAgo)/oi30mAgo",
      near(r.openInterestChange.value ?? 0, 1.0, 1e-9), `${r.openInterestChange.value}%`);
    check("OI change is flagged derived", r.openInterestChange.derived === true);
  }

  {
    // History unavailable -> the change is null, never invented.
    stubFetch((url) =>
      url.includes("/futures/data/openInterestHist") ? new Error("upstream 500") : okRoutes(url));
    const snap = await computeMetrics({ symbol: "ETHUSDC", position: position(), account });
    const r = buildReport(snap, now);
    restoreFetch();
    check("missing OI history -> null, not a fabricated number", r.openInterestChange.value === null);
    check("and it is reported as unavailable", r.health.unavailable.includes("openInterestChange"));
    check("current OI still reported", r.openInterest.value !== null);
  }

  /* ====================================================================== */
  section("8. Malformed upstream responses");

  {
    stubFetch((url) => (url.includes("/fapi/v1/premiumIndex") ? "<html>not json</html>" : okRoutes(url)));
    let threw = false;
    try {
      await computeMetrics({ symbol: "ETHUSDC", position: position(), account });
    } catch {
      threw = true;
    }
    restoreFetch();
    check("non-JSON upstream body fails loudly rather than silently", threw);
  }

  {
    // Numeric fields present but garbage: must not become NaN in the report.
    stubFetch((url) =>
      url.includes("/fapi/v1/premiumIndex")
        ? { symbol: "ETHUSDC", markPrice: "abc", indexPrice: "x", lastFundingRate: "y", nextFundingTime: 0 }
        : okRoutes(url));
    const snap = await computeMetrics({ symbol: "ETHUSDC", position: position(), account });
    const r = buildReport(snap, now);
    restoreFetch();
    check("unparseable mark price -> null, never NaN", r.markPrice.value === null, String(r.markPrice.value));
    check("unparseable funding -> null, never NaN", r.fundingRate.value === null, String(r.fundingRate.value));
  }

  /* ====================================================================== */
  section("9. Stale market data");

  {
    stubFetch(okRoutes);
    const snap = await computeMetrics({ symbol: "ETHUSDC", position: position(), account });
    restoreFetch();

    const fresh = buildReport(snap, now);
    check("recent candles are not stale", fresh.health.stale === false);

    const later = buildReport(snap, now + STALE_AFTER_MS + FIVE_MIN);
    check("an old candle series is flagged stale", later.health.stale === true);
    check("staleness does not erase the values", later.price.value !== null);
    check("warmed up with 50 candles", fresh.health.warmedUp === true,
      `${fresh.health.candlesLoaded}/${fresh.health.candlesRequired}`);
  }

  /* ====================================================================== */
  section("10. Position-derived fields");

  {
    stubFetch(okRoutes);

    // PnL%: unrealizedPnl / initialMargin, where initialMargin = notional/leverage.
    const p = position({ unrealizedPnl: 0.88, positionInitialMargin: 4.5258, unrealizedPnlPercent: (0.88 / 4.5258) * 100 });
    const snapA = await computeMetrics({ symbol: "ETHUSDC", position: p, account });
    const rA = buildReport(snapA, now);
    check("PnL% = pnl / initial margin", near(rA.unrealizedPnlPercent.value ?? 0, 19.4442, 1e-3),
      `${rA.unrealizedPnlPercent.value?.toFixed(4)}%`);

    // Liquidation distance from the live fixture: |mark - liq| / mark.
    check("liq distance = |mark - liq| / mark",
      near(rA.liquidationDistancePercent.value ?? 0, 30.05, 0.01), `${rA.liquidationDistancePercent.value}%`);

    // A zero/absent liquidation price must be null, not 0 and not Infinity.
    const snapB = await computeMetrics({
      symbol: "ETHUSDC",
      position: position({ liquidationPrice: null, liquidationDistancePercent: null }),
      account,
    });
    const rB = buildReport(snapB, now);
    restoreFetch();
    check("null liquidation price stays null", rB.liquidationPrice.value === null);
    check("null liq distance stays null", rB.liquidationDistancePercent.value === null);
    check("and both are listed unavailable", rB.health.unavailable.includes("liquidationPrice"));
  }

  /* ====================================================================== */
  section("11. Snapshot freezing across relay turns");

  {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-metrics-"));
    const store = new GuardianStore(join(dir, "guardian.json"));

    stubFetch(okRoutes);
    const cycle = store.beginCycle({});
    const first = await computeMetrics({ symbol: "ETHUSDC", position: position(), account });
    store.recordSnapshot(first);

    // A later host turn in the SAME cycle must reuse the frozen snapshot.
    const replayCycle = store.beginCycle({});
    check("the same cycle id is returned mid-flight", replayCycle.cycleId === cycle.cycleId);
    const frozen = store.read().cycle?.snapshot;
    check("the snapshot persisted", frozen != null);
    check("replay sees the identical snapshot",
      JSON.stringify(frozen) === JSON.stringify(first));
    check("frozen timestamp does not move", frozen?.at === first.at);

    // Even though upstream has moved on.
    stubFetch((url) =>
      url.includes("/fapi/v1/premiumIndex")
        ? { symbol: "ETHUSDC", markPrice: "9999", indexPrice: "9999", lastFundingRate: "0.99", nextFundingTime: 0 }
        : okRoutes(url));
    const stillFrozen = store.read().cycle?.snapshot;
    check("upstream moving does not mutate the frozen snapshot",
      stillFrozen?.sources.funding.lastFundingRate === first.sources.funding.lastFundingRate);

    // A NEW cycle takes fresh measurements.
    store.endCycle();
    const next = store.beginCycle({}, true);
    check("a new cycle gets a new id", next.cycleId !== cycle.cycleId);
    check("a new cycle starts with no snapshot", next.snapshot === null);
    const refreshed = await computeMetrics({ symbol: "ETHUSDC", position: position(), account });
    store.recordSnapshot(refreshed);
    check("the new cycle measured the moved market",
      refreshed.sources.funding.lastFundingRate === 0.99,
      String(refreshed.sources.funding.lastFundingRate));
    restoreFetch();
    rmSync(dir, { recursive: true, force: true });
  }

  /* ====================================================================== */
  section("12. No LLM anywhere in the metric path");

  {
    const metricFiles: string[] = [];
    const stack = ["src/lib/metrics", "src/lib/binance"];
    while (stack.length) {
      const cur = stack.pop() as string;
      const st = statSync(cur);
      if (st.isDirectory()) {
        for (const e of readdirSync(cur)) stack.push(join(cur, e));
      } else if (cur.endsWith(".ts")) metricFiles.push(cur);
    }
    const offenders = metricFiles.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /@anthropic-ai|Anthropic|compileGuardian|claude-/i.test(src);
    });
    check("no metric or market file imports an LLM", offenders.length === 0, offenders.join(", "));
    check("checked the whole metric path", metricFiles.length >= 6, `${metricFiles.length} files`);

    const reportSrc = readFileSync("src/lib/metrics/report.ts", "utf8");
    check("the report layer names both sources only",
      reportSrc.includes('"MCP"') && reportSrc.includes('"BINANCE_PUBLIC"'));
  }

  console.log(failed ? "\nMETRIC CHECKS FAILED.\n" : "\nAll metric checks passed.\n");
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  restoreFetch();
  console.error(e);
  process.exitCode = 1;
});
