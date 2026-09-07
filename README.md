# Sentinel

**Opening a position takes five seconds. Knowing when to get out is the hard
part.**

Sentinel is a risk layer for Binance Agent OS. You describe how you want a
position protected, in plain words. Sentinel turns that into a policy, checks
it, and enforces it with deterministic code — measuring the market, evaluating
your rules, and placing bounded `reduceOnly` orders when the conditions you set
actually hold.

It never opens, increases or flips a position. **It doesn't trade. It sets the
limits trading has to stay inside.**

A stop-loss fires on one number. A Guardian evaluates funding rate, momentum,
open interest, PnL and liquidation distance together, and reduces by an amount
you capped in advance.

---

## This spends real money

Sentinel places **real orders on your real Binance futures account**. There is
no paper-trading mode and no testnet.

Before you activate anything:

- Start with a position you can afford to lose entirely.
- Read the Guardian it authored before you type `activate`. A Guardian stays a
  `DRAFT` until you explicitly activate it, and that step exists so you read it.
- Understand your ceiling. `maxReductionPercent` is the most Sentinel can take
  in any single action. A ceiling of `100` means a rule **can close your whole
  position**.
- Nothing runs on a schedule unless you start the watcher yourself.

Sentinel is defensive only, and every order it places is `reduceOnly` — it can
shrink a position, never grow one.

---

## What you need

| | |
|---|---|
| **Node** | 20 or newer |
| **An Agent OS host** | Claude Code, Codex, or an IDE agent |
| **A Binance account** | USDC-M futures enabled, with funds in the sub-account the host authenticates as |
| **Keys** | **None.** Sentinel holds no Binance key and no LLM key. The host owns the session. |

That last row is the point. Sentinel never sees a credential. It hands the host
an exact call to make, and reads back the raw result.

---

## Install

**1. Put the repo inside the directory you start your host from.**

This matters. Your host discovers skills and MCP servers relative to where it
starts, so the layout is:

```
my-workspace/            ← start your Agent OS host HERE
├── .claude/skills/      ← the Sentinel skill lands here
└── sentinel/            ← this repo
```

```bash
git clone https://github.com/abdoulore/sentinel-risk-agent.git sentinel
cd sentinel
npm install
```

**2. Connect the Binance MCP server** to your host, from `my-workspace`:

```bash
claude mcp add --transport http binance-mcp-server https://agent.binance.com/mcp/agentic
```

Start your host and run `/mcp` to authenticate. You should see
`binance-mcp-server … ✔ Connected`. This is the step that does the actual
Binance work — without it Sentinel can measure the market but cannot see your
position or place an order.

**3. Install the skill** so your host knows how to drive Sentinel:

```bash
npm run skill:install
```

**4. Check it works.** This is offline: no orders, no network, no account.

```bash
npm run check:all
```

```
576 assertions, 0 failures
```

No configuration is required. `.env.example` documents the optional settings.

---

## Your first Guardian

From your host session, in plain English:

> protect my ETH position. if funding is expensive and price is falling, trim
> it. trim more if it keeps getting worse. never cut more than 30 percent at
> once.

The host's model reads Sentinel's published contract and writes the JSON:

```bash
npm run sentinel -- guardian:schema      # metrics, operators, actions, units
```

```json
{
  "id": "G-ETH-01",
  "symbol": "ETHUSDC",
  "maxReductionPercent": 30,
  "rules": [
    { "id": "R1",
      "conditions": [
        { "metric": "funding_rate", "operator": ">",  "value": 0.0003 },
        { "metric": "momentum",     "operator": "==", "value": "BEARISH" }
      ],
      "action": { "type": "reduce_position", "percent": 30 } }
  ]
}
```

```bash
npm run sentinel -- guardian:create --file guardian.json   # validates → DRAFT
npm run sentinel -- show                                   # read it
npm run sentinel -- activate                               # explicit, always
```

Sentinel validates the schema, metric names, operators, action types, numeric
bounds, symbol and ids. A rejected Guardian stores nothing, and the host can
never write to the Guardian store directly. The contract is generated from the
engine's own registries, so the docs cannot drift from what the code accepts.

**Units are the easiest thing to get wrong:** `funding_rate` is a decimal, so
`0.03%` is `0.0003`.

### Exit code 10 is normal

Run one evaluation:

```bash
npm run sentinel -- cycle
```

The first time, it stops with **exit code 10 and `RELAY_REQUIRED`**. This is not
an error. Sentinel does not hold the Binance session — your host does — so it
writes down the exact call it needs and the host makes it. Your host handles
this automatically through the skill.

| Exit | Meaning |
|---|---|
| `0` | finished |
| `10` | needs the host to relay a call — **normal control flow** |
| `20` | halt condition that must never be resolved by trading |
| `1` | error |

---

## Everyday commands

```bash
npm run sentinel -- status                   # where things stand
npm run sentinel -- show                     # the policy, readable
npm run sentinel -- metrics --source         # live measurements + provenance
npm run sentinel -- cycle                    # one evaluation
npm run sentinel -- pause | resume           # control
npm run sentinel -- stop                     # emergency: evaluate, refuse to act
npm run sentinel -- remove                   # retire the policy entirely
npm run relay -- pending                     # what the host must relay
npm run relay -- show                        # the audit trail
```

---

## Ready-made policies

Worked examples in [`guardians/`](guardians/), each one tested:

| File | Protects against |
|---|---|
| `funding-squeeze.json` | paying to hold a position into a downtrend |
| `liquidation-defence.json` | getting close to liquidation |
| `drawdown.json` | a position going against you |
| `staged-derisk.json` | escalating stress; reduces further as it worsens |
| `staged-capped.json` | the same ladder, but never more than 30% at once |
| `profit-lock.json` | giving back a gain |
| `leverage-discipline.json` | being too leveraged when margin tightens |

```bash
npm run sentinel -- guardian:create --file guardians/staged-capped.json
```

Read [`guardians/README.md`](guardians/README.md) first — it documents
first-match-wins ordering, and the trap where a 100% ceiling lets a rule close
you out.

---

## Running it unattended

A policy is only worth something if it is evaluated when its conditions occur,
which is rarely when you are at the keyboard.

```bash
npm run watch                # poll every 5 minutes
npm run watch -- --once      # single pass; exit 10 = a rule may fire
npm run watch -- --auto      # watch, and act when a rule fires
```

The watcher runs on **public Binance data only** — no credentials, no MCP, no
host — and it cannot trade. It screens the market side of your rules and raises
`.sentinel/attention.json` when the market moves into a state where a rule could
fire. Account-dependent conditions are deferred, never guessed.

In `--auto` it starts a headless host session when the market matches, and that
session runs the cycle and executes within your limits.

**A second limit applies there.** The Validator bounds a single action; it says
nothing about frequency. Bearish episodes last up to 45 minutes, so a correct
Guardian polled every five minutes would fire ten times and leave under 3% of
the position — every action valid, the aggregate absurd. A governor rate-limits
autonomous action:

```
>= 60 minutes between actions · max 3 per day · optional lifetime cap
```

Set with `SENTINEL_MIN_MINUTES_BETWEEN`, `SENTINEL_MAX_ACTIONS_PER_DAY` and
`SENTINEL_MAX_ACTIONS_TOTAL`. The budget is append-only and survives restarts,
so a crash loop cannot reset it, and only *executed* actions are rationed —
raising attention is free.

---

## Asking permission

Sentinel answers a question any agent, script or person can ask: *would this
action be permitted, and at what size?*

```bash
npm run sentinel -- check '{"type":"reduce_position","percent":80}'
```

```
RISK CHECK — G-ETH-01 on ETHUSDC
  proposed        reduce_position 80%
  policy ceiling  30%
  VERDICT         CLAMPED  (MAX_REDUCTION_EXCEEDED)
  permitted       30%  =  0.030 ETH  SELL reduceOnly
  Nothing was executed. This is a verdict, not an order.
```

Exit codes are the verdict — `0` allow, `11` clamp, `12` reject — and `--json`
gives a machine-readable form. Nothing executes.

This is the direction that matters most: a strategy agent proposes, Sentinel
checks it against your policy, and only the permitted size proceeds. A risk desk
between an AI trader and the exchange.

---

## Console

```bash
npm run console        # http://localhost:3000
```

Status, position, PnL, funding, momentum, Guardian state, and the agent feed —
stored domain events only, so it cannot manufacture an order ID, quantity, price
or fill.

The console is a reader. It can stop, pause, resume and arm a test scenario. It
**cannot** create a Guardian, run a cycle, or place an order. A browser button
cannot start a trade, and the tests assert it.

### Testing a policy safely

The Agent Lab simulates **market inputs only** — funding, open interest,
momentum — feeding the same Policy Engine, Validator and relay as the live path.
There is no separate demo code path.

```bash
npm run sentinel -- cycle --new --lab funding_rate=0.00041,momentum=BEARISH
```

It never simulates the Validator's outcome, exchange filters, rounding, the
order, the order ID, the fill, or the position change. Simulated values are
tagged **SIM**, and EMA20/ROC30m stay live even when momentum is overridden —
the Lab simulates the *classification*, not the candles.

> We're simulating the market event, not the trade.

---

## When something goes wrong

**`RELAY_REQUIRED` / exit 10** — not an error, see above. If your host isn't
relaying automatically, check the skill is installed (`npm run skill:install`)
and that you started the host from the parent directory.

**The skill doesn't load** — your host must be started in the directory *above*
this repo, where `.claude/skills/` and the MCP server live.

**`binance-mcp-server` not connected** — run `/mcp` in your host and
authenticate. Sentinel cannot do this for you; it holds no credentials.

**`No active Guardian`** — you created a DRAFT but never ran `activate`.

**`MIN_NOTIONAL`** — the trim is smaller than Binance's minimum order value
(currently $20 on ETHUSDC). Your position is too small to slice. Sentinel
journals the real rejection rather than faking success.

**`EXECUTION_STATE_UNKNOWN`** — an order was journalled but no result came back,
usually a crash mid-write. Sentinel refuses to guess. Run
`npm run relay -- pending` and let it reconcile against the deterministic client
order ID.

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
                             check:library ........ 45

Total ................ 576 assertions, 0 failures
```

Everything runs offline against mocked positions and stubbed upstreams. The
suite places no orders and touches no live position.

Beyond the obvious, the tests assert the properties the design depends on: that
a replayed cycle cannot resubmit an order, that a post-fill read is never served
from a pre-fill one, that a 60% proposal reaches execution only as 30%, that the
browser cannot reach any trading function, that a replayed cycle does not
duplicate feed events, and that no production file reads an LLM API key.

---

## How it works

The short version: **no language model is in the runtime loop.** A model is used
exactly once, to turn your sentence into JSON. Everything after that — every
measurement, rule result, limit, quantity, rounding decision and order parameter
— is deterministic code you can read, test and replay.

For the long version, including why Sentinel relays calls instead of holding its
own Binance session, how replay safety and idempotency work, and how each metric
is defined: **[docs/DESIGN.md](docs/DESIGN.md)**.

---

## Scope

One Guardian. One position. One console.

Deliberately not built: risk scores and confidence percentages, multi-page
navigation, deposits or withdrawals, wallet infrastructure, social or copy
trading, charting libraries, indicator suites, news feeds, multiple positions or
Guardians, a database, WebSockets.

> Sentinel turns trading instructions into risk policies that are enforced by
> code.
