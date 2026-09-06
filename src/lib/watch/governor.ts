/**
 * The governor — rate limits for autonomous action.
 *
 * WHY THIS EXISTS
 *
 * While a person triggered every cycle, they were an accidental rate limiter: a
 * Guardian could not fire twice because nobody ran it twice. Autonomy removes
 * that, and removing it is dangerous in a way the Validator does not cover.
 *
 * The Validator bounds a SINGLE action — at most `maxReductionPercent`. It says
 * nothing about how often. A Guardian written as "reduce 30% when funding is
 * high and momentum is bearish" is correct, but those conditions persist: the
 * measured data shows bearish episodes lasting up to 45 minutes. Polled every
 * five minutes, that same correct policy would fire nine times and take the
 * position to almost nothing — each action individually valid, the aggregate
 * absurd.
 *
 * So autonomy needs a second, orthogonal limit: not "how much per action" but
 * "how often, and how many". That is this file.
 *
 * The record is append-only and survives restarts, so a crash loop cannot reset
 * the budget. Only EXECUTED actions are recorded — raising attention costs
 * nothing and is not rationed.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { GOVERNOR_PATH } from "@/lib/config";

export interface ActionRecord {
  at: string;
  guardianId: string;
  executionId: string;
  /** Present once the order came back. Absent means it never completed. */
  orderId?: number;
  quantity?: string;
}

export interface GovernorLimits {
  /** Quiet period after any executed action. */
  minMinutesBetweenActions: number;
  /** Rolling 24-hour cap. */
  maxActionsPerDay: number;
  /** Lifetime cap for this Guardian. 0 disables the check. */
  maxActionsTotal: number;
}

/**
 * Deliberately conservative. A Guardian that protects a position does not need
 * to act often — the measured trigger rate is about 1.14 episodes a day — and
 * the cost of acting too rarely is far lower than the cost of acting too often.
 */
export const DEFAULT_LIMITS: GovernorLimits = {
  minMinutesBetweenActions: 60,
  maxActionsPerDay: 3,
  maxActionsTotal: 0,
};

export type GovernorDecision =
  | { allow: true; remainingToday: number }
  | { allow: false; reason: string; detail: string; nextEligibleAt?: string };

export class Governor {
  constructor(
    private readonly limits: GovernorLimits = DEFAULT_LIMITS,
    private readonly path: string = GOVERNOR_PATH,
  ) {}

  /** Every action ever executed, oldest first. */
  history(guardianId?: string): ActionRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const out: ActionRecord[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t) as ActionRecord;
        if (!guardianId || rec.guardianId === guardianId) out.push(rec);
      } catch {
        // A torn line is skipped. It can only ever cause the governor to
        // under-count, which fails toward acting less often, not more.
      }
    }
    return out;
  }

  /**
   * May the Guardian act right now?
   *
   * Called before a cycle is started, never after. A refusal is not an error —
   * it is the governor doing its job.
   */
  decide(guardianId: string, now = Date.now()): GovernorDecision {
    const past = this.history(guardianId);

    if (this.limits.maxActionsTotal > 0 && past.length >= this.limits.maxActionsTotal) {
      return {
        allow: false,
        reason: "TOTAL_CAP_REACHED",
        detail: `${past.length} of ${this.limits.maxActionsTotal} lifetime actions used`,
      };
    }

    const dayAgo = now - 24 * 60 * 60_000;
    const today = past.filter((a) => Date.parse(a.at) > dayAgo);
    if (today.length >= this.limits.maxActionsPerDay) {
      const oldest = Math.min(...today.map((a) => Date.parse(a.at)));
      return {
        allow: false,
        reason: "DAILY_CAP_REACHED",
        detail: `${today.length} of ${this.limits.maxActionsPerDay} actions in the last 24h`,
        nextEligibleAt: new Date(oldest + 24 * 60 * 60_000).toISOString(),
      };
    }

    const last = past[past.length - 1];
    if (last) {
      const since = (now - Date.parse(last.at)) / 60_000;
      if (since < this.limits.minMinutesBetweenActions) {
        const wait = this.limits.minMinutesBetweenActions - since;
        return {
          allow: false,
          reason: "COOLING_DOWN",
          detail: `last action ${since.toFixed(0)}m ago; ${wait.toFixed(0)}m of the ${this.limits.minMinutesBetweenActions}m quiet period remain`,
          nextEligibleAt: new Date(Date.parse(last.at) + this.limits.minMinutesBetweenActions * 60_000).toISOString(),
        };
      }
    }

    return { allow: true, remainingToday: this.limits.maxActionsPerDay - today.length };
  }

  /** Record an executed action. Call only after an order actually filled. */
  record(rec: Omit<ActionRecord, "at">): ActionRecord {
    const full: ActionRecord = { at: new Date().toISOString(), ...rec };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(full)}\n`, "utf8");
    return full;
  }

  describe(guardianId: string, now = Date.now()): string {
    const d = this.decide(guardianId, now);
    if (d.allow) return `may act (${d.remainingToday} of ${this.limits.maxActionsPerDay} left today)`;
    return `${d.reason} — ${d.detail}`;
  }
}

/** Limits from the environment, so an operator can tighten them without code. */
export function limitsFromEnv(): GovernorLimits {
  const n = (v: string | undefined, fallback: number) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? x : fallback;
  };
  return {
    minMinutesBetweenActions: n(process.env.SENTINEL_MIN_MINUTES_BETWEEN, DEFAULT_LIMITS.minMinutesBetweenActions),
    maxActionsPerDay: n(process.env.SENTINEL_MAX_ACTIONS_PER_DAY, DEFAULT_LIMITS.maxActionsPerDay),
    maxActionsTotal: n(process.env.SENTINEL_MAX_ACTIONS_TOTAL, DEFAULT_LIMITS.maxActionsTotal),
  };
}
