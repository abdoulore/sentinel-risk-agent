import { signedRequest } from "@/lib/binance/client";

/**
 * Live state of the one position Sentinel guards, read from the execution
 * account. Validation and execution share these credentials by construction —
 * never validate against one account and execute on another (BUILD_PLAN §2).
 */
export interface PositionState {
  symbol: string;
  /** Signed: positive is long, negative is short. */
  positionAmt: number;
  side: "LONG" | "SHORT" | "FLAT";
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number | null;
  /** Absolute USD notional of the position. */
  notional: number;
  unrealizedPnl: number;
  /** PnL as a percentage of the margin committed to this position. */
  unrealizedPnlPercent: number | null;
  /** Percentage move in mark price that would reach liquidation. */
  liquidationDistancePercent: number | null;
  leverage: number | null;
  marginType: string | null;
  positionInitialMargin: number;
  maintMargin: number;
  updateTime: number;
}

export interface AccountState {
  totalWalletBalance: number;
  totalMarginBalance: number;
  totalUnrealizedProfit: number;
  totalMaintMargin: number;
  availableBalance: number;
  /** Maintenance margin / margin balance. Approaches 1.0 at liquidation. */
  marginRatio: number | null;
}

interface RawPosition {
  symbol: string;
  positionSide: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  liquidationPrice: string;
  unRealizedProfit: string;
  notional: string;
  positionInitialMargin: string;
  maintMargin: string;
  updateTime: number;
}

interface RawSymbolConfig {
  symbol: string;
  marginType: string;
  leverage: number;
}

interface RawAccount {
  totalWalletBalance: string;
  totalMarginBalance: string;
  totalUnrealizedProfit: string;
  totalMaintMargin: string;
  availableBalance: string;
}

export async function fetchAccountState(): Promise<AccountState> {
  const raw = await signedRequest<RawAccount>("GET", "/fapi/v3/account");
  const marginBalance = Number(raw.totalMarginBalance);

  return {
    totalWalletBalance: Number(raw.totalWalletBalance),
    totalMarginBalance: marginBalance,
    totalUnrealizedProfit: Number(raw.totalUnrealizedProfit),
    totalMaintMargin: Number(raw.totalMaintMargin),
    availableBalance: Number(raw.availableBalance),
    marginRatio: marginBalance > 0 ? Number(raw.totalMaintMargin) / marginBalance : null,
  };
}

/** True when the account is in hedge mode, where reduceOnly is not accepted. */
export async function isHedgeMode(): Promise<boolean> {
  const raw = await signedRequest<{ dualSidePosition: boolean }>(
    "GET",
    "/fapi/v1/positionSide/dual",
  );
  return raw.dualSidePosition;
}

export async function fetchPositionState(symbol: string): Promise<PositionState> {
  // v3 positionRisk no longer carries leverage or marginType; symbolConfig does.
  const [positions, configs] = await Promise.all([
    signedRequest<RawPosition[]>("GET", "/fapi/v3/positionRisk", { symbol }),
    signedRequest<RawSymbolConfig[]>("GET", "/fapi/v1/symbolConfig", { symbol }).catch(() => []),
  ]);

  const config = configs.find((c) => c.symbol === symbol) ?? null;
  // A symbol with no open position may be absent, or present with amt 0.
  const raw = positions.find((p) => p.symbol === symbol && Number(p.positionAmt) !== 0);

  if (!raw) {
    return {
      symbol,
      positionAmt: 0,
      side: "FLAT",
      entryPrice: 0,
      markPrice: Number(positions[0]?.markPrice ?? 0),
      liquidationPrice: null,
      notional: 0,
      unrealizedPnl: 0,
      unrealizedPnlPercent: null,
      liquidationDistancePercent: null,
      leverage: config?.leverage ?? null,
      marginType: config?.marginType ?? null,
      positionInitialMargin: 0,
      maintMargin: 0,
      updateTime: Date.now(),
    };
  }

  const positionAmt = Number(raw.positionAmt);
  const markPrice = Number(raw.markPrice);
  const liquidationPrice = Number(raw.liquidationPrice);
  const initialMargin = Number(raw.positionInitialMargin);
  const unrealizedPnl = Number(raw.unRealizedProfit);

  // liquidationPrice is "0" when the position is far enough from liquidation
  // that Binance does not quote one.
  const hasLiquidation = liquidationPrice > 0 && markPrice > 0;

  return {
    symbol,
    positionAmt,
    side: positionAmt > 0 ? "LONG" : "SHORT",
    entryPrice: Number(raw.entryPrice),
    markPrice,
    liquidationPrice: hasLiquidation ? liquidationPrice : null,
    notional: Math.abs(Number(raw.notional)),
    unrealizedPnl,
    unrealizedPnlPercent: initialMargin > 0 ? (unrealizedPnl / initialMargin) * 100 : null,
    liquidationDistancePercent: hasLiquidation
      ? (Math.abs(markPrice - liquidationPrice) / markPrice) * 100
      : null,
    leverage: config?.leverage ?? null,
    marginType: config?.marginType ?? null,
    positionInitialMargin: initialMargin,
    maintMargin: Number(raw.maintMargin),
    updateTime: raw.updateTime,
  };
}
