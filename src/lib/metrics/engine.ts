import {
  closedOnly,
  fetchFunding,
  fetchKlineHistory,
  fetchOpenInterest,
  type Candle,
  type FundingState,
  type OpenInterestState,
} from "@/lib/binance/market";
import { BACKFILL_CANDLES, computeMomentum, type MomentumReading } from "@/lib/metrics/momentum";
import type { AccountState, PositionState } from "@/lib/binance/account";
import type { MetricName } from "@/lib/policy/types";

/**
 * The Metric Engine owns measurements. All of it is pure code — no LLM is
 * involved in producing a number here (BUILD_PLAN section 4).
 */

/** Every metric, keyed by the name a compiled policy may reference. */
export type MetricValues = {
  [K in MetricName]: number | string | null;
};

export interface MetricSources {
  candles: Candle[];
  momentum: MomentumReading | null;
  funding: FundingState;
  openInterest: OpenInterestState;
  position: PositionState;
  account: AccountState;
}

export interface MetricSnapshot {
  at: number;
  symbol: string;
  /** Measured from the exchange. Never overridden. */
  live: MetricValues;
  /** What the policy engine actually evaluates: live, with overrides applied. */
  effective: MetricValues;
  /** Agent Lab overrides currently in force. Empty during normal operation. */
  overrides: Partial<MetricValues>;
  sources: MetricSources;
}

function toValues(sources: MetricSources): MetricValues {
  const { momentum, funding, openInterest, position, account } = sources;

  return {
    momentum: momentum?.state ?? null,
    funding_rate: funding.lastFundingRate,
    funding_direction: funding.direction,
    open_interest: openInterest.openInterest,
    oi_change_percent: openInterest.changePercent,
    unrealized_pnl: position.unrealizedPnl,
    unrealized_pnl_percent: position.unrealizedPnlPercent,
    liquidation_distance_percent: position.liquidationDistancePercent,
    position_size: Math.abs(position.positionAmt),
    leverage: position.leverage,
    margin_ratio: account.marginRatio,
  };
}

/**
 * Builds the metric snapshot. `position` comes from the execution account, so
 * the metrics validation runs against and the account the order lands on are
 * the same by construction.
 */
export async function computeMetrics(params: {
  symbol: string;
  position: PositionState;
  account: AccountState;
  overrides?: Partial<MetricValues>;
  /** Reuse an existing candle series instead of re-fetching every cycle. */
  candles?: Candle[];
}): Promise<MetricSnapshot> {
  const { symbol, position, account, overrides = {} } = params;

  const [candles, funding, openInterest] = await Promise.all([
    params.candles ?? fetchKlineHistory(symbol, "5m", BACKFILL_CANDLES),
    fetchFunding(symbol),
    fetchOpenInterest(symbol),
  ]);

  const closed = closedOnly(candles);
  const sources: MetricSources = {
    candles: closed,
    momentum: computeMomentum(closed),
    funding,
    openInterest,
    position,
    account,
  };

  const live = toValues(sources);

  return {
    at: Date.now(),
    symbol,
    live,
    effective: { ...live, ...overrides },
    overrides,
    sources,
  };
}

/**
 * Re-applies a different override set to an existing snapshot without hitting
 * the network. Agent Lab uses this: the overrides change, the measurements do
 * not.
 */
export function withOverrides(
  snapshot: MetricSnapshot,
  overrides: Partial<MetricValues>,
): MetricSnapshot {
  return {
    ...snapshot,
    overrides,
    effective: { ...snapshot.live, ...overrides },
  };
}
