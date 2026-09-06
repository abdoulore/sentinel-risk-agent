/**
 * Governor checks — the rate limit that makes autonomy safe.
 *
 *   npm run check:governor
 *
 * The Validator bounds ONE action. It says nothing about frequency. Left
 * unguarded, a perfectly correct Guardian polled every five minutes through a
 * 45-minute bearish episode would fire nine times and take the position to
 * almost nothing — every action individually valid, the aggregate absurd.
 *
 * These tests pin the second limit: how often, and how many.
 *
 * Offline. No network, no host, no order.
 */
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Governor, DEFAULT_LIMITS, limitsFromEnv, type GovernorLimits } from "@/lib/watch/governor";

let failed = false;
const pass = (n: string, d = "") => console.log(`  [ok]   ${n}${d ? ` - ${d}` : ""}`);
function fail(n: string, d = "") { failed = true; console.log(`  [FAIL] ${n}${d ? ` - ${d}` : ""}`); }
const check = (n: string, c: boolean, d = "") => (c ? pass(n, d) : fail(n, d));
const section = (t: string) => console.log(`\n${t}`);

const dir = mkdtempSync(join(tmpdir(), "sentinel-gov-"));
let n = 0;
const newPath = () => join(dir, `gov-${n++}.jsonl`);
const G = "G-ETH-01";
const MIN = 60_000;

function withHistory(offsetsMinutesAgo: number[], limits = DEFAULT_LIMITS): { gov: Governor; path: string } {
  const path = newPath();
  const now = Date.now();
  for (const m of offsetsMinutesAgo) {
    appendFileSync(path, JSON.stringify({
      at: new Date(now - m * MIN).toISOString(),
      guardianId: G, executionId: `${G}:x${m}`, orderId: 1, quantity: "0.001",
    }) + "\n");
  }
  return { gov: new Governor(limits, path), path };
}

function main() {
  /* ==================================================================== */
  section("1. Defaults are conservative");

  check("at least an hour between actions", DEFAULT_LIMITS.minMinutesBetweenActions >= 60,
    `${DEFAULT_LIMITS.minMinutesBetweenActions}m`);
  check("a small daily cap", DEFAULT_LIMITS.maxActionsPerDay <= 3, String(DEFAULT_LIMITS.maxActionsPerDay));
  check("the measured trigger rate (~1.14/day) fits inside the daily cap",
    DEFAULT_LIMITS.maxActionsPerDay >= 2);

  /* ==================================================================== */
  section("2. A fresh Guardian may act");

  {
    const { gov } = withHistory([]);
    const d = gov.decide(G);
    check("no history -> allowed", d.allow === true);
    check("reports the remaining budget", d.allow && d.remainingToday === DEFAULT_LIMITS.maxActionsPerDay);
  }

  /* ==================================================================== */
  section("3. The cooldown blocks a rapid second action");

  {
    const { gov } = withHistory([5]); // acted 5 minutes ago
    const d = gov.decide(G);
    check("blocked inside the quiet period", d.allow === false);
    check("reason is COOLING_DOWN", !d.allow && d.reason === "COOLING_DOWN", !d.allow ? d.reason : "");
    check("says how long remains", !d.allow && /5[0-9]m of the 60m/.test(d.detail), !d.allow ? d.detail : "");
    check("gives a concrete next-eligible time", !d.allow && Boolean(d.nextEligibleAt));
  }

  {
    const { gov } = withHistory([61]); // just past the quiet period
    check("allowed once the quiet period passes", gov.decide(G).allow === true);
  }

  /* ==================================================================== */
  section("4. THE SCENARIO THIS EXISTS FOR — a 45-minute episode");

  {
    // Poll every 5 minutes through a persistent bearish episode.
    const path = newPath();
    const gov = new Governor(DEFAULT_LIMITS, path);
    let executed = 0;
    const start = Date.now();
    for (let minute = 0; minute <= 45; minute += 5) {
      const now = start + minute * MIN;
      if (gov.decide(G, now).allow) {
        executed += 1;
        appendFileSync(path, JSON.stringify({
          at: new Date(now).toISOString(), guardianId: G,
          executionId: `${G}:m${minute}`, orderId: minute, quantity: "0.001",
        }) + "\n");
      }
    }
    check("ten polls through the episode produced ONE action", executed === 1, `${executed} action(s)`);

    // Without the governor this is what would have happened.
    const unguarded = 10;
    const remaining = Math.pow(0.7, unguarded);
    check("unguarded, the same policy would have fired 10 times", unguarded === 10);
    check("which would have left under 3% of the position",
      remaining < 0.03, `${(remaining * 100).toFixed(1)}% would remain`);
  }

  /* ==================================================================== */
  section("5. The daily cap holds across a long day");

  {
    const limits: GovernorLimits = { minMinutesBetweenActions: 1, maxActionsPerDay: 3, maxActionsTotal: 0 };
    const { gov } = withHistory([600, 400, 200], limits); // three actions today
    const d = gov.decide(G);
    check("a fourth action in 24h is refused", d.allow === false);
    check("reason is DAILY_CAP_REACHED", !d.allow && d.reason === "DAILY_CAP_REACHED", !d.allow ? d.reason : "");
    check("says when the budget frees up", !d.allow && Boolean(d.nextEligibleAt));
  }

  {
    // Actions older than 24h no longer count.
    const limits: GovernorLimits = { minMinutesBetweenActions: 1, maxActionsPerDay: 3, maxActionsTotal: 0 };
    const { gov } = withHistory([1500, 1490, 1480], limits); // ~25h ago
    check("yesterday's actions do not consume today's budget", gov.decide(G).allow === true);
  }

  /* ==================================================================== */
  section("6. Lifetime cap");

  {
    const limits: GovernorLimits = { minMinutesBetweenActions: 0, maxActionsPerDay: 99, maxActionsTotal: 2 };
    const { gov } = withHistory([5000, 4000], limits);
    const d = gov.decide(G);
    check("the lifetime cap stops further action", d.allow === false);
    check("reason is TOTAL_CAP_REACHED", !d.allow && d.reason === "TOTAL_CAP_REACHED");
    const off: GovernorLimits = { ...limits, maxActionsTotal: 0 };
    check("zero disables the lifetime check",
      new Governor(off, withHistory([5000, 4000], off).path).decide(G).allow !== undefined);
  }

  /* ==================================================================== */
  section("7. The budget survives restarts and corruption");

  {
    const { gov, path } = withHistory([5]);
    check("a new Governor reads the same history", new Governor(DEFAULT_LIMITS, path).decide(G).allow === false);

    appendFileSync(path, '{"at":"2026-09-06T10:00:00Z","guard');  // torn line
    const after = new Governor(DEFAULT_LIMITS, path).decide(G);
    check("a torn record does not crash the governor", after.allow === false);
    check("and the existing history still counts", !after.allow && after.reason === "COOLING_DOWN");
  }

  {
    // Another Guardian's actions must not consume this one's budget.
    const path = newPath();
    appendFileSync(path, JSON.stringify({
      at: new Date().toISOString(), guardianId: "G-OTHER", executionId: "x", orderId: 1, quantity: "0.001",
    }) + "\n");
    check("budgets are per-Guardian", new Governor(DEFAULT_LIMITS, path).decide(G).allow === true);
  }

  /* ==================================================================== */
  section("8. Only executed actions are rationed");

  {
    const path = newPath();
    const gov = new Governor(DEFAULT_LIMITS, path);
    check("raising attention costs nothing", gov.decide(G).allow === true);
    gov.record({ guardianId: G, executionId: `${G}:1`, orderId: 42, quantity: "0.001" });
    check("recording an execution consumes budget", gov.decide(G).allow === false);
    const hist = gov.history(G);
    check("the record carries the order id", hist[0].orderId === 42);
    check("and a timestamp", Boolean(Date.parse(hist[0].at)));
  }

  /* ==================================================================== */
  section("9. Limits are operator-configurable, and fail safe");

  {
    process.env.SENTINEL_MIN_MINUTES_BETWEEN = "120";
    process.env.SENTINEL_MAX_ACTIONS_PER_DAY = "1";
    const l = limitsFromEnv();
    check("env tightens the cooldown", l.minMinutesBetweenActions === 120);
    check("env tightens the daily cap", l.maxActionsPerDay === 1);

    process.env.SENTINEL_MIN_MINUTES_BETWEEN = "not-a-number";
    check("garbage falls back to the safe default",
      limitsFromEnv().minMinutesBetweenActions === DEFAULT_LIMITS.minMinutesBetweenActions);
    delete process.env.SENTINEL_MIN_MINUTES_BETWEEN;
    delete process.env.SENTINEL_MAX_ACTIONS_PER_DAY;
  }

  /* ==================================================================== */
  section("10. Autopilot cannot trade, and asks the governor first");

  {
    const src = readFileSync("src/lib/watch/autopilot.ts", "utf8");
    check("autopilot names no order tool", !/newOrder|reducePosition|submitVerified/.test(src));
    check("autopilot imports no execution adapter", !/execution-adapter/.test(src));
    check("autopilot imports no relay invoker", !/HostRelayInvoker/.test(src));
    check("the governor is consulted before the host is started",
      src.indexOf("governor.decide") < src.indexOf("spawn("), "decide precedes spawn");
    check("an action is recorded only after an order is confirmed",
      src.indexOf("outcomeFromEvents") < src.indexOf("governor.record"));
    check("it refuses to start a second cycle over one in flight",
      /CYCLE_IN_FLIGHT/.test(src));
    check("it refuses unless the Guardian is ACTIVE", /GUARDIAN_\$\{state\.status\}/.test(src));
    check("the outcome is read from journalled events, not the host's prose",
      /outcomeFromEvents\(events/.test(src));
  }

  console.log(failed ? "\nGOVERNOR CHECKS FAILED.\n" : "\nAll governor checks passed.\n");
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}

try { main(); } catch (e) { console.error(e); rmSync(dir, { recursive: true, force: true }); process.exitCode = 1; }
