# Sentinel — design

Why Sentinel is built the way it is. Start with [the README](../README.md) if
you just want to run it.

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

Back to the [README](../README.md).
