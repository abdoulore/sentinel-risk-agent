/**
 * The MCP contract — the narrow surface everything above the transport depends
 * on. Pure types and error classes, no transport, no auth, no I/O.
 *
 * This module exists because Sentinel does not own the Binance MCP session. A
 * supported Agent OS host (Claude Code) owns it, and Sentinel reaches it through
 * whatever invoker is injected. Keeping the contract free of any transport is
 * what lets the same Execution Adapter run against a mock, against a journal
 * replay, or against a live host relay without changing a line of policy code.
 *
 * Previously these lived in mcp/binance-client.ts alongside the custom-OAuth
 * client. That client is now a dead spike (spikes/custom-mcp-client/); the
 * contract stayed behind because the runtime depends on it.
 */

/**
 * Raised when there is no usable Binance MCP session. The code is stable and
 * the policy runtime classifies it as EXECUTION_BLOCKED — never a generic error.
 */
export class McpAuthRequiredError extends Error {
  readonly code = "MCP_AUTH_REQUIRED" as const;
  constructor(detail = "no Binance MCP session available to the Agent OS host") {
    super(`MCP_AUTH_REQUIRED: ${detail}`);
    this.name = "McpAuthRequiredError";
  }
}

/** Raised when a tool exists and auth is fine, but the call itself failed. */
export class McpToolError extends Error {
  constructor(
    readonly tool: string,
    detail: string,
  ) {
    super(`MCP tool ${tool} failed: ${detail}`);
    this.name = "McpToolError";
  }
}

/**
 * Per-call identity, supplied by the layer that knows the *meaning* of the call.
 *
 * `stepId` is what makes a read replay-safe: `getPosition` before a fill and
 * `getPosition` after it are the same tool with identical arguments, and must
 * never share a journal entry. The step names them apart.
 *
 * `executionId` is required on writes and is what makes them idempotent. It
 * identifies the *logical action* (this rule firing, this once), not the
 * arguments — two legitimate triggers may produce byte-identical arguments and
 * must both reach Binance.
 */
export interface CallMeta {
  /** Logical step within the cycle, e.g. "POSITION_BEFORE" / "POSITION_AFTER". */
  stepId?: string;
  /** Required for side-effecting calls. e.g. "G-ETH-03:R1:trigger-…". */
  executionId?: string;
  /** Marks a call as side-effecting. Defaults to false (READ). */
  write?: boolean;
}

/**
 * The narrow surface the Execution Adapter depends on. Injecting this interface
 * rather than a concrete client is what lets the adapter be unit-tested with
 * mocked responses and driven in production by the host relay.
 */
export interface McpToolInvoker {
  call<T>(tool: string, args?: Record<string, unknown>, meta?: CallMeta): Promise<T>;
  close(): Promise<void>;
}
