/**
 * Quantity checks — the arithmetic that turns a validator-approved percentage
 * into the exact string sent to Binance.
 *
 *   npm run check:quantity
 *
 * This is the last purely-numeric step before a real order, so every case below
 * asserts. Two properties matter more than any individual example:
 *
 *   1. The stepped quantity NEVER exceeds the raw request. Flooring up would
 *      reduce more of the user's position than the Guardian authorised.
 *   2. The stepped quantity is always an exact multiple of stepSize, as a
 *      decimal string — Binance rejects anything else, and floats cannot
 *      represent most step multiples exactly.
 */
import { floorToStep, decimalsOf, computeReductionQuantity } from "@/lib/execution/quantity";

let failed = false;
function pass(name: string, detail = "") {
  console.log(`  [ok]   ${name}${detail ? ` - ${detail}` : ""}`);
}
function fail(name: string, detail = "") {
  failed = true;
  console.log(`  [FAIL] ${name}${detail ? ` - ${detail}` : ""}`);
}
function check(name: string, cond: boolean, detail = "") {
  if (cond) pass(name, detail);
  else fail(name, detail);
}
function equal(name: string, got: unknown, want: unknown) {
  check(name, Object.is(got, want), `got ${String(got)}, want ${String(want)}`);
}
function section(title: string) {
  console.log(`\n${title}`);
}

/* ========================================================================== */
section("1. decimalsOf");

equal("0.001 -> 3", decimalsOf("0.001"), 3);
equal("1 -> 0", decimalsOf("1"), 0);
equal("0.10000000 -> 1 (trailing zeros add no precision)", decimalsOf("0.10000000"), 1);
equal("0.00000001 -> 8", decimalsOf("0.00000001"), 8);
equal("10 -> 0", decimalsOf("10"), 0);
equal(" 0.01 (whitespace tolerated) -> 2", decimalsOf(" 0.01 "), 2);

/* ========================================================================== */
section("2. floorToStep");

const floorCases: Array<[number, string, string, string]> = [
  [0.0066, "0.001", "0.006", "floors down, never up"],
  [0.006, "0.001", "0.006", "exact multiple is preserved"],
  [0.0126, "0.001", "0.012", "floors down"],
  [0.0009, "0.001", "0.000", "below one step collapses to zero"],
  [1.9999, "0.001", "1.999", "no rounding up near a boundary"],
  [0.022 * 0.3, "0.001", "0.006", "30% of 0.022"],
  [0.041 * 0.3, "0.001", "0.012", "30% of 0.041"],
  [0.009 * 0.3, "0.001", "0.002", "30% of the live fixture size"],
  [0, "0.001", "0.000", "zero"],
  [5, "1", "5", "integer step"],
  [5.9, "1", "5", "integer step floors"],
];
for (const [qty, step, want, why] of floorCases) {
  equal(`floorToStep(${qty}, ${step}) — ${why}`, floorToStep(qty, step), want);
}

// The float-noise case this function exists for: 0.006 is not representable,
// and a naive floor would collapse 0.005999999999999999 to 0.005.
equal("float noise does not lose a step", floorToStep(0.005999999999999999, "0.001"), "0.006");
equal("0.1+0.2 arithmetic noise", floorToStep(0.1 + 0.2, "0.1"), "0.3");

check(
  "result is always a fixed-precision string matching the step",
  floorToStep(0.5, "0.001") === "0.500" && floorToStep(5, "1") === "5",
  `${floorToStep(0.5, "0.001")} / ${floorToStep(5, "1")}`,
);

/* ========================================================================== */
section("3. computeReductionQuantity");

{
  const r = computeReductionQuantity(0.009, 30, "0.001");
  equal("positionQty", r.positionQty, 0.009);
  equal("requestedPercent", r.requestedPercent, 30);
  equal("steppedQty", r.steppedQty, "0.002");
  equal("stepSize echoed", r.stepSize, "0.001");
  check("rawQty is the exact product", Math.abs(r.rawQty - 0.0027) < 1e-12, String(r.rawQty));
  check("wasRounded is true (0.0027 -> 0.002)", r.wasRounded === true);
}

{
  // An exact multiple must not be reported as rounded.
  const r = computeReductionQuantity(0.02, 30, "0.001");
  equal("exact multiple steppedQty", r.steppedQty, "0.006");
  check("wasRounded is false when nothing was discarded", r.wasRounded === false);
}

{
  // A short position: sizing works off the magnitude, sign is the side's job.
  const long = computeReductionQuantity(0.009, 30, "0.001");
  const short = computeReductionQuantity(-0.009, 30, "0.001");
  equal("short position uses |positionAmt|", short.steppedQty, long.steppedQty);
  equal("positionQty is absolute", short.positionQty, 0.009);
}

{
  const r = computeReductionQuantity(0.009, 100, "0.001");
  equal("100% of 0.009", r.steppedQty, "0.009");
  check("100% is not rounded", r.wasRounded === false);
}

{
  // Below one step — the Validator rejects this as QUANTITY_BELOW_MIN, but the
  // arithmetic must produce a clean zero rather than something unsendable.
  const r = computeReductionQuantity(0.002, 10, "0.001");
  equal("sub-step reduction floors to zero", r.steppedQty, "0.000");
  check("and is flagged as rounded", r.wasRounded === true);
}

/* ========================================================================== */
section("4. Invariants across the reduction space");

{
  let overshoot = 0;
  let notAMultiple = 0;
  let wrongDecimals = 0;
  let samples = 0;

  const steps = ["0.001", "0.01", "1"];
  for (const step of steps) {
    const decimals = decimalsOf(step);
    const scale = 10 ** decimals;
    for (let pos = 1; pos <= 200; pos++) {
      const positionQty = pos * 0.001 + 0.0004; // deliberately off-step
      for (const percent of [1, 7, 10, 25, 30, 33.3, 50, 99, 100]) {
        samples++;
        const r = computeReductionQuantity(positionQty, percent, step);
        const stepped = Number(r.steppedQty);

        // 1. never more than requested (1e-9 tolerance for float compare only)
        if (stepped > r.rawQty + 1e-9) overshoot++;
        // 2. exact multiple of the step
        if (Math.abs(Math.round(stepped * scale) - stepped * scale) > 1e-6) notAMultiple++;
        // 3. string carries exactly the step's precision
        const dot = r.steppedQty.indexOf(".");
        const got = dot === -1 ? 0 : r.steppedQty.length - dot - 1;
        if (got !== decimals) wrongDecimals++;
      }
    }
  }

  check(`stepped never exceeds requested (${samples} samples)`, overshoot === 0, `${overshoot} overshoots`);
  check("stepped is always an exact step multiple", notAMultiple === 0, `${notAMultiple} violations`);
  check("string precision always matches the step", wrongDecimals === 0, `${wrongDecimals} violations`);
}

{
  // Reducing by X% then by X% again must never exceed the position.
  const position = 0.009;
  const first = Number(computeReductionQuantity(position, 30, "0.001").steppedQty);
  const second = Number(computeReductionQuantity(position - first, 30, "0.001").steppedQty);
  check(
    "successive reductions stay within the position",
    first + second <= position + 1e-12,
    `${first} + ${second} vs ${position}`,
  );
}

console.log(failed ? "\nQUANTITY CHECKS FAILED.\n" : "\nAll quantity checks passed.\n");
process.exit(failed ? 1 : 0);
