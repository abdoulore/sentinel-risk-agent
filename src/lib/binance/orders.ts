import { signedRequest } from "@/lib/binance/client";

export interface OrderResult {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  status: string;
  origQty: number;
  executedQty: number;
  /** Volume-weighted fill price. Zero until the order fills. */
  avgPrice: number;
  cumQuote: number;
  reduceOnly: boolean;
  updateTime: number;
}

interface RawOrder {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  status: string;
  origQty: string;
  executedQty: string;
  avgPrice: string;
  cumQuote?: string;
  reduceOnly: boolean;
  updateTime: number;
}

function normalise(raw: RawOrder): OrderResult {
  return {
    orderId: raw.orderId,
    clientOrderId: raw.clientOrderId,
    symbol: raw.symbol,
    side: raw.side,
    status: raw.status,
    origQty: Number(raw.origQty),
    executedQty: Number(raw.executedQty),
    avgPrice: Number(raw.avgPrice),
    cumQuote: Number(raw.cumQuote ?? 0),
    reduceOnly: raw.reduceOnly,
    updateTime: raw.updateTime,
  };
}

/**
 * Submits a reduce-only market order.
 *
 * `reduceOnly` is non-negotiable on every Guardian action: it makes the order
 * incapable of opening or flipping a position, and exempts it from the
 * minimum-notional filter (BUILD_PLAN §3, §7).
 */
export async function submitReduceOnlyMarketOrder(params: {
  symbol: string;
  /** SELL reduces a long, BUY reduces a short. */
  side: "BUY" | "SELL";
  /** Already floored to stepSize, as a fixed-precision string. */
  quantity: string;
  clientOrderId?: string;
}): Promise<OrderResult> {
  const raw = await signedRequest<RawOrder>("POST", "/fapi/v1/order", {
    symbol: params.symbol,
    side: params.side,
    type: "MARKET",
    quantity: params.quantity,
    reduceOnly: "true",
    newClientOrderId: params.clientOrderId,
    // RESULT waits for the matching engine, so the response carries the fill.
    newOrderRespType: "RESULT",
  });
  return normalise(raw);
}

/** Re-reads an order from the exchange to verify what actually filled. */
export async function fetchOrder(symbol: string, orderId: number): Promise<OrderResult> {
  const raw = await signedRequest<RawOrder>("GET", "/fapi/v1/order", { symbol, orderId });
  return normalise(raw);
}

/** The side that reduces the given position. */
export function reducingSide(positionAmt: number): "BUY" | "SELL" {
  return positionAmt > 0 ? "SELL" : "BUY";
}
