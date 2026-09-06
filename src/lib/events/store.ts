/**
 * Domain event store.
 *
 * The Agent Feed renders these and nothing else. It has no other data source,
 * cannot compute a value of its own, and cannot invent an event — if something
 * is not here, it did not happen. That constraint is the whole point: the feed
 * is evidence, not narration.
 *
 * Append-only JSONL, written by the runtime as each event is emitted. Events
 * are already immutable facts (a rule matched, an order filled, a position
 * changed), so there is nothing to update — only to append and to read back.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RuntimeEvent } from "@/lib/policy/runtime";
import { EVENT_LOG_PATH } from "@/lib/config";

/** A runtime event plus the cycle it belongs to. */
export type StoredEvent = RuntimeEvent & {
  cycleId: string;
  /** Monotonic within a cycle, so equal timestamps still render in order. */
  seq: number;
};

export class EventStore {
  constructor(private readonly path: string = EVENT_LOG_PATH) {}

  readAll(): StoredEvent[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const out: StoredEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as StoredEvent);
      } catch {
        // A torn final line is skipped rather than failing the whole feed.
      }
    }
    return out;
  }

  /** Newest last, which is the order the feed reads in. */
  recent(limit = 200): StoredEvent[] {
    const all = this.readAll();
    return all.slice(Math.max(0, all.length - limit));
  }

  forCycle(cycleId: string): StoredEvent[] {
    return this.readAll().filter((e) => e.cycleId === cycleId);
  }

  append(event: RuntimeEvent, cycleId: string, seq: number): StoredEvent {
    const stored: StoredEvent = { ...event, cycleId, seq };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(stored)}\n`, "utf8");
    return stored;
  }

  /**
   * An emit sink bound to one cycle.
   *
   * A cycle spans several host turns and the runtime is re-run on each one, so
   * it re-emits every event that preceded the relay pause. Those are replays of
   * facts already recorded, not new ones — writing them again would show the
   * operator the same rule matching four times.
   *
   * The runtime is deterministic, so the Nth event of a cycle is always the same
   * event. The sink counts its own position and writes only when that slot is
   * empty; a replayed event is dropped, and the stored record keeps the
   * timestamp from when it first actually happened.
   */
  sink(cycleId: string, also?: (e: RuntimeEvent) => void): (e: RuntimeEvent) => void {
    const existing = this.forCycle(cycleId);
    let position = 0;

    return (event) => {
      const seq = position++;
      const recorded = existing.find((e) => e.seq === seq);
      // Same slot, same event type: already on disk from an earlier turn.
      if (!recorded || recorded.type !== event.type) {
        this.append(event, cycleId, seq);
      }
      also?.(event);
    };
  }
}
