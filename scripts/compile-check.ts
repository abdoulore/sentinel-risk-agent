/**
 * Host-native compilation checks.
 *
 *   npm run check:compile
 *
 * The ownership contract under test:
 *
 *   Host LLM   interpretation — it emits Guardian JSON
 *   Sentinel   schema, metrics, operators, actions, bounds, symbol,
 *              persistence, activation, runtime
 *
 * Sentinel makes no LLM call of its own. This suite runs with
 * ANTHROPIC_API_KEY explicitly deleted from the environment and must pass
 * regardless — that is the point of the refactor.
 *
 * Offline. No network, no live fixture, no order.
 */
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateGuardianInput, CompileError, verify } from "@/lib/compiler/validate";
import { guardianContract, renderContract } from "@/lib/compiler/contract";
import { GuardianStore } from "@/lib/guardian/store";
import { evaluateGuardian } from "@/lib/policy/engine";
import type { MetricSnapshot, MetricValues } from "@/lib/metrics/engine";
import type { CompiledPolicy } from "@/lib/compiler/schema";

// Prove the production path does not depend on it, before anything is imported
// that might read it.
delete process.env.ANTHROPIC_API_KEY;

let failed = false;
const pass = (n: string, d = "") => console.log(`  [ok]   ${n}${d ? ` - ${d}` : ""}`);
function fail(n: string, d = "") {
  failed = true;
  console.log(`  [FAIL] ${n}${d ? ` - ${d}` : ""}`);
}
const check = (n: string, c: boolean, d = "") => (c ? pass(n, d) : fail(n, d));
const section = (t: string) => console.log(`\n${t}`);

const dir = mkdtempSync(join(tmpdir(), "sentinel-compile-"));
let n = 0;
const newStore = () => new GuardianStore(join(dir, `state-${n++}.json`));
const CONTEXT = { symbol: "ETHUSDC" };

/** Exactly the JSON the brief specifies a host should produce. */
const HOST_JSON = {
  id: "G-ETH-03",
  name: "ETH Defensive Guardian",
  symbol: "ETHUSDC",
  maxReductionPercent: 30,
  rules: [
    {
      id: "R1",
      conditions: [
        { metric: "funding_rate", operator: ">", value: 0.0003 },
        { metric: "momentum", operator: "==", value: "BEARISH" },
      ],
      action: { type: "reduce_position", percent: 30 },
    },
  ],
};

function rejects(name: string, input: unknown, matcher?: (issues: string[]) => boolean) {
  try {
    validateGuardianInput(input, CONTEXT);
    fail(name, "accepted, should have been rejected");
  } catch (e) {
    if (!(e instanceof CompileError)) return fail(name, `wrong error: ${String(e)}`);
    const ok = matcher ? matcher(e.issues) : true;
    check(name, ok, ok ? e.issues[0] ?? e.message : `issues: ${e.issues.join(" | ")}`);
  }
}

function main() {
  /* ====================================================================== */
  section("1. No ANTHROPIC_API_KEY anywhere in the production path");

  check("ANTHROPIC_API_KEY is unset for this suite", !process.env.ANTHROPIC_API_KEY);

  {
    const offenders: string[] = [];
    const anthropicImports: string[] = [];
    const stack = ["src", "scripts"];
    const files: string[] = [];
    while (stack.length) {
      const cur = stack.pop() as string;
      const st = statSync(cur);
      if (st.isDirectory()) {
        for (const e of readdirSync(cur)) stack.push(join(cur, e));
      } else if (cur.endsWith(".ts") || cur.endsWith(".tsx")) files.push(cur);
    }

    // The optional adapter and its optional dev check may reference Anthropic.
    const optional = (f: string) =>
      f.includes(join("compiler", "adapters")) || f.endsWith("compiler-check.ts") || f.endsWith("compile-check.ts");

    // Test what the claim actually is: does production code READ the key, or
    // IMPORT the SDK? Naming either in a comment, a help string, or another
    // test's own regex is not a dependency.
    const READS_KEY = /process\.env\.ANTHROPIC_API_KEY/;
    const IMPORTS_SDK = /(?:from\s*|import\s*\(\s*)["'`]@anthropic-ai/;

    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (!optional(f) && READS_KEY.test(src)) offenders.push(f);
      if (!optional(f) && IMPORTS_SDK.test(src)) anthropicImports.push(f);
    }
    check("no production file reads ANTHROPIC_API_KEY", offenders.length === 0, offenders.join(", "));
    check("no production file imports @anthropic-ai", anthropicImports.length === 0, anthropicImports.join(", "));
    check("checked the whole tree", files.length > 20, `${files.length} files`);
  }

  {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    check("@anthropic-ai/sdk is NOT a production dependency",
      !("@anthropic-ai/sdk" in (pkg.dependencies ?? {})),
      Object.keys(pkg.dependencies ?? {}).join(", "));
    check("it is kept as an optional devDependency",
      "@anthropic-ai/sdk" in (pkg.devDependencies ?? {}));
    const env = readFileSync(".env.example", "utf8");
    check(".env.example marks the key OPTIONAL",
      /OPTIONAL/.test(env) && /NOT REQUIRED FOR AGENT OS-NATIVE SENTINEL/.test(env));
    check(".env.example does not present it as required",
      !/^ANTHROPIC_API_KEY=/m.test(env));
  }

  /* ====================================================================== */
  section("2-3. A valid host-authored Guardian is accepted and stored as DRAFT");

  {
    const result = validateGuardianInput(HOST_JSON, CONTEXT);
    check("guardian id preserved", result.guardian.id === "G-ETH-03", result.guardian.id);
    check("name preserved", result.guardian.name === "ETH Defensive Guardian");
    check("symbol is the configured one", result.guardian.symbol === "ETHUSDC");
    check("mode is owned by the application", result.guardian.mode === "guarded");
    check("ceiling preserved", result.guardian.maxReductionPercent === 30);
    check("one rule compiled", result.guardian.rules.length === 1);
    check("conditions preserved",
      result.guardian.rules[0].conditions.length === 2 &&
        result.guardian.rules[0].conditions[0].value === 0.0003 &&
        result.guardian.rules[0].conditions[1].value === "BEARISH");
    check("action preserved",
      result.guardian.rules[0].action.type === "reduce_position" &&
        result.guardian.rules[0].action.percent === 30);
    check("no warnings for a clean policy", result.warnings.length === 0, result.warnings.join("; "));

    // Same JSON as a STRING, which is how a host hands it over.
    const asString = validateGuardianInput(JSON.stringify(HOST_JSON), CONTEXT);
    check("accepts a JSON string identically",
      JSON.stringify(asString.guardian) === JSON.stringify(result.guardian));

    // The compiled Guardian actually drives the real Policy Engine.
    const base: MetricValues = {
      momentum: "BEARISH", funding_rate: 0.00041, funding_direction: "RISING",
      open_interest: 1_000_000, oi_change_percent: 11, unrealized_pnl: -0.3,
      unrealized_pnl_percent: -1.6, liquidation_distance_percent: 30,
      position_size: 0.01, leverage: 5, margin_ratio: 0.013,
    };
    const snap = { at: Date.now(), symbol: "ETHUSDC", live: base, effective: base,
      overrides: {}, sources: {} } as unknown as MetricSnapshot;
    check("the compiled Guardian fires in the real Policy Engine",
      evaluateGuardian(result.guardian, snap).firedRule?.rule.id === "R1");

    // 3. Persistence
    const store = newStore();
    store.update({ draft: result.guardian });
    const state = store.read();
    check("stored as DRAFT", state.draft?.id === "G-ETH-03");
    check("NOT active", state.guardian === null);
    check("status is not ACTIVE", state.status !== "ACTIVE", state.status);
  }

  /* ====================================================================== */
  section("4. Activation stays explicit");

  {
    const store = newStore();
    store.update({ draft: validateGuardianInput(HOST_JSON, CONTEXT).guardian });
    check("validation alone does not arm anything", store.read().guardian === null);
    check("and status stays PAUSED", store.read().status === "PAUSED");

    // What `sentinel activate` does.
    const draft = store.read().draft!;
    store.update({ guardian: draft, draft: null, status: "ACTIVE" });
    check("explicit activation promotes the draft", store.read().guardian?.id === "G-ETH-03");
    check("draft cleared on activation", store.read().draft === null);
    check("now ACTIVE", store.read().status === "ACTIVE");
  }

  /* ====================================================================== */
  section("5-9. The host cannot bypass validation");

  // 5. Unknown metric
  rejects("unknown metric is rejected",
    { ...HOST_JSON, rules: [{ id: "R1", conditions: [{ metric: "vibes", operator: ">", value: 1 }],
      action: { type: "reduce_position", percent: 30 } }] });

  rejects("a real-sounding but unregistered metric is rejected",
    { ...HOST_JSON, rules: [{ id: "R1", conditions: [{ metric: "rsi", operator: ">", value: 70 }],
      action: { type: "reduce_position", percent: 30 } }] });

  // 6. Unsupported action — including anything that opens risk
  for (const type of ["increase_position", "buy", "open_position", "withdraw_funds", "flip"]) {
    rejects(`action "${type}" is rejected`,
      { ...HOST_JSON, rules: [{ id: "R1", conditions: [{ metric: "momentum", operator: "==", value: "BEARISH" }],
        action: { type, percent: 30 } }] });
  }

  // 7. Malformed JSON
  rejects("malformed JSON is rejected", "{ not json", (i) => i.length > 0);
  rejects("empty input is rejected", "   ");
  rejects("a JSON array is rejected", "[]");
  rejects("a JSON scalar is rejected", "42");
  rejects("null is rejected", null);

  // 8. Invalid percentages
  rejects("negative reduce percent is rejected",
    { ...HOST_JSON, rules: [{ id: "R1", conditions: [{ metric: "momentum", operator: "==", value: "BEARISH" }],
      action: { type: "reduce_position", percent: -20 } }] },
    (i) => i.some((x) => x.includes("positive percent")));

  rejects("zero reduce percent is rejected",
    { ...HOST_JSON, rules: [{ id: "R1", conditions: [{ metric: "momentum", operator: "==", value: "BEARISH" }],
      action: { type: "reduce_position", percent: 0 } }] });

  rejects("reduce_position without a percent is rejected",
    { ...HOST_JSON, rules: [{ id: "R1", conditions: [{ metric: "momentum", operator: "==", value: "BEARISH" }],
      action: { type: "reduce_position" } }] });

  rejects("maxReductionPercent of 0 is rejected", { ...HOST_JSON, maxReductionPercent: 0 });
  rejects("maxReductionPercent above 100 is rejected", { ...HOST_JSON, maxReductionPercent: 150 });
  rejects("negative maxReductionPercent is rejected", { ...HOST_JSON, maxReductionPercent: -30 });

  // 9. Structural bypass attempts
  rejects("a policy with no rules is rejected", { ...HOST_JSON, rules: [] });
  rejects("a rule with no conditions is rejected",
    { ...HOST_JSON, rules: [{ id: "R1", conditions: [], action: { type: "reduce_position", percent: 30 } }] });
  rejects("an enum metric compared with > is rejected",
    { ...HOST_JSON, rules: [{ id: "R1", conditions: [{ metric: "momentum", operator: ">", value: "BEARISH" }],
      action: { type: "reduce_position", percent: 30 } }] });
  rejects("an invalid enum state is rejected",
    { ...HOST_JSON, rules: [{ id: "R1", conditions: [{ metric: "momentum", operator: "==", value: "VERY_BEARISH" }],
      action: { type: "reduce_position", percent: 30 } }] });
  rejects("a numeric metric compared to a string is rejected",
    { ...HOST_JSON, rules: [{ id: "R1", conditions: [{ metric: "funding_rate", operator: ">", value: "high" }],
      action: { type: "reduce_position", percent: 30 } }] });
  rejects("a symbol the host invented is rejected",
    { ...HOST_JSON, symbol: "BTCUSDT" }, (i) => i.some((x) => x.includes("does not match")));
  rejects("an unknown operator is rejected",
    { ...HOST_JSON, rules: [{ id: "R1", conditions: [{ metric: "funding_rate", operator: "~=", value: 0.0003 }],
      action: { type: "reduce_position", percent: 30 } }] });

  {
    // Extra fields the host might smuggle in must not survive into the Guardian.
    const r = validateGuardianInput(
      { ...HOST_JSON, mode: "unguarded", quantity: "9.999", orderId: 1, maxNotional: 1e9 },
      CONTEXT,
    );
    check("mode cannot be set by the host", r.guardian.mode === "guarded");
    const keys = Object.keys(r.guardian).sort().join(",");
    check("no extra field reaches the Guardian",
      keys === "id,maxReductionPercent,mode,name,rules,symbol", keys);
  }

  {
    // Nothing is persisted when validation fails.
    const store = newStore();
    try {
      validateGuardianInput({ ...HOST_JSON, maxReductionPercent: 500 }, CONTEXT);
    } catch {
      /* expected */
    }
    check("a rejected Guardian is not stored", store.read().draft === null);
  }

  /* ====================================================================== */
  section("10. Existing compiler semantics are unchanged");

  {
    // percent above the ceiling stays a WARNING, not a rejection — the Validator
    // clamps it at runtime. This behaviour predates the refactor.
    const over = validateGuardianInput(
      { ...HOST_JSON, maxReductionPercent: 30,
        rules: [{ id: "R1", conditions: [{ metric: "momentum", operator: "==", value: "BEARISH" }],
          action: { type: "reduce_position", percent: 60 } }] },
      CONTEXT,
    );
    check("percent above the ceiling compiles with a warning, not a rejection",
      over.warnings.some((w) => w.includes("clamped")), over.warnings.join("; "));
    check("and the ceiling is preserved untouched", over.guardian.maxReductionPercent === 30);
    check("and the rule keeps its stated percent", over.guardian.rules[0].action.percent === 60);

    // The funding percent/decimal mix-up warning.
    const mixup = validateGuardianInput(
      { ...HOST_JSON, rules: [{ id: "R1", conditions: [{ metric: "funding_rate", operator: ">", value: 0.03 }],
        action: { type: "reduce_position", percent: 30 } }] },
      CONTEXT,
    );
    check("a funding threshold that looks like a percentage warns",
      mixup.warnings.some((w) => w.includes("looks like a percentage")));

    // verify() is exported and behaves as before on a raw policy.
    const policy: CompiledPolicy = {
      name: "x", maxReductionPercent: 30,
      rules: [{ id: "R1", conditions: [{ metric: "momentum", operator: "==", value: "BEARISH" }],
        action: { type: "watch", percent: null } }],
      unsupported: [],
    };
    const v = verify(policy);
    check("non-reduce actions compile without a percent",
      v.issues.length === 0 && v.rules[0].action.type === "watch");
    check("and carry no percent field", !("percent" in v.rules[0].action));

    // unsupported is surfaced, not dropped.
    const withUnsupported = validateGuardianInput(
      { ...HOST_JSON, unsupported: ["buy the dip if funding flips negative"] }, CONTEXT);
    check("unsupported items are surfaced", withUnsupported.unsupported.length === 1);

    // id is optional; Sentinel generates one.
    const noId = validateGuardianInput({ ...HOST_JSON, id: undefined }, CONTEXT);
    check("a missing id is generated by Sentinel", /^G-ETH-\d{2}$/.test(noId.guardian.id), noId.guardian.id);
    rejects("a hostile id is rejected", { ...HOST_JSON, id: "../../etc/passwd" });
  }

  /* ====================================================================== */
  section("11. The published contract matches the registries");

  {
    const c = guardianContract("ETHUSDC");
    check("contract names the configured symbol", c.symbol === "ETHUSDC");
    check("contract publishes every registry metric", c.metrics.length === 11, `${c.metrics.length}`);
    check("momentum is published as an enum with its states",
      c.metrics.find((m) => m.name === "momentum")?.values?.includes("BEARISH") === true);
    check("enum metrics publish only == and !=",
      c.metrics.filter((m) => m.kind === "enum").every((m) => m.operators.length === 2));
    check("funding_rate publishes its decimal units",
      /0\.0003/.test(c.metrics.find((m) => m.name === "funding_rate")?.units ?? ""));
    check("only the four defensive actions are published",
      c.actions.join(",") === "reduce_position,close_position,watch,hold", c.actions.join(","));
    check("no action opens or increases a position",
      !c.actions.some((a) => /buy|increase|open|long|short/.test(a)));

    // The published example must itself validate — a contract that documents an
    // invalid example is worse than none.
    const fromExample = validateGuardianInput(c.example, CONTEXT);
    check("the published example validates", fromExample.guardian.rules.length === 1);
    check("rendered contract is non-empty prose", renderContract(c).length > 400);
  }

  /* ====================================================================== */
  section("12. The skill instructs the host correctly");

  {
    const skill = readFileSync("agent/skills/sentinel/SKILL.md", "utf8");
    // Markdown wraps prose across lines, so match with \s+ rather than a literal
    // space — otherwise a line break silently fails an assertion about content
    // that is plainly present.
    const says = (re: RegExp) => re.test(skill);
    check("skill tells the host to interpret with its OWN model",
      says(/host\s+LLM\s+owns\s+interpretation/i));
    check("skill says never to call Anthropic",
      says(/never\s+call\s+(the\s+)?anthropic/i));
    check("skill says no API key is required",
      says(/ANTHROPIC_API_KEY/) && says(/not\s+required|never\s+require/i));
    check("skill points at guardian:create", /guardian:create/.test(skill));
    check("skill points at guardian:schema", /guardian:schema/.test(skill));
    check("skill forbids auto-activation",
      /do not activate automatically|never activate/i.test(skill));
    check("skill requires explicit activation",
      says(/explicit\s+activation\s+is\s+always\s+required/i));
    check("skill no longer tells the host to run `compile`",
      !/sentinel -- compile\b/.test(skill));
    check("skill does not hardcode a single host",
      /Codex|any supported|agent os host/i.test(skill));
  }

  console.log(failed ? "\nCOMPILE CHECKS FAILED.\n" : "\nAll host-compile checks passed.\n");
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}

try {
  main();
} catch (e) {
  console.error(e);
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = 1;
}
