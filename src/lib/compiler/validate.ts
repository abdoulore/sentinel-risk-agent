/**
 * Guardian validation — deterministic, and the only thing that decides whether
 * a Guardian may exist.
 *
 * OWNERSHIP
 *
 *   Host LLM   interpretation. It reads the user's sentence and emits Guardian
 *              JSON. It runs inside the supported Agent OS host (Claude Code,
 *              Codex, an IDE agent) which already has a model — Sentinel does
 *              not make a second, separate LLM call to do this.
 *
 *   Sentinel   everything else: the schema, the supported metrics, operators
 *              and actions, semantic checks, numeric bounds, the symbol,
 *              persistence, activation, and the whole runtime.
 *
 * Once a Guardian is validated and activated, no model is in the loop again.
 *
 * The checks below are the same ones that previously ran on the output of
 * Sentinel's own Anthropic call. Nothing about the policy semantics changed:
 * only *who* produces the JSON did. Whatever emits it — a host LLM, a fixture,
 * a hand-written file — is checked identically and is not trusted.
 */
import { CompiledPolicySchema, type CompiledPolicy } from "@/lib/compiler/schema";
import {
  METRIC_REGISTRY,
  isActionType,
  isMetricName,
  isOperator,
  type Condition,
  type Guardian,
  type Rule,
} from "@/lib/policy/types";

export class CompileError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = "CompileError";
  }
}

export interface CompileContext {
  /** The one symbol Sentinel is configured for. A mismatch is rejected. */
  symbol: string;
  /** Free-text description of the live position, for the host's context only. */
  positionSummary?: string;
}

export interface CompileResult {
  guardian: Guardian;
  /** Things the host could not express. Shown to the user at review time. */
  unsupported: string[];
  /** Non-fatal deterministic findings, e.g. a suspicious funding threshold. */
  warnings: string[];
  raw: CompiledPolicy;
}

/** Deterministic id, so interpretation does not own the Guardian's identity. */
export function makeGuardianId(symbol: string): string {
  const asset = symbol.replace(/USDT$/, "").replace(/USDC$/, "");
  const suffix = String(Math.floor(Math.random() * 90) + 10);
  return `G-${asset}-${suffix}`;
}

/** Guardian ids are referenced in executionIds, so keep them boring. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,40}$/;

/**
 * Re-checks a compiled policy against the registries in plain code.
 *
 * The schema already constrains this, but the whole argument is that whoever
 * produced the JSON is not trusted — so it is checked twice, and this is the
 * check that decides.
 */
export function verify(policy: CompiledPolicy): {
  rules: Rule[];
  issues: string[];
  warnings: string[];
} {
  const issues: string[] = [];
  const warnings: string[] = [];
  const rules: Rule[] = [];

  if (!Number.isFinite(policy.maxReductionPercent)) {
    issues.push("maxReductionPercent is not a number");
  } else if (policy.maxReductionPercent <= 0 || policy.maxReductionPercent > 100) {
    issues.push(`maxReductionPercent ${policy.maxReductionPercent} is outside 0–100`);
  }

  if (policy.rules.length === 0) {
    issues.push("policy contains no rules");
  }

  for (const rule of policy.rules) {
    if (rule.conditions.length === 0) {
      issues.push(`rule ${rule.id} has no conditions and would fire unconditionally`);
      continue;
    }

    const conditions: Condition[] = [];
    for (const c of rule.conditions) {
      if (!isMetricName(c.metric)) {
        issues.push(`rule ${rule.id} references unknown metric "${c.metric}"`);
        continue;
      }
      if (!isOperator(c.operator)) {
        issues.push(`rule ${rule.id} uses unknown operator "${c.operator}"`);
        continue;
      }

      const spec = METRIC_REGISTRY[c.metric];
      if (spec.kind === "enum") {
        const allowed = spec.values as readonly string[];
        if (typeof c.value !== "string" || !allowed.includes(c.value)) {
          issues.push(
            `rule ${rule.id}: ${c.metric} must compare against one of ${allowed.join(", ")}`,
          );
          continue;
        }
        if (c.operator !== "==" && c.operator !== "!=") {
          issues.push(`rule ${rule.id}: ${c.metric} supports only == and !=`);
          continue;
        }
      } else if (typeof c.value !== "number" || !Number.isFinite(c.value)) {
        issues.push(`rule ${rule.id}: ${c.metric} must compare against a number`);
        continue;
      }

      // A funding rate above 1% is almost certainly a percent/decimal mix-up:
      // 0.03% is 0.0003, and real funding rarely leaves the basis-point range.
      if (c.metric === "funding_rate" && typeof c.value === "number" && Math.abs(c.value) > 0.01) {
        warnings.push(
          `rule ${rule.id}: funding_rate threshold ${c.value} looks like a percentage — ` +
            `0.03% should be 0.0003`,
        );
      }

      conditions.push({ metric: c.metric, operator: c.operator, value: c.value });
    }

    if (!isActionType(rule.action.type)) {
      issues.push(`rule ${rule.id} uses action type "${rule.action.type}", which is not permitted`);
      continue;
    }

    const percent = rule.action.percent;
    if (rule.action.type === "reduce_position") {
      if (typeof percent !== "number" || !Number.isFinite(percent) || percent <= 0) {
        issues.push(`rule ${rule.id}: reduce_position needs a positive percent`);
        continue;
      }
      if (percent > policy.maxReductionPercent) {
        // Not fatal: the Validator clamps this at runtime. Surface it anyway so
        // the user sees the contradiction before activating.
        warnings.push(
          `rule ${rule.id} reduces ${percent}% but the ceiling is ` +
            `${policy.maxReductionPercent}% — it will be clamped`,
        );
      }
    }

    if (conditions.length !== rule.conditions.length) continue;

    rules.push({
      id: rule.id,
      conditions,
      action:
        rule.action.type === "reduce_position"
          ? { type: "reduce_position", percent: percent as number }
          : { type: rule.action.type },
    });
  }

  return { rules, issues, warnings };
}

/**
 * Normalises host-produced input into the shape `verify` expects.
 *
 * The host may include `id` and `symbol` (its JSON reads more naturally with
 * them), and may omit `unsupported`. Neither is taken on trust: the symbol must
 * match the configured one, and the id must be a plain token.
 */
function normalize(input: Record<string, unknown>, context: CompileContext): {
  policy: unknown;
  id: string;
  issues: string[];
} {
  const issues: string[] = [];

  const symbol = input.symbol;
  if (symbol !== undefined && symbol !== context.symbol) {
    issues.push(
      `symbol "${String(symbol)}" does not match the configured symbol ${context.symbol}`,
    );
  }

  let id: string;
  if (input.id === undefined || input.id === null || input.id === "") {
    id = makeGuardianId(context.symbol);
  } else if (typeof input.id === "string" && ID_PATTERN.test(input.id)) {
    id = input.id;
  } else {
    issues.push(`guardian id ${JSON.stringify(input.id)} is not a plain identifier`);
    id = makeGuardianId(context.symbol);
  }

  const rules = Array.isArray(input.rules)
    ? input.rules.map((r) => {
        if (r === null || typeof r !== "object" || Array.isArray(r)) return r;
        const rule = r as Record<string, unknown>;
        const action =
          rule.action && typeof rule.action === "object" && !Array.isArray(rule.action)
            ? { percent: null, ...(rule.action as Record<string, unknown>) }
            : rule.action;
        return { ...rule, action };
      })
    : input.rules;

  return {
    policy: {
      name: input.name,
      maxReductionPercent: input.maxReductionPercent,
      rules,
      unsupported: Array.isArray(input.unsupported) ? input.unsupported : [],
    },
    id,
    issues,
  };
}

/**
 * The production compilation entry point.
 *
 * Takes structured Guardian JSON — produced by the host LLM, read from a file,
 * or written by hand — and either returns a validated Guardian or throws with
 * every reason it was rejected. No network, no model, no API key.
 */
export function validateGuardianInput(
  input: unknown,
  context: CompileContext,
): CompileResult {
  let body: unknown = input;

  if (typeof body === "string") {
    const text = body.trim();
    if (!text) throw new CompileError("No Guardian JSON given");
    try {
      body = JSON.parse(text);
    } catch (e) {
      throw new CompileError("Guardian input is not valid JSON", [
        e instanceof Error ? e.message : String(e),
      ]);
    }
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new CompileError("Guardian input must be a JSON object", [
      `received ${Array.isArray(body) ? "an array" : typeof body}`,
    ]);
  }

  const { policy, id, issues: normalizeIssues } = normalize(
    body as Record<string, unknown>,
    context,
  );

  const parsed = CompiledPolicySchema.safeParse(policy);
  if (!parsed.success) {
    const schemaIssues = parsed.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new CompileError("Guardian failed schema validation", [
      ...normalizeIssues,
      ...schemaIssues,
    ]);
  }

  const { rules, issues, warnings } = verify(parsed.data);
  const allIssues = [...normalizeIssues, ...issues];
  if (allIssues.length > 0) {
    throw new CompileError("Guardian failed validation", allIssues);
  }

  const guardian: Guardian = {
    id,
    name: parsed.data.name,
    // Symbol and mode belong to the application, never to interpretation.
    symbol: context.symbol,
    mode: "guarded",
    maxReductionPercent: parsed.data.maxReductionPercent,
    rules,
  };

  return { guardian, unsupported: parsed.data.unsupported, warnings, raw: parsed.data };
}
