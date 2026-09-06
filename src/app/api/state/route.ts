/**
 * The console's only endpoint.
 *
 *   GET   → the full console state
 *   POST  → a Guardian control action
 *
 * The control surface is deliberately tiny: stop, pause, resume. Nothing here
 * can create a Guardian, run a cycle, or place an order. Evaluation and
 * execution belong to the deterministic runtime driven by the Agent OS host —
 * a browser button must never be able to start a trade.
 */
import { GuardianStore } from "@/lib/guardian/store";
import { readConsoleState } from "@/lib/console/state";
import { buildLabScenario, LabScenarioError } from "@/lib/guardian/lab";

export async function GET() {
  return Response.json(readConsoleState(), {
    headers: { "cache-control": "no-store" },
  });
}

/** The only state changes the console may make. */
const CONTROLS = {
  /** Emergency stop: keep measuring and evaluating, refuse every action. */
  stop: "OBSERVING",
  pause: "PAUSED",
  resume: "ACTIVE",
} as const;

type Control = keyof typeof CONTROLS;

function isControl(value: unknown): value is Control {
  return typeof value === "string" && value in CONTROLS;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const action = (body as { action?: unknown })?.action;

  /* ---------------------------- Agent Lab ------------------------------ */

  // RUN SCENARIO *arms* a scenario for the next cycle. It does not evaluate,
  // does not run the runtime, and reaches no exchange. The deterministic runtime
  // — driven by the Agent OS host — picks it up on the next `cycle`. This is
  // what keeps trading authority out of the browser entirely.
  if (action === "lab_arm") {
    const store = new GuardianStore();
    if (store.read().cycle) {
      return Response.json({ error: "CYCLE_IN_FLIGHT" }, { status: 409 });
    }
    try {
      const scenario = buildLabScenario((body as { scenario?: unknown }).scenario ?? {});
      store.armLab(scenario);
    } catch (e) {
      if (e instanceof LabScenarioError) {
        return Response.json({ error: e.reason, detail: e.message }, { status: 400 });
      }
      throw e;
    }
    return Response.json(readConsoleState(), { headers: { "cache-control": "no-store" } });
  }

  // RESET TO LIVE. Clears the armed scenario for subsequent cycles only; an
  // in-flight cycle keeps the scenario it started under, and no historical
  // cycle or event is rewritten.
  if (action === "lab_reset") {
    new GuardianStore().resetLab();
    return Response.json(readConsoleState(), { headers: { "cache-control": "no-store" } });
  }
  if (!isControl(action)) {
    return Response.json(
      { error: "UNKNOWN_ACTION", allowed: Object.keys(CONTROLS) },
      { status: 400 },
    );
  }

  const store = new GuardianStore();
  const current = store.read();
  if (!current.guardian) {
    return Response.json({ error: "NO_GUARDIAN" }, { status: 409 });
  }
  // Resuming is the one control that can re-arm the Guardian, so it is refused
  // while a cycle is mid-flight: the in-flight cycle validated against the
  // status it started with.
  if (action === "resume" && current.cycle) {
    return Response.json({ error: "CYCLE_IN_FLIGHT" }, { status: 409 });
  }

  store.update({ status: CONTROLS[action] });
  return Response.json(readConsoleState(), {
    headers: { "cache-control": "no-store" },
  });
}
