/**
 * Live metrics report — the complete, provenance-tagged view of one frozen
 * MetricSnapshot.
 *
 * Every number Sentinel can act on comes from one of exactly two places:
 *
 *   MCP             the Binance Agent OS session the host owns. Account-side
 *                   truth: position, entry, leverage, PnL, liquidation.
 *   BINANCE_PUBLIC  unauthenticated Binance market endpoints. Public
 *                   measurements the MCP toolset does not expose cleanly:
 *                   klines, funding rate, open interest, scalar mark price.
 *
 * Authenticated Binance REST is not a source here and never will be — it is not
 * an execution or account path for Sentinel.
 *
 * Provenance is derived structurally rather than recorded per-fetch, because
 * the mapping is fixed by construction: computeMetrics only ever reads
 * position/account from the injected ExecutionAdapter (MCP), and only ever
 * reads candles/funding/openInterest from the public client. If that ever
 * stops being true this module is the thing that must change with it.
 *
 * No LLM is involved anywhere in this file, or anywhere upstream of it.
 */
import type { MetricSnapshot } from "@/lib/metrics/engine";
import { EMA_PERIOD, MIN_CANDLES, ROC_LOOKBACK } from "@/lib/metrics/momentum";

export type MetricSource = "MCP" | "BINANCE_PUBLIC";

export interface Sourced<T> {
  value: T;
  source: MetricSource;
  /** True when Sentinel computed this from source data rather than reading it. */
  derived?: boolean;
  /**
   * True when an Agent Lab override replaced the measurement for this cycle.
   *
   * The report shows the value the Policy Engine actually evaluated, not the
   * untouched measurement. Showing the live reading here would put the panel
   * and the feed into open disagreement during a scenario — momentum NEUTRAL
   * beside a rule that matched on BEARISH — which reads as though the feed
   * invented the match. The live value stays available on the snapshot.
   */
  simulated?: boolean;
}

function tag<T>(value: T, source: MetricSource, derived: boolean, simulated: boolean): Sourced<T> {
  const out: Sourced<T> = { value, source };
  if (derived) out.derived = true;
  if (simulated) out.simulated = true;
  return out;
}

/**
 * How old the newest closed 5m candle may be before the series is considered
 * stale. Three missed candles: a normal gap is one interval, so this only trips
 * on a genuine feed problem.
 */
export const STALE_AFTER_MS = 15 * 60_000;

export interface LiveMetricsReport {
  symbol: string;
  /** When the snapshot was taken. */
  timestamp: number;

  /* --- market ---------------------------------------------------------- */
  /** Last CLOSED 5m close. This is the price momentum is evaluated against. */
  price: Sourced<number | null>;
  markPrice: Sourced<number | null>;
  fundingRate: Sourced<number | null>;
  openInterest: Sourced<number | null>;
  /** OI_CHANGE_30M as a percentage. See OI_CHANGE_WINDOW_MINUTES. */
  openInterestChange: Sourced<number | null>;

  /* --- position (account-side truth) ----------------------------------- */
  positionQty: Sourced<number>;
  entryPrice: Sourced<number | null>;
  leverage: Sourced<number | null>;
  unrealizedPnl: Sourced<number | null>;
  unrealizedPnlPercent: Sourced<number | null>;
  liquidationPrice: Sourced<number | null>;
  liquidationDistancePercent: Sourced<number | null>;

  /* --- momentum (frozen definition) ------------------------------------ */
  ema20_5m: Sourced<number | null>;
  roc30m: Sourced<number | null>;
  momentum: Sourced<"BULLISH" | "BEARISH" | "NEUTRAL" | null>;

  /* --- health ----------------------------------------------------------- */
  health: {
    candlesLoaded: number;
    candlesRequired: number;
    /** False until enough closed candles exist to evaluate momentum honestly. */
    warmedUp: boolean;
    /** Newest closed candle is older than STALE_AFTER_MS. */
    stale: boolean;
    newestCandleCloseTime: number | null;
    /** Fields that could not be measured at all. */
    unavailable: string[];
  };
}

/** The one OI window Sentinel measures. Fixed, not a label. */
export const OI_CHANGE_WINDOW_MINUTES = 30;

export function buildReport(snapshot: MetricSnapshot, now = Date.now()): LiveMetricsReport {
  const { position, funding, openInterest, momentum, candles } = snapshot.sources;

  // `effective` is live measurements with Agent Lab overrides applied — exactly
  // what evaluateGuardian compared against.
  const eff = snapshot.effective;
  const overridden = (k: keyof typeof eff) => k in snapshot.overrides;
  const numeric = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  const mcp = <T,>(value: T, derived = false, key?: keyof typeof eff): Sourced<T> =>
    tag(value, "MCP", derived, key ? overridden(key) : false);
  const pub = <T,>(value: T, derived = false, key?: keyof typeof eff): Sourced<T> =>
    tag(value, "BINANCE_PUBLIC", derived, key ? overridden(key) : false);

  const newestCandleCloseTime = candles.length ? candles[candles.length - 1].closeTime : null;
  const stale = newestCandleCloseTime === null || now - newestCandleCloseTime > STALE_AFTER_MS;
  const warmedUp = candles.length >= MIN_CANDLES;

  const unavailable: string[] = [];
  if (eff.momentum === null || eff.momentum === undefined) unavailable.push("momentum");
  if (numeric(eff.oi_change_percent) === null) unavailable.push("openInterestChange");
  if (position.liquidationPrice === null) unavailable.push("liquidationPrice");
  if (numeric(eff.unrealized_pnl_percent) === null) unavailable.push("unrealizedPnlPercent");

  return {
    symbol: snapshot.symbol,
    timestamp: snapshot.at,

    price: pub(momentum?.latestClose ?? null),
    markPrice: pub(Number.isFinite(funding.markPrice) ? funding.markPrice : null),
    fundingRate: pub(numeric(eff.funding_rate), false, "funding_rate"),
    openInterest: pub(numeric(eff.open_interest), false, "open_interest"),
    openInterestChange: pub(numeric(eff.oi_change_percent), true, "oi_change_percent"),

    positionQty: mcp(position.positionAmt),
    entryPrice: mcp(position.entryPrice || null),
    leverage: mcp(numeric(eff.leverage), false, "leverage"),
    unrealizedPnl: mcp(numeric(eff.unrealized_pnl), false, "unrealized_pnl"),
    unrealizedPnlPercent: mcp(numeric(eff.unrealized_pnl_percent), true, "unrealized_pnl_percent"),
    liquidationPrice: mcp(position.liquidationPrice),
    liquidationDistancePercent: mcp(numeric(eff.liquidation_distance_percent), true, "liquidation_distance_percent"),

    ema20_5m: pub(momentum?.ema20 ?? null, true),
    roc30m: pub(momentum?.rocPercent ?? null, true),
    momentum: pub(
      (eff.momentum as LiveMetricsReport["momentum"]["value"]) ?? null,
      true,
      "momentum",
    ),

    health: {
      candlesLoaded: candles.length,
      candlesRequired: MIN_CANDLES,
      warmedUp,
      stale,
      newestCandleCloseTime,
      unavailable,
    },
  };
}

/* -------------------------------- rendering -------------------------------- */

function num(v: number | null, digits = 2): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function pct(v: number | null, digits = 2): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

export function renderReport(r: LiveMetricsReport): string {
  const side = r.positionQty.value > 0 ? "LONG" : r.positionQty.value < 0 ? "SHORT" : "FLAT";
  const L: string[] = [];

  L.push(`${r.symbol} LIVE METRICS`);
  L.push("");
  L.push(`Price                  ${num(r.price.value)}`);
  L.push(`Mark Price             ${num(r.markPrice.value)}`);
  L.push(
    `Funding                ${
      r.fundingRate.value === null ? "—" : `${(r.fundingRate.value * 100).toFixed(4)}%`
    }`,
  );
  L.push(`Open Interest          ${num(r.openInterest.value, 3)}`);
  L.push(`OI Change ${OI_CHANGE_WINDOW_MINUTES}m           ${pct(r.openInterestChange.value)}`);
  L.push(`EMA${EMA_PERIOD} (5m)            ${num(r.ema20_5m.value)}`);
  L.push(`ROC${ROC_LOOKBACK * 5}m                 ${pct(r.roc30m.value)}`);
  L.push(`Momentum               ${r.momentum.value ?? "—"}`);
  L.push("");
  L.push(
    `Position               ${Math.abs(r.positionQty.value)} ETH ${side}`,
  );
  L.push(`Entry                  ${num(r.entryPrice.value)}`);
  L.push(`Leverage               ${r.leverage.value === null ? "—" : `${r.leverage.value}x`}`);
  L.push(`Unrealized PnL         ${num(r.unrealizedPnl.value)}  (${pct(r.unrealizedPnlPercent.value)})`);
  L.push(`Liquidation            ${num(r.liquidationPrice.value)}`);
  L.push(`Liq Distance           ${pct(r.liquidationDistancePercent.value)}`);

  if (!r.health.warmedUp || r.health.stale || r.health.unavailable.length) {
    L.push("");
    if (!r.health.warmedUp) {
      L.push(`! not warmed up: ${r.health.candlesLoaded}/${r.health.candlesRequired} closed candles`);
    }
    if (r.health.stale) L.push("! market data is stale");
    if (r.health.unavailable.length) L.push(`! unavailable: ${r.health.unavailable.join(", ")}`);
  }
  return L.join("\n");
}

/** Field -> source, for inspection. The provenance the runtime must expose. */
export function provenanceOf(r: LiveMetricsReport): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(r)) {
    if (val && typeof val === "object" && "source" in val) {
      const s = val as Sourced<unknown>;
      const notes = [s.derived ? "derived" : null, s.simulated ? "SIMULATED" : null].filter(Boolean);
      out[key] = notes.length ? `${s.source} (${notes.join(", ")})` : s.source;
    }
  }
  return out;
}
