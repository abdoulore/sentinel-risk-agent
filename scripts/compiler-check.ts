/**
 * OPTIONAL dev check for the Anthropic compile adapter.
 *
 * NOT part of the production test suite and NOT required for Agent OS-native
 * Sentinel. It exercises the optional adapter, so it needs ANTHROPIC_API_KEY and
 * skips cleanly without one. The production compilation path — host LLM emits
 * JSON, Sentinel validates it — is covered by `npm run check:compile`.
 *
 *   npm run check:compiler
 *   npm run check:compiler -- "your own instruction here"
 */
import { compileGuardianWithAnthropic } from "@/lib/compiler/adapters/anthropic";
import { CompileError } from "@/lib/compiler/validate";
import { SYMBOL } from "@/lib/config";
import { evaluateGuardian } from "@/lib/policy/engine";
import type { MetricSnapshot, MetricValues } from "@/lib/metrics/engine";

const EXAMPLE =
  "Protect my ETH position. If funding exceeds 0.03% while momentum is bearish, " +
  "reduce 30%. Never reduce more than 30% in one action.";

const instruction = process.argv.slice(2).join(" ").trim() || EXAMPLE;

/** Minimal snapshot: only `effective` is read by the policy engine. */
function snapshotWith(values: Partial<MetricValues>): MetricSnapshot {
  const base: MetricValues = {
    momentum: "NEUTRAL",
    funding_rate: 0.00012,
    funding_direction: "RISING",
    open_interest: 2_300_942,
    oi_change_percent: 1.8,
    unrealized_pnl: -0.33,
    unrealized_pnl_percent: -1.66,
    liquidation_distance_percent: 18.4,
    position_size: 0.041,
    leverage: 5,
    margin_ratio: 0.0198,
  };
  const effective = { ...base, ...values };
  return {
    at: Date.now(),
    symbol: SYMBOL,
    live: base,
    effective,
    overrides: values,
    sources: null as never,
  };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    // A skip, not a failure. Sentinel does not need this key: the host LLM
    // authors the Guardian and `guardian:create` validates it. This adapter is
    // only for compiling from plain text outside a host.
    console.log("SKIPPED — ANTHROPIC_API_KEY is not set.\n");
    console.log("This adapter is OPTIONAL and NOT REQUIRED for Agent OS-native Sentinel.");
    console.log("The production compilation path is:");
    console.log("  npm run sentinel -- guardian:schema");
    console.log("  npm run sentinel -- guardian:create --file guardian.json");
    console.log("  (covered by: npm run check:compile)\n");
    return;
  }

  console.log("Instruction:");
  console.log(`  ${instruction}\n`);
  console.log("Compiling (one LLM call)...\n");

  const t0 = Date.now();
  let result;
  try {
    result = await compileGuardianWithAnthropic(instruction, {
      symbol: SYMBOL,
      positionSummary: "LONG 0.041 ETH at 5x, entry 2410.00",
    });
  } catch (err) {
    if (err instanceof CompileError) {
      console.error(`COMPILE REJECTED: ${err.message}`);
      for (const issue of err.issues) console.error(`  - ${issue}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  console.log(`Compiled in ${Date.now() - t0}ms\n`);
  console.log(JSON.stringify(result.guardian, null, 2));

  if (result.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const w of result.warnings) console.log(`  ! ${w}`);
  }
  if (result.unsupported.length > 0) {
    console.log("\nNot expressible as rules:");
    for (const u of result.unsupported) console.log(`  - ${u}`);
  }

  // The compiled policy is now data. Run it through the deterministic engine.
  console.log("\n--- Evaluated by the policy engine ---");

  const quiet = evaluateGuardian(result.guardian, snapshotWith({}));
  console.log(`Live conditions        -> ${quiet.firedRule ? quiet.firedRule.rule.id : "no rule fired"}`);

  const stressed = evaluateGuardian(
    result.guardian,
    snapshotWith({ funding_rate: 0.00041, momentum: "BEARISH", unrealized_pnl_percent: -7 }),
  );
  console.log(
    `Simulated stress       -> ${stressed.firedRule ? `${stressed.firedRule.rule.id} fired` : "no rule fired"}`,
  );
  for (const rule of stressed.rules) {
    for (const c of rule.conditions) {
      console.log(`    ${c.matched ? "match" : "     "}  ${rule.rule.id}  ${c.rendered}`);
    }
  }
}

main().catch((err) => {
  console.error("\nCompiler check failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
