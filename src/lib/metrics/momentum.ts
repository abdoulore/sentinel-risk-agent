import type { Candle } from "@/lib/binance/market";

/**
 * Momentum — frozen definition (BUILD_PLAN §4).
 *
 *   Timeframe:    5m candles
 *   EMA:          EMA20 over 5m closes
 *   ROC lookback: 6 candles = 30 minutes
 *
 *   BEARISH: price < EMA20(5m) AND ROC30m < -1.0%
 *   BULLISH: price > EMA20(5m) AND ROC30m > +1.0%
 *   NEUTRAL: otherwise
 *
 * The +/-1.0% threshold is a declared Guardian metric. It is not calibrated or
 * optimised, and must never be described as either.
 */

export const EMA_PERIOD = 20;
export const ROC_LOOKBACK = 6;
export const ROC_THRESHOLD_PERCENT = 1.0;

/** Candles needed before momentum can be computed at all. */
export const MIN_CANDLES = EMA_PERIOD + ROC_LOOKBACK;

/** Backfilled at startup so EMA20 is not sitting on its minimum sample. */
export const BACKFILL_CANDLES = 50;

export type Momentum = "BEARISH" | "BULLISH" | "NEUTRAL";

export interface MomentumReading {
  state: Momentum;
  latestClose: number;
  ema20: number;
  rocPercent: number;
  closeLookbackAgo: number;
  /** The candle this reading was computed from. */
  candleCloseTime: number;
  samples: number;
}

/**
 * EMA seeded with the SMA of the first `period` values, then smoothed with
 * 2/(period+1). Returns the full series so callers can inspect any point.
 */
export function ema(values: number[], period: number): number[] {
  if (values.length < period) return [];

  const multiplier = 2 / (period + 1);
  const out: number[] = [];
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];

  let current = seed / period;
  out.push(current);

  for (let i = period; i < values.length; i++) {
    current = (values[i] - current) * multiplier + current;
    out.push(current);
  }
  return out;
}

/** Rate of change between the last close and the close `lookback` candles ago. */
export function rateOfChangePercent(closes: number[], lookback: number): number {
  const latest = closes[closes.length - 1];
  const past = closes[closes.length - 1 - lookback];
  if (past === 0) return 0;
  return ((latest - past) / past) * 100;
}

export function classifyMomentum(latestClose: number, ema20: number, rocPercent: number): Momentum {
  if (latestClose < ema20 && rocPercent < -ROC_THRESHOLD_PERCENT) return "BEARISH";
  if (latestClose > ema20 && rocPercent > ROC_THRESHOLD_PERCENT) return "BULLISH";
  return "NEUTRAL";
}

/**
 * Computes momentum from a series of closed 5m candles, oldest first.
 * Returns null when there is not enough history to evaluate honestly.
 */
export function computeMomentum(candles: Candle[]): MomentumReading | null {
  if (candles.length < MIN_CANDLES) return null;

  const closes = candles.map((c) => c.close);
  const emaSeries = ema(closes, EMA_PERIOD);
  if (emaSeries.length === 0) return null;

  const latestClose = closes[closes.length - 1];
  const ema20 = emaSeries[emaSeries.length - 1];
  const rocPercent = rateOfChangePercent(closes, ROC_LOOKBACK);

  return {
    state: classifyMomentum(latestClose, ema20, rocPercent),
    latestClose,
    ema20,
    rocPercent,
    closeLookbackAgo: closes[closes.length - 1 - ROC_LOOKBACK],
    candleCloseTime: candles[candles.length - 1].closeTime,
    samples: candles.length,
  };
}
