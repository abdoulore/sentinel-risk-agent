"use client";

/**
 * The Sentinel console — one surface, three regions.
 *
 *   COMMAND STRIP   what is true right now
 *   AGENT FEED      what the runtime did, in its own words
 *   PANELS          the Guardian in force
 *
 * Nothing here computes. Every number is read from the frozen cycle snapshot
 * and every feed line from a stored domain event. Where the runtime has not
 * measured something, this renders a dash — never a zero, never a guess.
 */
import { useEffect, useRef, useState } from "react";
import type { ConsoleState } from "@/lib/console/state";
import type { StoredEvent } from "@/lib/events/store";
import type { LiveMetricsReport } from "@/lib/metrics/report";

const POLL_MS = 2000;

/* --------------------------------- format --------------------------------- */

const DASH = "—";

function num(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function pct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}
function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 23);
}
function ago(at: number | null, now: number): string {
  if (at === null) return DASH;
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/* --------------------------------- events --------------------------------- */

type Tone = "neutral" | "decision" | "danger" | "verified" | "lab";

/**
 * One event -> one feed line. Every branch reads only fields that exist on that
 * event variant, so the feed cannot show a quantity, price or order id the
 * runtime did not emit.
 */
function describe(e: StoredEvent): { label: string; detail: string; tone: Tone } {
  switch (e.type) {
    case "RULE_MATCHED":
      return { label: "RULE MATCHED", detail: `${e.guardianId} · ${e.ruleId}`, tone: "decision" };
    case "ACTION_PROPOSED":
      return {
        label: "ACTION PROPOSED",
        detail: `${e.actionType.replace("_", " ")}${e.requestedPercent !== null ? ` ${e.requestedPercent}%` : ""}`,
        tone: "neutral",
      };
    case "ACTION_CLAMPED":
      return {
        label: "ACTION CLAMPED",
        detail: `${e.requestedPercent}% → ${e.executedPercent}%   policy ceiling enforced`,
        tone: "decision",
      };
    case "ACTION_REJECTED":
      return { label: "ACTION REJECTED", detail: e.reason, tone: "danger" };
    case "EXECUTION_VALIDATED":
      return {
        label: "EXECUTION VALIDATED",
        detail: `position ${e.positionQty}   requested ${e.requestedQty.toFixed(8)}   rounded ${e.roundedQty}   reduceOnly ✓`,
        tone: "neutral",
      };
    case "ORDER_SUBMITTED":
      return { label: "ORDER SUBMITTED", detail: `Binance Agent OS   order ${e.orderId}`, tone: "neutral" };
    case "ORDER_FILLED":
      return { label: "ORDER FILLED", detail: `${e.executedQty}   order ${e.orderId}`, tone: "verified" };
    case "POSITION_REFRESHED":
      return { label: "POSITION REFRESHED", detail: `${e.before} → ${e.after}`, tone: "verified" };
    case "GUARDIAN_REEVALUATING":
      return { label: "GUARDIAN RE-EVALUATING", detail: "", tone: "neutral" };
    case "GUARDIAN_STATE_CHANGED":
      return {
        label: "GUARDIAN STATE",
        detail: e.nextTrigger ? `${e.state}   next: ${e.nextTrigger}` : e.state,
        tone: "neutral",
      };
    case "EXECUTION_BLOCKED":
      return { label: "EXECUTION BLOCKED", detail: e.cause, tone: "danger" };
    case "EXECUTION_REJECTED":
      return { label: "EXECUTION REJECTED", detail: e.reason, tone: "danger" };
    case "EXECUTION_FAILED":
      return { label: "EXECUTION FAILED", detail: e.reason, tone: "danger" };
    case "EXECUTION_VERIFICATION_FAILED":
      return {
        label: "VERIFICATION FAILED",
        detail: `${e.reason}   ${e.before} → ${e.after}`,
        tone: "danger",
      };
    case "EXECUTION_STATE_UNKNOWN":
      return {
        label: "EXECUTION STATE UNKNOWN",
        detail: `${e.executionId}   reconcile ${e.clientOrderId ?? DASH}`,
        tone: "danger",
      };
    case "IDEMPOTENCY_CONFLICT":
      return { label: "IDEMPOTENCY CONFLICT", detail: e.executionId, tone: "danger" };
    case "LAB_SCENARIO_STARTED":
      return {
        label: "LAB SCENARIO",
        detail: `${e.preset ?? "custom"}   ${Object.entries(e.overrides)
          .map(([k, v]) => `${k}=${v}`)
          .join("   ")}`,
        tone: "lab",
      };
    case "LAB_PROPOSAL_INJECTED":
      return {
        label: "LAB INPUT",
        detail: `proposal ${e.labPercent}%   ·   guardian rule ${e.guardianPercent ?? DASH}%   ·   ceiling ${e.maxReductionPercent}%`,
        tone: "lab",
      };
  }
}

const TONE: Record<Tone, string> = {
  neutral: "text-text",
  decision: "text-warn",
  danger: "text-danger",
  verified: "text-ok",
  // Lab lines are simulated INPUTS. They read as a distinct colour so they can
  // never be mistaken for a measurement or an exchange fact.
  lab: "text-live",
};

/* ------------------------------- primitives -------------------------------- */

/** Marks a value the Agent Lab replaced, so it is never read as a measurement. */
function Sim() {
  return (
    <span
      title="simulated by Agent Lab — not a measurement"
      className="ml-1.5 border border-live/40 px-1 text-[9px] tracking-[0.08em] text-live align-[1px]"
    >
      SIM
    </span>
  );
}

function Stat({
  label,
  value,
  tone,
  simulated,
}: {
  label: string;
  value: string;
  tone?: string;
  simulated?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 px-4 border-l border-line-soft first:border-l-0 first:pl-0">
      <span className="label">{label}</span>
      <span className={`tabular text-[13px] ${tone ?? "text-text"}`}>
        {value}
        {simulated && <Sim />}
      </span>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
  simulated,
}: {
  label: string;
  value: string;
  tone?: string;
  simulated?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-[5px]">
      <span className="text-dim text-[12px]">{label}</span>
      <span className={`tabular text-[12px] ${tone ?? "text-text"}`}>
        {value}
        {simulated && <Sim />}
      </span>
    </div>
  );
}


/* -------------------------------- Agent Lab -------------------------------- */

/**
 * Agent Lab simulates MARKET CONDITIONS only.
 *
 * RUN SCENARIO arms the scenario for the next cycle — it does not evaluate, does
 * not run the runtime, and does not reach Binance. The deterministic runtime,
 * driven by the Agent OS host, picks it up. The browser has no trading
 * authority and this panel does not give it any.
 */
function AgentLab({
  state,
  onArm,
  onReset,
  busy,
}: {
  state: ConsoleState;
  onArm: (scenario: {
    overrides: Record<string, number | string>;
    proposedPercent: number | null;
  }) => void;
  onReset: () => void;
  busy: boolean;
}) {
  const preset = state.presets[0];
  const armed = state.lab;
  const live = state.liveMetrics;

  const [funding, setFunding] = useState<string>(String(preset?.overrides.funding_rate ?? ""));
  const [oi, setOi] = useState<string>(String(preset?.overrides.oi_change_percent ?? ""));
  const [momentum, setMomentum] = useState<string>(String(preset?.overrides.momentum ?? "BEARISH"));
  const [proposal, setProposal] = useState<string>(String(preset?.proposedPercent ?? ""));
  const [open, setOpen] = useState(true);

  const liveFunding =
    live?.fundingRate.value == null ? DASH : `${(live.fundingRate.value * 100).toFixed(4)}%`;
  const liveOi = pct(live?.openInterestChange.value);
  const liveMomentum = live?.momentum.value ?? DASH;

  function loadPreset() {
    if (!preset) return;
    setFunding(String(preset.overrides.funding_rate ?? ""));
    setOi(String(preset.overrides.oi_change_percent ?? ""));
    setMomentum(String(preset.overrides.momentum ?? "BEARISH"));
    setProposal(String(preset.proposedPercent ?? ""));
  }

  function run() {
    const overrides: Record<string, number | string> = {};
    if (funding.trim() !== "") overrides.funding_rate = Number(funding);
    if (oi.trim() !== "") overrides.oi_change_percent = Number(oi);
    if (momentum.trim() !== "") overrides.momentum = momentum;
    onArm({ overrides, proposedPercent: proposal.trim() === "" ? null : Number(proposal) });
  }

  const field =
    "w-full bg-bg border border-line px-2 py-1 text-[12px] tabular text-live focus:outline-none focus:border-live/60";

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between border-y border-line-soft px-5 py-2.5 text-left hover:bg-raised"
      >
        <span className="label">Agent Lab</span>
        <span className="text-[11px] text-faint">
          {armed ? <span className="text-live">ARMED</span> : "live"} {open ? "−" : "+"}
        </span>
      </button>

      {open && (
        <div className="px-5 py-4">
          <p className="mb-3 text-[11px] leading-snug text-faint">
            Simulates market conditions only. Execution, fills, order IDs and the
            Validator&apos;s decision are never simulated.
          </p>

          <div className="mb-1 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <span className="label">Live</span>
            <span />
            <span className="label text-live">Simulated</span>
          </div>

          <div className="flex flex-col gap-2.5">
            <div>
              <div className="text-[11px] text-dim">Funding rate</div>
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                <span className="tabular text-[12px]">{liveFunding}</span>
                <span className="text-faint">→</span>
                <input
                  className={field}
                  value={funding}
                  onChange={(e) => setFunding(e.target.value)}
                  placeholder="0.00041"
                  aria-label="simulated funding rate"
                />
              </div>
            </div>

            <div>
              <div className="text-[11px] text-dim">OI change 30m (%)</div>
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                <span className="tabular text-[12px]">{liveOi}</span>
                <span className="text-faint">→</span>
                <input
                  className={field}
                  value={oi}
                  onChange={(e) => setOi(e.target.value)}
                  placeholder="11"
                  aria-label="simulated open interest change"
                />
              </div>
            </div>

            <div>
              <div className="text-[11px] text-dim">Momentum</div>
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                <span className="tabular text-[12px]">{liveMomentum}</span>
                <span className="text-faint">→</span>
                <select
                  className={field}
                  value={momentum}
                  onChange={(e) => setMomentum(e.target.value)}
                  aria-label="simulated momentum"
                >
                  <option value="BEARISH">BEARISH</option>
                  <option value="NEUTRAL">NEUTRAL</option>
                  <option value="BULLISH">BULLISH</option>
                </select>
              </div>
            </div>
          </div>

          <div className="mt-4 border-t border-line-soft pt-3">
            <div className="text-[11px] text-dim">Test proposal</div>
            <div className="mt-1 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <span className="tabular text-[12px] text-faint">
                rule {state.guardian?.rules[0]?.action.percent ?? DASH}%
              </span>
              <span className="text-faint">→</span>
              <input
                className={field}
                value={proposal}
                onChange={(e) => setProposal(e.target.value)}
                placeholder="60"
                aria-label="test proposal percent"
              />
            </div>
            <p className="mt-1.5 text-[10px] leading-snug text-faint">
              Enlarges the percentage the matched rule <em>proposes</em>, before
              validation. The Guardian&apos;s ceiling stays{" "}
              {state.guardian?.maxReductionPercent ?? DASH}% and the Validator decides
              the clamp independently.
            </p>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={run}
              disabled={busy || Boolean(state.cycle)}
              className="border border-live/50 bg-live/10 px-3 py-1.5 text-[11px] tracking-[0.08em] text-live hover:bg-live/20 disabled:opacity-30"
            >
              RUN SCENARIO
            </button>
            <button
              onClick={onReset}
              disabled={busy || !armed}
              className="border border-line bg-raised px-3 py-1.5 text-[11px] tracking-[0.08em] text-dim hover:text-text disabled:opacity-30"
            >
              RESET TO LIVE
            </button>
            {preset && (
              <button
                onClick={loadPreset}
                disabled={busy}
                className="border border-line px-3 py-1.5 text-[11px] tracking-[0.08em] text-faint hover:text-dim disabled:opacity-30"
                title={preset.note}
              >
                PRESET
              </button>
            )}
          </div>

          {state.cycle && (
            <p className="mt-3 text-[10px] leading-snug text-warn">
              A cycle is in flight. Scenarios are armed between cycles so an
              in-flight evaluation is never changed underneath itself.
            </p>
          )}

          {armed && (
            <div className="mt-3 border border-live/25 bg-live/5 p-2.5">
              <div className="text-[10px] tracking-[0.08em] text-live">ARMED FOR NEXT CYCLE</div>
              <div className="tabular mt-1 text-[11px] text-dim">
                {Object.entries(armed.overrides).map(([k, v]) => (
                  <div key={k}>
                    {k} = {String(v)}
                  </div>
                ))}
                {armed.proposedPercent !== null && <div>proposal = {armed.proposedPercent}%</div>}
              </div>
              <div className="mt-1.5 text-[10px] text-faint">
                Run a cycle through the Agent OS host to evaluate it.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* --------------------------------- console --------------------------------- */

export default function Console({ initial }: { initial: ConsoleState }) {
  const [state, setState] = useState<ConsoleState>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const settled = useRef(false);

  // Follow the newest event, but never yank the view away from someone who has
  // scrolled up to read. 40px of slack absorbs sub-pixel rounding.
  //
  // The first paint is unconditional: arriving at the top of a feed that
  // already has history would hide the very thing the operator opened it for.
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    if (!settled.current) {
      settled.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [state.events.length]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/state", { cache: "no-store" });
        if (!res.ok) return;
        const next = (await res.json()) as ConsoleState;
        if (alive) setState(next);
      } catch {
        // A dropped poll is not worth surfacing; the next one will land.
      }
    };
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  async function control(
    action: "stop" | "pause" | "resume" | "lab_arm" | "lab_reset",
    extra: Record<string, unknown> = {},
  ) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const body = await res.json();
      if (!res.ok) setError(String(body.error ?? "FAILED"));
      else setState(body as ConsoleState);
    } catch {
      setError("UNREACHABLE");
    } finally {
      setBusy(false);
    }
  }

  const { guardian, draft, status, metrics, cycle, relay } = state;
  const m: LiveMetricsReport | null = metrics;
  const side = m ? (m.positionQty.value > 0 ? "LONG" : m.positionQty.value < 0 ? "SHORT" : "FLAT") : null;

  const statusTone =
    status === "ACTIVE" && guardian
      ? "text-ok"
      : status === "OBSERVING"
        ? "text-danger"
        : "text-dim";
  const statusText = guardian ? status : draft ? "DRAFT" : "NO GUARDIAN";

  return (
    <div className="flex min-h-full flex-col bg-bg">
      {/* ───────────────────────── COMMAND STRIP ───────────────────────── */}
      <header className="border-b border-line bg-panel">
        <div className="flex flex-wrap items-center gap-y-4 px-5 py-3">
          <div className="flex items-center gap-2.5 pr-5">
            <span
              className={`h-[7px] w-[7px] rounded-full ${
                status === "ACTIVE" && guardian ? "bg-ok" : status === "OBSERVING" ? "bg-danger" : "bg-faint"
              } ${cycle ? "pulse" : ""}`}
            />
            <span className="text-[13px] font-semibold tracking-[0.14em]">SENTINEL</span>
            <span className={`text-[11px] tracking-[0.09em] ${statusTone}`}>{statusText}</span>
          </div>

          <Stat label="Instrument" value={`${state.symbol}${side && side !== "FLAT" ? ` ${side}` : ""}`} />
          <Stat
            label="Position"
            value={m ? `${Math.abs(m.positionQty.value)} ETH` : DASH}
          />
          <Stat label="Leverage" value={m?.leverage.value ? `${m.leverage.value}×` : DASH} />
          <Stat
            label="Unrealized PnL"
            value={m ? `${num(m.unrealizedPnl.value)}  ${pct(m.unrealizedPnlPercent.value)}` : DASH}
            simulated={m?.unrealizedPnl.simulated}
            tone={
              m?.unrealizedPnl.value == null
                ? undefined
                : m.unrealizedPnl.value >= 0
                  ? "text-ok"
                  : "text-danger"
            }
          />
          <Stat
            label="Funding"
            value={m?.fundingRate.value == null ? DASH : `${(m.fundingRate.value * 100).toFixed(4)}%`}
            simulated={m?.fundingRate.simulated}
          />
          <Stat
            label="Momentum"
            value={m?.momentum.value ?? DASH}
            simulated={m?.momentum.simulated}
          />
          <Stat
            label="Agent OS"
            value={relay.label}
            tone={relay.label === "AWAITING RELAY" ? "text-warn" : "text-dim"}
          />

          <div className="ml-auto flex items-center gap-2 pl-5">
            {error && <span className="text-[11px] text-danger tabular">{error}</span>}
            {status !== "ACTIVE" && guardian && (
              <button
                onClick={() => control("resume")}
                disabled={busy || Boolean(cycle)}
                className="border border-line bg-raised px-3 py-1.5 text-[11px] tracking-[0.08em] text-dim hover:text-text hover:border-faint disabled:opacity-40"
              >
                RESUME
              </button>
            )}
            <button
              onClick={() => control("stop")}
              disabled={busy || !guardian || status === "OBSERVING"}
              className="border border-danger/50 bg-danger/10 px-3 py-1.5 text-[11px] tracking-[0.08em] text-danger hover:bg-danger/20 disabled:opacity-30"
            >
              STOP GUARDIAN
            </button>
          </div>
        </div>

        {relay.pendingWrite && (
          <div className="border-t border-warn/30 bg-warn/10 px-5 py-2 text-[12px] text-warn">
            A real order is awaiting relay. Sentinel will not submit it — approve it
            through the Agent OS host.
          </div>
        )}
        {cycle?.simulated && (
          <div className="border-t border-live/25 bg-live/8 px-5 py-2 text-[12px] text-live">
            AGENT LAB — simulated market inputs:{" "}
            <span className="tabular">
              {Object.entries(cycle.overrides)
                .map(([k, v]) => `${k}=${v}`)
                .join("  ")}
            </span>
            <span className="text-dim"> · the market event is simulated, the trade is not</span>
          </div>
        )}
      </header>

      {/* ──────────────────── FEED + PANELS ──────────────────── */}
      <div className="flex flex-1 flex-col lg:flex-row">
        {/* AGENT FEED */}
        <main className="flex min-w-0 flex-1 flex-col border-line lg:border-r">
          <div className="flex items-baseline justify-between border-b border-line-soft px-5 py-2.5">
            <span className="label">Agent Feed</span>
            <span className="label">
              {cycle ? `cycle ${cycle.cycleId.slice(-8)}` : "idle"} · {state.events.length} events
            </span>
          </div>

          {/*
            Chronological, oldest first. A cycle tells a story — rule matched,
            proposed, clamped, submitted, filled, position changed — and reading
            it newest-first makes that story run backwards up the screen. The
            view follows the newest event unless the operator has scrolled away
            to read something.
          */}
          <div ref={feedRef} className="flex-1 overflow-y-auto px-5 py-3">
            {state.events.length === 0 ? (
              <p className="py-16 text-center text-[12px] text-faint">
                No runtime events yet. The feed renders only what the runtime emits.
              </p>
            ) : (
              <ol className="flex flex-col">
                {state.events.map((e, i) => {
                  const d = describe(e);
                  const startsCycle = i > 0 && state.events[i - 1].cycleId !== e.cycleId;
                  return (
                    <li
                      key={`${e.cycleId}-${e.seq}-${i}`}
                      className={`flex gap-4 border-b border-line-soft py-2 last:border-b-0 ${
                        startsCycle ? "mt-3 border-t border-line pt-3" : ""
                      }`}
                    >
                      <span className="tabular shrink-0 text-[11px] text-faint">{clock(e.at)}</span>
                      <span
                        className={`shrink-0 text-[11px] leading-snug tracking-[0.06em] ${TONE[d.tone]} w-[200px]`}
                      >
                        {d.label}
                      </span>
                      <span className="tabular min-w-0 break-words text-[11px] text-dim">{d.detail}</span>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </main>

        {/* PANELS */}
        <aside className="w-full shrink-0 bg-panel lg:w-[360px]">
          <div className="border-b border-line-soft px-5 py-2.5">
            <span className="label">Guardian</span>
          </div>

          <div className="px-5 py-4">
            {guardian || draft ? (
              <>
                <div className="mb-3">
                  <div className="text-[13px]">{(guardian ?? draft)!.name}</div>
                  <div className="tabular text-[11px] text-faint">{(guardian ?? draft)!.id}</div>
                </div>
                <Row label="Status" value={statusText} tone={statusTone} />
                <Row label="Symbol" value={(guardian ?? draft)!.symbol} />
                <Row
                  label="Max reduction"
                  value={`${(guardian ?? draft)!.maxReductionPercent}%`}
                  tone="text-warn"
                />

                <div className="mt-4 border-t border-line-soft pt-3">
                  <span className="label">Rules</span>
                  {(guardian ?? draft)!.rules.map((rule) => (
                    <div key={rule.id} className="mt-2.5 border border-line-soft bg-raised p-3">
                      <div className="tabular mb-1.5 text-[11px] text-faint">{rule.id}</div>
                      {rule.conditions.map((c, i) => (
                        <div key={i} className="tabular text-[11px] text-dim">
                          {i > 0 && <span className="text-faint">AND </span>}
                          {c.metric} {c.operator} {String(c.value)}
                        </div>
                      ))}
                      <div className="tabular mt-1.5 text-[11px] text-text">
                        → {rule.action.type.replace("_", " ")}
                        {rule.action.percent !== undefined ? ` ${rule.action.percent}%` : ""}
                        {rule.action.percent !== undefined &&
                          rule.action.percent > (guardian ?? draft)!.maxReductionPercent && (
                            <span className="text-warn">
                              {" "}
                              → clamped to {(guardian ?? draft)!.maxReductionPercent}%
                            </span>
                          )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="py-8 text-center text-[12px] text-faint">
                No Guardian. Create one through the Agent OS host.
              </p>
            )}
          </div>

          {/* Measurements the engine is evaluating — the frozen snapshot. */}
          <div className="border-y border-line-soft px-5 py-2.5">
            <span className="label">Measurements</span>
          </div>
          <div className="px-5 py-3">
            {m ? (
              <>
                <Row label="Price (5m close)" value={num(m.price.value)} />
                <Row label="Mark" value={num(m.markPrice.value)} />
                <Row label="EMA20 (5m)" value={num(m.ema20_5m.value)} />
                <Row label="ROC 30m" value={pct(m.roc30m.value)} />
                {m.momentum.simulated && (
                  <p className="mt-1 text-[10px] leading-snug text-faint">
                    EMA and ROC remain live measurements — Agent Lab simulates the
                    momentum classification, not the candles.
                  </p>
                )}
                <Row label="Open interest" value={num(m.openInterest.value, 0)} simulated={m.openInterest.simulated} />
                <Row
                  label="OI change 30m"
                  value={pct(m.openInterestChange.value)}
                  simulated={m.openInterestChange.simulated}
                />
                <Row label="Entry" value={num(m.entryPrice.value)} />
                <Row label="Liquidation" value={num(m.liquidationPrice.value)} />
                <Row
                  label="Liq distance"
                  value={pct(m.liquidationDistancePercent.value)}
                  simulated={m.liquidationDistancePercent.simulated}
                />
                {(m.health.stale || !m.health.warmedUp || m.health.unavailable.length > 0) && (
                  <div className="mt-3 border border-warn/25 bg-warn/5 p-2.5 text-[11px] text-warn">
                    {!m.health.warmedUp && (
                      <div>
                        warming up — {m.health.candlesLoaded}/{m.health.candlesRequired} candles
                      </div>
                    )}
                    {m.health.stale && <div>market data is stale</div>}
                    {m.health.unavailable.length > 0 && (
                      <div>unavailable: {m.health.unavailable.join(", ")}</div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <p className="py-6 text-center text-[12px] text-faint">
                No frozen snapshot. Run a cycle through the host.
              </p>
            )}
          </div>

          <AgentLab
            state={state}
            busy={busy}
            onArm={(scenario) => control("lab_arm", { scenario })}
            onReset={() => control("lab_reset")}
          />

          <div className="border-t border-line-soft px-5 py-3">
            <Row label="Relay calls" value={String(relay.totalCalls)} />
            <Row
              label="Pending"
              value={String(relay.pending)}
              tone={relay.pending > 0 ? "text-warn" : undefined}
            />
            <Row label="Last activity" value={ago(relay.lastActivityAt, state.now)} />
          </div>
        </aside>
      </div>
    </div>
  );
}
