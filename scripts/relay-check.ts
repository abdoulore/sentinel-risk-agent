/**
 * Host-relay checks — the Agent OS bridge, exercised end to end against a
 * temporary journal and a fake host. No network, no credentials, and the live
 * ETHUSDC fixture is never touched.
 *
 *   npm run check:relay
 *
 * What this is really testing is the boundary contract: that the runtime hands
 * the host an exact envelope, that the host cannot change it, and that replay
 * can never resubmit an order or re-serve a stale position read.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  HostRelayInvoker,
  RelayRequired,
  IdempotencyConflictError,
  ExecutionStateUnknownError,
  RelayNondeterminismError,
} from "@/lib/mcp/host-relay";
import { RelayJournal, clientOrderIdFor, hashArgs, canonicalize } from "@/lib/mcp/journal";
import {
  planReconciliation,
  applyReconciliation,
  ReconciliationError,
} from "@/lib/mcp/reconcile";
import {
  McpExecutionAdapter,
  submitVerifiedReduction,
  type ReducePositionInput,
} from "@/lib/execution/execution-adapter";
import { runGuardianCycle, type RuntimeEvent } from "@/lib/policy/runtime";
import { validateAction } from "@/lib/policy/validator";
import type { Guardian } from "@/lib/policy/types";
import type { SymbolFilters } from "@/lib/binance/filters";
import type { PositionState } from "@/lib/binance/account";
import type { MetricSnapshot } from "@/lib/metrics/engine";

let failed = false;
function pass(name: string, detail = "") {
  console.log(`  [ok]   ${name}${detail ? ` - ${detail}` : ""}`);
}
function fail(name: string, detail = "") {
  failed = true;
  console.log(`  [FAIL] ${name}${detail ? ` - ${detail}` : ""}`);
}
function check(name: string, cond: boolean, detail = "") {
  if (cond) pass(name, detail);
  else fail(name, detail);
}
function section(title: string) {
  console.log(`\n${title}`);
}

/* --------------------------------- fixtures -------------------------------- */

const SYMBOL = "ETHUSDC";

const FILTERS: SymbolFilters = {
  symbol: SYMBOL,
  tickSize: "0.01",
  stepSize: "0.001",
  minQty: "0.001",
  maxQty: "8000",
  marketStepSize: "0.001",
  marketMinQty: "0.001",
  marketMaxQty: "700",
  minNotional: "20",
  pricePrecision: 2,
  quantityPrecision: 3,
  fetchedAt: Date.now(),
};

function position(amt: number): PositionState {
  return {
    symbol: SYMBOL,
    positionAmt: amt,
    side: amt > 0 ? "LONG" : amt < 0 ? "SHORT" : "FLAT",
    entryPrice: 2416.56,
    markPrice: 2497.64,
    liquidationPrice: 1758.42,
    notional: Math.abs(amt) * 2497.64,
    unrealizedPnl: 0.73,
    unrealizedPnlPercent: 16.1,
    liquidationDistancePercent: 29.6,
    leverage: 5,
    marginType: "cross",
    positionInitialMargin: 4.49,
    maintMargin: 0.09,
    updateTime: Date.now(),
  };
}

/** Raw MCP position row, as Binance returns it. */
function rawPosition(amt: number) {
  return [
    {
      symbol: SYMBOL,
      positionAmt: String(amt),
      entryPrice: "2416.56",
      markPrice: "2497.64",
      liquidationPrice: "1758.42",
      unRealizedProfit: "0.73",
      notional: String(Math.abs(amt) * 2497.64),
      leverage: "5",
      marginType: "cross",
      updateTime: Date.now(),
    },
  ];
}

function rawOrder(over: Record<string, unknown> = {}) {
  return {
    orderId: 987654321,
    clientOrderId: "SENTINEL-abc",
    symbol: SYMBOL,
    side: "SELL",
    status: "FILLED",
    origQty: "0.002",
    executedQty: "0.002",
    avgPrice: "2497.64",
    cumQuote: "4.99",
    reduceOnly: true,
    updateTime: Date.now(),
    ...over,
  };
}

const GUARDIAN: Guardian = {
  id: "G-ETH-03",
  name: "ETH Defensive Guardian",
  symbol: SYMBOL,
  mode: "guarded",
  maxReductionPercent: 30,
  rules: [
    {
      id: "R1",
      conditions: [
        { metric: "funding_rate", operator: ">", value: 0.0003 },
        { metric: "momentum", operator: "==", value: "BEARISH" },
      ],
      action: { type: "reduce_position", percent: 60 },
    },
  ],
};

function snapshot(pos: PositionState): MetricSnapshot {
  const values = {
    momentum: "BEARISH",
    funding_rate: 0.00041,
    funding_direction: "RISING",
    open_interest: 1_000_000,
    oi_change_percent: 11,
    unrealized_pnl: pos.unrealizedPnl,
    unrealized_pnl_percent: pos.unrealizedPnlPercent,
    liquidation_distance_percent: pos.liquidationDistancePercent,
    position_size: Math.abs(pos.positionAmt),
    leverage: pos.leverage,
    margin_ratio: 0.013,
  };
  return {
    at: Date.now(),
    symbol: SYMBOL,
    live: values,
    effective: values,
    overrides: {},
    sources: {
      candles: [],
      momentum: null,
      funding: { lastFundingRate: 0.00041, direction: "RISING" } as never,
      openInterest: { openInterest: 1_000_000, changePercent: 11 } as never,
      position: pos,
      account: { marginRatio: 0.013 } as never,
    },
  } as MetricSnapshot;
}

/* ------------------------------- fake host --------------------------------- */

/**
 * Stands in for Claude Code. It does exactly what the real skill is allowed to
 * do: take the envelope, invoke that tool with those arguments, record the raw
 * result. It never inspects or alters the arguments.
 */
class FakeHost {
  readonly relayed: { tool: string; args: Record<string, unknown> }[] = [];
  constructor(
    private readonly journal: RelayJournal,
    private readonly handlers: Record<string, (args: Record<string, unknown>) => unknown>,
    /**
     * When true, a request this host has no handler for is left untouched in
     * REQUESTED — which is what a host that died mid-turn actually leaves
     * behind. The default (false) records an explicit FAILED, which is what a
     * host that *did* invoke the tool and got an error leaves behind. The two
     * are very different states and the relay must treat them differently.
     */
    private readonly leaveUnhandledPending = false,
  ) {}

  /** Fulfil every pending request. Returns how many it relayed. */
  drain(): number {
    const pending = this.journal.pending();
    for (const req of pending) {
      this.relayed.push({ tool: req.tool, args: req.args });
      const handler = this.handlers[req.tool];
      if (!handler) {
        if (this.leaveUnhandledPending) {
          this.relayed.pop(); // it was never actually relayed
          continue;
        }
        this.journal.fail(req.requestId, `no handler for ${req.tool}`);
        continue;
      }
      try {
        this.journal.fulfill(req.requestId, handler(req.args));
      } catch (e) {
        this.journal.fail(req.requestId, e instanceof Error ? e.message : String(e));
      }
    }
    return pending.length;
  }

  callsTo(tool: string) {
    return this.relayed.filter((r) => r.tool === tool);
  }
}

/**
 * Drive a relay-backed operation to completion across simulated host turns.
 * Each RelayRequired is a turn boundary — exactly how the real skill works.
 */
async function driveToCompletion<T>(
  run: () => Promise<T>,
  host: FakeHost,
  maxTurns = 12,
): Promise<T> {
  for (let turn = 0; turn < maxTurns; turn++) {
    try {
      return await run();
    } catch (e) {
      if (e instanceof RelayRequired) {
        host.drain();
        continue;
      }
      throw e;
    }
  }
  throw new Error(`did not settle within ${maxTurns} host turns`);
}

/* ---------------------------------- setup ---------------------------------- */

const dir = mkdtempSync(join(tmpdir(), "sentinel-relay-"));
const journalPath = () => join(dir, `journal-${jn}.jsonl`);
let jn = 0;
function freshJournal(): RelayJournal {
  jn += 1;
  return new RelayJournal(journalPath());
}

async function main() {
  /* ======================================================================== */
  section("1. The envelope handed to the host is exact");

  {
    const journal = freshJournal();
    const relay = new HostRelayInvoker({ cycleId: "cycle-1", journal });
    const adapter = new McpExecutionAdapter(relay, SYMBOL);

    let envelope: ReturnType<RelayRequired["envelope"]["valueOf"]> | null = null;
    try {
      await adapter.getPosition(SYMBOL, "POSITION_BEFORE");
      fail("read without a recorded result throws RelayRequired");
    } catch (e) {
      if (e instanceof RelayRequired) {
        envelope = e.envelope as never;
        pass("read without a recorded result throws RelayRequired");
      } else fail("read throws RelayRequired", String(e));
    }

    const env = envelope as unknown as { tool: string; args: Record<string, unknown>; kind: string };
    check("envelope names the exact MCP tool", env.tool === "futures_usds_positionInformationV2", env.tool);
    check("envelope carries the exact args", canonicalize(env.args) === canonicalize({ symbol: SYMBOL }), canonicalize(env.args));
    check("read is classified READ", env.kind === "READ", env.kind);
    check("intent is persisted before the host acts", journal.pending().length === 1);
  }

  /* ======================================================================== */
  section("2. Reads are cycle+step scoped, never keyed by (tool, args)");

  {
    const journal = freshJournal();
    // Same tool, same args, different step — must be two distinct live reads.
    let served = 0;
    const host = new FakeHost(journal, {
      futures_usds_positionInformationV2: () => rawPosition(served++ === 0 ? 0.009 : 0.007),
    });

    const relay = new HostRelayInvoker({ cycleId: "cycle-2", journal });
    const adapter = new McpExecutionAdapter(relay, SYMBOL);

    const before = await driveToCompletion(
      () => adapter.getPosition(SYMBOL, "POSITION_BEFORE"),
      host,
    );
    // A fresh invoker = a fresh replay of the same cycle, as a re-run would be.
    const relay2 = new HostRelayInvoker({ cycleId: "cycle-2", journal });
    const adapter2 = new McpExecutionAdapter(relay2, SYMBOL);
    const after = await driveToCompletion(
      () => adapter2.getPosition(SYMBOL, "POSITION_AFTER"),
      host,
    );

    check("POSITION_BEFORE and POSITION_AFTER are distinct requests", journal.fold().size >= 2);
    check("POSITION_BEFORE served 0.009", before.positionAmt === 0.009, String(before.positionAmt));
    check(
      "POSITION_AFTER served a FRESH read, not the cached 0.009",
      after.positionAmt === 0.007,
      String(after.positionAmt),
    );
    check(
      "the host was invoked twice for the same tool+args",
      host.callsTo("futures_usds_positionInformationV2").length === 2,
      String(host.callsTo("futures_usds_positionInformationV2").length),
    );
  }

  {
    const journal = freshJournal();
    const host = new FakeHost(journal, {
      futures_usds_positionInformationV2: () => rawPosition(0.009),
    });
    const relay = new HostRelayInvoker({ cycleId: "cycle-3", journal });
    const adapter = new McpExecutionAdapter(relay, SYMBOL);
    await driveToCompletion(() => adapter.getPosition(SYMBOL, "POSITION_BEFORE"), host);

    // Replaying the SAME step must not re-invoke the host.
    const relay2 = new HostRelayInvoker({ cycleId: "cycle-3", journal });
    const adapter2 = new McpExecutionAdapter(relay2, SYMBOL);
    const replayed = await adapter2.getPosition(SYMBOL, "POSITION_BEFORE");
    check("replaying the same step consumes the record", replayed.positionAmt === 0.009);
    check(
      "replay did not invoke the host again",
      host.callsTo("futures_usds_positionInformationV2").length === 1,
      String(host.callsTo("futures_usds_positionInformationV2").length),
    );
  }

  /* ======================================================================== */
  section("3. Write idempotency is keyed by executionId, not by args");

  const ORDER_ARGS_HASH = hashArgs({
    symbol: SYMBOL,
    side: "SELL",
    type: "MARKET",
    quantity: "0.002",
    reduceOnly: "true",
    newOrderRespType: "RESULT",
    newClientOrderId: clientOrderIdFor("G-ETH-03:R1:cycle-A"),
  });

  {
    const journal = freshJournal();
    const host = new FakeHost(journal, {
      futures_usds_positionInformationV2: () => rawPosition(0.009),
      futures_usds_newOrder: () => rawOrder(),
    });
    const input: ReducePositionInput = {
      symbol: SYMBOL,
      side: "SELL",
      quantity: "0.002",
      executionId: "G-ETH-03:R1:cycle-A",
    };

    const relay = new HostRelayInvoker({ cycleId: "cycle-A", journal });
    const adapter = new McpExecutionAdapter(relay, SYMBOL);
    const order = await driveToCompletion(() => adapter.reducePosition(input), host);
    check("write reached Binance once", host.callsTo("futures_usds_newOrder").length === 1);
    check("real orderId captured", order.orderId === 987654321, String(order.orderId));

    const sent = host.callsTo("futures_usds_newOrder")[0].args;
    check("relayed symbol unchanged", sent.symbol === SYMBOL, String(sent.symbol));
    check("relayed side unchanged", sent.side === "SELL", String(sent.side));
    check("relayed type is MARKET", sent.type === "MARKET", String(sent.type));
    check("relayed reduceOnly is true", sent.reduceOnly === "true", String(sent.reduceOnly));
    check("relayed quantity unchanged", sent.quantity === "0.002", String(sent.quantity));
    check(
      "clientOrderId is derived from executionId (reconcilable)",
      sent.newClientOrderId === clientOrderIdFor("G-ETH-03:R1:cycle-A"),
      String(sent.newClientOrderId),
    );
    check("canonical args match the recorded hash", hashArgs(sent) === ORDER_ARGS_HASH);

    // --- replay: same executionId, same args -> recorded fill, no new order ---
    const relay2 = new HostRelayInvoker({ cycleId: "cycle-A", journal });
    const adapter2 = new McpExecutionAdapter(relay2, SYMBOL);
    const replayed = await driveToCompletion(() => adapter2.reducePosition(input), host);
    check(
      "same executionId + same args replays the recorded fill",
      replayed.orderId === 987654321,
      String(replayed.orderId),
    );
    check(
      "NO second order was submitted",
      host.callsTo("futures_usds_newOrder").length === 1,
      `${host.callsTo("futures_usds_newOrder").length} submissions`,
    );

    // --- same executionId, DIFFERENT args -> hard fail ---
    const relay3 = new HostRelayInvoker({ cycleId: "cycle-A", journal });
    const adapter3 = new McpExecutionAdapter(relay3, SYMBOL);
    try {
      await driveToCompletion(
        () => adapter3.reducePosition({ ...input, quantity: "0.003" }),
        host,
      );
      fail("same executionId + different args is a hard failure");
    } catch (e) {
      check(
        "same executionId + different args -> IDEMPOTENCY_CONFLICT",
        e instanceof IdempotencyConflictError,
        e instanceof Error ? e.name : String(e),
      );
    }
    check(
      "conflict submitted nothing",
      host.callsTo("futures_usds_newOrder").length === 1,
      `${host.callsTo("futures_usds_newOrder").length} submissions`,
    );

    // --- DIFFERENT executionId, same args -> a new legitimate trade ---
    const relay4 = new HostRelayInvoker({ cycleId: "cycle-B", journal });
    const adapter4 = new McpExecutionAdapter(relay4, SYMBOL);
    await driveToCompletion(
      () =>
        adapter4.reducePosition({
          symbol: SYMBOL,
          side: "SELL",
          quantity: "0.002",
          executionId: "G-ETH-03:R1:cycle-B",
        }),
      host,
    );
    check(
      "different executionId + same args DOES submit again",
      host.callsTo("futures_usds_newOrder").length === 2,
      `${host.callsTo("futures_usds_newOrder").length} submissions`,
    );
  }

  /* ======================================================================== */
  section("4. The crash-after-submit window becomes EXECUTION_STATE_UNKNOWN");

  {
    const journal = freshJournal();
    const host = new FakeHost(journal, {
      futures_usds_positionInformationV2: () => rawPosition(0.009),
      futures_usds_newOrder: () => rawOrder(),
    });
    const input: ReducePositionInput = {
      symbol: SYMBOL,
      side: "SELL",
      quantity: "0.002",
      executionId: "G-ETH-03:R1:cycle-CRASH",
    };

    // First pass: intent gets journaled, then the "host dies" — we simply never
    // fulfil the write request.
    const relay = new HostRelayInvoker({ cycleId: "cycle-CRASH", journal });
    const adapter = new McpExecutionAdapter(relay, SYMBOL);
    try {
      await driveToCompletion(
        () => adapter.reducePosition(input),
        new FakeHost(
          journal,
          { futures_usds_positionInformationV2: () => rawPosition(0.009) },
          true, // host dies before touching the write: it stays REQUESTED
        ),
        4,
      );
    } catch {
      /* expected: never settles */
    }

    const stuck = journal.findByExecutionId("G-ETH-03:R1:cycle-CRASH");
    check("write intent was persisted before invocation", stuck?.status === "REQUESTED", String(stuck?.status));
    check(
      "the persisted intent carries the reconcilable clientOrderId",
      stuck?.args.newClientOrderId === clientOrderIdFor("G-ETH-03:R1:cycle-CRASH"),
    );

    // Re-run: must refuse to resubmit.
    const relay2 = new HostRelayInvoker({ cycleId: "cycle-CRASH", journal });
    const adapter2 = new McpExecutionAdapter(relay2, SYMBOL);
    try {
      await driveToCompletion(() => adapter2.reducePosition(input), host, 6);
      fail("ambiguous write must not auto-retry");
    } catch (e) {
      check(
        "ambiguous write -> EXECUTION_STATE_UNKNOWN",
        e instanceof ExecutionStateUnknownError,
        e instanceof Error ? e.name : String(e),
      );
      if (e instanceof ExecutionStateUnknownError) {
        check(
          "carries the clientOrderId reconciliation needs",
          e.clientOrderId === clientOrderIdFor("G-ETH-03:R1:cycle-CRASH"),
          String(e.clientOrderId),
        );
      }
    }
    check(
      "NO order was resubmitted during the ambiguous window",
      host.callsTo("futures_usds_newOrder").length === 0,
      `${host.callsTo("futures_usds_newOrder").length} submissions`,
    );
  }

  /* ======================================================================== */
  section("5. Replay divergence is a hard stop");

  {
    const journal = freshJournal();
    const host = new FakeHost(journal, {
      futures_usds_positionInformationV2: () => rawPosition(0.009),
    });
    const relay = new HostRelayInvoker({ cycleId: "cycle-ND", journal });
    const adapter = new McpExecutionAdapter(relay, SYMBOL);
    await driveToCompletion(() => adapter.getPosition(SYMBOL, "POSITION_BEFORE"), host);

    // Same cycle+step, different arguments than recorded.
    const relay2 = new HostRelayInvoker({ cycleId: "cycle-ND", journal });
    try {
      await relay2.call("futures_usds_positionInformationV2", { symbol: "BTCUSDT" }, {
        stepId: "POSITION_BEFORE",
      });
      fail("divergent replay is rejected");
    } catch (e) {
      check(
        "same step with different args -> RELAY_NONDETERMINISM",
        e instanceof RelayNondeterminismError,
        e instanceof Error ? e.name : String(e),
      );
    }
  }

  /* ======================================================================== */
  section("6. A write without an executionId is refused");

  {
    const journal = freshJournal();
    const relay = new HostRelayInvoker({ cycleId: "cycle-NOEXEC", journal });
    try {
      await relay.call("futures_usds_newOrder", { symbol: SYMBOL }, { write: true });
      fail("write without executionId is refused");
    } catch (e) {
      check(
        "write without executionId -> EXECUTION_ID_REQUIRED",
        e instanceof Error && e.message.includes("EXECUTION_ID_REQUIRED"),
        e instanceof Error ? e.message : String(e),
      );
    }
    check("nothing was journaled for the refused write", journal.pending().length === 0);
  }

  /* ======================================================================== */
  section("7. Host responses are validated, not trusted");

  {
    const journal = freshJournal();
    const input: ReducePositionInput = {
      symbol: SYMBOL,
      side: "SELL",
      quantity: "0.002",
      executionId: "G-ETH-03:R1:bad-1",
    };
    const host = new FakeHost(journal, {
      futures_usds_positionInformationV2: () => rawPosition(0.009),
      // Host returns an order that lost reduceOnly.
      futures_usds_newOrder: () => rawOrder({ reduceOnly: false }),
    });
    const relay = new HostRelayInvoker({ cycleId: "cycle-bad1", journal });
    const adapter = new McpExecutionAdapter(relay, SYMBOL);
    try {
      await driveToCompletion(() => adapter.reducePosition(input), host);
      fail("order that lost reduceOnly is rejected");
    } catch (e) {
      check(
        "response without reduceOnly -> RESPONSE_NOT_REDUCE_ONLY",
        e instanceof Error && e.message.includes("RESPONSE_NOT_REDUCE_ONLY"),
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  {
    const journal = freshJournal();
    const host = new FakeHost(journal, {
      futures_usds_positionInformationV2: () => rawPosition(0.009),
      futures_usds_newOrder: () => rawOrder({ side: "BUY" }),
    });
    const relay = new HostRelayInvoker({ cycleId: "cycle-bad2", journal });
    const adapter = new McpExecutionAdapter(relay, SYMBOL);
    try {
      await driveToCompletion(
        () =>
          adapter.reducePosition({
            symbol: SYMBOL,
            side: "SELL",
            quantity: "0.002",
            executionId: "G-ETH-03:R1:bad-2",
          }),
        host,
      );
      fail("mismatched side in the response is rejected");
    } catch (e) {
      check(
        "response side mismatch -> RESPONSE_MISMATCH",
        e instanceof Error && e.message.includes("RESPONSE_MISMATCH"),
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  {
    const journal = freshJournal();
    const host = new FakeHost(journal, {
      futures_usds_positionInformationV2: () => rawPosition(0.009),
      futures_usds_newOrder: () => ({ notAnOrder: true }),
    });
    const relay = new HostRelayInvoker({ cycleId: "cycle-bad3", journal });
    const adapter = new McpExecutionAdapter(relay, SYMBOL);
    try {
      const r = await driveToCompletion(
        () =>
          adapter.reducePosition({
            symbol: SYMBOL,
            side: "SELL",
            quantity: "0.002",
            executionId: "G-ETH-03:R1:bad-3",
          }),
        host,
      );
      // A malformed body must not pass as a real order.
      check(
        "malformed host response yields no usable orderId",
        !Number.isFinite(r.orderId) || r.symbol !== SYMBOL,
        `orderId=${String(r.orderId)} symbol=${String(r.symbol)}`,
      );
    } catch (e) {
      pass("malformed host response rejected", e instanceof Error ? e.name : String(e));
    }
  }

  /* ======================================================================== */
  section("8. Position-not-reduced is still detected across the relay");

  {
    const journal = freshJournal();
    const host = new FakeHost(journal, {
      // Position never shrinks, despite a FILLED order.
      futures_usds_positionInformationV2: () => rawPosition(0.009),
      futures_usds_newOrder: () => rawOrder(),
    });
    const relay = new HostRelayInvoker({ cycleId: "cycle-noshrink", journal });
    const adapter = new McpExecutionAdapter(relay, SYMBOL);
    const outcome = await driveToCompletion(
      () =>
        submitVerifiedReduction(adapter, {
          symbol: SYMBOL,
          side: "SELL",
          quantity: "0.002",
          executionId: "G-ETH-03:R1:noshrink",
        }),
      host,
    );
    check("fill reported but position unchanged", outcome.quantityChanged === false);
    check("reducedBy is zero", Math.abs(outcome.reducedBy) < 1e-12, String(outcome.reducedBy));
  }

  /* ======================================================================== */
  section("9. Reject path never reaches the host");

  {
    const journal = freshJournal();
    const host = new FakeHost(journal, {
      futures_usds_positionInformationV2: () => rawPosition(0.009),
      futures_usds_newOrder: () => rawOrder(),
    });
    const relay = new HostRelayInvoker({ cycleId: "cycle-reject", journal });
    const adapter = new McpExecutionAdapter(relay, SYMBOL);
    const events: RuntimeEvent[] = [];

    const observing = await runGuardianCycle({
      guardian: GUARDIAN,
      status: "OBSERVING", // emergency stop -> validator refuses everything
      cycleId: "cycle-reject",
      filters: FILTERS,
      snapshot: snapshot(position(0.009)),
      adapter,
      reevaluate: async () => {
        throw new Error("must not re-evaluate on a rejected action");
      },
      emit: (e) => events.push(e),
    });

    check("terminal is ACTION_REJECTED", observing.terminal === "ACTION_REJECTED", observing.terminal);
    check(
      "GUARDIAN_NOT_ACTIVE was the reason",
      events.some((e) => e.type === "ACTION_REJECTED" && e.reason === "GUARDIAN_NOT_ACTIVE"),
    );
    check("no MCP write was relayed", host.callsTo("futures_usds_newOrder").length === 0);
    check("nothing was journaled at all", journal.readAll().length === 0);
    check(
      "no re-evaluation happened",
      !events.some((e) => e.type === "GUARDIAN_REEVALUATING"),
    );
  }

  /* ======================================================================== */
  section("10. Clamp path relays only the clamped quantity");

  {
    const journal = freshJournal();
    let posAmt = 0.009;
    const host = new FakeHost(journal, {
      futures_usds_positionInformationV2: () => rawPosition(posAmt),
      futures_usds_newOrder: () => {
        posAmt = 0.007; // the fill actually moves the position
        return rawOrder({ executedQty: "0.002" });
      },
    });
    const relay = new HostRelayInvoker({ cycleId: "cycle-clamp", journal });
    const adapter = new McpExecutionAdapter(relay, SYMBOL);
    const events: RuntimeEvent[] = [];

    // The Guardian asks for 60%; maxReductionPercent is 30.
    const validation = validateAction(GUARDIAN.rules[0].action, {
      guardian: GUARDIAN,
      status: "ACTIVE",
      position: position(0.009),
      filters: FILTERS,
    });
    check("validator clamped 60 -> 30", validation.resolution === "CLAMPED", validation.resolution);
    check("clamped quantity is 0.002", validation.quantity?.steppedQty === "0.002", String(validation.quantity?.steppedQty));

    const result = await driveToCompletion(
      () =>
        runGuardianCycle({
          guardian: GUARDIAN,
          status: "ACTIVE",
          cycleId: "cycle-clamp",
          filters: FILTERS,
          snapshot: snapshot(position(0.009)),
          adapter,
          reevaluate: async () => ({
            at: Date.now(),
            guardianId: GUARDIAN.id,
            rules: [],
            firedRule: null,
            incomplete: false,
          }),
          emit: (e) => events.push(e),
        }),
      host,
    );

    const sent = host.callsTo("futures_usds_newOrder")[0]?.args ?? {};
    check("terminal is REEVALUATED", result.terminal === "REEVALUATED", result.terminal);
    check(
      "ACTION_CLAMPED emitted 60 -> 30",
      events.some((e) => e.type === "ACTION_CLAMPED" && e.requestedPercent === 60 && e.executedPercent === 30),
    );
    check("host received the CLAMPED quantity only", sent.quantity === "0.002", String(sent.quantity));
    check("host never saw a 60% quantity", sent.quantity !== "0.005" && sent.quantity !== "0.0054");
    check(
      "re-evaluation ran only after a verified shrink",
      events.findIndex((e) => e.type === "GUARDIAN_REEVALUATING") >
        events.findIndex((e) => e.type === "POSITION_REFRESHED"),
    );
    check(
      "executionId bound the guardian, rule and cycle",
      journal.findByExecutionId("G-ETH-03:R1:cycle-clamp") !== undefined,
    );
  }

  /* ======================================================================== */
  section("11. No production dependency on the custom-OAuth spike");

  {
    const offenders: string[] = [];
    const roots = ["src", "scripts"];
    const stack = [...roots];
    const { readdirSync, statSync } = await import("node:fs");
    while (stack.length) {
      const cur = stack.pop() as string;
      if (!existsSync(cur)) continue;
      const st = statSync(cur);
      if (st.isDirectory()) {
        for (const entry of readdirSync(cur)) stack.push(join(cur, entry));
        continue;
      }
      if (!cur.endsWith(".ts") && !cur.endsWith(".tsx")) continue;
      const body = readFileSync(cur, "utf8");
      if (/from\s+["'].*(spikes|mcp\/binance-client|mcp\/provider|mcp\/client)["']/.test(body)) {
        offenders.push(cur);
      }
    }
    check(
      "src/ and scripts/ import nothing from the OAuth spike",
      offenders.length === 0,
      offenders.join(", "),
    );
    check("spikes/ is excluded from tsconfig", readFileSync("tsconfig.json", "utf8").includes('"spikes"'));
  }


  /* ======================================================================== */
  section("12. Reconciliation settles the ambiguous window");

  /** Put a write into the ambiguous REQUESTED state and hand back the journal. */
  async function ambiguousWrite(executionId: string, cycleId: string) {
    const journal = freshJournal();
    const crashHost = new FakeHost(
      journal,
      { futures_usds_positionInformationV2: () => rawPosition(0.009) },
      true,
    );
    const relay = new HostRelayInvoker({ cycleId, journal });
    const adapter = new McpExecutionAdapter(relay, SYMBOL);
    try {
      await driveToCompletion(
        () =>
          adapter.reducePosition({
            symbol: SYMBOL,
            side: "SELL",
            quantity: "0.002",
            executionId,
          }),
        crashHost,
        4,
      );
    } catch {
      /* expected: the write never settles */
    }
    return journal;
  }

  {
    const executionId = "G-ETH-03:R1:recon-exists";
    const journal = await ambiguousWrite(executionId, "cycle-recon-1");
    const plan = planReconciliation(journal, executionId);

    check("a plan is produced for an ambiguous write", plan !== null);
    check(
      "reconciliation queries by the deterministic clientOrderId",
      plan?.args.origClientOrderId === clientOrderIdFor(executionId),
      String(plan?.args.origClientOrderId),
    );
    check(
      "reconciliation is a READ of queryOrder",
      plan?.tool === "futures_usds_queryOrder",
      String(plan?.tool),
    );

    const outcome = applyReconciliation(journal, plan!, {
      ok: true,
      order: rawOrder({ clientOrderId: clientOrderIdFor(executionId) }),
    });
    check("outcome is ORDER_EXISTS", outcome.state === "ORDER_EXISTS", outcome.state);
    check(
      "journal now holds the real fill",
      journal.findByExecutionId(executionId)?.status === "FULFILLED",
      String(journal.findByExecutionId(executionId)?.status),
    );

    const host = new FakeHost(journal, {
      futures_usds_positionInformationV2: () => rawPosition(0.007),
      futures_usds_newOrder: () => rawOrder(),
    });
    const relay = new HostRelayInvoker({ cycleId: "cycle-recon-1", journal });
    const adapter = new McpExecutionAdapter(relay, SYMBOL);
    const order = await driveToCompletion(
      () =>
        adapter.reducePosition({
          symbol: SYMBOL,
          side: "SELL",
          quantity: "0.002",
          executionId,
        }),
      host,
    );
    check("replay returns the reconciled order", order.orderId === 987654321, String(order.orderId));
    check(
      "reconciled execution NEVER resubmits",
      host.callsTo("futures_usds_newOrder").length === 0,
      `${host.callsTo("futures_usds_newOrder").length} submissions`,
    );
  }

  {
    const executionId = "G-ETH-03:R1:recon-absent";
    const journal = await ambiguousWrite(executionId, "cycle-recon-2");
    const plan = planReconciliation(journal, executionId)!;

    const outcome = applyReconciliation(journal, plan, {
      ok: false,
      error: "-2013 Order does not exist.",
    });
    check("outcome is ORDER_ABSENT", outcome.state === "ORDER_ABSENT", outcome.state);
    check(
      "the spent executionId is closed out as failed",
      journal.findByExecutionId(executionId)?.status === "FAILED",
      String(journal.findByExecutionId(executionId)?.status),
    );

    const host = new FakeHost(journal, {
      futures_usds_positionInformationV2: () => rawPosition(0.009),
      futures_usds_newOrder: () => rawOrder(),
    });
    const relayOld = new HostRelayInvoker({ cycleId: "cycle-recon-2", journal });
    const adapterOld = new McpExecutionAdapter(relayOld, SYMBOL);
    try {
      await driveToCompletion(
        () =>
          adapterOld.reducePosition({
            symbol: SYMBOL,
            side: "SELL",
            quantity: "0.002",
            executionId,
          }),
        host,
      );
      fail("a reconciled-absent executionId must not resubmit under its old id");
    } catch {
      pass("a reconciled-absent executionId must not resubmit under its old id");
    }
    check(
      "still no order submitted under the spent id",
      host.callsTo("futures_usds_newOrder").length === 0,
    );

    const relayNew = new HostRelayInvoker({ cycleId: "cycle-recon-3", journal });
    const adapterNew = new McpExecutionAdapter(relayNew, SYMBOL);
    await driveToCompletion(
      () =>
        adapterNew.reducePosition({
          symbol: SYMBOL,
          side: "SELL",
          quantity: "0.002",
          executionId: "G-ETH-03:R1:recon-retry",
        }),
      host,
    );
    check(
      "a NEW executionId may act after reconciliation",
      host.callsTo("futures_usds_newOrder").length === 1,
      `${host.callsTo("futures_usds_newOrder").length} submissions`,
    );
  }

  {
    const executionId = "G-ETH-03:R1:recon-mismatch";
    const journal = await ambiguousWrite(executionId, "cycle-recon-4");
    const plan = planReconciliation(journal, executionId)!;
    try {
      applyReconciliation(journal, plan, {
        ok: true,
        order: rawOrder({ clientOrderId: "SENTINEL-someoneelsesorder" }),
      });
      fail("a foreign clientOrderId must not be attributed to this execution");
    } catch (e) {
      check(
        "foreign clientOrderId -> ReconciliationError",
        e instanceof ReconciliationError,
        e instanceof Error ? e.name : String(e),
      );
    }

    try {
      applyReconciliation(journal, plan, { ok: false, error: "ETIMEDOUT talking to Binance" });
      fail("an inconclusive lookup must not resolve the ambiguity");
    } catch (e) {
      check(
        "inconclusive lookup -> stays ambiguous",
        e instanceof ReconciliationError,
        e instanceof Error ? e.name : String(e),
      );
    }
    check(
      "record is still REQUESTED after an inconclusive lookup",
      journal.findByExecutionId(executionId)?.status === "REQUESTED",
      String(journal.findByExecutionId(executionId)?.status),
    );
  }


  /* ======================================================================== */
  section("13. The skill package cannot drift from the code");

  {
    const skillPath = "agent/skills/sentinel/SKILL.md";
    const skill = existsSync(skillPath) ? readFileSync(skillPath, "utf8") : "";
    check("SKILL.md exists", skill.length > 0, skillPath);

    // Frontmatter is what makes Claude Code able to route to it at all.
    const fm = skill.match(/^---\n([\s\S]*?)\n---/);
    check("has YAML frontmatter", fm !== null);
    check("declares a name", /(^|\n)name:\s*sentinel\b/.test(fm?.[1] ?? ""));
    check("declares a description", /(^|\n)description:\s*\S/.test(fm?.[1] ?? ""));

    // Every Binance tool the adapter really calls must be documented, or the
    // host will not know how to relay it.
    const adapterSrc = readFileSync("src/lib/execution/execution-adapter.ts", "utf8");
    const called = [...adapterSrc.matchAll(/"(futures_usds_[A-Za-z0-9_]+)"/g)].map((m) => m[1]);
    const undocumented = [...new Set(called)].filter((t) => !skill.includes(t));
    check(
      "every tool the adapter calls is documented in SKILL.md",
      undocumented.length === 0,
      undocumented.length ? `missing: ${undocumented.join(", ")}` : `${new Set(called).size} tools`,
    );

    // Reconciliation's tool must be documented too.
    const reconcileSrc = readFileSync("src/lib/mcp/reconcile.ts", "utf8");
    const reconTool = reconcileSrc.match(/tool:\s*"(futures_usds_[A-Za-z0-9_]+)"/)?.[1];
    check(
      "the reconciliation tool is documented",
      reconTool !== undefined && skill.includes(reconTool),
      String(reconTool),
    );

    // The exit-code contract the skill tells the host to branch on.
    const cliSrc = readFileSync("scripts/sentinel.ts", "utf8");
    for (const [name, value] of [
      ["EXIT_RELAY_REQUIRED", "10"],
      ["EXIT_HALT", "20"],
    ] as const) {
      check(
        `${name} is ${value} in both the CLI and the skill`,
        new RegExp(`const ${name} = ${value};`).test(cliSrc) && skill.includes(`\`${value}\``),
        value,
      );
    }

    // The CLI must never hard-exit: that races socket teardown on Windows and
    // reports 127, silently breaking the exit-code contract above.
    check(
      "CLI sets process.exitCode rather than calling process.exit",
      !/process\.exit\(/.test(cliSrc),
      `${(cliSrc.match(/process\.exit\(/g) ?? []).length} process.exit calls`,
    );

    // The defensive boundary must be stated, not implied.
    for (const rule of ["reduceOnly", "Never increase a position", "Never withdraw"]) {
      check(`skill states: "${rule}"`, skill.includes(rule));
    }
  }


  /* ======================================================================== */
  section("14. ORDER_SUBMITTED reports the real submission time");

  {
    const journal = freshJournal();
    const host = new FakeHost(journal, {
      futures_usds_positionInformationV2: () => rawPosition(0.009),
      // Binance's fill time, as it would come back on the wire.
      futures_usds_newOrder: () => rawOrder({ updateTime: Date.now() }),
    });
    const input: ReducePositionInput = {
      symbol: SYMBOL,
      side: "SELL",
      quantity: "0.002",
      executionId: "G-ETH-03:R1:cycle-TIME",
    };

    const relay = new HostRelayInvoker({ cycleId: "cycle-TIME", journal });
    const adapter = new McpExecutionAdapter(relay, SYMBOL);

    // Drive until the WRITE intent is journaled. The adapter's own POSITION_GUARD
    // read pauses first, so the write is not reached on the very first pass.
    for (let turn = 0; turn < 5; turn++) {
      try {
        await adapter.reducePosition(input);
        break;
      } catch (e) {
        if (!(e instanceof RelayRequired)) throw e;
        if (e.request.kind === "WRITE") break; // intent journaled; stop before fulfilling
        host.drain();
      }
    }
    const intentRecord = journal.findByExecutionId(input.executionId!);
    check("the write intent was journaled", intentRecord !== undefined);
    const intentAt = Date.parse(intentRecord!.requestedAt);
    host.drain();

    // A LATER host turn replays and reports the order. Without the fix this run's
    // clock would be stamped on the submission.
    await new Promise((r) => setTimeout(r, 25));
    const relay2 = new HostRelayInvoker({ cycleId: "cycle-TIME", journal });
    const adapter2 = new McpExecutionAdapter(relay2, SYMBOL);
    const replayRunStartedAt = Date.now();
    const outcome = await driveToCompletion(
      () => submitVerifiedReduction(adapter2, input),
      host,
    );

    check(
      "the relay can report when the write was journaled",
      relay2.writeRequestedAt(input.executionId!) === intentAt,
      String(relay2.writeRequestedAt(input.executionId!)),
    );
    check(
      "submittedAt is the journaled intent, not the replay's clock",
      outcome.submittedAt === intentAt,
      `submittedAt=${outcome.submittedAt} intent=${intentAt} replayRun=${replayRunStartedAt}`,
    );
    check(
      "and is strictly earlier than the replaying run",
      outcome.submittedAt < replayRunStartedAt,
      `${replayRunStartedAt - outcome.submittedAt}ms earlier`,
    );
    check(
      "so the feed never shows a submission after its own fill",
      outcome.submittedAt <= outcome.order.updateTime,
      `submitted=${outcome.submittedAt} filled=${outcome.order.updateTime}`,
    );

    // An adapter with no journal behind it must still work.
    const plain = new McpExecutionAdapter(
      { call: async () => ({}) as never, close: async () => {} },
      SYMBOL,
    );
    check(
      "the hook is optional — no journal, no crash",
      plain.submittedAtFor("anything") === undefined,
    );
  }

  console.log(
    failed ? "\nRELAY CHECKS FAILED.\n" : "\nAll host-relay checks passed.\n",
  );
  rmSync(dir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
