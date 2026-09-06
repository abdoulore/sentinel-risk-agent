/**
 * Execution Adapter (Binance Agent OS / MCP).
 *
 *   Guardian / Validator
 *          ↓
 *   ExecutionAdapter      ← this file: domain operations + Guardian invariants
 *          ↓
 *   BinanceMcpClient      ← session + tool invocation + auth
 *          ↓
 *   connect() → Binance Agent OS MCP
 *
 * Authority stays above MCP. The Validator has already turned a percentage into
 * a final, exchange-floored quantity; `reducePosition` receives that quantity
 * and only *enforces* the safety invariants before handing it to the exchange.
 * The MCP layer never decides that "30%" means "0.002 ETH".
 *
 * Invariants asserted on every reduction:
 *   symbol      = the configured Guardian symbol
 *   side        = the side that reduces the current position (opposite of it)
 *   type        = MARKET
 *   reduceOnly  = true
 *   quantity    = the validator-approved quantity, unchanged
 *
 * Until `npm run mcp:connect` has been run, every method rejects with
 * McpAuthRequiredError (code MCP_AUTH_REQUIRED). No browser, no interactive
 * auth, no REST fallback — and the identical code path starts working once the
 * OAuth session exists.
 */
import type { AccountState, PositionState } from "@/lib/binance/account";
import type { OrderResult } from "@/lib/binance/orders";
import { parseSymbolFilters, type RawSymbol, type SymbolFilters } from "@/lib/binance/filters";
import { SYMBOL } from "@/lib/config";
import type { McpToolInvoker } from "@/lib/mcp/contract";
import { clientOrderIdFor } from "@/lib/mcp/journal";

/** Position === PositionState; aliased to match the adapter contract's naming. */
export type Position = PositionState;

export interface ReducePositionInput {
  symbol: string;
  /** SELL reduces a long, BUY reduces a short. Must oppose the live position. */
  side: "BUY" | "SELL";
  /** Validator-approved, already floored to stepSize. Sent to Binance verbatim. */
  quantity: string;
  /**
   * Identifies the logical action — this rule firing, this once. Required by the
   * host relay for write idempotency: two legitimate triggers may produce
   * byte-identical arguments and must both reach Binance, while the same trigger
   * replayed must not. Also derives the deterministic clientOrderId that makes
   * the crash-after-submit window reconcilable.
   */
  executionId?: string;
  clientOrderId?: string;
}

export interface ExecutionAdapter {
  /**
   * `step` names the call for the relay journal. It is what keeps a read
   * replay-safe: POSITION_BEFORE and POSITION_AFTER are the same tool with
   * identical arguments and must never share a journal entry, or post-fill
   * verification would keep re-reading the pre-fill position.
   */
  getPosition(symbol: string, step?: string): Promise<Position>;
  getAccountState(step?: string): Promise<AccountState>;
  getExchangeFilters(symbol: string, step?: string): Promise<SymbolFilters>;
  reducePosition(input: ReducePositionInput): Promise<OrderResult>;
  getOrder(symbol: string, orderId: string, step?: string): Promise<OrderResult>;
}

/* ----------------------------- raw MCP shapes ----------------------------- */

interface McpRawPosition {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  liquidationPrice: string;
  unRealizedProfit: string;
  notional: string;
  leverage: string;
  marginType: string;
  updateTime: number;
}

interface McpRawAsset {
  walletBalance?: string;
  marginBalance?: string;
  unrealizedProfit?: string;
  maintMargin?: string;
  availableBalance?: string;
}

interface McpRawAccount {
  totalWalletBalance?: string;
  totalMarginBalance?: string;
  totalUnrealizedProfit?: string;
  totalMaintMargin?: string;
  availableBalance?: string;
  assets?: McpRawAsset[];
}

interface McpRawOrder {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  status: string;
  origQty: string;
  executedQty: string;
  avgPrice?: string;
  cumQuote?: string;
  reduceOnly: boolean;
  updateTime: number;
}

/* ------------------------------- mappers ---------------------------------- */

function mapPosition(rows: McpRawPosition[], symbol: string): PositionState {
  const raw = rows.find((p) => p.symbol === symbol);

  if (!raw || Number(raw.positionAmt) === 0) {
    return {
      symbol,
      positionAmt: 0,
      side: "FLAT",
      entryPrice: 0,
      markPrice: Number(raw?.markPrice ?? 0),
      liquidationPrice: null,
      notional: 0,
      unrealizedPnl: 0,
      unrealizedPnlPercent: null,
      liquidationDistancePercent: null,
      leverage: raw ? Number(raw.leverage) || null : null,
      marginType: raw?.marginType ?? null,
      positionInitialMargin: 0,
      maintMargin: 0,
      updateTime: raw?.updateTime ?? Date.now(),
    };
  }

  const positionAmt = Number(raw.positionAmt);
  const markPrice = Number(raw.markPrice);
  const liquidationPrice = Number(raw.liquidationPrice);
  const leverage = Number(raw.leverage) || null;
  const notional = Math.abs(Number(raw.notional));
  // positionInformationV2 omits initial margin; derive it from notional/leverage
  // so unrealizedPnlPercent is still meaningful. maintMargin is not exposed here.
  const initialMargin = leverage && leverage > 0 ? notional / leverage : 0;
  const unrealizedPnl = Number(raw.unRealizedProfit);
  const hasLiquidation = liquidationPrice > 0 && markPrice > 0;

  return {
    symbol,
    positionAmt,
    side: positionAmt > 0 ? "LONG" : "SHORT",
    entryPrice: Number(raw.entryPrice),
    markPrice,
    liquidationPrice: hasLiquidation ? liquidationPrice : null,
    notional,
    unrealizedPnl,
    unrealizedPnlPercent: initialMargin > 0 ? (unrealizedPnl / initialMargin) * 100 : null,
    liquidationDistancePercent: hasLiquidation
      ? (Math.abs(markPrice - liquidationPrice) / markPrice) * 100
      : null,
    leverage,
    marginType: raw.marginType ?? null,
    positionInitialMargin: initialMargin,
    maintMargin: 0,
    updateTime: raw.updateTime,
  };
}

function mapAccount(raw: McpRawAccount): AccountState {
  const assets = raw.assets ?? [];
  const assetSum = (field: keyof McpRawAsset) =>
    assets.reduce((acc, a) => acc + Number(a[field] ?? 0), 0);

  // Single-asset USDC accounts report 0 in the USDT-denominated top-level totals
  // while the collateral sits in the USDC asset entry. Prefer a non-zero
  // top-level figure; otherwise fall back to summing the asset entries.
  const pick = (top: string | undefined, field: keyof McpRawAsset) => {
    const t = Number(top ?? 0);
    return t !== 0 ? t : assetSum(field);
  };

  const totalMarginBalance = pick(raw.totalMarginBalance, "marginBalance");
  const totalMaintMargin = pick(raw.totalMaintMargin, "maintMargin");

  return {
    totalWalletBalance: pick(raw.totalWalletBalance, "walletBalance"),
    totalMarginBalance,
    totalUnrealizedProfit: pick(raw.totalUnrealizedProfit, "unrealizedProfit"),
    totalMaintMargin,
    availableBalance: pick(raw.availableBalance, "availableBalance"),
    marginRatio: totalMarginBalance > 0 ? totalMaintMargin / totalMarginBalance : null,
  };
}

function mapOrder(raw: McpRawOrder): OrderResult {
  return {
    orderId: raw.orderId,
    clientOrderId: raw.clientOrderId,
    symbol: raw.symbol,
    side: raw.side,
    status: raw.status,
    origQty: Number(raw.origQty),
    executedQty: Number(raw.executedQty),
    avgPrice: Number(raw.avgPrice ?? 0),
    cumQuote: Number(raw.cumQuote ?? 0),
    reduceOnly: raw.reduceOnly,
    updateTime: raw.updateTime,
  };
}

/* ------------------------------- adapter ---------------------------------- */

export class McpExecutionAdapter implements ExecutionAdapter {
  constructor(
    private readonly mcp: McpToolInvoker,
    /** The one symbol this adapter is allowed to act on. */
    private readonly symbol: string = SYMBOL,
  ) {}

  async getPosition(symbol: string, step = "POSITION"): Promise<Position> {
    const rows = await this.mcp.call<McpRawPosition[]>(
      "futures_usds_positionInformationV2",
      { symbol },
      { stepId: step },
    );
    return mapPosition(rows, symbol);
  }

  async getAccountState(step = "ACCOUNT"): Promise<AccountState> {
    const raw = await this.mcp.call<McpRawAccount>(
      "futures_usds_accountInformationV3",
      {},
      { stepId: step },
    );
    return mapAccount(raw);
  }

  async getExchangeFilters(symbol: string, step = "FILTERS"): Promise<SymbolFilters> {
    // The MCP exchangeInformation tool takes no symbol argument; Sentinel pulls
    // the full set and selects the symbol itself (strengthens the Agent OS story
    // and keeps a single filter parser shared with the REST path).
    const data = await this.mcp.call<{ symbols: RawSymbol[] }>(
      "futures_usds_exchangeInformation",
      {},
      { stepId: step },
    );
    return parseSymbolFilters(data.symbols, symbol);
  }

  async reducePosition(input: ReducePositionInput): Promise<OrderResult> {
    // ---- Invariants, before anything leaves for the exchange ----------------
    if (input.symbol !== this.symbol) {
      throw new ExecutionSafeguardError(
        "SYMBOL_MISMATCH",
        `${input.symbol} is not the Guardian symbol ${this.symbol}`,
      );
    }
    const qty = Number(input.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new ExecutionSafeguardError("INVALID_QUANTITY", `${input.quantity}`);
    }

    // side must reduce the live position, which also proves a position exists
    // and is at least as large as the requested quantity.
    const position = await this.getPosition(input.symbol, "POSITION_GUARD");
    if (position.side === "FLAT" || position.positionAmt === 0) {
      throw new ExecutionSafeguardError("NO_POSITION", "nothing to reduce");
    }
    const requiredSide = position.positionAmt > 0 ? "SELL" : "BUY";
    if (input.side !== requiredSide) {
      throw new ExecutionSafeguardError(
        "SIDE_MISMATCH",
        `expected ${requiredSide} to reduce ${position.side}, got ${input.side}`,
      );
    }
    if (qty > Math.abs(position.positionAmt) + 1e-12) {
      throw new ExecutionSafeguardError(
        "POSITION_INSUFFICIENT",
        `${input.quantity} > ${Math.abs(position.positionAmt)}`,
      );
    }

    // ---- Submit: MARKET, reduceOnly, exact validated quantity ---------------
    // The clientOrderId is derived from the executionId rather than random, so a
    // host crash between Binance accepting the order and the journal recording
    // it stays reconcilable: we can ask Binance for this exact id.
    const clientOrderId =
      input.clientOrderId ??
      (input.executionId ? clientOrderIdFor(input.executionId) : undefined);

    const raw = await this.mcp.call<McpRawOrder>(
      "futures_usds_newOrder",
      {
        symbol: input.symbol,
        side: input.side,
        type: "MARKET",
        quantity: input.quantity,
        reduceOnly: "true",
        newOrderRespType: "RESULT",
        ...(clientOrderId ? { newClientOrderId: clientOrderId } : {}),
      },
      { stepId: "ORDER_SUBMIT", write: true, executionId: input.executionId },
    );
    const order = mapOrder(raw);

    // ---- Post-conditions on the exchange's response -------------------------
    if (order.symbol !== input.symbol || order.side !== input.side) {
      throw new ExecutionSafeguardError(
        "RESPONSE_MISMATCH",
        `sent ${input.side} ${input.symbol}, got ${order.side} ${order.symbol}`,
      );
    }
    if (order.reduceOnly !== true) {
      throw new ExecutionSafeguardError("RESPONSE_NOT_REDUCE_ONLY", "order lost reduceOnly");
    }
    return order;
  }

  async getOrder(symbol: string, orderId: string, step = "ORDER_VERIFY"): Promise<OrderResult> {
    const raw = await this.mcp.call<McpRawOrder>(
      "futures_usds_queryOrder",
      { symbol, orderId: Number(orderId) },
      { stepId: step },
    );
    return mapOrder(raw);
  }
}

/** Guardian-invariant violation, distinct from an exchange/API error. */
export class ExecutionSafeguardError extends Error {
  constructor(
    readonly reason: string,
    detail: string,
  ) {
    super(`EXECUTION_SAFEGUARD ${reason}: ${detail}`);
    this.name = "ExecutionSafeguardError";
  }
}

/* --------------------------- verified reduction --------------------------- */

export interface ReductionOutcome {
  order: OrderResult;
  positionBefore: PositionState;
  positionAfter: PositionState;
  /** True when |position| actually shrank on the exchange. */
  quantityChanged: boolean;
  /** |before| − |after|, the realised reduction. */
  reducedBy: number;
  submittedAt: number;
  verifiedAt: number;
}

/**
 * The full proof path: submit → capture real orderId → refresh position through
 * MCP → verify the position actually shrank. Returns the structured outcome the
 * policy loop turns into fill/position feed events and a Guardian re-evaluation.
 * (Event emission and re-evaluation live above the adapter, deliberately.)
 */
export async function submitVerifiedReduction(
  adapter: ExecutionAdapter,
  input: ReducePositionInput,
): Promise<ReductionOutcome> {
  const positionBefore = await adapter.getPosition(input.symbol, "POSITION_BEFORE");
  const submittedAt = Date.now();
  const order = await adapter.reducePosition(input);
  // A distinct step, deliberately: same tool, same arguments, but this read must
  // be fresh or the shrink check below would confirm itself against stale state.
  const positionAfter = await adapter.getPosition(input.symbol, "POSITION_AFTER");
  const verifiedAt = Date.now();

  const reducedBy = Math.abs(positionBefore.positionAmt) - Math.abs(positionAfter.positionAmt);
  return {
    order,
    positionBefore,
    positionAfter,
    quantityChanged: reducedBy > 1e-12,
    reducedBy,
    submittedAt,
    verifiedAt,
  };
}
