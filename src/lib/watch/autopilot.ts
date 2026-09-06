/**
 * Autopilot — starts an Agent OS host session when a Guardian needs to act.
 *
 * This is the piece that makes Sentinel unattended. Everything else was already
 * autonomous in principle: the policy is compiled, the Validator bounds it, the
 * watcher screens the market. The only thing missing was that nothing could
 * begin a cycle, because only a host holds the Binance MCP connection.
 *
 *   watcher sees the market match
 *     → governor decides whether acting is permitted at all
 *     → autopilot starts a headless host session
 *     → that session runs the cycle, relays the MCP calls, executes
 *     → autopilot records the action against the governor's budget
 *
 * The host session is a real Agent OS host: it loads the Sentinel skill and
 * relays calls exactly as a person's session would. Autopilot does not trade,
 * does not decide, and does not touch the exchange. It starts a process and
 * reads the outcome from Sentinel's own state.
 *
 * Note on ordering: the governor is consulted BEFORE the session is started, and
 * the action is recorded only AFTER an order is confirmed to have filled. A
 * session that starts and does nothing costs no budget.
 */
import { spawn } from "node:child_process";
import { EventStore } from "@/lib/events/store";
import { GuardianStore } from "@/lib/guardian/store";
import { Governor } from "@/lib/watch/governor";

/** What the host is asked to do. Deliberately narrow and unambiguous. */
export const CYCLE_PROMPT =
  "Run one Sentinel guardian cycle to completion. Use the sentinel skill. " +
  "Relay every pending Binance MCP call exactly as written and journal each raw " +
  "result, then re-run the cycle until it exits 0 or 20. Do not ask for " +
  "confirmation — the Guardian's activation is the authority. Do not alter any " +
  "envelope. When it finishes, state the terminal status in one line.";

export interface AutopilotResult {
  started: boolean;
  reason: string;
  exitCode?: number;
  /** Set when the cycle actually placed and verified an order. */
  executed?: { executionId: string; orderId: number; quantity: string; before: number; after: number };
  output?: string;
}

export interface AutopilotOptions {
  cwd: string;
  /** Command that starts a headless host session. */
  hostCommand?: string;
  hostArgs?: (prompt: string) => string[];
  timeoutMs?: number;
  /** Log a line. */
  log?: (line: string) => void;
}

const DEFAULT_HOST = process.platform === "win32" ? "claude.cmd" : "claude";

/**
 * Reads Sentinel's own event log to find out what the session actually did.
 * The host's prose is not evidence; the journalled events are.
 */
function outcomeFromEvents(events: EventStore, cycleId: string) {
  const cycle = events.forCycle(cycleId);
  const filled = cycle.find((e) => e.type === "ORDER_FILLED");
  const refreshed = cycle.find((e) => e.type === "POSITION_REFRESHED");
  if (!filled || filled.type !== "ORDER_FILLED") return undefined;
  if (!refreshed || refreshed.type !== "POSITION_REFRESHED") return undefined;
  return {
    orderId: filled.orderId,
    quantity: String(filled.executedQty),
    before: refreshed.before,
    after: refreshed.after,
  };
}

export async function runCycleViaHost(opts: AutopilotOptions): Promise<AutopilotResult> {
  const log = opts.log ?? (() => {});
  const store = new GuardianStore();
  const events = new EventStore();
  const governor = new Governor();

  const state = store.read();
  if (!state.guardian) return { started: false, reason: "NO_GUARDIAN" };
  if (state.status !== "ACTIVE") return { started: false, reason: `GUARDIAN_${state.status}` };
  if (state.cycle) {
    // A cycle already in flight means a previous session is mid-relay. Starting
    // a second host would race it onto the same journal.
    return { started: false, reason: "CYCLE_IN_FLIGHT" };
  }

  const verdict = governor.decide(state.guardian.id);
  if (!verdict.allow) {
    return { started: false, reason: verdict.reason, output: verdict.detail };
  }

  log(`starting host session (${verdict.remainingToday} action(s) left today)`);

  const cmd = opts.hostCommand ?? DEFAULT_HOST;
  const args = (opts.hostArgs ?? ((p: string) => ["-p", p]))(CYCLE_PROMPT);

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, shell: process.platform === "win32" });
    let done = false;
    const finish = (code: number) => {
      if (!done) { done = true; resolve(code); }
    };
    child.stdout?.on("data", (d) => log(`  host: ${String(d).trim().slice(0, 200)}`));
    child.stderr?.on("data", (d) => log(`  host!: ${String(d).trim().slice(0, 200)}`));
    child.on("error", (e) => { log(`  host failed to start: ${e.message}`); finish(-1); });
    child.on("close", (code) => finish(code ?? -1));
    const t = setTimeout(() => { child.kill(); log("  host session timed out"); finish(-2); },
      opts.timeoutMs ?? 10 * 60_000);
    child.on("close", () => clearTimeout(t));
  });

  // The session may have started a cycle and left it recorded even if the
  // process exited oddly, so read state rather than trusting the exit code.
  // A completed cycle clears itself, so fall back to the newest logged event.
  const after = store.read();
  const recent = events.recent(400);
  const lastCycle: string | undefined =
    after.cycle?.cycleId ?? recent[recent.length - 1]?.cycleId;

  if (!lastCycle) return { started: true, reason: "NO_CYCLE_RECORDED", exitCode };

  const outcome = outcomeFromEvents(events, lastCycle);
  if (!outcome) {
    return { started: true, reason: "NO_ORDER", exitCode };
  }

  const executionId = `${after.guardian?.id ?? state.guardian.id}:auto:${lastCycle}`;
  governor.record({
    guardianId: state.guardian.id,
    executionId,
    orderId: outcome.orderId,
    quantity: outcome.quantity,
  });

  return {
    started: true,
    reason: "EXECUTED",
    exitCode,
    executed: { executionId, ...outcome },
  };
}
