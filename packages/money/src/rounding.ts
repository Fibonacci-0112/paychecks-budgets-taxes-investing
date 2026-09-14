import { DivisionByZeroError } from "./errors.js";

/**
 * Rounding modes, matching the semantics of `java.math.RoundingMode` and
 * IEEE 754 where they overlap.
 *
 * Which one to use is a domain decision, not a preference:
 * - `HALF_EVEN` is the default for financial reporting. It avoids the upward
 *   bias that `HALF_UP` introduces when summing many rounded values.
 * - `HALF_UP` is what US tax rules generally specify. Use it in the tax engine.
 * - `DOWN` / `FLOOR` matter for interest accrual conventions that must never
 *   round in the customer's favour.
 */
export type RoundingMode =
  | "HALF_EVEN"
  | "HALF_UP"
  | "HALF_DOWN"
  | "UP"
  | "DOWN"
  | "FLOOR"
  | "CEIL";

export const DEFAULT_ROUNDING: RoundingMode = "HALF_EVEN";

/**
 * Exact integer division with explicit rounding.
 *
 * This is the single place in the codebase where precision can be lost, which
 * is deliberate: every rounding decision in the system funnels through here and
 * is therefore testable in one spot.
 */
export function divideRound(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode = DEFAULT_ROUNDING,
): bigint {
  if (denominator === 0n) throw new DivisionByZeroError();

  // Normalise so the denominator is positive; sign lives entirely in `n`.
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }

  const quotient = n / d; // bigint division truncates toward zero
  const remainder = n % d; // carries the sign of `n`
  if (remainder === 0n) return quotient;

  const isNegative = remainder < 0n;
  const away = isNegative ? quotient - 1n : quotient + 1n;

  // Compare |remainder| * 2 against d to classify below/at/above the midpoint
  // without introducing a fraction.
  const doubled = (isNegative ? -remainder : remainder) * 2n;

  switch (mode) {
    case "DOWN":
      return quotient;
    case "UP":
      return away;
    case "FLOOR":
      return isNegative ? away : quotient;
    case "CEIL":
      return isNegative ? quotient : away;
    case "HALF_UP":
      return doubled >= d ? away : quotient;
    case "HALF_DOWN":
      return doubled > d ? away : quotient;
    case "HALF_EVEN":
      if (doubled > d) return away;
      if (doubled < d) return quotient;
      // Exactly at the midpoint: pick whichever neighbour is even.
      return quotient % 2n === 0n ? quotient : away;
  }
}

/** 10n ** exponent, for non-negative exponents. */
export function pow10(exponent: number): bigint {
  if (!Number.isInteger(exponent) || exponent < 0) {
    throw new RangeError(`pow10 requires a non-negative integer, got ${exponent}`);
  }
  return 10n ** BigInt(exponent);
}
