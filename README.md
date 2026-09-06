# Sentinel

**An autonomous position-risk agent for Binance Agent OS.**

You state a risk policy in plain language. Sentinel compiles it into a
structured Guardian, then enforces it with deterministic code — measuring the
market, evaluating rules, clamping unsafe actions, and executing real
`reduceOnly` orders through Binance Agent OS.

> Traditional stop-losses only understand price. Sentinel understands risk.

A stop-loss fires on one number. A Guardian evaluates funding rate, momentum,
open interest, PnL and liquidation distance together, and reduces a position by
a bounded amount when the conditions it was given actually hold.

---

## The one idea

**No language model is in the runtime loop.**

An LLM is used exactly once, to turn a sentence into JSON. Everything after that
— every measurement, every rule result, every limit, every quantity, every
rounding decision, every order parameter — is deterministic code that can be
read, tested and replayed.

| Component | Owns |
|---|---|
| **Host LLM** | Interpretation. Natural language → structured Guardian JSON. Nothing else. |
| **Schema / validator** | Guardian authoring constraints and validation |
| **Metric Engine** | Measurements |
| **Policy Engine** | Rule evaluation |
| **Validator** | Permissions and bounds — allow / clamp / reject |
| **Execution Adapter** | The exact Binance execution contract |
| **Host relay** | Relays already-validated MCP calls **without changing them** |
| **Binance Agent OS MCP** | Binance account and trading interaction |

---

## Agent OS-native

Sentinel is not driven from its own website. It is driven from a supported
Binance Agent OS host — the host already has a model and an authenticated
Binance MCP session, so Sentinel borrows both instead of duplicating them.

```
USER
  ↓
Supported Agent OS host          (Claude Code, Codex, an IDE agent)
  ↓  host LLM interprets the instruction
Structured Guardian JSON
  ↓  deterministic validation
DRAFT  →  explicit user activation
  ↓
Deterministic Sentinel Runtime
  ├─ Metric Engine     ├─ Policy Engine
  ├─ Validator         └─ Execution Adapter
  ↓  exact execution envelope
Host relay journal               (append-only, replayable)
  ↓  host invokes the exact MCP tool, unchanged
Binance Agent OS MCP  →  Binance
```

**Sentinel requires no LLM API key and no Binance API key.** The host owns the
session; the host's model does the interpreting.

Separately, for observability:

```
Runtime → domain event store → Sentinel Console
```

---

## Authoring a Guardian

The host's model reads Sentinel's published contract, then emits JSON.

```bash
npm run sentinel -- guardian:schema      # metrics, operators, actions, units
```

> "Protect my ETHUSDC long. If funding exceeds 0.03% while momentum is bearish,
> reduce 30%. Never reduce more than 30% in one action."

becomes

```json
{
  "id": "G-ETH-03",
  "name": "ETH Defensive Guardian",
  "symbol": "ETHUSDC",
  "maxReductionPercent": 30,
  "rules": [
    {
      "id": "R1",
      "conditions": [
        { "metric": "funding_rate", "operator": ">",  "value": 0.0003 },
        { "metric": "momentum",     "operator": "==", "value": "BEARISH" }
      ],
      "action": { "type": "reduce_position", "percent": 30 }
    }
  ]
}
```

```bash
npm run sentinel -- guardian:create --file guardian.json
```

Sentinel validates the schema, metric names, operators, action types, numeric
bounds, symbol and ids — then stores it as a **DRAFT**. Activation is always a
separate, explicit step. A rejected Guardian stores nothing, and the host can
never write to the Guardian store directly.

The contract is generated from the engine's own registries, so documentation
cannot drift from what the code accepts.

---

## Why a relay, and not a direct connection

Two things were tested rather than assumed, and both shaped the design.

**Sentinel cannot hold its own Binance MCP session.** Registering Sentinel as a
custom OAuth client is refused: *"The AI Agent you are using is not currently
supported."* That work is isolated under `spikes/custom-mcp-client/`, excluded
from the build and imported by nothing.

**Nor can local code reach the host's session.** A host's MCP server exposes
only its own built-in tools and proxies no connected servers; there is no
supported IPC for third-party code to borrow that session.

So the runtime and the host communicate through an **append-only journal**:

```
runtime needs a Binance call
  → writes an exact RelayRequest, throws RelayRequired, exits cleanly
  → host sees the pending envelope, invokes that exact tool with those exact args
  → raw result journaled verbatim
  → runtime re-runs, replays the journal, continues deterministically
```

The process never blocks, every crossing of the boundary is recorded, and the
journal doubles as an audit trail.

### Safety semantics

**Reads** are keyed by `cycleId + stepId`, never by `(tool, args)`. `getPosition`
before a fill and after it are the same tool with identical arguments — keying
by arguments would return the pre-fill position forever and make post-fill
verification silently self-confirming.

**Writes** are keyed by a deterministic `executionId`:

```
same executionId + same args      → replay the recorded result, never resubmit
same executionId + changed args   → IDEMPOTENCY_CONFLICT, hard stop
different executionId + same args → a legitimate new action, submit
intent journaled, no result       → EXECUTION_STATE_UNKNOWN, never retry
```

`newClientOrderId` is derived from the `executionId` and written **before** the
order is sent, so a crash between Binance accepting an order and the journal
recording it is *recoverable*: reconciliation asks Binance for that exact client
order ID instead of resubmitting. None of these states is ever resolved by
placing another trade.

**Frozen snapshots.** A cycle spans several host turns. Measurements are taken
once, at the top of the cycle, and every replay of that cycle reuses them — so a
replay cannot fetch different funding and silently reinterpret the same
decision.

---

## Watching

A policy is only worth something if it is evaluated when its conditions occur —
which is rarely when you are at the keyboard.

```bash
npm run watch                # poll every 5 minutes
npm run watch -- --once      # single pass; exit 10 = a rule may fire
```

The watcher runs on **public Binance data only** — no credentials, no MCP, no
host — and it cannot trade. It screens the market side of your Guardian's rules
and raises `.sentinel/attention.json` when the market moves into a state where
a rule could fire. Account-dependent conditions are deferred, never guessed.

That split matters: the conditions in a typical Guardian occur roughly once a
day, so screening locally means a host session is spent only when something
actually needs deciding, rather than on every poll.

### Unattended

```bash
npm run watch -- --auto      # watch, and act when a rule fires
```

In `--auto` the watcher starts a headless Agent OS host session when the market
matches, and that session runs the cycle, relays the MCP calls and executes
within the Guardian's limits. No human in the loop.

**A second limit applies there, and it matters.** The Validator bounds a single
action; it says nothing about frequency. Bearish episodes last up to 45 minutes,
so a correct Guardian polled every five minutes would fire ten times and leave
under 3% of the position — every action valid, the aggregate absurd. A governor
rate-limits autonomous action:

```
>= 60 minutes between actions · max 3 per day · optional lifetime cap
```

Configurable via `SENTINEL_MIN_MINUTES_BETWEEN`, `SENTINEL_MAX_ACTIONS_PER_DAY`
and `SENTINEL_MAX_ACTIONS_TOTAL`. The budget is append-only and survives
restarts, so a crash loop cannot reset it, and only *executed* actions are
rationed — raising attention is free.

## It is a policy engine, not a funding bot

The example above uses funding and momentum, but nothing in the engine is about
funding. Rules can combine any of the eleven metrics, and `guardians/` ships
ready-made policies for the common cases:

| Policy | Protects against |
|---|---|
| `liquidation-defence` | getting close to liquidation |
| `drawdown` | a position going against you |
| `staged-derisk` | escalating stress — cuts further as it worsens |
| `profit-lock` | giving back a gain |
| `leverage-discipline` | being over-leveraged when margin tightens |
| `funding-squeeze` | paying to hold into a downtrend |

Rules are evaluated **in order, first match wins**, so a Guardian can escalate:

```
liquidation < 8%                          → close
funding > 0.05%  AND  down more than 4%   → reduce 30%
OI +15%          AND  bearish             → reduce 25%
funding > 0.03%  AND  bearish             → reduce 20%
```

That is one Guardian, four stages, no code changes.

## Asking permission — Sentinel as a risk desk

The Validator answers a question any agent can ask: *would this action be
permitted, and at what size?*

```bash
echo '{"type":"reduce_position","percent":80}' | npm run sentinel -- check
```

```
RISK CHECK — G-ETH-03 on ETHUSDC
  proposed        reduce_position 80%
  policy ceiling  30%
  VERDICT         CLAMPED  (MAX_REDUCTION_EXCEEDED)
  permitted       30%  =  0.030 ETH  SELL reduceOnly
  Nothing was executed. This is a verdict, not an order.
```

Exit codes are the verdict — `0` allow, `11` clamp, `12` reject — and `--json`
gives a machine-readable form. Nothing executes.

This is the direction that matters most: a strategy agent proposes, Sentinel
checks it against the user's policy, and only the permitted size proceeds. A
risk desk between an AI trader and the exchange.

## Metrics

Pure code. No model involvement anywhere in this path.

**Momentum** (frozen definition, not a calibrated one):

```
5m candles · EMA20 over 5m closes · ROC over 6 candles (30m)

ROC30m  = (latestClose − close6CandlesAgo) / close6CandlesAgo
BEARISH = price < EMA20 AND ROC30m < −1.0%
BULLISH = price > EMA20 AND ROC30m > +1.0%
NEUTRAL = otherwise
```

Measured over one week of real ETHUSDC 5m data (2,015 candles, 1,990
evaluations): BEARISH held on **23 candles (1.16%)** across **8 distinct
episodes**, about **1.14 per day**, longest run 45 minutes. Real but infrequent —
which is why Agent Lab exists.

**Open-interest change** is an explicit measurement, not a vague label:
`OI_CHANGE_30M = (currentOI − oi30mAgo) / oi30mAgo`. If the history is
unavailable the value is `null`, never substituted.

Every metric is tagged with its origin — `MCP` for account truth, or
`BINANCE_PUBLIC` for public measurements Agent OS does not expose cleanly
(klines, funding, open interest, scalar mark price):

```bash
npm run sentinel -- metrics --source
```

---

## The Validator owns the clamp

```
Invalid intent                    → REJECT
Valid intent, unsafe magnitude    → CLAMP
Valid intent within bounds        → EXECUTE
```

Agent Lab can supply a **test proposal** of 60% while the Guardian's own ceiling
stays 30%. The Guardian is not rewritten — it is byte-identical after the run.
The Validator receives the larger proposal and independently decides:

```
LAB INPUT             proposal 60% (guardian rule 30%, ceiling 30%)
ACTION PROPOSED       reduce_position 60%
ACTION CLAMPED        60% -> 30%
EXECUTION VALIDATED   position 0.01  raw 0.00300000  rounded 0.003  reduceOnly ✓
```

Only the clamped 30% reaches quantity calculation.

---

## Agent Lab

Simulates **market inputs only** — funding, open interest, momentum — feeding
the same Policy Engine, Validator and relay as the live path. There is no
separate demo code path.

It never simulates the Validator's outcome, exchange filters, rounding, the
order, the order ID, the fill, or the position change. Simulated values are
tagged **SIM** in the console, and EMA20/ROC30m stay live even when momentum is
overridden — the Lab simulates the *classification*, not the candles.

> We're simulating the market event, not the trade.

---

## Verified execution

The full path, executed against a live account.

```
Fixture      ETHUSDC LONG · 0.010 ETH · 5x cross · entry 2530.05

Lab proposal      60%
Guardian ceiling  30%
Validator         CLAMP 60% → 30%
30% of 0.010      0.003 ETH   (stepSize 0.001, no rounding loss)

Envelope     SELL 0.003 ETHUSDC MARKET reduceOnly=true

Result       order 82432218254 · FILLED · 0.003 ETH · reduceOnly true
             clientOrderId SENTINEL-25dff279aa0bfddfc322176c

A fresh MCP position read confirmed:   0.010 ETH → 0.007 ETH
```

Twenty-one pre-relay checks were verified against the journal — not against a
recollection of what was sent — before the order was relayed.

Post-fill, the Guardian re-evaluated to **TRIGGERED**, not `WATCH`. That is
correct: the Lab cycle re-evaluates against the same frozen simulated snapshot,
so the rule still matched at the reduced size. A live cycle takes a fresh
snapshot and would move to `WATCH` once conditions no longer hold.

---

## Console

One surface. Two routes — `/` and `/api/state`. No multi-page dashboard, no
client-side routing.

```bash
npm run console        # http://localhost:3000
```

- **Command strip** — status, position, leverage, PnL, funding, momentum,
  Guardian state, relay state, `STOP GUARDIAN`
- **Agent feed** — stored domain events only, oldest first so a cycle reads as
  the story it is; it cannot manufacture an order ID, quantity, price or fill
- **Panels** — Guardian details, measurements, Agent Lab

The console is a reader. Its endpoint accepts stop / pause / resume and arming
an Agent Lab scenario — it cannot create a Guardian, run a cycle, or place an
order. **A browser button cannot start a trade**, and the tests assert it.

Relay state reads `READY` / `IDLE` / `AWAITING RELAY`. It does not claim
"Binance connected": Sentinel does not hold that session, so asserting a
connection it cannot observe would be inventing a value.

---

## Running it

Requires Node 20+ and a supported Agent OS host with the Binance MCP server
connected.

```bash
npm install
npm run skill:install        # installs the Sentinel skill for the host
npm run check:all            # full offline test suite
```

Then, from the host:

```bash
npm run sentinel -- guardian:schema                       # the authoring contract
npm run sentinel -- guardian:create --file guardian.json  # validate → DRAFT
npm run sentinel -- activate                              # explicit
npm run sentinel -- metrics --source                      # live snapshot
npm run sentinel -- cycle                                 # one evaluation
npm run relay -- pending                                  # what the host must relay
npm run relay -- show                                     # audit trail
```

`cycle` exits `0` when done, **`10` when it needs the host to relay a call**
(normal control flow, not an error), `20` on a halt condition that must never be
resolved by trading, and `1` on error.

No configuration is required to run. See `.env.example` for optional settings.

---

## Tests

```
tsc --noEmit ......... exit 0

check:quantity ....... 38    check:metrics ........ 69
check:adapter ........ 29    check:console ........ 40
check:runtime ........ 27    check:lab ............ 91
check:relay .......... 86    check:compile ........ 82
                             check:watch .......... 30
                             check:governor ....... 39
                             check:library ........ 39

Total ................ 570 assertions, 0 failures
```

Everything runs offline against mocked positions and stubbed upstreams. The
suite places no orders and touches no live position.

Beyond the obvious, the tests assert the properties the design depends on: that
a replayed cycle cannot resubmit an order, that a post-fill read is never served
from a pre-fill one, that a 60% proposal reaches execution only as 30%, that the
browser cannot reach any trading function, that a replayed cycle does not
duplicate feed events, and that no production file reads an LLM API key.

---

## Layout

```
src/lib/
  compiler/     schema, deterministic validation, published contract
  metrics/      momentum, metric engine, provenance-tagged reporting
  binance/      public market data, symbol filters, shared response types
  policy/       types + registries, policy engine, validator, runtime loop
  execution/    quantity arithmetic, execution adapter + invariants
  mcp/          contract, relay journal, host relay, reconciliation
  guardian/     Guardian + cycle state, Agent Lab scenarios
  events/       append-only domain event store
  console/      read-only console state assembly
src/app/        the console (one page + one data route)
scripts/        the CLI, the relay CLI, and the test suites
agent/skills/   the Agent OS skill
spikes/         discarded experiments — excluded from the build
```

---

## Scope

One Guardian. One position. One console.

Deliberately not built: risk scores and confidence percentages, multi-page
navigation, deposits or withdrawals, wallet infrastructure, social or copy
trading, charting libraries, indicator suites, news feeds, multiple positions or
Guardians, a database, WebSockets.

Sentinel is **defensive only**. There is no action that opens, increases or
flips a position, and every protective order is `reduceOnly`.

> Sentinel turns trading instructions into risk policies that are enforced by code.
