/**
 * Execution Adapter checks — run entirely against a mocked MCP invoker, so this
 * exercises the full adapter (mapping, Guardian invariants, verified reduction,
 * MCP_AUTH_REQUIRED) without any network, credentials, or touching the live
 * ETHUSDC fixture.
 *
 *   npm run check:adapter
 */
import {
  McpExecutionAdapter,
  ExecutionSafeguardError,
  submitVerifiedReduction,
  type ReducePositionInput,
} from "@/lib/execution/execution-adapter";
import { McpAuthRequiredError, type McpToolInvoker } from "@/lib/mcp/contract";

let failed = false;
function pass(name: string, detail = "") {
  console.log(`  [ok]   ${name}${detail ? ` - ${detail}` : ""}`);
}
function fail(name: string, detail = "") {
  failed = true;
  console.log(`  [FAIL] ${name}${detail ? ` - ${detail}` : ""}`);
}
function check(name: string, cond: boolean, detail = "") {
  if (cond) pass(name, detail);
  else fail(name, detail);
}
async function expectThrow(
  name: string,
  fn: () => Promise<unknown>,
  matcher: (e: unknown) => boolean,
) {
  try {
    await fn();
    fail(name, "expected a throw, got success");
  } catch (e) {
    if (matcher(e)) pass(name);
    else fail(name, `wrong error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/* ------------------------------ mock invoker ------------------------------ */

type Handler = (args: Record<string, unknown>) => unknown;

class MockInvoker implements McpToolInvoker {
  readonly calls: { tool: string; args: Record<string, unknown> }[] = [];
  constructor(private readonly handlers: Record<string, Handler>) {}
  async call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ tool, args });
    const h = this.handlers[tool];
    if (!h) throw new Error(`mock has no handler for ${tool}`);
    const r = h(args);
    if (r instanceof Error) throw r;
    return r as T;
  }
  async close(): Promise<void> {}
  lastCall(tool: string) {
    return [...this.calls].reverse().find((c) => c.tool === tool);
  }
}

const longPosition = (amt: string) => [
  {
    symbol: "ETHUSDC",
    positionAmt: amt,
    entryPrice: "2416.56",
    markPrice: "2416.41",
    liquidationPrice: "1824.82",
    unRealizedProfit: "-0.0015",
    notional: (Number(amt) * 2416.41).toFixed(8),
    leverage: "5",
    marginType: "cross",
    updateTime: 1,
  },
];

const filledOrder = {
  orderId: 82283985098,
  clientOrderId: "sentinel-1",
  symbol: "ETHUSDC",
  status: "FILLED",
  origQty: "0.001",
  executedQty: "0.001",
  avgPrice: "2416.00",
  cumQuote: "2.41600",
  reduceOnly: true,
  updateTime: 2,
  side: "SELL",
};

const exchangeInfo = {
  symbols: [
    { symbol: "BTCUSDT", status: "TRADING", contractType: "PERPETUAL", quantityPrecision: 3, pricePrecision: 2, filters: [] },
    {
      symbol: "ETHUSDC",
      status: "TRADING",
      contractType: "PERPETUAL",
      quantityPrecision: 3,
      pricePrecision: 2,
      filters: [
        { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "8000" },
        { filterType: "MARKET_LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "700" },
        { filterType: "MIN_NOTIONAL", notional: "20" },
        { filterType: "PRICE_FILTER", tickSize: "0.01" },
      ],
    },
  ],
};

const singleAssetUsdcAccount = {
  totalWalletBalance: "0.00000000",
  totalMarginBalance: "0.00000000",
  totalUnrealizedProfit: "0.00000000",
  totalMaintMargin: "0.00000000",
  availableBalance: "0.00000000",
  assets: [
    { walletBalance: "6", marginBalance: "6", unrealizedProfit: "0", maintMargin: "0", availableBalance: "6" },
    { walletBalance: "0", marginBalance: "0", unrealizedProfit: "0", maintMargin: "0", availableBalance: "0" },
  ],
};

function baseHandlers(positionAmt = "0.010"): Record<string, Handler> {
  return {
    futures_usds_positionInformationV2: () => longPosition(positionAmt),
    futures_usds_accountInformationV3: () => singleAssetUsdcAccount,
    futures_usds_exchangeInformation: () => exchangeInfo,
    futures_usds_newOrder: () => filledOrder,
    futures_usds_queryOrder: () => filledOrder,
  };
}

/* --------------------------------- tests ---------------------------------- */

async function main() {
  console.log("Execution Adapter checks (mocked MCP)\n");

  // 1. Reads + mapping ------------------------------------------------------
  console.log("1. Reads and mapping");
  {
    const adapter = new McpExecutionAdapter(new MockInvoker(baseHandlers()), "ETHUSDC");

    const pos = await adapter.getPosition("ETHUSDC");
    check("position side LONG", pos.side === "LONG", pos.side);
    check("positionAmt 0.010", pos.positionAmt === 0.01, String(pos.positionAmt));
    check("leverage 5", pos.leverage === 5, String(pos.leverage));
    check(
      "initial margin derived from notional/leverage",
      Math.abs(pos.positionInitialMargin - (0.01 * 2416.41) / 5) < 1e-6,
      pos.positionInitialMargin.toFixed(4),
    );

    const acct = await adapter.getAccountState();
    check("account availableBalance from USDC asset", acct.availableBalance === 6, String(acct.availableBalance));
    check("account walletBalance from USDC asset", acct.totalWalletBalance === 6, String(acct.totalWalletBalance));

    const filters = await adapter.getExchangeFilters("ETHUSDC");
    check("filters selected ETHUSDC from full set", filters.symbol === "ETHUSDC");
    check("stepSize 0.001", filters.stepSize === "0.001", filters.stepSize);
    check("minNotional 20", filters.minNotional === "20", filters.minNotional);
    check("market maxQty 700", filters.marketMaxQty === "700", filters.marketMaxQty);
  }

  // 2. reducePosition — happy path + invariants sent to MCP -----------------
  console.log("\n2. reducePosition sends exactly the validated order");
  {
    const mock = new MockInvoker(baseHandlers());
    const adapter = new McpExecutionAdapter(mock, "ETHUSDC");
    const input: ReducePositionInput = {
      symbol: "ETHUSDC",
      side: "SELL",
      quantity: "0.001",
      clientOrderId: "sentinel-1",
    };
    const order = await adapter.reducePosition(input);
    check("returns real orderId", order.orderId === 82283985098, String(order.orderId));

    const sent = mock.lastCall("futures_usds_newOrder");
    check("symbol forwarded verbatim", sent?.args.symbol === "ETHUSDC");
    check("side SELL (opposes long)", sent?.args.side === "SELL");
    check("type MARKET", sent?.args.type === "MARKET");
    check("reduceOnly true", sent?.args.reduceOnly === "true");
    check("quantity unchanged (0.001, not recomputed)", sent?.args.quantity === "0.001", String(sent?.args.quantity));
    check("newOrderRespType RESULT", sent?.args.newOrderRespType === "RESULT");
  }

  // 3. Safeguards -----------------------------------------------------------
  console.log("\n3. Safeguards reject bad intents before submission");
  {
    const mkAdapter = (amt = "0.010") => {
      const mock = new MockInvoker(baseHandlers(amt));
      return { adapter: new McpExecutionAdapter(mock, "ETHUSDC"), mock };
    };
    const isSafeguard = (reason: string) => (e: unknown) =>
      e instanceof ExecutionSafeguardError && e.reason === reason;

    const a1 = mkAdapter();
    await expectThrow(
      "SYMBOL_MISMATCH when symbol != Guardian symbol",
      () => a1.adapter.reducePosition({ symbol: "BTCUSDT", side: "SELL", quantity: "0.001" }),
      isSafeguard("SYMBOL_MISMATCH"),
    );
    check("no order submitted on symbol mismatch", a1.mock.lastCall("futures_usds_newOrder") === undefined);

    const a2 = mkAdapter();
    await expectThrow(
      "SIDE_MISMATCH when side does not oppose position",
      () => a2.adapter.reducePosition({ symbol: "ETHUSDC", side: "BUY", quantity: "0.001" }),
      isSafeguard("SIDE_MISMATCH"),
    );
    check("no order submitted on side mismatch", a2.mock.lastCall("futures_usds_newOrder") === undefined);

    const a3 = mkAdapter();
    await expectThrow(
      "POSITION_INSUFFICIENT when qty > position",
      () => a3.adapter.reducePosition({ symbol: "ETHUSDC", side: "SELL", quantity: "0.020" }),
      isSafeguard("POSITION_INSUFFICIENT"),
    );

    const a4 = mkAdapter();
    await expectThrow(
      "INVALID_QUANTITY when qty <= 0",
      () => a4.adapter.reducePosition({ symbol: "ETHUSDC", side: "SELL", quantity: "0" }),
      isSafeguard("INVALID_QUANTITY"),
    );

    const flat = new McpExecutionAdapter(
      new MockInvoker(baseHandlers("0")),
      "ETHUSDC",
    );
    await expectThrow(
      "NO_POSITION when position is flat",
      () => flat.reducePosition({ symbol: "ETHUSDC", side: "SELL", quantity: "0.001" }),
      isSafeguard("NO_POSITION"),
    );
  }

  // 4. MCP_AUTH_REQUIRED propagates cleanly ---------------------------------
  console.log("\n4. Missing OAuth fails cleanly as MCP_AUTH_REQUIRED");
  {
    const authless: McpToolInvoker = {
      call: async () => {
        throw new McpAuthRequiredError();
      },
      close: async () => {},
    };
    const adapter = new McpExecutionAdapter(authless, "ETHUSDC");
    await expectThrow(
      "getPosition surfaces MCP_AUTH_REQUIRED",
      () => adapter.getPosition("ETHUSDC"),
      (e) => e instanceof McpAuthRequiredError && e.code === "MCP_AUTH_REQUIRED",
    );
  }

  // 5. Verified reduction: submit → refresh → confirm shrink ----------------
  console.log("\n5. submitVerifiedReduction confirms the position shrank");
  {
    // Stateful mock: position is 0.010 until the order lands, then 0.009.
    let ordered = false;
    const mock = new MockInvoker({
      futures_usds_positionInformationV2: () => longPosition(ordered ? "0.009" : "0.010"),
      futures_usds_newOrder: () => {
        ordered = true;
        return filledOrder;
      },
      futures_usds_accountInformationV3: () => singleAssetUsdcAccount,
      futures_usds_exchangeInformation: () => exchangeInfo,
      futures_usds_queryOrder: () => filledOrder,
    });
    const adapter = new McpExecutionAdapter(mock, "ETHUSDC");
    const outcome = await submitVerifiedReduction(adapter, {
      symbol: "ETHUSDC",
      side: "SELL",
      quantity: "0.001",
    });
    check("captured real orderId", outcome.order.orderId === 82283985098);
    check("position shrank", outcome.quantityChanged, `reducedBy ${outcome.reducedBy.toFixed(4)}`);
    check(
      "reducedBy ≈ 0.001",
      Math.abs(outcome.reducedBy - 0.001) < 1e-6,
      outcome.reducedBy.toFixed(6),
    );
    check("before 0.010 / after 0.009",
      Math.abs(outcome.positionBefore.positionAmt) === 0.01 &&
        Math.abs(outcome.positionAfter.positionAmt) === 0.009);
  }

  console.log(failed ? "\nADAPTER CHECKS FAILED\n" : "\nAll adapter checks passed.\n");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("\nadapter-check aborted:", err instanceof Error ? err.message : err);
  process.exit(1);
});
