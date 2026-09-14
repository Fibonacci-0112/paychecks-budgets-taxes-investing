import { Money, Rate } from "@finance/money";
import type { BracketRow } from "./types.js";

/**
 * Rounding for tax computation.
 *
 * US tax rules generally specify rounding away from zero at the half, not
 * banker's rounding. `@finance/money` defaults to HALF_EVEN because that is
 * correct for financial *reporting*; tax is a different domain with a different
 * published rule, so every call in this package passes HALF_UP explicitly
 * rather than relying on a default.
 */
export const TAX_ROUNDING = "HALF_UP" as const;

export class TaxDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaxDataError";
  }
}

export interface ParsedBracket {
  readonly threshold: Money;
  readonly base: Money;
  readonly rate: Rate;
}

/**
 * Parse and validate a published rate schedule.
 *
 * Validation is not ceremony here. A tax table is transcribed by hand from a
 * PDF once a year, and a mistyped digit produces an answer that looks entirely
 * reasonable. Checking that thresholds ascend and that each printed cumulative
 * `base` equals the sum of the brackets beneath it turns a transcription error
 * into a loud failure at load time.
 */
export function parseBrackets(
  rows: readonly BracketRow[],
  currencyCode = "USD",
): ParsedBracket[] {
  if (rows.length === 0) {
    throw new TaxDataError("Rate schedule is empty");
  }

  const parsed = rows.map((row, index) => {
    try {
      return {
        threshold: Money.parse(row.threshold, currencyCode),
        base: Money.parse(row.base, currencyCode),
        rate: Rate.parse(row.rate),
      };
    } catch (cause) {
      throw new TaxDataError(
        `Bracket ${index} is malformed (${JSON.stringify(row)}): ${String(cause)}`,
      );
    }
  });

  const first = parsed[0];
  if (first === undefined || !first.threshold.isZero()) {
    throw new TaxDataError("The first bracket must start at zero");
  }
  if (!first.base.isZero()) {
    throw new TaxDataError("The first bracket must have a zero base");
  }

  for (let i = 1; i < parsed.length; i += 1) {
    const previous = parsed[i - 1];
    const current = parsed[i];
    if (previous === undefined || current === undefined) continue;

    if (current.threshold.lessThanOrEqual(previous.threshold)) {
      throw new TaxDataError(
        `Bracket thresholds must ascend: bracket ${i} starts at ` +
          `${current.threshold.toString()}, which is not above ` +
          `${previous.threshold.toString()}`,
      );
    }

    // The published cumulative tax must equal tax accrued in the band below.
    const width = current.threshold.subtract(previous.threshold);
    const expected = previous.base.add(width.multiply(previous.rate, TAX_ROUNDING));

    if (!expected.equals(current.base)) {
      throw new TaxDataError(
        `Bracket ${i} is internally inconsistent: the table states a cumulative ` +
          `tax of ${current.base.toString()} at ${current.threshold.toString()}, ` +
          `but the brackets below it sum to ${expected.toString()}. ` +
          `This usually means a digit was mistyped when transcribing the table.`,
      );
    }
  }

  return parsed;
}

/** Tax on `taxableIncome` under a progressive schedule. */
export function taxFromBrackets(
  taxableIncome: Money,
  brackets: readonly ParsedBracket[],
): Money {
  const zero = Money.zero(taxableIncome.currencyCode);
  if (!taxableIncome.isPositive()) return zero;

  // The applicable bracket is the last one whose threshold the income reaches.
  let applicable = brackets[0];
  for (const bracket of brackets) {
    if (taxableIncome.greaterThan(bracket.threshold)) {
      applicable = bracket;
    } else {
      break;
    }
  }
  if (applicable === undefined) return zero;

  const excess = taxableIncome.subtract(applicable.threshold);
  return applicable.base.add(excess.multiply(applicable.rate, TAX_ROUNDING));
}

/** The rate on the next dollar earned. */
export function marginalRate(
  taxableIncome: Money,
  brackets: readonly ParsedBracket[],
): Rate {
  let applicable = brackets[0];
  for (const bracket of brackets) {
    if (taxableIncome.greaterThan(bracket.threshold)) {
      applicable = bracket;
    } else {
      break;
    }
  }
  return applicable?.rate ?? Rate.ZERO;
}

/**
 * Tax as a share of income — what is actually paid, as opposed to the marginal
 * rate, which is what people tend to quote at themselves.
 */
export function effectiveRate(tax: Money, income: Money): Rate {
  if (!income.isPositive()) return Rate.ZERO;
  return tax.ratioTo(income);
}
