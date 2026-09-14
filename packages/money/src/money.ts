import { getCurrency, MONEY_SCALE, type Currency } from "./currency.js";
import { formatDecimal, parseDecimal, type ParseOptions } from "./decimal.js";
import { AllocationError, CurrencyMismatchError } from "./errors.js";
import { Rate, RATE_SCALE } from "./rate.js";
import { divideRound, pow10, type RoundingMode } from "./rounding.js";

const RATE_UNIT = pow10(RATE_SCALE);

export interface MoneyJSON {
  readonly amount: string;
  readonly currency: string;
}

/**
 * An exact monetary amount.
 *
 * Stored as a `bigint` count of units at {@link MONEY_SCALE} decimal places,
 * tagged with a currency. No operation anywhere in this class converts to
 * `number`, so 0.1 + 0.2 is exactly 0.3 and a sum of a million rows carries no
 * accumulated drift.
 *
 * Being a class is itself part of the design: TypeScript rejects `a + b` on two
 * `Money` values at compile time, which is the enforcement that a raw `number`
 * representation could never provide.
 */
export class Money {
  /** Nominal brand, so a structurally identical object is not assignable. */
  declare private readonly __brand: "Money";

  private constructor(
    /** Amount in units of 10^-MONEY_SCALE of the major unit. */
    readonly scaled: bigint,
    readonly currencyCode: string,
  ) {}

  // ---------------------------------------------------------------- creation

  static zero(currencyCode: string): Money {
    getCurrency(currencyCode); // validate
    return new Money(0n, currencyCode);
  }

  /**
   * Parse an exact decimal string: `Money.parse("1234.56", "USD")`.
   *
   * Throws if the input carries more precision than can be stored, rather than
   * rounding silently. Pass `{ excessPrecision: "HALF_EVEN" }` to opt in.
   */
  static parse(input: string, currencyCode: string, options?: ParseOptions): Money {
    getCurrency(currencyCode);
    return new Money(parseDecimal(input, MONEY_SCALE, options), currencyCode);
  }

  /** From minor units — cents for USD, whole yen for JPY, fils for KWD. */
  static fromMinor(minor: bigint, currencyCode: string): Money {
    const currency = getCurrency(currencyCode);
    return new Money(minor * pow10(MONEY_SCALE - currency.decimals), currencyCode);
  }

  /** From the raw internal representation. Prefer `parse` unless round-tripping. */
  static fromScaled(scaled: bigint, currencyCode: string): Money {
    getCurrency(currencyCode);
    return new Money(scaled, currencyCode);
  }

  /**
   * From a JS number. Named to be greppable: `number` cannot represent most
   * decimals exactly, so precision may already have been lost before this call.
   * Legitimate only at the boundary with data that genuinely arrives as a float
   * (some CSV exports, third-party APIs), and the result should be reconciled
   * against the source.
   */
  static unsafeFromNumber(value: number, currencyCode: string): Money {
    if (!Number.isFinite(value)) {
      throw new RangeError(`Money.unsafeFromNumber requires a finite number, got ${value}`);
    }
    return Money.parse(value.toFixed(MONEY_SCALE), currencyCode, {
      excessPrecision: "HALF_EVEN",
    });
  }

  // -------------------------------------------------------------- arithmetic

  private assertSameCurrency(other: Money): void {
    if (this.currencyCode !== other.currencyCode) {
      throw new CurrencyMismatchError(this.currencyCode, other.currencyCode);
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.scaled + other.scaled, this.currencyCode);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.scaled - other.scaled, this.currencyCode);
  }

  /** Money × Rate — applying a tax rate, an interest rate, a percentage. */
  multiply(rate: Rate, mode: RoundingMode = "HALF_EVEN"): Money {
    return new Money(
      divideRound(this.scaled * rate.scaled, RATE_UNIT, mode),
      this.currencyCode,
    );
  }

  /** Money × integer — a quantity of identical items. Always exact. */
  multiplyInt(factor: bigint): Money {
    return new Money(this.scaled * factor, this.currencyCode);
  }

  /** Money ÷ Rate. */
  divide(rate: Rate, mode: RoundingMode = "HALF_EVEN"): Money {
    return new Money(
      divideRound(this.scaled * RATE_UNIT, rate.scaled, mode),
      this.currencyCode,
    );
  }

  /** Money ÷ integer. Rounds; use `allocate` when the parts must sum exactly. */
  divideInt(divisor: bigint, mode: RoundingMode = "HALF_EVEN"): Money {
    return new Money(divideRound(this.scaled, divisor, mode), this.currencyCode);
  }

  /** What proportion this is of `other`, as an exact rate. */
  ratioTo(other: Money, mode: RoundingMode = "HALF_EVEN"): Rate {
    this.assertSameCurrency(other);
    return Rate.fromScaled(divideRound(this.scaled * RATE_UNIT, other.scaled, mode));
  }

  negate(): Money {
    return new Money(-this.scaled, this.currencyCode);
  }

  abs(): Money {
    return this.scaled < 0n ? this.negate() : this;
  }

  // -------------------------------------------------------------- allocation

  /**
   * Granularity the parts of an allocation must land on.
   *
   * `"minor"` — whole minor units of the currency (cents for USD). This is the
   * default because an allocated amount is normally one that gets paid,
   * displayed, or budgeted, and a share of 33.3334 dollars is none of those.
   *
   * `"exact"` — the full internal scale. For accruals and intermediate splits
   * that are not themselves settled, where discarding sub-cent precision this
   * early would bias the eventual total.
   */
  allocate(
    weights: readonly (number | bigint)[],
    options: { readonly granularity?: "minor" | "exact" } = {},
  ): Money[] {
    if (weights.length === 0) {
      throw new AllocationError("Cannot allocate across zero buckets");
    }

    const ratios = weights.map((weight, index) => {
      // Validate before converting: BigInt(1.5) throws a RangeError that says
      // nothing useful about which weight was wrong.
      if (typeof weight === "number" && !Number.isInteger(weight)) {
        throw new AllocationError(
          `Weight at index ${index} must be an integer, got ${weight}. ` +
            `Scale fractional weights up to integers first.`,
        );
      }
      const value = typeof weight === "bigint" ? weight : BigInt(weight);
      if (value < 0n) {
        throw new AllocationError(`Weight at index ${index} is negative`);
      }
      return value;
    });

    const total = ratios.reduce((sum, r) => sum + r, 0n);
    if (total === 0n) {
      throw new AllocationError("Allocation weights sum to zero");
    }

    const unit =
      (options.granularity ?? "minor") === "minor"
        ? pow10(MONEY_SCALE - this.currency.decimals)
        : 1n;

    // Allocate whole units; any sub-unit remainder is placed separately below
    // so that the parts still sum back to exactly this amount.
    const whole = this.scaled / unit;
    const subUnit = this.scaled % unit;

    const shares = ratios.map((ratio) => (whole * ratio) / total);
    const distributed = shares.reduce((sum, share) => sum + share, 0n);
    let residue = whole - distributed;

    // Rank buckets by the size of the remainder they gave up, descending, so
    // the residue lands where the fractional claim was largest. Ties break
    // toward the earlier bucket, which makes the result deterministic.
    const order = ratios
      .map((ratio, index) => ({ index, remainder: (whole * ratio) % total }))
      .sort((a, b) => {
        const left = a.remainder < 0n ? -a.remainder : a.remainder;
        const right = b.remainder < 0n ? -b.remainder : b.remainder;
        if (left === right) return a.index - b.index;
        return left > right ? -1 : 1;
      });

    const step = residue < 0n ? -1n : 1n;
    for (const { index } of order) {
      if (residue === 0n) break;
      shares[index] = (shares[index] ?? 0n) + step;
      residue -= step;
    }

    const parts = shares.map((share) => share * unit);

    // A sub-minor-unit remainder cannot be expressed as whole minor units, so
    // it goes to the first participating bucket rather than being dropped.
    if (subUnit !== 0n) {
      const target = ratios.findIndex((ratio) => ratio > 0n);
      const index = target >= 0 ? target : 0;
      parts[index] = (parts[index] ?? 0n) + subUnit;
    }

    return parts.map((part) => new Money(part, this.currencyCode));
  }

  /** Split into `count` as-equal-as-possible parts that sum exactly. */
  split(count: number, options?: { readonly granularity?: "minor" | "exact" }): Money[] {
    if (!Number.isInteger(count) || count < 1) {
      throw new AllocationError(`split requires a positive integer, got ${count}`);
    }
    return this.allocate(new Array<number>(count).fill(1), options);
  }

  // -------------------------------------------------------------- comparison

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.scaled < other.scaled) return -1;
    if (this.scaled > other.scaled) return 1;
    return 0;
  }

  equals(other: Money): boolean {
    return this.currencyCode === other.currencyCode && this.scaled === other.scaled;
  }

  lessThan(other: Money): boolean {
    return this.compare(other) < 0;
  }

  lessThanOrEqual(other: Money): boolean {
    return this.compare(other) <= 0;
  }

  greaterThan(other: Money): boolean {
    return this.compare(other) > 0;
  }

  greaterThanOrEqual(other: Money): boolean {
    return this.compare(other) >= 0;
  }

  isZero(): boolean {
    return this.scaled === 0n;
  }

  isPositive(): boolean {
    return this.scaled > 0n;
  }

  isNegative(): boolean {
    return this.scaled < 0n;
  }

  // ------------------------------------------------------------- aggregation

  /**
   * Sum a collection. `currencyCode` is required only for a possibly-empty
   * collection, where there is otherwise no way to know the currency of zero.
   */
  static sum(values: readonly Money[], currencyCode?: string): Money {
    const first = values[0];
    if (first === undefined) {
      if (currencyCode === undefined) {
        throw new AllocationError(
          "Money.sum of an empty collection needs an explicit currency",
        );
      }
      return Money.zero(currencyCode);
    }
    if (currencyCode !== undefined && currencyCode !== first.currencyCode) {
      throw new CurrencyMismatchError(currencyCode, first.currencyCode);
    }
    return values.reduce((total, value) => total.add(value), Money.zero(first.currencyCode));
  }

  static min(a: Money, b: Money): Money {
    return a.lessThan(b) ? a : b;
  }

  static max(a: Money, b: Money): Money {
    return a.greaterThan(b) ? a : b;
  }

  // --------------------------------------------------------------- rendering

  get currency(): Currency {
    return getCurrency(this.currencyCode);
  }

  /** Plain decimal at the currency's natural precision: `"1234.56"`. */
  toString(): string {
    return formatDecimal(this.scaled, MONEY_SCALE, this.currency.decimals);
  }

  /**
   * Exactly {@link MONEY_SCALE} decimal places, for binding to a Postgres
   * `NUMERIC(19, 4)` column without passing through a float.
   */
  toNumericString(): string {
    return formatDecimal(this.scaled, MONEY_SCALE, MONEY_SCALE);
  }

  /** Localised for display, e.g. `"$1,234.56"`. */
  format(locale = "en-US", options: Intl.NumberFormatOptions = {}): string {
    const currency = this.currency;
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: this.currencyCode,
      minimumFractionDigits: currency.decimals,
      maximumFractionDigits: currency.decimals,
      ...options,
    }).format(
      // Intl needs a number; safe here because this is presentation only and
      // the value has already been rounded to the currency's own precision.
      Number(formatDecimal(this.scaled, MONEY_SCALE, currency.decimals)),
    );
  }

  toJSON(): MoneyJSON {
    return { amount: this.scaled.toString(), currency: this.currencyCode };
  }

  static fromJSON(json: MoneyJSON): Money {
    getCurrency(json.currency);
    return new Money(BigInt(json.amount), json.currency);
  }
}
