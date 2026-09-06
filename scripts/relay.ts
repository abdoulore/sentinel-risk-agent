/**
 * Relay CLI — the host's entire interface to Sentinel.
 *
 * Claude Code is deliberately boring here. It reads a pending envelope, invokes
 * exactly that Binance MCP tool with exactly those arguments, and records the
 * raw result. It decides nothing: not whether the Guardian fires, not the
 * percentage, quantity, rounding, side, clamp, or whether execution is allowed.
 *
 *   npm run relay -- pending            what does Sentinel need invoked?
 *   npm run relay -- fulfill <id> --file result.json
 *   npm run relay -- fail    <id> --error "..."
 *   npm run relay -- show    [--cycle <id>]
 *   npm run relay -- reconcile <executionId>
 *   npm run relay -- reconcile-resolve <executionId> --file order.json | --absent
 */
import { readFileSync } from "node:fs";
import { RelayJournal, type RelayRecord } from "@/lib/mcp/journal";
import {
  applyReconciliation,
  planReconciliation,
  ReconciliationError,
} from "@/lib/mcp/reconcile";

const argv = process.argv.slice(2);
const command = argv[0];

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return argv.includes(`--${name}`);
}
function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const journal = new RelayJournal();

/** Read a JSON payload from --file or --json. */
function payload(): unknown {
  const file = flag("file");
  if (file) return JSON.parse(readFileSync(file, "utf8"));
  const inline = flag("json");
  if (inline) return JSON.parse(inline);
  die("provide the raw MCP result with --file <path> or --json '<raw>'");
}

function describe(r: RelayRecord): string {
  const mark = { REQUESTED: "…", FULFILLED: "✓", CONSUMED: "·", FAILED: "✗" }[r.status];
  const exec = r.executionId ? `  exec=${r.executionId}` : "";
  return `  ${mark} [${r.status}] ${r.stepId}  ${r.tool}${exec}`;
}

switch (command) {
  /* --------------------------------------------------------------------- */
  case "pending": {
    const pending = journal.pending();
    if (pending.length === 0) {
      console.log("No pending relay requests.");
      break;
    }
    // The envelope, and nothing but the envelope.
    console.log(
      JSON.stringify(
        pending.map((r) => ({
          requestId: r.requestId,
          kind: r.kind,
          executionId: r.executionId,
          tool: r.tool,
          args: r.args,
        })),
        null,
        2,
      ),
    );
    if (pending.some((r) => r.kind === "WRITE")) {
      console.error(
        "\n!! A WRITE is pending. It places a REAL order. Relay it only with " +
          "explicit user approval, exactly as written — no substitutions.",
      );
    }
    break;
  }

  /* --------------------------------------------------------------------- */
  case "fulfill": {
    const requestId = argv[1] ?? die("usage: relay fulfill <requestId> --file <path>");
    const record = journal.findByRequestId(requestId);
    if (!record) die(`unknown requestId: ${requestId}`);
    if (record.status !== "REQUESTED") {
      die(`request ${requestId} is already ${record.status}; refusing to overwrite`);
    }
    const result = payload();
    journal.fulfill(requestId, result);
    console.log(`Recorded result for ${requestId} (${record.tool}).`);
    break;
  }

  /* --------------------------------------------------------------------- */
  case "fail": {
    const requestId = argv[1] ?? die("usage: relay fail <requestId> --error <msg>");
    const record = journal.findByRequestId(requestId);
    if (!record) die(`unknown requestId: ${requestId}`);
    const error = flag("error") ?? die("provide --error <msg>");
    if (record.kind === "WRITE" && !has("confirm-not-submitted")) {
      die(
        "Refusing to mark a WRITE as failed without --confirm-not-submitted.\n" +
          "If Binance may have accepted the order, do NOT fail it — reconcile:\n" +
          `  npm run relay -- reconcile ${record.executionId ?? "<executionId>"}`,
      );
    }
    journal.fail(requestId, error);
    console.log(`Recorded failure for ${requestId}.`);
    break;
  }

  /* --------------------------------------------------------------------- */
  case "show": {
    const cycle = flag("cycle");
    const records = cycle ? journal.cycle(cycle) : [...journal.fold().values()];
    if (records.length === 0) {
      console.log("Journal is empty.");
      break;
    }
    const byCycle = new Map<string, RelayRecord[]>();
    for (const r of records) {
      byCycle.set(r.cycleId, [...(byCycle.get(r.cycleId) ?? []), r]);
    }
    for (const [cycleId, rs] of byCycle) {
      console.log(`\n${cycleId}`);
      for (const r of rs.sort((a, b) => a.seq - b.seq)) console.log(describe(r));
    }
    console.log();
    break;
  }

  /* --------------------------------------------------------------------- */
  case "reconcile": {
    const executionId = argv[1] ?? die("usage: relay reconcile <executionId>");
    const plan = planReconciliation(journal, executionId);
    if (!plan) {
      console.log(`${executionId} is not in an ambiguous state — nothing to reconcile.`);
      break;
    }
    console.log(
      "EXECUTION_STATE_UNKNOWN — order intent was journaled but no result was.\n" +
        "Binance may or may not hold this order. Do NOT submit anything.\n" +
        "Relay exactly this read, then pass the answer back:\n",
    );
    console.log(JSON.stringify({ tool: plan.tool, args: plan.args }, null, 2));
    console.log(
      `\n  found    → npm run relay -- reconcile-resolve ${executionId} --file order.json` +
        `\n  no such order → npm run relay -- reconcile-resolve ${executionId} --absent`,
    );
    break;
  }

  /* --------------------------------------------------------------------- */
  case "reconcile-resolve": {
    const executionId = argv[1] ?? die("usage: relay reconcile-resolve <executionId> …");
    const plan = planReconciliation(journal, executionId);
    if (!plan) die(`${executionId} is not awaiting reconciliation`);

    try {
      const outcome = has("absent")
        ? applyReconciliation(journal, plan, {
            ok: false,
            error: flag("error") ?? "-2013 Order does not exist",
          })
        : applyReconciliation(journal, plan, {
            ok: true,
            order: payload() as Record<string, unknown>,
          });

      if (outcome.state === "ORDER_EXISTS") {
        console.log(
          `Reconciled: the order EXISTS on Binance.\n` +
            `Recorded as the result of ${outcome.record.requestId}. Replays will ` +
            `return this fill and will not resubmit.`,
        );
      } else if (outcome.state === "ORDER_ABSENT") {
        console.log(
          `Reconciled: the order never reached Binance.\n` +
            `${outcome.record.requestId} marked failed. The Guardian may act again ` +
            `under a NEW executionId — this one stays spent.`,
        );
      } else {
        console.log("Nothing to reconcile.");
      }
    } catch (e) {
      if (e instanceof ReconciliationError) die(e.message);
      throw e;
    }
    break;
  }

  /* --------------------------------------------------------------------- */
  default:
    console.log(
      "Sentinel relay — the host relays, it does not decide.\n\n" +
        "  pending                                   envelopes awaiting invocation\n" +
        "  fulfill <requestId> --file <path>         record the raw MCP result\n" +
        "  fail <requestId> --error <msg>            record an invocation failure\n" +
        "  show [--cycle <id>]                       audit trail\n" +
        "  reconcile <executionId>                   settle an ambiguous write\n" +
        "  reconcile-resolve <executionId> …         apply the reconciliation answer\n",
    );
}
