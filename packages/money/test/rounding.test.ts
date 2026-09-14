import { describe, expect, it } from "vitest";
import { divideRound, type RoundingMode } from "../src/rounding.js";
import { DivisionByZeroError } from "../src/errors.js";

/**
 * Each case is `numerator / 2`, so the remainder is exactly half and every mode
 * is forced to reveal its tie-breaking behaviour. Signs are included because
 * FLOOR/CEIL/UP/DOWN differ only there, and that difference is where interest
 * and tax conventions actually live.
 */
const HALF_CASES: ReadonlyArray<[RoundingMode, bigint, bigint]> = [
  // mode,        numerator (÷2),  expected
  ["HALF_EVEN", 5n, 2n], //  2.5 -> 2 (even)
  ["HALF_EVEN", 7n, 4n], //  3.5 -> 4 (even)
  ["HALF_EVEN", -5n, -2n], // -2.5 -> -2 (even)
  ["HALF_EVEN", -7n, -4n], // -3.5 -> -4 (even)
  ["HALF_UP", 5n, 3n], //  2.5 -> 3 (away from zero)
  ["HALF_UP", -5n, -3n], // -2.5 -> -3
  ["HALF_DOWN", 5n, 2n], //  2.5 -> 2 (toward zero)
  ["HALF_DOWN", -5n, -2n], // -2.5 -> -2
  ["UP", 5n, 3n], //  2.5 -> 3
  ["UP", -5n, -3n], // -2.5 -> -3
  ["DOWN", 5n, 2n], //  2.5 -> 2
  ["DOWN", -5n, -2n], // -2.5 -> -2
  ["FLOOR", 5n, 2n], //  2.5 -> 2 (toward -inf)
  ["FLOOR", -5n, -3n], // -2.5 -> -3
  ["CEIL", 5n, 3n], //  2.5 -> 3 (toward +inf)
  ["CEIL", -5n, -2n], // -2.5 -> -2
];

describe("divideRound", () => {
  it.each(HALF_CASES)("%s: %s/2 -> %s", (mode, numerator, expected) => {
    expect(divideRound(numerator, 2n, mode)).toBe(expected);
  });

  it("is exact when there is no remainder, whatever the mode", () => {
    const modes: RoundingMode[] = [
      "HALF_EVEN",
      "HALF_UP",
      "HALF_DOWN",
      "UP",
      "DOWN",
      "FLOOR",
      "CEIL",
    ];
    for (const mode of modes) {
      expect(divideRound(10n, 5n, mode)).toBe(2n);
      expect(divideRound(-10n, 5n, mode)).toBe(-2n);
    }
  });

  it("handles a negative denominator by normalising the sign", () => {
    expect(divideRound(5n, -2n, "HALF_UP")).toBe(-3n);
    expect(divideRound(-5n, -2n, "HALF_UP")).toBe(3n);
  });

  it("rejects division by zero", () => {
    expect(() => divideRound(1n, 0n)).toThrow(DivisionByZeroError);
  });

  it("rounds below the midpoint down and above it up, for every half mode", () => {
    // 2.4 -> 2 and 2.6 -> 3 under all three HALF_* modes.
    for (const mode of ["HALF_EVEN", "HALF_UP", "HALF_DOWN"] as const) {
      expect(divideRound(24n, 10n, mode)).toBe(2n);
      expect(divideRound(26n, 10n, mode)).toBe(3n);
    }
  });
});
