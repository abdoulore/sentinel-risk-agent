import { publicGet } from "@/lib/binance/client";

/**
 * The exchange constraints Sentinel must respect before submitting anything.
 * Never hardcode these — they are fetched from the exchange (BUILD_PLAN §7).
 */
export interface SymbolFilters {
  symbol: string;
  /** LOT_SIZE step for limit orders. */
  stepSize: string;
  minQty: string;
  maxQty: string;
  /** MARKET_LOT_SIZE caps market orders lower than LOT_SIZE does. */
  marketStepSize: string;
  marketMinQty: string;
  marketMaxQty: string;
  minNotional: string;
  tickSize: string;
  quantityPrecision: number;
  pricePrecision: number;
  fetchedAt: number;
}

interface RawFilter {
  filterType: string;
  stepSize?: string;
  minQty?: string;
  maxQty?: string;
  tickSize?: string;
  notional?: string;
}

export interface RawSymbol {
  symbol: string;
  status: string;
  contractType: string;
  quantityPrecision: number;
  pricePrecision: number;
  filters: RawFilter[];
}

export async function fetchSymbolFilters(symbol: string): Promise<SymbolFilters> {
  const data = await publicGet<{ symbols: RawSymbol[] }>("/fapi/v1/exchangeInfo", { symbol });
  return parseSymbolFilters(data.symbols, symbol);
}

/**
 * Pure filter extraction, shared by the REST path (fetchSymbolFilters) and the
 * MCP path (which pulls the full exchangeInformation and selects the symbol
 * itself, since the MCP tool takes no symbol argument). Kept identical so both
 * transports yield exactly the same SymbolFilters.
 */
export function parseSymbolFilters(symbols: RawSymbol[], symbol: string): SymbolFilters {
  const entry = symbols.find((s) => s.symbol === symbol);

  if (!entry) throw new Error(`${symbol} not present in exchangeInfo`);
  if (entry.status !== "TRADING") {
    throw new Error(`${symbol} is not trading (status: ${entry.status})`);
  }

  const byType = (type: string) => entry.filters.find((f) => f.filterType === type);
  const lot = byType("LOT_SIZE");
  const marketLot = byType("MARKET_LOT_SIZE");
  const notional = byType("MIN_NOTIONAL");
  const price = byType("PRICE_FILTER");

  if (!lot?.stepSize || !lot.minQty || !lot.maxQty) {
    throw new Error(`${symbol} exchangeInfo is missing a usable LOT_SIZE filter`);
  }

  return {
    symbol: entry.symbol,
    stepSize: lot.stepSize,
    minQty: lot.minQty,
    maxQty: lot.maxQty,
    marketStepSize: marketLot?.stepSize ?? lot.stepSize,
    marketMinQty: marketLot?.minQty ?? lot.minQty,
    marketMaxQty: marketLot?.maxQty ?? lot.maxQty,
    minNotional: notional?.notional ?? "0",
    tickSize: price?.tickSize ?? "0.01",
    quantityPrecision: entry.quantityPrecision,
    pricePrecision: entry.pricePrecision,
    fetchedAt: Date.now(),
  };
}
