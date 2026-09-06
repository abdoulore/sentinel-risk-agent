/**
 * Sentinel watch — continuous monitoring.
 *
 *   npm run watch                  poll every 5 minutes, forever
 *   npm run watch -- --every 60    poll every 60 seconds
 *   npm run watch -- --once        one screen and exit (for cron)
 *
 * This is the piece that makes a Guardian a policy rather than a command.
 * Without it, a Guardian only evaluates when somebody asks — which is no use
 * at three in the morning, when the conditions it was written for actually
 * occur.
 *
 * It runs entirely on public Binance data: no credentials, no MCP, no Agent OS
 * host. It never trades, and it cannot — nothing here can reach an exchange
 * write. All it decides is whether the market has moved into a state where the
 * Guardian *might* fire, and therefore whether it is worth spending a host turn
 * on a full cycle.
 *
 *   ATTENTION  → a host must run `sentinel cycle` to evaluate against the live
 *                position and, if the Validator agrees, execute.
 *
 * When it raises attention it writes .sentinel/attention.json, so a scheduled
 * host session can pick the signal up without watching this process.
 */
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { GuardianStore } from "@/lib/guardian/store";
import { screenMarket, describeMarket, type ScreenResult } from "@/lib/watch/screen";
import { ATTENTION_PATH } from "@/lib/config";

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (n: string) => argv.includes(`--${n}`);

const everySec = Math.max(30, Number(flag("every") ?? 300));
const once = has("once");
const store = new GuardianStore();

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function raiseAttention(result: ScreenResult, guardianId: string): void {
  mkdirSync(dirname(ATTENTION_PATH), { recursive: true });
  writeFileSync(
    ATTENTION_PATH,
    JSON.stringify(
      {
        raisedAt: new Date().toISOString(),
        guardianId,
        symbol: result.symbol,
        reason: result.reason,
        market: result.market,
        rules: result.rules.map((r) => ({ ruleId: r.ruleId, verdict: r.verdict })),
        // The screen decides nothing about trading. This is the instruction.
        action: "Run `npm run sentinel -- cycle` through the Agent OS host to evaluate against the live position.",
      },
      null,
      2,
    ),
    "utf8",
  );
}

function clearAttention(): void {
  if (existsSync(ATTENTION_PATH)) rmSync(ATTENTION_PATH, { force: true });
}

async function tick(): Promise<boolean> {
  const state = store.read();

  if (!state.guardian) {
    console.log(`${stamp()}  no Guardian — nothing to watch`);
    return false;
  }
  if (state.status !== "ACTIVE") {
    console.log(`${stamp()}  Guardian ${state.guardian.id} is ${state.status} — not watching`);
    return false;
  }

  let result: ScreenResult;
  try {
    result = await screenMarket(state.guardian);
  } catch (e) {
    // A failed poll is not a signal. Never raise attention on missing data.
    console.log(`${stamp()}  market data unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }

  if (!result.attention) {
    clearAttention();
    console.log(`${stamp()}  quiet   ${describeMarket(result)}`);
    return false;
  }

  raiseAttention(result, state.guardian.id);
  console.log("");
  console.log(`${stamp()}  ATTENTION — ${result.reason}`);
  console.log(`          ${describeMarket(result)}`);
  for (const r of result.rules) {
    if (r.verdict === "BLOCKED") continue;
    for (const c of r.checked) {
      console.log(`          ${r.ruleId}  ${c.condition.metric} ${c.condition.operator} ${c.condition.value}  ->  ${c.matched ? "met" : "not met"}`);
    }
    if (r.deferred.length) {
      console.log(`          ${r.ruleId}  ${r.deferred.length} condition(s) need live position data`);
    }
  }
  console.log(`          run:  npm run sentinel -- cycle`);
  console.log("");
  return true;
}

async function main() {
  const state = store.read();
  console.log("SENTINEL WATCH");
  console.log(`  guardian   ${state.guardian?.id ?? "none"}  (${state.status})`);
  console.log(`  interval   ${once ? "single pass" : `${everySec}s`}`);
  console.log("  source     public Binance market data — no credentials, no host, no trading");
  console.log("");

  if (once) {
    const fired = await tick();
    process.exitCode = fired ? 10 : 0; // 10 = attention, for cron branching
    return;
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await tick();
    await new Promise((r) => setTimeout(r, everySec * 1000));
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
