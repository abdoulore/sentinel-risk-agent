/**
 * The relay journal — an append-only record of every Binance MCP interaction
 * that crossed the boundary between Sentinel's deterministic runtime and the
 * Agent OS host.
 *
 * It serves three jobs at once:
 *
 *   1. Replay      — a re-run of the runtime consumes recorded results instead
 *                    of re-invoking the host, so a cycle can span several host
 *                    turns without the Node process ever blocking.
 *   2. Idempotency — a write is keyed by its logical executionId, so the same
 *                    order is never submitted twice and two legitimate triggers
 *                    with identical arguments are never confused for each other.
 *   3. Evidence    — the file *is* the audit trail: intent, exact arguments,
 *                    raw Binance response, and the position either side of it.
 *
 * Append-only is deliberate. Records are never edited in place; a status change
 * appends a new record for the same requestId and the fold takes the last one.
 * A truncated final line (host killed mid-write) is skipped on load rather than
 * failing the whole journal — but a half-written record is never treated as a
 * completed one, which is exactly the crash window the WRITE rules cover.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { RELAY_JOURNAL_PATH } from "@/lib/config";

export type RelayKind = "READ" | "WRITE";

export type RelayStatus =
  /** Intent persisted. For a WRITE this is the ambiguous window. */
  | "REQUESTED"
  /** The host invoked the tool and recorded the raw result. */
  | "FULFILLED"
  /** The runtime has read the result back during replay. */
  | "CONSUMED"
  /** The host invoked the tool and Binance/MCP returned an error. */
  | "FAILED";

export interface RelayRecord {
  requestId: string;
  cycleId: string;
  stepId: string;
  /** Ordinal of this call within its cycle. Detects replay divergence. */
  seq: number;

  kind: RelayKind;
  /** Required on WRITE. Identifies the logical action, not the arguments. */
  executionId?: string;

  tool: string;
  args: Record<string, unknown>;
  /** sha256 over the canonical (key-sorted) arguments. */
  argsHash: string;

  status: RelayStatus;
  requestedAt: string;
  fulfilledAt?: string;

  result?: unknown;
  error?: unknown;
}

/* ------------------------------ canonical args ---------------------------- */

/**
 * Stable stringify: object keys sorted at every depth so that argument order
 * can never change a hash. Arrays keep their order — it is significant.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(",")}}`;
}

export function hashArgs(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalize(args)).digest("hex").slice(0, 32);
}

/**
 * Deterministic Binance clientOrderId derived from the logical executionId.
 *
 * This is what makes the crash-after-submit window *recoverable* rather than
 * merely detectable: if the host died between Binance accepting the order and
 * the journal recording it, reconciliation can ask Binance for this exact id.
 * Binance's constraint is ^[\.A-Z\:/a-z0-9_-]{1,36}$, so a hex digest is safe.
 */
export function clientOrderIdFor(executionId: string): string {
  const digest = createHash("sha256").update(executionId).digest("hex").slice(0, 24);
  return `SENTINEL-${digest}`;
}

/* -------------------------------- the store ------------------------------- */

export class RelayJournal {
  constructor(private readonly path: string = RELAY_JOURNAL_PATH) {}

  /** Every record, in append order, including superseded ones. */
  readAll(): RelayRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const records: RelayRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as RelayRecord);
      } catch {
        // A truncated final line means the host died mid-append. Skipping it
        // leaves any WRITE it belonged to in REQUESTED, which is the correct
        // ambiguous state — never silently promoted to a completed call.
      }
    }
    return records;
  }

  /** Current state of each request: last record wins. */
  fold(): Map<string, RelayRecord> {
    const byRequest = new Map<string, RelayRecord>();
    for (const record of this.readAll()) byRequest.set(record.requestId, record);
    return byRequest;
  }

  /** Cycle+step scoped lookup. Reads are never keyed by tool+args. */
  findByRequestId(requestId: string): RelayRecord | undefined {
    return this.fold().get(requestId);
  }

  /**
   * Global lookup across every cycle — a write's idempotency must outlive the
   * cycle that created it. Returns the newest record for that executionId.
   */
  findByExecutionId(executionId: string): RelayRecord | undefined {
    let latest: RelayRecord | undefined;
    for (const record of this.fold().values()) {
      if (record.executionId !== executionId) continue;
      if (!latest || record.requestedAt >= latest.requestedAt) latest = record;
    }
    return latest;
  }

  /** All records for one cycle, in sequence order — the demo's audit trail. */
  cycle(cycleId: string): RelayRecord[] {
    return [...this.fold().values()]
      .filter((r) => r.cycleId === cycleId)
      .sort((a, b) => a.seq - b.seq);
  }

  /** Every request still awaiting the host. */
  pending(): RelayRecord[] {
    return [...this.fold().values()]
      .filter((r) => r.status === "REQUESTED")
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  append(record: RelayRecord): RelayRecord {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }

  /** Record the host's raw result. Never overwrites — appends a new state. */
  fulfill(requestId: string, result: unknown): RelayRecord {
    const prior = this.findByRequestId(requestId);
    if (!prior) throw new Error(`RELAY_UNKNOWN_REQUEST: ${requestId}`);
    return this.append({
      ...prior,
      status: "FULFILLED",
      fulfilledAt: new Date().toISOString(),
      result,
    });
  }

  /** Record that the host's invocation failed. */
  fail(requestId: string, error: unknown): RelayRecord {
    const prior = this.findByRequestId(requestId);
    if (!prior) throw new Error(`RELAY_UNKNOWN_REQUEST: ${requestId}`);
    return this.append({
      ...prior,
      status: "FAILED",
      fulfilledAt: new Date().toISOString(),
      error,
    });
  }
}
