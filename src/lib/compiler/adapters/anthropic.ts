/**
 * OPTIONAL DEV ADAPTER — NOT REQUIRED FOR AGENT OS-NATIVE SENTINEL.
 *
 * Production Sentinel never calls this. The supported Agent OS host (Claude
 * Code, Codex, an IDE agent) already has a model, and that model does the
 * interpreting; asking Sentinel to make a second, separate LLM call to compile
 * a Guardian was an architectural mistake, now corrected.
 *
 * This file remains only so a Guardian can be compiled outside a host — for a
 * fixture, a regression corpus, or local experimentation. It requires
 * ANTHROPIC_API_KEY. Nothing on the production path imports it, and a test
 * asserts that stays true.
 *
 * The deterministic half is NOT duplicated here: this adapter produces JSON and
 * then hands it to `validateGuardianInput`, exactly as a host would. The
 * validation that decides is the same in both paths.
 */
import { CompiledPolicySchema } from "@/lib/compiler/schema";
import { guardianContract, renderContract } from "@/lib/compiler/contract";
import {
  CompileError,
  validateGuardianInput,
  type CompileContext,
  type CompileResult,
} from "@/lib/compiler/validate";

const MODEL = "claude-opus-5";

/** The authoring contract, rendered as a system prompt. Single-sourced. */
export function systemPrompt(symbol: string): string {
  return [
    "You compile a trader's plain-language risk instruction into a structured defensive policy.",
    "",
    "You own interpretation only. You do not measure anything, you do not choose limits the",
    "user did not state, and you never see this policy again after it is compiled.",
    "",
    renderContract(guardianContract(symbol)),
  ].join("\n");
}

/**
 * Compiles a natural-language instruction into a Guardian using Anthropic.
 * Requires ANTHROPIC_API_KEY. Prefer the host-native path.
 */
export async function compileGuardianWithAnthropic(
  instruction: string,
  context: CompileContext,
): Promise<CompileResult> {
  if (!instruction.trim()) throw new CompileError("No instruction given");
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new CompileError(
      "ANTHROPIC_API_KEY is not set. This adapter is optional and not required " +
        "for Agent OS-native Sentinel — let the host LLM produce the Guardian JSON " +
        "and pass it to `sentinel guardian:create` instead.",
    );
  }

  // Imported lazily so the SDK is never loaded on the production path.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");

  const client = new Anthropic();
  const userContent = [
    `Symbol: ${context.symbol}`,
    context.positionSummary ? `Current position: ${context.positionSummary}` : null,
    "",
    "Instruction:",
    instruction.trim(),
  ]
    .filter((line) => line !== null)
    .join("\n");

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: systemPrompt(context.symbol),
    messages: [{ role: "user", content: userContent }],
    output_config: { format: zodOutputFormat(CompiledPolicySchema) },
  });

  if (response.stop_reason === "refusal") {
    throw new CompileError("The compiler declined to interpret this instruction");
  }
  const raw = response.parsed_output;
  if (!raw) throw new CompileError("The compiler did not return a policy");

  // Same deterministic gate the host path goes through. No shortcut.
  return validateGuardianInput(raw, context);
}
