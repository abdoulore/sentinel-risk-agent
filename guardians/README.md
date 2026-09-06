# Guardian library

Ready-made risk policies. Each is plain JSON that passes Sentinel's validation
unchanged — nothing here needs a code change, and none of it is special-cased.

```bash
npm run sentinel -- guardian:create --file guardians/liquidation-defence.json
npm run sentinel -- show
npm run sentinel -- activate
```

Treat them as starting points. Change the thresholds to your own risk appetite,
or describe what you want in plain language and let the host's model write it —
these exist to show the shape, not to be obeyed.

| File | Protects against |
|---|---|
| `funding-squeeze.json` | paying to hold a position into a downtrend |
| `liquidation-defence.json` | getting close to liquidation |
| `drawdown.json` | a position going against you |
| `staged-derisk.json` | escalating stress — reduces further as it worsens |
| `staged-capped.json` | the same escalation, but never more than 30% in one action |
| `profit-lock.json` | giving back a gain |
| `leverage-discipline.json` | being too leveraged when margin tightens |

## How rules resolve

Rules are evaluated **in order, and the first match wins**. Put the most severe
condition first, or a milder rule will pre-empt it. `staged-derisk.json` shows
the pattern: liquidation defence, then loss-plus-funding, then OI stress.

`maxReductionPercent` is a hard ceiling the Validator enforces on **every**
action, whatever a rule asks for. A rule requesting more is clamped, not
rejected — a smaller protective action beats none.

`close_position` is treated as 100% and is clamped by the same ceiling. A
Guardian with a 30% ceiling **cannot** close you out; one with a 100% ceiling
can, in a single action. Set that deliberately.

## Metrics you can use

Run `npm run sentinel -- guardian:schema` for the authoritative list with units.
Getting units wrong is the most common mistake: **`funding_rate` is a decimal**,
so 0.03% is `0.0003`, while `unrealized_pnl_percent` is a plain percentage, so
"down 5%" is `-5`.
