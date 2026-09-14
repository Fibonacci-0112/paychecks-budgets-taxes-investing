import { formatDecimal, parseDecimal, type ParseOptions } from "./decimal.js";
import { divideRound, pow10, type RoundingMode } from "./rounding.js";

/**
 * Decimal places a `Rate` is stored at. Twelve comfortably holds every rate the
 * system deals with exactly — tax brackets (0.22), FICA (0.0765), APRs, and
 * daily periodic rates derived from them.
 */
export const RATE_SCALE = 12;

const RATE_UNIT = pow10(RATE_SCALE);

/**
 * An exact decimal ratio: a tax rate, an interest rate, a percentage, an
 * allocation weight.
 *
 * Kept separate from `Money` on purpose. A rate is dimensionless, so adding one
 * to a dollar amount is meaningless — and because both are classes rather than
 * numbers, TypeScript rejects `money + rate` at compile time rather than
 * producing `"[object Object][object Object]"` at runtime.
 */
export class Rate {
  /** Nominal brand. Prevents structural assignment from a lookalike object. */
  declare private readonly __brand: "Rate";

  private constructor(readonly scaled: bigint) {}

  static readonly ZERO = new Rate(0n);
  static readonly ONE = new Rate(RATE_UNIT);

  /** From a decimal string: `Rate.parse("0.0765")` is 7.65%. */
  static parse(input: string, options?: ParseOptions): Rate {
    return new Rate(parseDecimal(input, RATE_SCALE, options));
  }

  /** From a percentage string: `Rate.percent("7.65")` is 0.0765. */
  static percent(input: string, options?: ParseOptions): Rate {
    const scaled = parseDecimal(input, RATE_SCALE, options);
    return new Rate(divideRound(scaled, 100n, "HALF_EVEN"));
  }

  /** From the raw scaled integer. Prefer `parse` unless round-tripping. */
  static fromScaled(scaled: bigint): Rate {
    return new Rate(scaled);
  }

  /**
   * From a JS number. Named to be greppable: a `number` cannot represent most
   * decimals exactly, so every call site is a place precision may already have
   * been lost upstream. Legitimate for simulation inputs and imported data.
   */
  static unsafeFromNumber(value: number): Rate {
    if (!Number.isFinite(value)) {
      throw new RangeError(`Rate.unsafeFromNumber requires a finite number, got ${value}`);
    }
    return Rate.parse(value.toFixed(RATE_SCALE), { excessPrecision: "HALF_EVEN" });
  }

  add(other: Rate): Rate {
    return new Rate(this.scaled + other.scaled);
  }

  subtract(other: Rate): Rate {
    return new Rate(this.scaled - other.scaled);
  }

  /** Rate × Rate, e.g. composing a monthly rate from an annual one. */
  multiply(other: Rate, mode: RoundingMode = "HALF_EVEN"): Rate {
    return new Rate(divideRound(this.scaled * other.scaled, RATE_UNIT, mode));
  }

  divide(other: Rate, mode: RoundingMode = "HALF_EVEN"): Rate {
    return new Rate(divideRound(this.scaled * RATE_UNIT, other.scaled, mode));
  }

  negate(): Rate {
    return new Rate(-this.scaled);
  }

  /** `1 - this`, the common "remaining after withholding" complement. */
  complement(): Rate {
    return new Rate(RATE_UNIT - this.scaled);
  }

  compare(other: Rate): -1 | 0 | 1 {
    if (this.scaled < other.scaled) return -1;
    if (this.scaled > other.scaled) return 1;
    return 0;
  }

  equals(other: Rate): boolean {
    return this.scaled === other.scaled;
  }

  isZero(): boolean {
    return this.scaled === 0n;
  }

  isNegative(): boolean {
    return this.scaled < 0n;
  }

  /**
   * Escape hatch to floating point, for Monte Carlo and other simulation where
   * exactness is neither achievable nor meaningful. Never use this on a path
   * that produces a number shown to the user as money.
   */
  unsafeToNumber(): number {
    return Number(this.scaled) / Number(RATE_UNIT);
  }

  /** Trailing zeros trimmed, so `0.0765` does not render as `0.076500000000`. */
  toString(): string {
    const full = formatDecimal(this.scaled, RATE_SCALE);
    if (!full.includes(".")) return full;
    return full.replace(/\.?0+$/, "");
  }

  toPercentString(decimals = 2): string {
    return `${formatDecimal(this.scaled * 100n, RATE_SCALE, decimals)}%`;
  }

  toJSON(): string {
    return this.scaled.toString();
  }

  static fromJSON(value: string): Rate {
    return new Rate(BigInt(value));
  }
}
