/**
 * Watch checks — the market pre-screen that lets Sentinel monitor without a host.
 *
 *   npm run check:watch
 *
 * The screen exists to answer one question: is it worth waking the runtime?
 * It must never decide to trade, never raise attention on missing data, and
 * never let an account-dependent rule be judged on market data alone.
 *
 * Offline. Upstream is stubbed; no live fixture, no order.
 */
import { readFileSync } from "node:fs";
import { screenMarket, needsAccount, MARKET_METRICS } from "@/lib/watch/screen";
import type { Guardian } from "@/lib/policy/types";

let failed = false;
const pass = (n: string, d = "") => console.log(`  [ok]   ${n}${d ? ` - ${d}` : ""}`);
function fail(n: string, d = "") { failed = true; console.log(`  [FAIL] ${n}${d ? ` - ${d}` : ""}`); }
const check = (n: string, c: boolean, d = "") => (c ? pass(n, d) : fail(n, d));
const section = (t: string) => console.log(`\n${t}`);

const SYMBOL = "ETHUSDC";
const FIVE_MIN = 5 * 60_000;

function guardian(conditions: Guardian["rules"][0]["conditions"]): Guardian {
  return {
    id: "G-ETH-01", name: "Test", symbol: SYMBOL, mode: "guarded",
    maxReductionPercent: 30,
    rules: [{ id: "R1", conditions, action: { type: "reduce_position", percent: 30 } }],
  };
}

const realFetch = globalThis.fetch;
let funding = 0.00008;
let closes = () => Array.from({ length: 50 }, () => 2500);
let failOn: string | null = null;

function stub() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (failOn && url.includes(failOn)) throw new Error("upstream down");
    const json = (o: unknown) => new Response(JSON.stringify(o), {
      status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/fapi/v1/klines")) {
      const end = Date.now() - FIVE_MIN;
      const cs = closes();
      return json(cs.map((c, i) => {
        const t = end - (cs.length - 1 - i) * FIVE_MIN;
        return [t - FIVE_MIN + 1, String(c), String(c), String(c), String(c), "1", t, "0", 1, "0", "0", "0"];
      }));
    }
    if (url.includes("/fapi/v1/premiumIndex"))
      return json({ symbol: SYMBOL, markPrice: "2500", indexPrice: "2500",
        lastFundingRate: String(funding), nextFundingTime: Date.now() + 3600_000 });
    if (url.includes("/fapi/v1/fundingRate")) return json([{ fundingRate: String(funding) }]);
    if (url.includes("/fapi/v1/openInterest")) return json({ openInterest: "1000000" });
    if (url.includes("/futures/data/openInterestHist"))
      return json(Array.from({ length: 7 }, (_, i) => ({
        sumOpenInterest: i === 0 ? "1000000" : "1000000", sumOpenInterestValue: "1" })));
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
}
const restore = () => { globalThis.fetch = realFetch; };

/** Flat for 20 then a sharp drop = BEARISH under the frozen definition. */
const bearishCloses = () => [...Array.from({ length: 44 }, () => 2500), 2495, 2490, 2480, 2470, 2460, 2450];

async function main() {
  stub();

  /* ==================================================================== */
  section("1. The screen never needs an account or a host");

  {
    const src = readFileSync("src/lib/watch/screen.ts", "utf8");
    check("screen imports no MCP client", !/mcp\/|McpToolInvoker|HostRelay/.test(src));
    check("screen imports no execution adapter", !/execution-adapter|reducePosition/.test(src));
    check("screen cannot place an order", !/newOrder|submitVerified/.test(src));

    const w = readFileSync("scripts/watch.ts", "utf8");
    check("watcher cannot place an order", !/newOrder|reducePosition|submitVerified/.test(w));
    check("watcher does not import the relay", !/host-relay|RelayJournal/.test(w));
    check("market metrics are market-only",
      MARKET_METRICS.every((m) => !needsAccount(m)));
    check("position metrics are correctly flagged as needing an account",
      needsAccount("position_size") && needsAccount("unrealized_pnl") &&
      needsAccount("liquidation_distance_percent") && needsAccount("leverage"));
  }

  /* ==================================================================== */
  section("2. Quiet markets stay quiet");

  {
    funding = 0.00008; closes = () => Array.from({ length: 50 }, () => 2500);
    const r = await screenMarket(guardian([
      { metric: "funding_rate", operator: ">", value: 0.0003 },
      { metric: "momentum", operator: "==", value: "BEARISH" },
    ]));
    check("no attention when nothing matches", r.attention === false, r.reason);
    check("the rule is BLOCKED", r.rules[0].verdict === "BLOCKED");
    check("it says which conditions were checked", r.rules[0].checked.length === 2);
    check("funding was read from public data", r.market.funding_rate === 0.00008);
  }

  /* ==================================================================== */
  section("3. A matching market raises attention");

  {
    funding = 0.00041; closes = bearishCloses;
    const r = await screenMarket(guardian([
      { metric: "funding_rate", operator: ">", value: 0.0003 },
      { metric: "momentum", operator: "==", value: "BEARISH" },
    ]));
    check("attention raised", r.attention === true, r.reason);
    check("verdict is MATCHED (no account data needed)", r.rules[0].verdict === "MATCHED");
    check("every condition matched", r.rules[0].checked.every((c) => c.matched));
    check("momentum computed from the frozen definition", r.market.momentum === "BEARISH");
  }

  /* ==================================================================== */
  section("4. One failing market condition blocks the rule");

  {
    funding = 0.00041; closes = () => Array.from({ length: 50 }, () => 2500); // NEUTRAL
    const r = await screenMarket(guardian([
      { metric: "funding_rate", operator: ">", value: 0.0003 },
      { metric: "momentum", operator: "==", value: "BEARISH" },
    ]));
    check("funding alone is not enough", r.attention === false);
    check("blocked on momentum",
      r.rules[0].checked.some((c) => c.condition.metric === "momentum" && !c.matched));
  }

  /* ==================================================================== */
  section("5. Account conditions are deferred, never judged here");

  {
    funding = 0.00041; closes = bearishCloses;
    const r = await screenMarket(guardian([
      { metric: "funding_rate", operator: ">", value: 0.0003 },
      { metric: "unrealized_pnl_percent", operator: "<", value: -5 },
    ]));
    check("verdict is NEEDS_ACCOUNT", r.rules[0].verdict === "NEEDS_ACCOUNT");
    check("attention still raised so the runtime can decide", r.attention === true);
    check("the account condition was deferred, not evaluated",
      r.rules[0].deferred.length === 1 &&
      r.rules[0].deferred[0].metric === "unrealized_pnl_percent");
    check("it was not silently counted as matched",
      !r.rules[0].checked.some((c) => c.condition.metric === "unrealized_pnl_percent"));
  }

  {
    // A market condition that fails still blocks, even with a deferred one present.
    funding = 0.00001; closes = bearishCloses;
    const r = await screenMarket(guardian([
      { metric: "funding_rate", operator: ">", value: 0.0003 },
      { metric: "position_size", operator: ">", value: 0.001 },
    ]));
    check("a failed market condition blocks despite deferrals", r.attention === false);
  }

  /* ==================================================================== */
  section("6. Missing data never raises attention");

  {
    funding = 0.00041; closes = bearishCloses;
    failOn = "premiumIndex";
    let threw = false;
    try { await screenMarket(guardian([{ metric: "funding_rate", operator: ">", value: 0.0003 }])); }
    catch { threw = true; }
    failOn = null;
    check("an upstream failure throws rather than returning a false quiet", threw);

    const w = readFileSync("scripts/watch.ts", "utf8");
    check("the watcher catches it and does NOT raise attention",
      /catch[\s\S]{0,200}market data unavailable[\s\S]{0,120}return false/.test(w));
  }

  {
    // Momentum unavailable (too few candles) must not match an == BEARISH rule.
    funding = 0.00041; closes = () => Array.from({ length: 10 }, () => 2500);
    const r = await screenMarket(guardian([
      { metric: "momentum", operator: "==", value: "BEARISH" },
    ]));
    check("null momentum does not match", r.attention === false);
    check("and is reported as null, not guessed", r.market.momentum === null);
  }

  /* ==================================================================== */
  section("7. Multiple rules — any live rule wakes the runtime");

  {
    funding = 0.00041; closes = bearishCloses;
    const g = guardian([{ metric: "funding_rate", operator: ">", value: 0.0003 }]);
    g.rules.push({
      id: "R2",
      conditions: [{ metric: "funding_rate", operator: ">", value: 0.9 }],
      action: { type: "reduce_position", percent: 10 },
    });
    const r = await screenMarket(g);
    check("R1 matched", r.rules[0].verdict === "MATCHED");
    check("R2 blocked", r.rules[1].verdict === "BLOCKED");
    check("attention raised because one rule is live", r.attention === true);
    check("the reason names the live rule", r.reason.includes("R1"));
  }

  restore();
  console.log(failed ? "\nWATCH CHECKS FAILED.\n" : "\nAll watch checks passed.\n");
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { restore(); console.error(e); process.exitCode = 1; });
