/**
 * Sentinel CLI — everything the Agent OS host can ask Sentinel to do.
 *
 *   npm run sentinel -- guardian:schema             what Sentinel accepts
 *   npm run sentinel -- guardian:create --file <f>  validate + store a DRAFT
 *   npm run sentinel -- show                        the Guardian, readable
 *   npm run sentinel -- activate                    put the draft in force
 *   npm run sentinel -- pause | stop | resume       control status
 *   npm run sentinel -- cycle [--lab k=v,…] [--new] run one Guardian cycle
 *   npm run sentinel -- check '{"type":"reduce_position","percent":80}'
 *                                                  ALLOW / CLAMP / REJECT, no execution
 *   npm run sentinel -- metrics [--fresh] [--source] one live MetricSnapshot
 *   npm run sentinel -- status                      one-screen state
 *
 * The host never computes anything here. It calls `cycle`, and either the cycle
 * completes or it stops with EXIT_RELAY_REQUIRED and a pending envelope for the
 * host to relay. That is normal control flow, not an error.
 *
 * Exit codes are the host's contract:
 *   0   done
 *   10  RELAY_REQUIRED     — relay the pending envelope, then run `cycle` again
 *   20  EXECUTION_STATE_UNKNOWN / IDEMPOTENCY_CONFLICT / NONDETERMINISM
 *                          — STOP. Never resolve these by trading.
 *   1   ordinary failure
 */
import { validateGuardianInput, CompileError } from "@/lib/compiler/validate";
import { validateAction } from "@/lib/policy/validator";
import { guardianContract, renderContract } from "@/lib/compiler/contract";
import { readFileSync } from "node:fs";
import { GuardianStore } from "@/lib/guardian/store";
import { computeMetrics, type MetricValues } from "@/lib/metrics/engine";
import { evaluateGuardian, describeNextTrigger } from "@/lib/policy/engine";
import { runGuardianCycle, metricsReevaluator, type RuntimeEvent } from "@/lib/policy/runtime";
import { METRIC_REGISTRY, type Guardian, type MetricName } from "@/lib/policy/types";
import { McpExecutionAdapter } from "@/lib/execution/execution-adapter";
import { HostRelayInvoker, RelayRequired, IdempotencyConflictError, ExecutionStateUnknownError, RelayNondeterminismError } from "@/lib/mcp/host-relay";
import { RelayJournal } from "@/lib/mcp/journal";
import { EventStore } from "@/lib/events/store";
import { SYMBOL } from "@/lib/config";
import { buildReport, renderReport, provenanceOf } from "@/lib/metrics/report";

const EXIT_OK = 0;
const EXIT_RELAY_REQUIRED = 10;
const EXIT_HALT = 20;
const EXIT_ERROR = 1;

const argv = process.argv.slice(2);
const command = argv[0];

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const has = (name: string) => argv.includes(`--${name}`);

const store = new GuardianStore();
const journal = new RelayJournal();
const eventStore = new EventStore();

/* ------------------------------ presentation ------------------------------ */

function describeGuardian(g: Guardian, status: string): string {
  const lines: string[] = [];
  lines.push(`${g.name}  [${g.id}]`);
  lines.push(`  symbol            ${g.symbol}`);
  lines.push(`  status            ${status}`);
  lines.push(`  max reduction     ${g.maxReductionPercent}%  (hard ceiling, enforced by the Validator)`);
  lines.push("");
  for (const rule of g.rules) {
    lines.push(`  ${rule.id}  WHEN`);
    for (const c of rule.conditions) {
      const spec = METRIC_REGISTRY[c.metric as MetricName];
      const shown =
        spec && spec.kind === "number" && typeof c.value === "number"
          ? spec.describe(c.value)
          : String(c.value);
      lines.push(`        ${spec?.label ?? c.metric} ${c.operator} ${shown}`);
    }
    const pct = rule.action.percent !== undefined ? ` ${rule.action.percent}%` : "";
    lines.push(`      THEN ${rule.action.type}${pct}`);
    if (rule.action.percent !== undefined && rule.action.percent > g.maxReductionPercent) {
      lines.push(`        ! ${rule.action.percent}% exceeds the ${g.maxReductionPercent}% ceiling — will be CLAMPED to ${g.maxReductionPercent}%`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderEvent(e: RuntimeEvent): string {
  const t = new Date(e.at).toISOString().slice(11, 23);
  const pad = (s: string) => `${t}  ${s}`;
  switch (e.type) {
    case "RULE_MATCHED":
      return pad(`RULE MATCHED          ${e.guardianId} / ${e.ruleId}`);
    case "ACTION_PROPOSED":
      return pad(`ACTION PROPOSED       ${e.actionType}${e.requestedPercent !== null ? ` ${e.requestedPercent}%` : ""}`);
    case "ACTION_CLAMPED":
      return pad(`ACTION CLAMPED        ${e.requestedPercent}% -> ${e.executedPercent}%`);
    case "ACTION_REJECTED":
      return pad(`ACTION REJECTED       ${e.reason}`);
    case "EXECUTION_VALIDATED":
      return pad(`EXECUTION VALIDATED   position ${e.positionQty}  raw ${e.requestedQty.toFixed(8)}  rounded ${e.roundedQty}  reduceOnly ✓`);
    case "ORDER_SUBMITTED":
      return pad(`ORDER SUBMITTED       Binance Agent OS  orderId ${e.orderId}`);
    case "ORDER_FILLED":
      return pad(`ORDER FILLED          orderId ${e.orderId}  qty ${e.executedQty}`);
    case "POSITION_REFRESHED":
      return pad(`POSITION REFRESHED    ${e.before} -> ${e.after}`);
    case "GUARDIAN_REEVALUATING":
      return pad("GUARDIAN RE-EVALUATING");
    case "GUARDIAN_STATE_CHANGED":
      return pad(`GUARDIAN STATE        ${e.state}${e.nextTrigger ? `  next: ${e.nextTrigger}` : ""}`);
    case "EXECUTION_BLOCKED":
      return pad(`EXECUTION BLOCKED     ${e.cause}`);
    case "EXECUTION_REJECTED":
      return pad(`EXECUTION REJECTED    ${e.reason}`);
    case "EXECUTION_FAILED":
      return pad(`EXECUTION FAILED      ${e.reason}`);
    case "EXECUTION_VERIFICATION_FAILED":
      return pad(`VERIFICATION FAILED   ${e.reason}  ${e.before} -> ${e.after}`);
    case "EXECUTION_STATE_UNKNOWN":
      return pad(`EXECUTION STATE UNKNOWN  ${e.executionId}  clientOrderId ${e.clientOrderId ?? "?"}`);
    case "IDEMPOTENCY_CONFLICT":
      return pad(`IDEMPOTENCY CONFLICT  ${e.executionId}`);
    case "LAB_SCENARIO_STARTED":
      return pad(
        `LAB SCENARIO          ${e.preset ?? "custom"}   ` +
          Object.entries(e.overrides)
            .map(([k, v]) => `${k}=${v}`)
            .join("  "),
      );
    case "LAB_PROPOSAL_INJECTED":
      return pad(
        `LAB INPUT             proposal ${e.labPercent}%` +
          ` (guardian rule ${e.guardianPercent ?? "—"}%, ceiling ${e.maxReductionPercent}%)`,
      );
  }
}

/** Agent Lab: --lab funding_rate=0.00041,momentum=BEARISH */
function parseOverrides(spec: string | undefined): Partial<MetricValues> {
  if (!spec) return {};
  const out: Record<string, number | string> = {};
  for (const pair of spec.split(",")) {
    const [k, v] = pair.split("=").map((s) => s.trim());
    if (!k || v === undefined) continue;
    if (!(k in METRIC_REGISTRY)) {
      // Agent Lab simulates declared measurements only. Inventing a metric here
      // would let a scenario reference something the Metric Engine never
      // produces, which is exactly what the registry exists to prevent.
      throw new Error(
        `Unknown metric "${k}". Agent Lab may only override declared metrics: ` +
          `${Object.keys(METRIC_REGISTRY).join(", ")}`,
      );
    }
    const spec2 = METRIC_REGISTRY[k as MetricName];
    out[k] = spec2.kind === "number" ? Number(v) : v;
  }
  return out as Partial<MetricValues>;
}

/**
 * Print the pending envelope(s) and hand back the host's exit code.
 *
 * Returns rather than calling process.exit: exiting while the metric fetches'
 * sockets are still closing aborts the process on Windows (libuv async.c
 * assertion) and reports 127, which would silently corrupt the exit-code
 * contract the host depends on. Everything here sets process.exitCode and lets
 * Node drain instead.
 */
function reportPending(cycleId: string): number {
  // Scoped to this cycle on purpose. An abandoned cycle can leave requests
  // permanently REQUESTED, and handing those to the host would invite it to
  // relay a call belonging to a dead evaluation.
  const pending = journal.pending().filter((r) => r.cycleId === cycleId);
  console.log("\nRELAY_REQUIRED — Sentinel needs the host to invoke these Binance MCP calls.");
  console.log("Relay each EXACTLY as written, record the raw result, then run `cycle` again.\n");
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
    console.log(
      "\n!! WRITE PENDING — this places a REAL Binance order.\n" +
        "   Do not relay it without explicit user approval.\n" +
        "   Do not alter the tool, symbol, side, type, quantity or reduceOnly.",
    );
  }
  return EXIT_RELAY_REQUIRED;
}

/* --------------------------------- commands -------------------------------- */

async function main() {
  switch (command) {
    /* -------------------------------------------------------------------- */
    case "guardian:schema": {
      // What the host must author against. Published from the registries so a
      // skill file can never drift from what Sentinel actually accepts.
      const contract = guardianContract(SYMBOL);
      if (has("json")) {
        console.log(JSON.stringify(contract, null, 2));
      } else {
        console.log();
        console.log(renderContract(contract));
        console.log();
      }
      break;
    }

    /* -------------------------------------------------------------------- */
    case "guardian:create": {
      // The production compilation path.
      //
      //   host LLM  ->  Guardian JSON  ->  here  ->  deterministic validation
      //
      // Sentinel makes no LLM call of its own. Whoever produced the JSON is not
      // trusted: it is validated against the schema and the registries, and the
      // Guardian is stored as a DRAFT that still requires explicit activation.
      //
      // JSON arrives by file or stdin rather than as an argv string — quoting
      // JSON through a shell is fragile, and on Windows it is worse.
      let raw: string;
      const file = flag("file");
      if (file) {
        try {
          raw = readFileSync(file, "utf8");
        } catch (e) {
          console.error(`Could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
          process.exitCode = EXIT_ERROR;
          return;
        }
      } else if (argv[1] && !argv[1].startsWith("--")) {
        raw = argv[1];
      } else {
        raw = readFileSync(0, "utf8");
      }

      try {
        const result = validateGuardianInput(raw, { symbol: SYMBOL });
        // Persistence goes through Sentinel, never by the host writing state.
        store.update({ draft: result.guardian });

        console.log("\nGUARDIAN VALIDATED — stored as DRAFT (not active)\n");
        console.log(describeGuardian(result.guardian, "DRAFT"));
        if (result.warnings.length) {
          console.log("  warnings:");
          for (const w of result.warnings) console.log(`    - ${w}`);
        }
        if (result.unsupported.length) {
          console.log("  could not be expressed:");
          for (const u of result.unsupported) console.log(`    - ${u}`);
        }
        console.log("\nStored Guardian:\n");
        console.log(JSON.stringify(result.guardian, null, 2));
        console.log("\nStatus: DRAFT. Review it with the user, then activate explicitly:");
        console.log("  npm run sentinel -- activate\n");
      } catch (e) {
        if (e instanceof CompileError) {
          console.error(`\nGUARDIAN REJECTED: ${e.message}`);
          for (const i of e.issues) console.error(`  - ${i}`);
          console.error("\nNothing was stored. Correct the JSON and try again.\n");
          process.exitCode = EXIT_ERROR;
          return;
        }
        throw e;
      }
      break;
    }

    /* -------------------------------------------------------------------- */
    case "compile": {
      // Kept only as a pointer. Sentinel is Agent OS-native: the host's own LLM
      // interprets the instruction. There is no second Anthropic call here.
      console.error(
        "\n`compile` is not the Agent OS-native path.\n\n" +
          "Interpretation belongs to the host LLM. Author the Guardian JSON there,\n" +
          "then hand it to Sentinel for validation and storage:\n\n" +
          "  npm run sentinel -- guardian:schema          what Sentinel accepts\n" +
          "  npm run sentinel -- guardian:create --file guardian.json\n\n" +
          "An OPTIONAL dev adapter can still compile from text outside a host\n" +
          "(requires ANTHROPIC_API_KEY, not needed in production):\n\n" +
          "  npm run check:compiler -- \"<instruction>\"\n",
      );
      process.exitCode = EXIT_ERROR;
      return;
    }

    /* -------------------------------------------------------------------- */
    case "show": {
      const s = store.read();
      const g = s.guardian ?? s.draft;
      if (!g) {
        console.log("No Guardian.  Create one:  npm run sentinel -- guardian:create --file guardians/<name>.json");
        break;
      }
      console.log();
      console.log(describeGuardian(g, s.guardian ? s.status : "DRAFT — not active"));
      break;
    }

    /* -------------------------------------------------------------------- */
    case "activate": {
      const s = store.read();
      if (!s.draft) {
        console.error("No draft to activate. Run `compile` first.");
        process.exitCode = EXIT_ERROR;
        return;
      }
      store.update({ guardian: s.draft, draft: null, status: "ACTIVE" });
      console.log("\nGuardian ACTIVE. Deterministic runtime now owns evaluation.\n");
      console.log(describeGuardian(s.draft, "ACTIVE"));
      break;
    }

    /* -------------------------------------------------------------------- */
    case "pause": {
      store.update({ status: "PAUSED" });
      console.log("Guardian PAUSED. It will not evaluate or act.");
      break;
    }

    case "stop": {
      // Emergency stop: keep evaluating and emitting, refuse every action.
      store.update({ status: "OBSERVING" });
      console.log("EMERGENCY STOP. Guardian is OBSERVING: it still measures and");
      console.log("evaluates, but the Validator now rejects every action.");
      break;
    }

    case "resume": {
      const s = store.read();
      if (!s.guardian) {
        console.error("No active Guardian to resume.");
        process.exitCode = EXIT_ERROR;
        return;
      }
      store.update({ status: "ACTIVE" });
      console.log("Guardian ACTIVE.");
      break;
    }


    /* -------------------------------------------------------------------- */
    case "remove": {
      // Retire a Guardian.
      //
      // Pausing stops a Guardian acting; it does not remove it. Without this,
      // a policy you have finished with stays in the state file, shows up in
      // `show` and `status`, and is one `resume` away from being live again.
      //
      // Removal is deliberate rather than convenient: it refuses while a cycle
      // is in flight, and it prints the policy it removed so nothing is lost
      // that cannot be pasted back.
      const s = store.read();
      const target = s.guardian ?? s.draft;
      if (!target) {
        console.log("No Guardian to remove.");
        break;
      }
      if (s.cycle) {
        console.error(
          `Cycle ${s.cycle.cycleId} is in flight. Removing the Guardian now would\n` +
            "orphan its journalled relay requests. Finish or reset the cycle first.",
        );
        process.exitCode = EXIT_ERROR;
        return;
      }

      console.log();
      console.log(`REMOVED  ${target.id}  ${target.name}`);
      console.log();
      console.log("  Keep this if you may want it back:");
      console.log();
      console.log(
        JSON.stringify(target, null, 2)
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n"),
      );
      console.log();

      // A scenario armed against a removed Guardian is meaningless, and leaving
      // it would silently colour the first cycle of whatever replaces it.
      const hadLab = Boolean(s.lab);
      store.update({ guardian: null, draft: null, status: "PAUSED", lab: null });

      console.log("  Guardian removed. Sentinel now holds no policy and will not act.");
      if (hadLab) console.log("  The armed Agent Lab scenario was cleared with it.");
      console.log(
        "  Action history in the governor's log is kept — it is an audit record,\n" +
          "  not policy.",
      );
      console.log();
      break;
    }

    case "check": {
      // Sentinel as a risk desk.
      //
      //   another agent proposes an action
      //     -> Sentinel checks it against the user's Guardian
      //     -> ALLOW / CLAMP / REJECT
      //
      // This executes nothing. It answers "would this be permitted, and at what
      // size" — which is what lets a strategy agent, a script, or a person ask
      // permission before acting rather than discovering the limit afterwards.
      //
      // It needs the live position and exchange filters, so it goes through the
      // same relay as a cycle. That is deliberate: a verdict computed against
      // stale position data would be worse than no verdict.
      let raw: string;
      const file = flag("file");
      if (file) {
        try {
          raw = readFileSync(file, "utf8");
        } catch (e) {
          console.error(`Could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
          process.exitCode = EXIT_ERROR;
          return;
        }
      } else if (argv[1] && !argv[1].startsWith("--")) {
        raw = argv[1];
      } else {
        raw = readFileSync(0, "utf8");
      }

      let proposal: { type?: unknown; percent?: unknown };
      try {
        proposal = JSON.parse(raw.trim());
      } catch (e) {
        console.error(`Proposal is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
        process.exitCode = EXIT_ERROR;
        return;
      }

      const s = store.read();
      if (!s.guardian) {
        console.error("No active Guardian — there is no policy to check against.");
        process.exitCode = EXIT_ERROR;
        return;
      }
      const guardian = s.guardian;

      // The action is validated as written; an unknown type is rejected by the
      // Validator itself rather than being guessed at here.
      const action = {
        type: String(proposal.type ?? ""),
        ...(proposal.percent !== undefined && proposal.percent !== null
          ? { percent: Number(proposal.percent) }
          : {}),
      } as Parameters<typeof validateAction>[0];

      const cycle = store.beginCycle({}, has("new"));
      const relay = new HostRelayInvoker({ cycleId: cycle.cycleId, journal });
      const adapter = new McpExecutionAdapter(relay, guardian.symbol);

      try {
        const reads = await Promise.allSettled([
          adapter.getPosition(guardian.symbol, "POSITION_BEFORE"),
          adapter.getExchangeFilters(guardian.symbol, "FILTERS"),
        ]);
        if (reads.some((r) => r.status === "rejected" && r.reason instanceof RelayRequired)) {
          process.exitCode = reportPending(cycle.cycleId);
          return;
        }
        for (const r of reads) if (r.status === "rejected") throw r.reason;
        const position = (reads[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof adapter.getPosition>>>).value;
        const filters = (reads[1] as PromiseFulfilledResult<Awaited<ReturnType<typeof adapter.getExchangeFilters>>>).value;

        const verdict = validateAction(action, {
          guardian,
          status: s.status,
          position,
          filters,
        });

        const asJson = has("json");
        if (asJson) {
          console.log(JSON.stringify({
            verdict: verdict.resolution,
            allowed: verdict.allowed,
            reason: verdict.reason ?? null,
            requestedPercent: verdict.requestedPercent ?? null,
            maxAllowedPercent: verdict.maxAllowedPercent ?? null,
            executedPercent: verdict.executedPercent ?? null,
            quantity: verdict.quantity?.steppedQty ?? null,
            side: verdict.side ?? null,
            guardian: guardian.id,
            symbol: guardian.symbol,
            positionBefore: position.positionAmt,
            positionAfter: verdict.quantity
              ? Number((Math.abs(position.positionAmt) - Number(verdict.quantity.steppedQty)).toFixed(8))
              : position.positionAmt,
          }, null, 2));
        } else {
          console.log();
          console.log(`RISK CHECK — ${guardian.id} on ${guardian.symbol}`);
          console.log();
          console.log(`  proposed        ${action.type}${action.percent !== undefined ? ` ${action.percent}%` : ""}`);
          console.log(`  policy ceiling  ${guardian.maxReductionPercent}%`);
          console.log(`  position        ${position.positionAmt} ETH`);
          console.log();
          console.log(`  VERDICT         ${verdict.resolution}${verdict.reason ? `  (${verdict.reason})` : ""}`);
          if (verdict.quantity) {
            console.log(`  permitted       ${verdict.executedPercent}%  =  ${verdict.quantity.steppedQty} ETH  ${verdict.side} reduceOnly`);
            console.log(`  would leave     ${(Math.abs(position.positionAmt) - Number(verdict.quantity.steppedQty)).toFixed(3)} ETH`);
          }
          console.log();
          for (const c of verdict.checks) {
            console.log(`    ${c.passed ? "ok " : "NO "} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
          }
          console.log();
          console.log("  Nothing was executed. This is a verdict, not an order.");
          console.log();
        }

        // Exit code is the verdict, so a caller can branch without parsing.
        process.exitCode =
          verdict.resolution === "EXECUTE" ? 0 : verdict.resolution === "CLAMPED" ? 11 : 12;
        store.endCycle();
        return;
      } catch (e) {
        if (e instanceof RelayRequired) {
          process.exitCode = reportPending(cycle.cycleId);
          return;
        }
        throw e;
      }
    }

    /* -------------------------------------------------------------------- */
    case "metrics": {
      // Reads position/account through the relay and market data from public
      // Binance. Uses the same cycle machinery as `cycle`, so the snapshot it
      // prints is the *frozen* one: running this during a live cycle shows
      // exactly what the Policy Engine is evaluating, not a fresher reading.
      const cycle = store.beginCycle({}, has("fresh"));
      const relay = new HostRelayInvoker({ cycleId: cycle.cycleId, journal });
      const adapter = new McpExecutionAdapter(relay, SYMBOL);
      const startedOwnCycle = store.read().cycle?.cycleId === cycle.cycleId && !cycle.snapshot;

      try {
        const reads = await Promise.allSettled([
          adapter.getPosition(SYMBOL, "POSITION_BEFORE"),
          adapter.getAccountState("ACCOUNT"),
        ]);
        if (reads.some((r) => r.status === "rejected" && r.reason instanceof RelayRequired)) {
          process.exitCode = reportPending(cycle.cycleId);
          return;
        }
        for (const r of reads) if (r.status === "rejected") throw r.reason;
        const position = (reads[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof adapter.getPosition>>>).value;
        const account = (reads[1] as PromiseFulfilledResult<Awaited<ReturnType<typeof adapter.getAccountState>>>).value;

        let snapshot = store.read().cycle?.snapshot ?? null;
        if (!snapshot) {
          snapshot = await computeMetrics({
            symbol: SYMBOL,
            position,
            account,
            overrides: cycle.overrides,
          });
          store.recordSnapshot(snapshot);
        }

        const report = buildReport(snapshot);
        console.log();
        console.log(renderReport(report));
        if (has("source")) {
          console.log("\nPROVENANCE");
          for (const [field, source] of Object.entries(provenanceOf(report))) {
            console.log(`  ${field.padEnd(28)}${source}`);
          }
        }
        console.log();
        // Only tear down a cycle this command created; never one mid-flight.
        if (startedOwnCycle && !store.read().guardian) store.endCycle();
        process.exitCode = EXIT_OK;
        return;
      } catch (e) {
        if (e instanceof RelayRequired) {
          process.exitCode = reportPending(cycle.cycleId);
          return;
        }
        throw e;
      }
    }

    /* -------------------------------------------------------------------- */
    case "status": {
      const s = store.read();
      const pending = journal.pending();
      console.log();
      console.log(`SENTINEL  ${s.guardian ? s.status : s.draft ? "DRAFT" : "NO GUARDIAN"}`);
      console.log(`  symbol          ${SYMBOL}`);
      console.log(`  guardian        ${s.guardian?.id ?? s.draft?.id ?? "—"}`);
      console.log(`  cycle           ${s.cycle?.cycleId ?? "idle"}`);
      if (s.cycle?.overrides && Object.keys(s.cycle.overrides).length) {
        console.log(`  agent lab       ${JSON.stringify(s.cycle.overrides)}`);
      }
      if (s.cycle?.lab?.proposedPercent != null) {
        console.log(`  lab proposal    ${s.cycle.lab.proposedPercent}%  (test input, validator still decides)`);
      }
      if (s.lab && !s.cycle) {
        console.log(`  lab armed       ${s.lab.preset ?? "custom"}  ${JSON.stringify(s.lab.overrides)}`);
      }
      console.log(`  relay pending   ${pending.length}`);
      for (const p of pending) console.log(`      ${p.kind}  ${p.stepId}  ${p.tool}`);
      console.log();
      break;
    }

    /* -------------------------------------------------------------------- */
    case "cycle": {
      const s = store.read();
      if (!s.guardian) {
        console.error("No active Guardian. Run `compile` then `activate`.");
        process.exitCode = EXIT_ERROR;
        return;
      }
      const guardian = s.guardian;

      const overrides = has("lab") ? parseOverrides(flag("lab")) : undefined;
      const cycle = store.beginCycle(overrides ?? {}, has("new"));
      const relay = new HostRelayInvoker({ cycleId: cycle.cycleId, journal });
      const adapter = new McpExecutionAdapter(relay, guardian.symbol);

      console.log(`\nCYCLE ${cycle.cycleId}   guardian ${guardian.id}   status ${s.status}`);
      if (Object.keys(cycle.overrides).length) {
        console.log(`AGENT LAB — simulating market inputs: ${JSON.stringify(cycle.overrides)}`);
        if (cycle.lab?.proposedPercent != null) {
          console.log(
            `AGENT LAB — test proposal ${cycle.lab.proposedPercent}% ` +
              `(the Guardian's ceiling stays ${guardian.maxReductionPercent}%; the Validator decides)`,
          );
        }
        console.log("(the market event is simulated; the trade is not)");
      }

      try {
        // --- account-side reads, issued together so one host turn covers all ---
        // POSITION_BEFORE is deliberate: submitVerifiedReduction re-reads that
        // same step later and replays this result instead of costing a turn.
        const reads = await Promise.allSettled([
          adapter.getPosition(guardian.symbol, "POSITION_BEFORE"),
          adapter.getAccountState("ACCOUNT"),
          adapter.getExchangeFilters(guardian.symbol, "FILTERS"),
        ]);
        const relayNeeded = reads.some(
          (r) => r.status === "rejected" && r.reason instanceof RelayRequired,
        );
        if (relayNeeded) {
          process.exitCode = reportPending(cycle.cycleId);
          return;
        }
        for (const r of reads) {
          if (r.status === "rejected") throw r.reason;
        }
        const [position, account, filters] = [
          (reads[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof adapter.getPosition>>>).value,
          (reads[1] as PromiseFulfilledResult<Awaited<ReturnType<typeof adapter.getAccountState>>>).value,
          (reads[2] as PromiseFulfilledResult<Awaited<ReturnType<typeof adapter.getExchangeFilters>>>).value,
        ];

        // --- measurements: taken once per cycle, then frozen ------------------
        let snapshot = store.read().cycle?.snapshot ?? null;
        if (!snapshot) {
          snapshot = await computeMetrics({
            symbol: guardian.symbol,
            position,
            account,
            overrides: cycle.overrides,
          });
          store.recordSnapshot(snapshot);
        }

        const preview = evaluateGuardian(guardian, snapshot);
        console.log(`\nMETRICS  ${Object.entries(snapshot.effective)
          .filter(([k]) => ["momentum", "funding_rate", "oi_change_percent", "position_size"].includes(k))
          .map(([k, v]) => `${k}=${METRIC_REGISTRY[k as MetricName].describe(v)}`)
          .join("  ")}`);
        if (!preview.firedRule) {
          console.log(`\nNo rule matched. ${describeNextTrigger(preview) ?? ""}`);
          store.endCycle();
          process.exitCode = EXIT_OK;
          return;
        }

        // --- the cycle itself -------------------------------------------------
        const emitted: RuntimeEvent[] = [];
        const activeLab = store.read().cycle?.lab ?? null;
        const result = await runGuardianCycle({
          guardian,
          status: s.status,
          cycleId: cycle.cycleId,
          // Read from the CYCLE, not from the armed scenario: a RESET TO LIVE
          // between host turns must not change what this cycle is doing.
          lab: activeLab
            ? {
                preset: activeLab.preset,
                overrides: activeLab.overrides as Record<string, number | string>,
                proposedPercent: activeLab.proposedPercent,
              }
            : undefined,
          filters,
          snapshot,
          adapter,
          reevaluate: metricsReevaluator({
            guardian,
            symbol: guardian.symbol,
            account,
            candles: snapshot.sources.candles,
            overrides: cycle.overrides,
          }),
          // Persisted first, printed second: the feed renders the stored
          // record, so anything the CLI shows must already be on disk.
          emit: eventStore.sink(cycle.cycleId, (e) => {
            emitted.push(e);
            console.log(renderEvent(e));
          }),
        });

        console.log(`\nTERMINAL  ${result.terminal}`);
        if (result.terminal === "EXECUTION_STATE_UNKNOWN" || result.terminal === "IDEMPOTENCY_CONFLICT") {
          console.log(
            "\nSTOP. Do NOT submit another order to resolve this.\n" +
              "  npm run relay -- reconcile <executionId>",
          );
          process.exitCode = EXIT_HALT;
          return;
        }
        store.endCycle();
        process.exitCode = EXIT_OK;
        return;
      } catch (e) {
        // RelayRequired is orchestration, not failure: the runtime paused
        // because it needs the host to invoke a Binance tool.
        if (e instanceof RelayRequired) {
          process.exitCode = reportPending(cycle.cycleId);
          return;
        }
        if (e instanceof ExecutionStateUnknownError || e instanceof IdempotencyConflictError) {
          console.error(`\n${e.message}\n\nSTOP. Never resolve this by trading. Reconcile instead.`);
          process.exitCode = EXIT_HALT;
          return;
        }
        if (e instanceof RelayNondeterminismError) {
          console.error(`\n${e.message}\n\nSTOP. The runtime diverged from its own journal.`);
          process.exitCode = EXIT_HALT;
          return;
        }
        throw e;
      }
    }

    /* -------------------------------------------------------------------- */
    default:
      console.log(
        "Sentinel — an autonomous position-risk Guardian.\n\n" +
          "  guardian:schema             the contract a Guardian must satisfy\n" +
          "  guardian:create --file <f>  validate a policy file into a draft\n" +
          '  compile "<instruction>"     compile plain language into a draft (needs an API key)\n' +
          "  show                        the Guardian, readable\n" +
          "  activate                    put the reviewed draft in force\n" +
          "  pause | stop | resume       control\n" +
          "  remove                      retire the Guardian entirely\n" +
          "  check <proposal> [--json]   would this action be permitted, and at what size\n" +
          "  cycle [--lab k=v,…] [--new] run one evaluation\n" +
          "  metrics [--source]          current measurements\n" +
          "  status                      current state\n",
      );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = EXIT_ERROR;
        return;
});
