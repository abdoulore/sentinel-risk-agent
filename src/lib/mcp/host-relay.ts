/**
 * Host relay — the Agent OS bridge.
 *
 *   Sentinel runtime → HostRelayInvoker → journal → Claude Code skill
 *                                                       ↓
 *                                            Binance Agent OS MCP tool
 *                                                       ↓
 *   Sentinel runtime ← journal ← raw result ────────────┘
 *
 * Empirically established: `claude mcp serve` re-exposes only Claude Code's own
 * built-in tools, so no in-process bridge to its authenticated Binance session
 * exists. The host must relay. This invoker is how the deterministic runtime
 * talks across that boundary without ever handing the host a decision.
 *
 * The runtime does not block. When a call has no recorded result, the invoker
 * persists the request and throws RelayRequired; the process exits cleanly, the
 * host fulfils the request, and the runtime is re-run. Because the runtime is
 * deterministic, the re-run reaches the same calls in the same order and
 * consumes the recorded results until it needs the next one.
 *
 * IDENTITY — the part that makes this safe for trading:
 *
 *   Reads  are keyed by cycleId + stepId.  Never by (tool, args).
 *          `getPosition` before a fill and after it are the same tool with
 *          identical arguments; keying by arguments would return the pre-fill
 *          position forever and make post-fill verification self-confirming.
 *
 *   Writes are keyed by executionId — the logical action, not its arguments.
 *          Two legitimate triggers can produce byte-identical order arguments
 *          and both must reach Binance; the same trigger replayed must not.
 */
import {
  McpAuthRequiredError,
  McpToolError,
  type CallMeta,
  type McpToolInvoker,
} from "@/lib/mcp/contract";
import {
  RelayJournal,
  hashArgs,
  type RelayKind,
  type RelayRecord,
} from "@/lib/mcp/journal";

/* -------------------------------- signals --------------------------------- */

/**
 * Control flow, not failure. Carries the exact envelope the host must relay.
 * The runtime re-throws this rather than classifying it as an execution error.
 */
export class RelayRequired extends Error {
  readonly code = "RELAY_REQUIRED" as const;
  constructor(readonly request: RelayRecord) {
    super(`RELAY_REQUIRED: ${request.tool} (${request.requestId})`);
    this.name = "RelayRequired";
  }

  /** The envelope handed to the host. Exactly what must be invoked. */
  get envelope(): { requestId: string; kind: RelayKind; tool: string; args: Record<string, unknown> } {
    return {
      requestId: this.request.requestId,
      kind: this.request.kind,
      tool: this.request.tool,
      args: this.request.args,
    };
  }
}

/**
 * The same logical action was re-issued with different arguments. Always a bug
 * or a tampered journal — never retried, never reconciled automatically.
 */
export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT" as const;
  constructor(
    readonly executionId: string,
    readonly recordedHash: string,
    readonly attemptedHash: string,
  ) {
    super(
      `IDEMPOTENCY_CONFLICT: executionId ${executionId} was recorded with args ` +
        `${recordedHash} but re-issued with ${attemptedHash}`,
    );
    this.name = "IdempotencyConflictError";
  }
}

/**
 * The crash window: a write's intent was persisted but no result ever was, so
 * Binance may or may not have accepted the order. Never retried automatically.
 * Reconciliation must establish the truth from Binance first — the deterministic
 * clientOrderId (see journal.clientOrderIdFor) is what makes that possible.
 */
export class ExecutionStateUnknownError extends Error {
  readonly code = "EXECUTION_STATE_UNKNOWN" as const;
  constructor(
    readonly executionId: string,
    readonly clientOrderId: string | undefined,
    detail: string,
  ) {
    super(`EXECUTION_STATE_UNKNOWN: ${executionId} — ${detail}`);
    this.name = "ExecutionStateUnknownError";
  }
}

/**
 * The runtime diverged from the recorded journal: the same cycle+step reached a
 * different tool or different arguments than last time. Replay is only sound
 * while the runtime is deterministic, so this is a hard stop.
 */
export class RelayNondeterminismError extends Error {
  readonly code = "RELAY_NONDETERMINISM" as const;
  constructor(readonly requestId: string, detail: string) {
    super(`RELAY_NONDETERMINISM: ${requestId} — ${detail}`);
    this.name = "RelayNondeterminismError";
  }
}

/* -------------------------------- invoker --------------------------------- */

export interface HostRelayOptions {
  cycleId: string;
  journal?: RelayJournal;
  /** Tools that mutate state. Anything here requires an executionId. */
  writeTools?: readonly string[];
}

/** Binance MCP tools that place or cancel orders. */
export const WRITE_TOOLS = [
  "futures_usds_newOrder",
  "futures_usds_cancelOrder",
  "futures_usds_newAlgoOrder",
  "futures_usds_cancelAlgoOrder",
  "futures_coin_newOrder",
  "futures_coin_cancelOrder",
  "spot_newOrder",
  "spot_deleteOrder",
] as const;

export class HostRelayInvoker implements McpToolInvoker {
  private readonly journal: RelayJournal;
  private readonly cycleId: string;
  private readonly writeTools: readonly string[];
  private seq = 0;

  constructor(opts: HostRelayOptions) {
    this.cycleId = opts.cycleId;
    this.journal = opts.journal ?? new RelayJournal();
    this.writeTools = opts.writeTools ?? WRITE_TOOLS;
  }

  async call<T>(
    tool: string,
    args: Record<string, unknown> = {},
    meta: CallMeta = {},
  ): Promise<T> {
    const seq = this.seq++;
    const kind: RelayKind = meta.write || this.writeTools.includes(tool) ? "WRITE" : "READ";
    const stepId = meta.stepId ?? `STEP_${seq}`;
    const requestId = `${this.cycleId}:${stepId}`;
    const argsHash = hashArgs(args);

    return kind === "WRITE"
      ? this.callWrite<T>({ tool, args, argsHash, meta, seq, stepId, requestId })
      : this.callRead<T>({ tool, args, argsHash, seq, stepId, requestId });
  }

  /* ------------------------------- reads ---------------------------------- */

  private async callRead<T>(ctx: {
    tool: string;
    args: Record<string, unknown>;
    argsHash: string;
    seq: number;
    stepId: string;
    requestId: string;
  }): Promise<T> {
    const prior = this.journal.findByRequestId(ctx.requestId);

    if (prior) {
      this.assertDeterministic(prior, ctx.tool, ctx.argsHash);

      if (prior.status === "FULFILLED" || prior.status === "CONSUMED") {
        if (prior.status === "FULFILLED") this.markConsumed(prior);
        return prior.result as T;
      }
      if (prior.status === "FAILED") throw this.replayError(prior);
      // REQUESTED: already asked, host has not answered yet.
      throw new RelayRequired(prior);
    }

    const record = this.journal.append({
      requestId: ctx.requestId,
      cycleId: this.cycleId,
      stepId: ctx.stepId,
      seq: ctx.seq,
      kind: "READ",
      tool: ctx.tool,
      args: ctx.args,
      argsHash: ctx.argsHash,
      status: "REQUESTED",
      requestedAt: new Date().toISOString(),
    });
    throw new RelayRequired(record);
  }

  /* ------------------------------- writes --------------------------------- */

  private async callWrite<T>(ctx: {
    tool: string;
    args: Record<string, unknown>;
    argsHash: string;
    meta: CallMeta;
    seq: number;
    stepId: string;
    requestId: string;
  }): Promise<T> {
    const executionId = ctx.meta.executionId;
    if (!executionId) {
      throw new McpToolError(
        ctx.tool,
        "EXECUTION_ID_REQUIRED: a side-effecting relay call must carry an executionId",
      );
    }

    // Idempotency is global, not per-cycle: a write recorded in an earlier cycle
    // still binds. This lookup is what stops a replayed trigger re-submitting.
    const prior = this.journal.findByExecutionId(executionId);

    if (prior) {
      if (prior.argsHash !== ctx.argsHash) {
        throw new IdempotencyConflictError(executionId, prior.argsHash, ctx.argsHash);
      }
      if (prior.status === "FULFILLED" || prior.status === "CONSUMED") {
        if (prior.status === "FULFILLED") this.markConsumed(prior);
        return prior.result as T;
      }
      if (prior.status === "FAILED") {
        // Binance answered and rejected it. Not ambiguous, but never silently
        // retried either: a genuine new attempt needs a new executionId.
        throw this.replayError(prior);
      }
      // REQUESTED — intent persisted, outcome never recorded. The order may or
      // may not exist on Binance. Reconcile; do not resubmit.
      throw new ExecutionStateUnknownError(
        executionId,
        typeof prior.args.newClientOrderId === "string" ? prior.args.newClientOrderId : undefined,
        "write intent was journaled but no result was recorded",
      );
    }

    // Persist intent BEFORE the host is allowed to invoke Binance. If everything
    // dies after this line, the record above is what makes the ambiguity visible
    // instead of silently losing an order.
    const record = this.journal.append({
      requestId: ctx.requestId,
      cycleId: this.cycleId,
      stepId: ctx.stepId,
      seq: ctx.seq,
      kind: "WRITE",
      executionId,
      tool: ctx.tool,
      args: ctx.args,
      argsHash: ctx.argsHash,
      status: "REQUESTED",
      requestedAt: new Date().toISOString(),
    });
    throw new RelayRequired(record);
  }

  /* ------------------------------- helpers -------------------------------- */

  private assertDeterministic(prior: RelayRecord, tool: string, argsHash: string): void {
    if (prior.tool !== tool) {
      throw new RelayNondeterminismError(
        prior.requestId,
        `recorded tool ${prior.tool}, runtime now calls ${tool}`,
      );
    }
    if (prior.argsHash !== argsHash) {
      throw new RelayNondeterminismError(
        prior.requestId,
        `recorded args ${prior.argsHash}, runtime now sends ${argsHash}`,
      );
    }
  }

  private markConsumed(prior: RelayRecord): void {
    this.journal.append({ ...prior, status: "CONSUMED" });
  }

  /** Rebuild the recorded failure so replay is deterministic. */
  private replayError(prior: RelayRecord): Error {
    const detail =
      typeof prior.error === "string" ? prior.error : JSON.stringify(prior.error ?? "unknown");
    if (detail.includes("MCP_AUTH_REQUIRED")) return new McpAuthRequiredError(detail);
    return new McpToolError(prior.tool, detail);
  }

  /** The instant a write's intent was journaled — the real submission time. */
  writeRequestedAt(executionId: string): number | undefined {
    const record = this.journal.findByExecutionId(executionId);
    if (!record) return undefined;
    const at = Date.parse(record.requestedAt);
    return Number.isFinite(at) ? at : undefined;
  }

  async close(): Promise<void> {
    /* nothing to close: the host owns the session */
  }
}
