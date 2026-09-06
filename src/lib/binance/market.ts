import { publicGet } from "@/lib/binance/client";

/** Public market data. Unauthenticated — no account state passes through here. */

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

type RawKline = [
  number, string, string, string, string, string, number,
  string, number, string, string, string,
];

/** Binance caps a single klines request at 1500 candles. */
export const KLINE_PAGE_LIMIT = 1500;

export async function fetchKlines(params: {
  symbol: string;
  interval: string;
  limit?: number;
  startTime?: number;
  endTime?: number;
}): Promise<Candle[]> {
  const raw = await publicGet<RawKline[]>("/fapi/v1/klines", {
    symbol: params.symbol,
    interval: params.interval,
    limit: params.limit,
    startTime: params.startTime,
    endTime: params.endTime,
  });

  return raw.map((k) => ({
    openTime: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: k[6],
  }));
}

/**
 * The last candle Binance returns is still forming. Metrics run on closed
 * candles only, so live evaluation and historical backtests agree exactly.
 */
export function closedOnly(candles: Candle[], now = Date.now()): Candle[] {
  return candles.filter((c) => c.closeTime < now);
}

/** Pages backwards until `count` closed candles have been collected. */
export async function fetchKlineHistory(
  symbol: string,
  interval: string,
  count: number,
): Promise<Candle[]> {
  const collected: Candle[] = [];
  let endTime: number | undefined;

  while (collected.length < count) {
    const remaining = Math.min(count - collected.length, KLINE_PAGE_LIMIT);
    const page = await fetchKlines({ symbol, interval, limit: remaining, endTime });
    if (page.length === 0) break;
    collected.unshift(...page);
    endTime = page[0].openTime - 1;
    if (page.length < remaining) break;
  }
  return collected;
}

export interface FundingState {
  symbol: string;
  /** Current funding rate as a decimal: 0.0003 is 0.03%. */
  lastFundingRate: number;
  markPrice: number;
  indexPrice: number;
  nextFundingTime: number;
  /** The last 3 settled rates, oldest first. */
  recentRates: number[];
  direction: "RISING" | "FALLING" | "FLAT";
}

interface RawPremiumIndex {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
}

export async function fetchFunding(symbol: string): Promise<FundingState> {
  const [premium, history] = await Promise.all([
    publicGet<RawPremiumIndex>("/fapi/v1/premiumIndex", { symbol }),
    publicGet<{ fundingRate: string }[]>("/fapi/v1/fundingRate", { symbol, limit: 3 }),
  ]);

  const recentRates = history.map((h) => Number(h.fundingRate));
  const first = recentRates[0];
  const last = recentRates[recentRates.length - 1];

  let direction: FundingState["direction"] = "FLAT";
  if (recentRates.length >= 2 && last > first) direction = "RISING";
  else if (recentRates.length >= 2 && last < first) direction = "FALLING";

  return {
    symbol,
    lastFundingRate: Number(premium.lastFundingRate),
    markPrice: Number(premium.markPrice),
    indexPrice: Number(premium.indexPrice),
    nextFundingTime: premium.nextFundingTime,
    recentRates,
    direction,
  };
}

export interface OpenInterestState {
  symbol: string;
  openInterest: number;
  openInterestValue: number | null;
  /** Percentage change over the comparison window. */
  changePercent: number | null;
  windowMinutes: number;
}

/** Compares current OI against its value `periods` x 5m ago. */
export async function fetchOpenInterest(
  symbol: string,
  periods = 6,
): Promise<OpenInterestState> {
  const [current, history] = await Promise.all([
    publicGet<{ openInterest: string }>("/fapi/v1/openInterest", { symbol }),
    publicGet<{ sumOpenInterest: string; sumOpenInterestValue: string }[]>(
      "/futures/data/openInterestHist",
      { symbol, period: "5m", limit: periods + 1 },
    ).catch(() => []),
  ]);

  const openInterest = Number(current.openInterest);
  const oldest = history.length > 0 ? Number(history[0].sumOpenInterest) : null;
  const latestValue =
    history.length > 0 ? Number(history[history.length - 1].sumOpenInterestValue) : null;

  return {
    symbol,
    openInterest,
    openInterestValue: latestValue,
    changePercent: oldest && oldest > 0 ? ((openInterest - oldest) / oldest) * 100 : null,
    windowMinutes: periods * 5,
  };
}
