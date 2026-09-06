/**
 * Quantity arithmetic against exchange filters.
 *
 * Binance quantities are decimal strings with a fixed step. JavaScript floats
 * cannot represent 0.006 exactly, so every operation here scales to integers
 * before flooring and returns a fixed-precision string.
 */

/** Decimal places implied by a step string: "0.001" -> 3, "1" -> 0. */
export function decimalsOf(step: string): number {
  const trimmed = step.trim();
  const dot = trimmed.indexOf(".");
  if (dot === -1) return 0;
  // Trailing zeros do not add precision: "0.10000000" is 1 decimal place.
  return trimmed.slice(dot + 1).replace(/0+$/, "").length;
}

/**
 * Floors `qty` down to the nearest multiple of `step`.
 *
 * Rounds away float noise at six digits beyond the step before flooring, so a
 * value that is mathematically 0.006 but stored as 0.005999999999999999 does
 * not collapse to 0.005.
 */
export function floorToStep(qty: number, step: string): string {
  const decimals = decimalsOf(step);
  const scale = 10 ** decimals;
  const scaled = Math.round(qty * scale * 1e6) / 1e6;
  const floored = Math.floor(scaled) / scale;
  return floored.toFixed(decimals);
}

export interface QuantityBreakdown {
  positionQty: number;
  requestedPercent: number;
  /** Exact product, before the exchange's step is applied. */
  rawQty: number;
  /** What will actually be sent. */
  steppedQty: string;
  stepSize: string;
  /** True when flooring discarded a non-zero remainder — worth showing. */
  wasRounded: boolean;
}

/**
 * positionQty x reductionPercent -> floor to stepSize.
 *
 * The rounding is returned rather than hidden: the feed shows it as evidence
 * the agent understands exchange constraints (BUILD_PLAN §7).
 */
export function computeReductionQuantity(
  positionQty: number,
  requestedPercent: number,
  stepSize: string,
): QuantityBreakdown {
  const absPosition = Math.abs(positionQty);
  const rawQty = (absPosition * requestedPercent) / 100;
  const steppedQty = floorToStep(rawQty, stepSize);

  return {
    positionQty: absPosition,
    requestedPercent,
    rawQty,
    steppedQty,
    stepSize,
    wasRounded: Number(steppedQty) !== Number(rawQty.toFixed(decimalsOf(stepSize) + 6)),
  };
}
