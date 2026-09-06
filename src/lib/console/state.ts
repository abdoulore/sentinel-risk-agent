/**
 * Console state — everything the one Sentinel surface renders, assembled on the
 * server from the same files the runtime writes.
 *
 * The console is a reader. It computes no metric, evaluates no rule, and
 * derives no trade. Each field below traces to something the runtime already
 * committed to disk: the Guardian store, the frozen cycle snapshot, the domain
 * event log, and the relay journal. If a value is not in one of those, the
 * console shows a dash.
 */
import { GuardianStore, type SentinelState } from "@/lib/guardian/store";
import { EventStore, type StoredEvent } from "@/lib/events/store";
import { RelayJournal } from "@/lib/mcp/journal";
import { buildReport, type LiveMetricsReport } from "@/lib/metrics/report";
import type { Guardian, GuardianStatus } from "@/lib/policy/types";
import { LAB_PRESETS, type LabScenario } from "@/lib/guardian/lab";
import { SYMBOL } from "@/lib/config";

/**
 * Sentinel does not hold the Binance session — a supported Agent OS host does.
 * So the console reports the state of the *relay*, which is knowable, rather
 * than claiming a connection it cannot observe.
 */
export type RelayStatusLabel =
  /** The runtime is waiting on the host to invoke something. */
  | "AWAITING RELAY"
  /** Traffic has flowed and nothing is outstanding. */
  | "READY"
  /** Nothing has crossed the boundary yet this session. */
  | "IDLE";

export interface ConsoleState {
  symbol: string;
  now: number;

  guardian: Guardian | null;
  draft: Guardian | null;
  status: GuardianStatus;
  /** True when a Guardian is in force and permitted to act. */
  armed: boolean;

  cycle: {
    cycleId: string;
    startedAt: string;
    overrides: Record<string, number | string>;
    /** Agent Lab is in force for this cycle. */
    simulated: boolean;
    /** The test proposal this cycle ran under, if any. */
    proposedPercent: number | null;
  } | null;

  /** Scenario armed for the NEXT cycle. Null once reset to live. */
  lab: LabScenario | null;
  /** Named scenarios the console offers. */
  presets: { id: string; label: string; note: string; overrides: Record<string, number | string>; proposedPercent: number | null }[];

  /** Built from the FROZEN cycle snapshot — what the engine is evaluating. */
  metrics: LiveMetricsReport | null;
  /**
   * The same frozen snapshot with overrides stripped: what was actually
   * measured. Agent Lab shows this beside `metrics` so the operator can see
   * exactly which values a scenario replaced.
   */
  liveMetrics: LiveMetricsReport | null;

  events: StoredEvent[];

  relay: {
    label: RelayStatusLabel;
    pending: number;
    /** A pending WRITE is a real order awaiting approval. Always surfaced. */
    pendingWrite: boolean;
    lastActivityAt: number | null;
    totalCalls: number;
  };
}

export function readConsoleState(limit = 200): ConsoleState {
  const state: SentinelState = new GuardianStore().read();
  const events = new EventStore().recent(limit);
  const journal = new RelayJournal();

  const records = [...journal.fold().values()];
  const pending = records.filter((r) => r.status === "REQUESTED");
  const fulfilled = records.filter((r) => r.fulfilledAt);
  const lastActivityAt = fulfilled.length
    ? Math.max(...fulfilled.map((r) => Date.parse(r.fulfilledAt as string)))
    : null;

  const label: RelayStatusLabel =
    pending.length > 0 ? "AWAITING RELAY" : records.length > 0 ? "READY" : "IDLE";

  const overrides = (state.cycle?.overrides ?? {}) as Record<string, number | string>;

  return {
    symbol: SYMBOL,
    now: Date.now(),

    guardian: state.guardian,
    draft: state.draft,
    status: state.status,
    armed: Boolean(state.guardian) && state.status === "ACTIVE",

    cycle: state.cycle
      ? {
          cycleId: state.cycle.cycleId,
          startedAt: state.cycle.startedAt,
          overrides,
          simulated: Object.keys(overrides).length > 0,
          proposedPercent: state.cycle.lab?.proposedPercent ?? null,
        }
      : null,

    lab: state.lab,
    presets: Object.entries(LAB_PRESETS).map(([id, p]) => ({
      id,
      label: p.label,
      note: p.note,
      overrides: p.overrides as Record<string, number | string>,
      proposedPercent: p.proposedPercent,
    })),

    metrics: state.cycle?.snapshot ? buildReport(state.cycle.snapshot) : null,
    liveMetrics: state.cycle?.snapshot
      ? buildReport({
          ...state.cycle.snapshot,
          overrides: {},
          effective: state.cycle.snapshot.live,
        })
      : null,

    events,

    relay: {
      label,
      pending: pending.length,
      pendingWrite: pending.some((r) => r.kind === "WRITE"),
      lastActivityAt,
      totalCalls: records.length,
    },
  };
}
