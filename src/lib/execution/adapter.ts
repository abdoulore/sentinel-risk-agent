import { fetchSymbolFilters, type SymbolFilters } from "@/lib/binance/filters";
import {
  fetchAccountState,
  fetchPositionState,
  isHedgeMode,
  type AccountState,
  type PositionState,
} from "@/lib/binance/account";
import {
  fetchOrder,
  reducingSide,
  submitReduceOnlyMarketOrder,
  type OrderResult,
} from "@/lib/binance/orders";
import { computeReductionQuantity, type QuantityBreakdown } from "@/lib/execution/quantity";

/**
 * The Execution Adapter owns every interaction with Binance: orders, fills and
 * position state. Nothing above it constructs a request or interprets a
 * Binance response.
 */

/** Filters change rarely; re-fetch on this interval rather than every action. */
const FILTER_TTL_MS = 15 * 60_000;

let cachedFilters: SymbolFilters | null = null;

export async function getSymbolFilters(symbol: string, force = false): Promise<SymbolFilters> {
  const stale = !cachedFilters || Date.now() - cachedFilters.fetchedAt > FILTER_TTL_MS;
  if (force || stale || cachedFilters?.symbol !== symbol) {
    cachedFilters = await fetchSymbolFilters(symbol);
  }
  return cachedFilters;
}

export interface ExecutionSnapshot {
  filters: SymbolFilters;
  position: PositionState;
  account: AccountState;
  hedgeMode: boolean;
  at: number;
}

/** One consistent read of everything validation needs, from one account. */
export async function readSnapshot(symbol: string): Promise<ExecutionSnapshot> {
  const [filters, position, account, hedgeMode] = await Promise.all([
    getSymbolFilters(symbol),
    fetchPositionState(symbol),
    fetchAccountState(),
    isHedgeMode(),
  ]);
  return { filters, position, account, hedgeMode, at: Date.now() };
}

export interface ReductionPlan {
  symbol: string;
  side: "BUY" | "SELL";
  quantity: QuantityBreakdown;
  /** Estimated notional of the reduction at the current mark price. */
  estimatedNotional: number;
  positionBefore: number;
}

/**
 * Turns a percentage into a concrete, exchange-legal order. Does not decide
 * whether the reduction is *permitted* — that is the Validator's job.
 */
export function planReduction(
  snapshot: ExecutionSnapshot,
  percent: number,
): ReductionPlan {
  const { position, filters } = snapshot;
  // Market orders obey MARKET_LOT_SIZE, which can be stricter than LOT_SIZE.
  const quantity = computeReductionQuantity(
    position.positionAmt,
    percent,
    filters.marketStepSize,
  );

  return {
    symbol: position.symbol,
    side: reducingSide(position.positionAmt),
    quantity,
    estimatedNotional: Number(quantity.steppedQty) * position.markPrice,
    positionBefore: position.positionAmt,
  };
}

export interface ExecutionOutcome {
  order: OrderResult;
  /** Re-read from the exchange after the fill, not inferred from the request. */
  verified: OrderResult;
  positionAfter: PositionState;
  submittedAt: number;
  filledAt: number;
}

/**
 * Submits a planned reduction and verifies it against the exchange.
 *
 * Position state is re-read from REST afterwards so the caller re-evaluates
 * against reality rather than an assumption about what the order did.
 */
export async function executeReduction(plan: ReductionPlan): Promise<ExecutionOutcome> {
  const submittedAt = Date.now();
  const order = await submitReduceOnlyMarketOrder({
    symbol: plan.symbol,
    side: plan.side,
    quantity: plan.quantity.steppedQty,
  });

  const [verified, positionAfter] = await Promise.all([
    fetchOrder(plan.symbol, order.orderId),
    fetchPositionState(plan.symbol),
  ]);

  return { order, verified, positionAfter, submittedAt, filledAt: Date.now() };
}
