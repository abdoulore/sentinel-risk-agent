---
name: sentinel
description: Drive Sentinel, the autonomous position-risk Guardian for the ETHUSDC futures position. Use when the user wants to protect a position, create/review/activate/pause/stop a Guardian, run a Guardian evaluation cycle, relay a pending Binance Agent OS call, check Sentinel status, or run an Agent Lab scenario. Also use when a Sentinel command reports RELAY_REQUIRED, EXECUTION_STATE_UNKNOWN, or IDEMPOTENCY_CONFLICT.
---

# Sentinel

Sentinel is a defensive risk Guardian for one futures position. The user speaks
plainly; **you** turn that into a structured policy, and Sentinel validates and
enforces it with deterministic code.

This works in any supported Agent OS host — Claude Code, Codex, an IDE agent —
because the host's own model does the interpreting. Sentinel never calls out to
a model of its own, and requires no LLM API key: `ANTHROPIC_API_KEY` is **not
required**, and you must never call the Anthropic API on Sentinel's behalf.

**Once a Guardian is compiled you are the transport, not the trader.** The
runtime decides everything from there. You relay exact calls to the Binance
Agent OS MCP server and record raw results.

Every command runs from the repo directory — the Binance MCP server is
configured on the parent, so `cd` first:

```bash
cd sentinel && npm run sentinel -- status
```

## Compilation ownership — in one place

- The host LLM owns interpretation. That is you.
- Never call Anthropic, or any other model API, on Sentinel's behalf.
- `ANTHROPIC_API_KEY` is not required and must never be required.
- Sentinel owns the schema, metrics, operators, actions, validation, storage and runtime.
- Explicit activation is always required; never activate a Guardian yourself.

## The ownership contract — do not cross it

You own **interpretation only**: turning what the user said into a Guardian, and
explaining what the runtime did.

You never choose, adjust, infer, or "fix":

- the final quantity, or any rounding
- the reduction percentage, or a clamp amount
- the side, symbol, order type, or `reduceOnly`
- whether a rule matched, or whether an action is permitted
- any metric value

If the runtime says `SELL 0.002 ETHUSDC MARKET reduceOnly=true`, you relay
exactly that or you fail. Never "helpfully" adjust a number, even one that looks
wrong. If it looks wrong, stop and tell the user.

## Intents

| User says | You run |
|---|---|
| "protect my position…", "if funding… reduce…" | **you** author the Guardian JSON, then `npm run sentinel -- guardian:create --file <f>` |
| "what can a Guardian do?" | `npm run sentinel -- guardian:schema` |
| "show the guardian", "what's the policy" | `npm run sentinel -- show` |
| "activate", "turn it on" | `npm run sentinel -- activate` |
| "pause" | `npm run sentinel -- pause` |
| "stop", "emergency stop" | `npm run sentinel -- stop` |
| "resume" | `npm run sentinel -- resume` |
| "run a cycle", "check now" | `npm run sentinel -- cycle` |
| "what are the metrics", "show live data" | `npm run sentinel -- metrics` (add `--source` for provenance) |
| "simulate…", "what if funding spiked" | `npm run sentinel -- cycle --new --lab funding_rate=0.00041,momentum=BEARISH` |
| "status" | `npm run sentinel -- status` |
| "what's pending" | `npm run relay -- pending` |
| "show the audit trail" | `npm run relay -- show --cycle <id>` |

### Creating a Guardian — you do the interpreting

**Sentinel makes no LLM call of its own. Never call the Anthropic API. Never
require `ANTHROPIC_API_KEY`.** You are the model in this system; interpretation
is your half of the contract, and Sentinel owns everything after it.

```
user's sentence
  → YOU interpret it                    (this is the only interpretation step)
  → Guardian JSON
  → npm run sentinel -- guardian:create  (deterministic validation + storage)
  → DRAFT
  → user reviews
  → npm run sentinel -- activate         (explicit, never automatic)
  → deterministic runtime; no model in the loop again
```

**1. Read the contract first.** `npm run sentinel -- guardian:schema` prints the
metrics, operators, actions, units and constraints Sentinel accepts, generated
from its own registries. Use `--json` if you prefer structured output. Do not
work from memory of this file — the contract is authoritative and can change.

**2. Author the JSON.** Shape:

```json
{
  "id": "G-ETH-03",
  "name": "ETH Defensive Guardian",
  "symbol": "ETHUSDC",
  "maxReductionPercent": 30,
  "rules": [
    { "id": "R1",
      "conditions": [
        { "metric": "funding_rate", "operator": ">",  "value": 0.0003 },
        { "metric": "momentum",     "operator": "==", "value": "BEARISH" }
      ],
      "action": { "type": "reduce_position", "percent": 30 } }
  ],
  "unsupported": []
}
```

Units are the easiest thing to get wrong: **`funding_rate` is a decimal**, so
"0.03%" is `0.0003`. `guardian:schema` lists the rest.

Do not invent thresholds the user did not state. Anything you cannot express as
a rule goes in `unsupported` as a short phrase — never approximate it with a
rule they did not ask for.

**3. Hand it to Sentinel.** Write the JSON to a file and pass it in — shell
quoting of JSON is fragile, especially on Windows:

```bash
npm run sentinel -- guardian:create --file guardian.json
```

Stdin also works. **Never write to the Guardian store yourself.** All
persistence goes through Sentinel so validation cannot be skipped.

**4. If validation fails**, Sentinel prints every reason and stores nothing.
Fix your JSON and call `guardian:create` again. Correcting output is only ever
appropriate here, at compile time — never later, and never to make a runtime
result look different.

**5. Show the user the validated Guardian and stop.** Report the readable
summary, any warnings, any `unsupported` items, and that the status is DRAFT.
**Do not activate automatically.** Activation requires the user to say so, and
then `npm run sentinel -- activate`.

## Exit codes — the contract

| Code | Meaning | What you do |
|---|---|---|
| `0` | cycle completed | report what happened |
| `10` | `RELAY_REQUIRED` | **normal** — relay the envelope, re-run `cycle` |
| `20` | halt condition | **STOP.** See "Halt conditions" |
| `1` | ordinary error | report it, do not retry blindly |

**`RELAY_REQUIRED` is not an error.** It is how the runtime asks you to make a
call it cannot make itself. Expect several per cycle. Never report it to the
user as a failure, and never treat it as a reason to stop.

## The relay loop

```
npm run sentinel -- cycle
  ├─ exit 0  → done, report
  ├─ exit 20 → STOP
  └─ exit 10 → for each pending envelope:
                 invoke the MCP tool with the EXACT args
                 npm run relay -- fulfill <requestId> --file <result.json>
               then run `cycle` again
```

Repeat until exit 0 or 20. A firing cycle takes about four relay turns. Do not
ask the user for permission on READs — only on the WRITE.

### Tool mapping

The envelope's `tool` is the bare Binance tool name. Prefix it to get the MCP
tool:

```
futures_usds_positionInformationV2  →  mcp__binance-mcp-server__futures_usds_positionInformationV2
futures_usds_accountInformationV3   →  mcp__binance-mcp-server__futures_usds_accountInformationV3
futures_usds_exchangeInformation    →  mcp__binance-mcp-server__futures_usds_exchangeInformation
futures_usds_newOrder               →  mcp__binance-mcp-server__futures_usds_newOrder
futures_usds_queryOrder             →  mcp__binance-mcp-server__futures_usds_queryOrder
```

Pass `args` through unchanged — same keys, same values, same types. Write the
raw JSON result to a file and pass it to `fulfill`. Do not reformat, summarise,
round, or "clean up" the result: the runtime parses the raw Binance response and
verifies it.

If a relayed call fails, record the failure rather than inventing a result:

```
npm run relay -- fail <requestId> --error "<the error>"
```

For a WRITE, `fail` requires `--confirm-not-submitted`, and you may only pass
that when you are certain Binance never accepted the order. If you are not
certain, reconcile instead.

## WRITE rules — rigid

A `"kind": "WRITE"` envelope places a **real order with real money**.

1. Read the pending envelope.
2. Never edit the tool name.
3. Never edit the symbol.
4. Never edit the side.
5. Never edit the quantity.
6. Never change `MARKET`.
7. Never change `reduceOnly: "true"`.
8. Invoke the tool **exactly once**.
9. Immediately journal the raw result with `fulfill`.
10. Re-run `cycle`.

Before step 8, show the user the exact order and **get explicit approval**.
Present: current position, the rule that fired, the validator's decision
(including any clamp), raw quantity, rounded quantity, the MCP tool, the exact
arguments, and the expected remaining position.

`newClientOrderId` is derived deterministically from the executionId. Never
change or regenerate it — it is what makes a crashed submission recoverable.

If the invocation becomes ambiguous — a timeout, a dropped connection, a crash,
or any case where you cannot tell whether Binance accepted the order — **do not
invoke again**:

```
npm run relay -- reconcile <executionId>
→ relay the queryOrder it prints
→ npm run relay -- reconcile-resolve <executionId> --file order.json
   (or --absent if Binance reports no such order)
→ npm run sentinel -- cycle
```

## Halt conditions

On `IDEMPOTENCY_CONFLICT`, `RELAY_NONDETERMINISM`, or
`EXECUTION_STATE_UNKNOWN`:

**Stop. Tell the user. Never resolve any of them by placing another trade.**

There is no situation in which the correct response to one of these is a new
order. `EXECUTION_STATE_UNKNOWN` is resolved by reconciliation only. The other
two mean the runtime disagrees with its own audit trail, which is a bug to be
investigated, not traded through.

## Metrics and provenance

`metrics` prints one complete snapshot. Every field is tagged with where it came
from — `MCP` for account-side truth (position, entry, leverage, PnL,
liquidation), `BINANCE_PUBLIC` for market measurements the MCP toolset does not
expose cleanly (klines, funding rate, open interest, scalar mark price).

`metrics` shows the **frozen** snapshot when a cycle is in flight — the numbers
the Policy Engine is actually evaluating, not fresher ones. That is deliberate;
do not "refresh" it mid-cycle to get newer values. `--fresh` starts a new cycle.

Never quote a metric you did not read from this command's output, and never
fill in a field it printed as `—`. A dash means unmeasured, not zero.

## Agent Lab

Agent Lab simulates **market inputs only** — funding, open interest, momentum.
It never simulates execution. The simulated values flow through the same
deterministic Policy Engine, Validator, and relay as live values, so a triggered
scenario produces a real order.

Say it plainly to the user: *"We're simulating the market event, not the trade."*

Only metrics in the registry may be overridden. Never invent one.

## Boundaries

Sentinel is a **defensive Guardian**, not a trading interface.

- Never place an order outside the relay envelope flow.
- Never increase a position, open a new one, or place a directional trade.
- Never place a non-`reduceOnly` order.
- Never withdraw or transfer funds.
- Never author an action outside the four Sentinel publishes. There is no action
  that opens, increases or flips a position — if the user asks for one, put it
  in `unsupported` and say so plainly.
- Never trade a symbol other than the Guardian's.

If the user asks for any of these, decline briefly and offer the defensive
equivalent. "Buy me more ETH" is out of scope — Sentinel reduces risk, it does
not take it.

## Reporting

Report only what the runtime and Binance actually returned.

- Never claim an order succeeded without a real Binance order ID and a verified
  position change.
- Never state a fill, quantity, or position you did not read from a result.
- If verification failed, say so — a `FILLED` order whose position did not shrink
  is a problem, not a success.
- Quote the runtime's own event lines; they are the evidence.
