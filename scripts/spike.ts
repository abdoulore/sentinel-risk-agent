/**
 * Day 1 spike (BUILD_PLAN section 3). Blocks everything else.
 *
 *   npm run spike               read-only checks, submits nothing
 *   npm run spike -- --execute  also submits one tiny reduceOnly market order
 *
 * Step 5 is the one that matters: if the reduce-only order does not fill and
 * return an order ID, stop and report. Everything downstream assumes it works.
 */
import { signedRequest, syncClock, BinanceApiError } from "@/lib/binance/client";
import { FUTURES_BASE_URL, SYMBOL, isTestnet, requireCredentials } from "@/lib/config";
import { getSymbolFilters, readSnapshot } from "@/lib/execution/adapter";
import { fetchOrder, reducingSide, submitReduceOnlyMarketOrder } from "@/lib/binance/orders";
import { computeReductionQuantity } from "@/lib/execution/quantity";

const EXECUTE = process.argv.includes("--execute");

/** Test fixture from the plan: $20 collateral, 5x, roughly $100 notional. */
const FIXTURE_COLLATERAL_USD = 20;
const FIXTURE_LEVERAGE = 5;

let failed = false;

function pass(step: string, detail = "") {
  console.log(`  [ok]   ${step}${detail ? ` - ${detail}` : ""}`);
}
function warn(step: string, detail = "") {
  console.log(`  [warn] ${step}${detail ? ` - ${detail}` : ""}`);
}
function fail(step: string, detail = "") {
  failed = true;
  console.log(`  [FAIL] ${step}${detail ? ` - ${detail}` : ""}`);
}
function heading(n: number, title: string) {
  console.log(`\n${n}. ${title}`);
}

async function main() {
  const host = isTestnet() ? "  (TESTNET)" : "  (MAINNET - real funds)";
  console.log("Sentinel - Day 1 spike");
  console.log(`Host:   ${FUTURES_BASE_URL}${host}`);
  console.log(`Symbol: ${SYMBOL}`);
  console.log(`Mode:   ${EXECUTE ? "EXECUTE - will submit a real reduce-only order" : "read-only"}`);

  // ---- 1. Credentials and key permissions -------------------------------
  heading(1, "Credentials");

  // Fail fast: every later step is a signed call, and letting them all reject
  // concurrently buries this message under four identical errors.
  try {
    requireCredentials();
    pass("credentials present");
  } catch (err) {
    fail("credentials missing", err instanceof Error ? err.message : String(err));
    console.log("\nSPIKE FAILED - stop and report. Do not build on top of this.\n");
    process.exitCode = 1;
    return;
  }

  const offset = await syncClock();
  pass("clock synced", `local drift ${offset}ms`);

  try {
    const restrictions = await signedRequest<{
      enableWithdrawals: boolean;
      enableFutures: boolean;
      enableReading: boolean;
      ipRestrict: boolean;
    }>("GET", "/sapi/v1/account/apiRestrictions", {}, "https://api.binance.com");

    if (restrictions.enableWithdrawals) {
      fail("key has WITHDRAWAL permission", "revoke it before going further");
    } else {
      pass("no withdrawal permission");
    }
    if (restrictions.enableFutures) {
      pass("futures trading enabled");
    } else {
      fail("futures trading not enabled on this key");
    }
    pass("ip restriction", restrictions.ipRestrict ? "enabled" : "not set");
  } catch (err) {
    const msg = err instanceof BinanceApiError ? err.binanceMessage : String(err);
    warn("could not read key restrictions", `${msg} - verify manually in Binance API management`);
  }

  // ---- 2. Signed REST call reads account state --------------------------
  heading(2, "Signed REST call - account state");
  const snapshot = await readSnapshot(SYMBOL);
  pass("authenticated", `wallet balance ${snapshot.account.totalWalletBalance.toFixed(2)} USDT`);
  pass("available balance", `${snapshot.account.availableBalance.toFixed(2)} USDT`);
  if (snapshot.account.marginRatio !== null) {
    pass("margin ratio", `${(snapshot.account.marginRatio * 100).toFixed(2)}%`);
  }

  if (snapshot.hedgeMode) {
    fail("account is in HEDGE mode", "reduceOnly is rejected - switch to One-way");
  } else {
    pass("position mode", "one-way (reduceOnly accepted)");
  }

  // ---- 3. exchangeInfo filters ------------------------------------------
  heading(3, "exchangeInfo filters");
  const filters = await getSymbolFilters(SYMBOL, true);
  console.log(`         stepSize     ${filters.stepSize}`);
  console.log(`         minQty       ${filters.minQty}`);
  console.log(`         minNotional  ${filters.minNotional}`);
  console.log(`         tickSize     ${filters.tickSize}`);
  console.log(`         market step  ${filters.marketStepSize}  (max ${filters.marketMaxQty})`);
  pass("filters fetched from the exchange, not hardcoded");

  // ---- 4. Test fixture --------------------------------------------------
  heading(4, "Test fixture");
  const { position } = snapshot;
  const markPrice = position.markPrice;
  const asset = SYMBOL.replace("USDT", "");

  if (position.side === "FLAT") {
    const targetNotional = FIXTURE_COLLATERAL_USD * FIXTURE_LEVERAGE;
    const entryQty = markPrice > 0 ? targetNotional / markPrice : 0;
    warn("no open position", "open it by hand before running step 5");
    console.log("");
    console.log(`         At mark ${markPrice.toFixed(2)}, a ${FIXTURE_LEVERAGE}x fixture on`);
    console.log(`         ${FIXTURE_COLLATERAL_USD} USDT collateral is ${targetNotional} USDT notional`);
    console.log(`         = ${entryQty.toFixed(filters.quantityPrecision)} ${asset}`);
    console.log(`         Entry is NOT exempt from minNotional (${filters.minNotional} USDT).`);
    console.log("");
    console.log("         Reduction quantities at that size:");
    for (const p of [10, 20, 25, 30]) {
      const q = computeReductionQuantity(entryQty, p, filters.marketStepSize);
      console.log(`           ${String(p).padStart(2)}%  ->  ${q.steppedQty}  (raw ${q.rawQty.toFixed(6)})`);
    }
    console.log("");
    console.log("         Percentages resolving to the same quantity must not both");
    console.log("         appear in the demo.");
  } else {
    const size = Math.abs(position.positionAmt);
    pass("position open", `${position.side} ${size} @ ${position.entryPrice.toFixed(2)}`);
    console.log(`         mark        ${markPrice.toFixed(2)}`);
    console.log(`         notional    ${position.notional.toFixed(2)} USDT`);
    console.log(`         leverage    ${position.leverage ?? "?"}x  (${position.marginType ?? "?"})`);
    console.log(`         uPnL        ${position.unrealizedPnl.toFixed(4)} USDT`);
    if (position.liquidationDistancePercent !== null) {
      const liq = position.liquidationPrice?.toFixed(2) ?? "?";
      console.log(`         liq at      ${liq} (${position.liquidationDistancePercent.toFixed(2)}% away)`);
    }
    if (position.leverage !== null && position.leverage > FIXTURE_LEVERAGE) {
      warn("leverage above fixture", `${position.leverage}x - a liquidation destroys the fixture`);
    }
    console.log("");
    console.log("         Reduction quantities at this size:");
    for (const p of [10, 20, 25, 30]) {
      const q = computeReductionQuantity(position.positionAmt, p, filters.marketStepSize);
      console.log(`           ${String(p).padStart(2)}%  ->  ${q.steppedQty}  (raw ${q.rawQty.toFixed(6)})`);
    }
  }

  // ---- 5. The order everything else depends on --------------------------
  heading(5, "Tiny reduceOnly market order");
  if (position.side === "FLAT") {
    warn("skipped", "no position to reduce");
  } else if (!EXECUTE) {
    const qty = filters.marketMinQty;
    const notional = Number(qty) * markPrice;
    warn("skipped", "re-run with --execute to submit");
    const side = reducingSide(position.positionAmt);
    console.log(`         would submit: ${side} ${qty} ${SYMBOL} MARKET reduceOnly`);
    console.log(`         notional ~${notional.toFixed(2)} USDT - below minNotional ${filters.minNotional},`);
    console.log("         which reduce-only orders are exempt from.");
  } else {
    const qty = filters.marketMinQty;
    const side = reducingSide(position.positionAmt);
    console.log(`         submitting ${side} ${qty} ${SYMBOL} MARKET reduceOnly...`);
    try {
      const t0 = Date.now();
      const order = await submitReduceOnlyMarketOrder({ symbol: SYMBOL, side, quantity: qty });
      const verified = await fetchOrder(SYMBOL, order.orderId);
      const elapsed = Date.now() - t0;

      pass("order accepted", `id ${order.orderId} in ${elapsed}ms`);
      console.log(`         status      ${verified.status}`);
      console.log(`         executedQty ${verified.executedQty}`);
      console.log(`         avgPrice    ${verified.avgPrice}`);
      console.log(`         reduceOnly  ${verified.reduceOnly}`);

      if (verified.status !== "FILLED" || verified.executedQty <= 0) {
        fail("order did not fill", `status ${verified.status}`);
      } else {
        pass("FILLED with a real order ID - downstream is unblocked");
      }
    } catch (err) {
      if (err instanceof BinanceApiError) {
        fail("order rejected", `[${err.code}] ${err.binanceMessage}`);
        if (err.isMinNotional) {
          console.log("         reduceOnly should exempt this - check reduceOnly is actually set.");
        }
        if (err.isReduceOnlyRejected) {
          console.log("         -2022: position may be smaller than the order, or already closed.");
        }
      } else {
        fail("order failed", String(err));
      }
    }
  }

  console.log(
    failed
      ? "\nSPIKE FAILED - stop and report. Do not build on top of this.\n"
      : "\nSpike checks passed.\n",
  );
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("\nSpike aborted:", err instanceof Error ? err.message : err);
  process.exit(1);
});
