/**
 * Guardian state — the small amount of Sentinel that must survive between host
 * turns.
 *
 * The relay journal already records everything that crossed the Binance
 * boundary. This holds the other half: which Guardian is in force, whether the
 * user has activated it, and the in-flight cycle.
 *
 * The metric snapshot is persisted with the cycle deliberately. A cycle spans
 * several host turns, and the runtime is re-run on each one; if funding, open
 * interest and momentum were re-fetched every time, the same cycle could
 * evaluate differently between runs and the relay's replay guarantee would be
 * worthless. Measurements are taken once, at the top of the cycle, and every
 * subsequent run of that cycle reuses them.
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Guardian, GuardianStatus } from "@/lib/policy/types";
import type { MetricSnapshot, MetricValues } from "@/lib/metrics/engine";
import type { LabScenario } from "@/lib/guardian/lab";
import { GUARDIAN_STATE_PATH } from "@/lib/config";

export interface CycleState {
  cycleId: string;
  startedAt: string;
  /** Agent Lab overrides in force for this cycle. Frozen for its lifetime. */
  overrides: Partial<MetricValues>;
  /** Measurements taken once at the top of the cycle. */
  snapshot: MetricSnapshot | null;
  /**
   * The lab scenario this cycle was started under, captured at begin time.
   * Held on the cycle rather than read live so that RESET TO LIVE affects only
   * the NEXT cycle and never rewrites what an in-flight one is evaluating.
   */
  lab: LabScenario | null;
}

export interface SentinelState {
  /**
   * A lab scenario armed from the console, waiting for the next cycle to pick
   * it up. Arming prepares state; it never runs anything.
   */
  lab: LabScenario | null;
  /** Compiled but not yet activated. The user reviews this. */
  draft: Guardian | null;
  /** The Guardian in force. Only ever set by an explicit activation. */
  guardian: Guardian | null;
  status: GuardianStatus;
  cycle: CycleState | null;
  updatedAt: string;
}

const EMPTY: SentinelState = {
  lab: null,
  draft: null,
  guardian: null,
  status: "PAUSED",
  cycle: null,
  updatedAt: new Date(0).toISOString(),
};

export class GuardianStore {
  constructor(private readonly path: string = GUARDIAN_STATE_PATH) {}

  read(): SentinelState {
    try {
      return { ...EMPTY, ...(JSON.parse(readFileSync(this.path, "utf8")) as SentinelState) };
    } catch {
      return { ...EMPTY };
    }
  }

  write(state: Omit<SentinelState, "updatedAt">): SentinelState {
    const next: SentinelState = { ...state, updatedAt: new Date().toISOString() };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(next, null, 2), "utf8");
    return next;
  }

  update(patch: Partial<Omit<SentinelState, "updatedAt">>): SentinelState {
    const current = this.read();
    return this.write({ ...current, ...patch });
  }

  /**
   * Start a cycle, or return the one already in flight.
   *
   * A new cycle consumes whatever lab scenario is armed. Its overrides are
   * copied onto the cycle, so a later RESET TO LIVE cannot retroactively change
   * what this cycle measured or evaluated.
   */
  beginCycle(overrides: Partial<MetricValues> = {}, force = false): CycleState {
    const state = this.read();
    if (state.cycle && !force) return state.cycle;

    const lab = state.lab;
    const cycle: CycleState = {
      cycleId: `cycle-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`,
      startedAt: new Date().toISOString(),
      // An explicit argument (the CLI's --lab) wins; otherwise the armed scenario.
      overrides: Object.keys(overrides).length > 0 ? overrides : { ...(lab?.overrides ?? {}) },
      snapshot: null,
      lab: lab ? { ...lab } : null,
    };
    this.update({ cycle });
    return cycle;
  }

  /** Arm a scenario for the next cycle. Does not start or run anything. */
  armLab(lab: LabScenario): SentinelState {
    return this.update({ lab });
  }

  /**
   * RESET TO LIVE. Clears the armed scenario for subsequent cycles only —
   * historical cycles and their events are never rewritten.
   */
  resetLab(): SentinelState {
    return this.update({ lab: null });
  }

  /** Freeze this cycle's measurements so every re-run sees the same numbers. */
  recordSnapshot(snapshot: MetricSnapshot): void {
    const state = this.read();
    if (!state.cycle) return;
    this.update({ cycle: { ...state.cycle, snapshot } });
  }

  endCycle(): void {
    this.update({ cycle: null });
  }

  reset(): void {
    rmSync(this.path, { force: true });
  }
}
