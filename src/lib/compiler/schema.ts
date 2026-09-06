import { z } from "zod";
import { ACTION_TYPES, METRIC_NAMES, OPERATORS } from "@/lib/policy/types";

/**
 * The shape the Guardian Compiler is allowed to emit.
 *
 * Metric names, operators and action types are enums drawn from the same
 * registries the engine uses, so the model cannot name a measurement the
 * Metric Engine does not produce. The schema is enforced by the API, and then
 * checked again in deterministic code — see compile.ts.
 *
 * The model does NOT emit: id, symbol, or mode. Those are owned by the
 * application, not by interpretation.
 */

export const ConditionSchema = z.object({
  metric: z.enum(METRIC_NAMES as [string, ...string[]]),
  operator: z.enum(OPERATORS as unknown as [string, ...string[]]),
  value: z.union([z.number(), z.string()]),
});

export const ActionSchema = z.object({
  type: z.enum(ACTION_TYPES as unknown as [string, ...string[]]),
  /** Required for reduce_position. Null for every other action type. */
  percent: z.number().nullable(),
});

export const RuleSchema = z.object({
  id: z.string(),
  conditions: z.array(ConditionSchema),
  action: ActionSchema,
});

export const CompiledPolicySchema = z.object({
  /** A short human name for the Guardian, e.g. "ETH Defensive Guardian". */
  name: z.string(),
  /** The hard ceiling on any single reduction, in percent. */
  maxReductionPercent: z.number(),
  rules: z.array(RuleSchema),
  /**
   * Anything in the instruction the compiler could not express as a rule.
   * Surfaced to the user at review time rather than silently dropped.
   */
  unsupported: z.array(z.string()),
});

export type CompiledPolicy = z.infer<typeof CompiledPolicySchema>;
