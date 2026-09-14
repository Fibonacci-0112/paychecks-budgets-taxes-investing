import { ParseError } from "./errors.js";
import { divideRound, pow10, type RoundingMode } from "./rounding.js";

/** Plain decimal only. Exponent notation is rejected: in financial input it is
 *  almost always a float that leaked in from somewhere it should not have. */
const DECIMAL_PATTERN = /^([+-]?)(\d*)(?:\.(\d*))?$/;

export interface ParseOptions {
  /**
   * What to do when the input carries more decimal places than `scale`.
   * `"throw"` (the default) refuses, because silently discarding precision the
   * caller explicitly wrote is how cents go missing. Pass a rounding mode to
   * opt into it deliberately.
   */
  readonly excessPrecision?: "throw" | RoundingMode;
}

/**
 * Parse an exact decimal string into a scaled integer.
 *
 * `"12.34"` at scale 4 becomes `123400n`. No floating point is involved at any
 * point, so values that cannot be represented in binary (0.1, 0.2, …) survive
 * exactly.
 */
export function parseDecimal(
  input: string,
  scale: number,
  options: ParseOptions = {},
): bigint {
  const text = input.trim();
  if (text === "") throw new ParseError(input, "empty string");

  if (/[eE]/.test(text)) {
    throw new ParseError(input, "exponent notation is not accepted");
  }

  const match = DECIMAL_PATTERN.exec(text);
  if (!match) throw new ParseError(input, "not a decimal number");

  const [, sign = "", whole = "", fraction = ""] = match;
  if (whole === "" && fraction === "") {
    throw new ParseError(input, "no digits");
  }

  const digits = `${whole}${fraction}` || "0";
  const magnitude = BigInt(digits);
  const excess = fraction.length - scale;

  let scaled: bigint;
  if (excess <= 0) {
    scaled = magnitude * pow10(-excess);
  } else {
    const mode = options.excessPrecision ?? "throw";
    if (mode === "throw") {
      throw new ParseError(
        input,
        `has ${fraction.length} decimal places, which exceeds the scale of ${scale}`,
      );
    }
    scaled = divideRound(magnitude, pow10(excess), mode);
  }

  return sign === "-" ? -scaled : scaled;
}

/**
 * Render a scaled integer as a decimal string with exactly `displayScale`
 * places, rounding if `displayScale` is coarser than `scale`.
 */
export function formatDecimal(
  scaled: bigint,
  scale: number,
  displayScale: number = scale,
  mode: RoundingMode = "HALF_EVEN",
): string {
  let value = scaled;
  if (displayScale < scale) {
    value = divideRound(value, pow10(scale - displayScale), mode);
  } else if (displayScale > scale) {
    value = value * pow10(displayScale - scale);
  }

  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(displayScale + 1, "0");

  const cut = digits.length - displayScale;
  const whole = digits.slice(0, cut);
  const fraction = digits.slice(cut);

  const body = displayScale > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${body}` : body;
}
