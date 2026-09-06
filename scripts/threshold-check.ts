/**
 * Day 1 threshold check (BUILD_PLAN §4).
 *
 * Pulls a week of 5m klines for the configured symbol (ETHUSDC) and counts how often BEARISH would have
 * held under the frozen definition. Reports the number. Does not tune anything.
 *
 *   npm run check:threshold
 */
import { fetchKlineHistory, closedOnly } from "@/lib/binance/market";
import {
  EMA_PERIOD,
  MIN_CANDLES,
  ROC_LOOKBACK,
  ROC_THRESHOLD_PERCENT,
  classifyMomentum,
  ema,
  rateOfChangePercent,
  type Momentum,
} from "@/lib/metrics/momentum";
import { SYMBOL } from "@/lib/config";

const CANDLES_PER_WEEK = (7 * 24 * 60) / 5; // 2016

interface Tally {
  bearish: number;
  bullish: number;
  neutral: number;
  evaluated: number;
  bearishEpisodes: number;
  longestBearishStreak: number;
  longestBearishStart: number | null;
}

function walk(closes: number[], closeTimes: number[], threshold: number): Tally {
  const tally: Tally = {
    bearish: 0,
    bullish: 0,
    neutral: 0,
    evaluated: 0,
    bearishEpisodes: 0,
    longestBearishStreak: 0,
    longestBearishStart: null,
  };

  let streak = 0;
  let streakStart: number | null = null;
  let previous: Momentum | null = null;

  // Evaluate at every point that has a full lookback behind it, exactly as the
  // live engine would have seen it.
  for (let i = MIN_CANDLES - 1; i < closes.length; i++) {
    const window = closes.slice(0, i + 1);
    const emaSeries = ema(window, EMA_PERIOD);
    const ema20 = emaSeries[emaSeries.length - 1];
    const latestClose = window[window.length - 1];
    const roc = rateOfChangePercent(window, ROC_LOOKBACK);

    // classifyMomentum with an injected threshold, so the frozen function stays
    // the single source of truth at the declared 1.0%.
    const state: Momentum =
      threshold === ROC_THRESHOLD_PERCENT
        ? classifyMomentum(latestClose, ema20, roc)
        : latestClose < ema20 && roc < -threshold
          ? "BEARISH"
          : latestClose > ema20 && roc > threshold
            ? "BULLISH"
            : "NEUTRAL";

    tally.evaluated++;
    if (state === "BEARISH") {
      tally.bearish++;
      if (previous !== "BEARISH") {
        tally.bearishEpisodes++;
        streak = 0;
        streakStart = closeTimes[i];
      }
      streak++;
      if (streak > tally.longestBearishStreak) {
        tally.longestBearishStreak = streak;
        tally.longestBearishStart = streakStart;
      }
    } else if (state === "BULLISH") {
      tally.bullish++;
    } else {
      tally.neutral++;
    }
    previous = state;
  }
  return tally;
}

function pct(n: number, total: number): string {
  return total === 0 ? "n/a" : `${((n / total) * 100).toFixed(2)}%`;
}

async function main() {
  console.log(`Fetching ${CANDLES_PER_WEEK} x 5m klines for ${SYMBOL}...`);
  const raw = await fetchKlineHistory(SYMBOL, "5m", CANDLES_PER_WEEK);
  const candles = closedOnly(raw);

  const closes = candles.map((c) => c.close);
  const closeTimes = candles.map((c) => c.closeTime);
  const from = new Date(candles[0].openTime).toISOString();
  const to = new Date(candles[candles.length - 1].closeTime).toISOString();

  console.log(`\nWindow: ${from}  ->  ${to}`);
  console.log(`Closed candles: ${candles.length}`);
  console.log(
    `Definition: EMA${EMA_PERIOD} on 5m closes, ROC over ${ROC_LOOKBACK} candles ` +
      `(${ROC_LOOKBACK * 5}m), threshold +/-${ROC_THRESHOLD_PERCENT.toFixed(1)}%\n`,
  );

  const declared = walk(closes, closeTimes, ROC_THRESHOLD_PERCENT);

  console.log("=== THE NUMBER (declared threshold, 1.0%) ===");
  console.log(`Evaluations:            ${declared.evaluated}`);
  console.log(
    `BEARISH:                ${declared.bearish}  (${pct(declared.bearish, declared.evaluated)})`,
  );
  console.log(
    `BULLISH:                ${declared.bullish}  (${pct(declared.bullish, declared.evaluated)})`,
  );
  console.log(
    `NEUTRAL:                ${declared.neutral}  (${pct(declared.neutral, declared.evaluated)})`,
  );
  console.log(`Distinct BEARISH runs:  ${declared.bearishEpisodes}`);
  console.log(
    `Longest BEARISH streak: ${declared.longestBearishStreak} candles ` +
      `(${declared.longestBearishStreak * 5} minutes)`,
  );
  if (declared.longestBearishStart) {
    console.log(`  starting:             ${new Date(declared.longestBearishStart).toISOString()}`);
  }

  console.log("\n=== Sensitivity (context only — do not tune before reporting) ===");
  console.log("threshold   bearish bars   share    distinct runs");
  for (const t of [0.4, 0.6, 0.8, 1.0, 1.25, 1.5]) {
    const r = walk(closes, closeTimes, t);
    const mark = t === ROC_THRESHOLD_PERCENT ? "  <- declared" : "";
    console.log(
      `  ${t.toFixed(2)}%      ${String(r.bearish).padStart(6)}       ` +
        `${pct(r.bearish, r.evaluated).padStart(7)}   ${String(r.bearishEpisodes).padStart(6)}${mark}`,
    );
  }
}

main().catch((err) => {
  console.error("threshold check failed:", err);
  process.exitCode = 1;
});
