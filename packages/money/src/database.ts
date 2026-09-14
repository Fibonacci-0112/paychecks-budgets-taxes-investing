import { getCurrency } from "./currency.js";
import { MoneyError } from "./errors.js";
import { Money } from "./money.js";

/**
 * Binding money to and from the database.
 *
 * Money is stored as a `bigint` count of scaled minor units, **not** as
 * `NUMERIC`. That choice is forced by the sync layer rather than by taste:
 * PowerSync maps Postgres `NUMERIC` to SQLite `TEXT`, and SQLite's `SUM()` over
 * a text column silently coerces to a float. Summing
 * `'9007199254740993.0001'` and `'0.0001'` there yields `9007199254740992` —
 * the fraction gone, the integer part wrong, and no error raised.
 *
 * An `INTEGER` column sums exactly and raises `integer overflow` instead of
 * degrading to a float. A loud failure is the property worth having.
 *
 * Column naming follows the same logic: `amount_units`, never `amount`, so that
 * nobody writing ad-hoc SQL mistakes scaled units for dollars.
 */

/** Thrown when a database value cannot be read back as an exact amount. */
export class DatabaseValueError extends MoneyError {}

/**
 * The value to bind to a `bigint` column.
 *
 * Returned as a string because most drivers marshal `bigint` parameters via
 * `Number`, which is lossy above 2^53.
 */
export function toDatabaseValue(money: Money): string {
  return money.scaled.toString();
}

/**
 * Read an amount back from a `bigint` column.
 *
 * Accepts the shapes drivers actually return. A `number` is accepted only when
 * it is a safe integer: beyond that the driver has already lost precision, and
 * failing here is the last chance to notice.
 */
export function fromDatabaseValue(
  value: string | bigint | number,
  currencyCode: string,
): Money {
  getCurrency(currencyCode);

  if (typeof value === "bigint") {
    return Money.fromScaled(value, currencyCode);
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new DatabaseValueError(
        `Database returned ${value} as a JavaScript number, which cannot hold ` +
          `it exactly. Configure the driver to return bigint columns as strings ` +
          `or BigInt.`,
      );
    }
    return Money.fromScaled(BigInt(value), currencyCode);
  }

  const text = value.trim();
  if (!/^[+-]?\d+$/.test(text)) {
    throw new DatabaseValueError(
      `Expected an integer count of scaled units, got ${JSON.stringify(value)}. ` +
        `A value containing a decimal point means the column is NUMERIC or TEXT ` +
        `rather than bigint, which loses exactness across the sync boundary.`,
    );
  }

  return Money.fromScaled(BigInt(text), currencyCode);
}

/**
 * Sum amounts read from the database.
 *
 * Prefer this to `SUM(amount_units)` for any total a user sees. SQL aggregation
 * is exact on an `INTEGER` column, but going through `Money` keeps currency
 * checking and overflow behaviour consistent between the two paths.
 */
export function sumDatabaseValues(
  rows: ReadonlyArray<{ amount_units: string | bigint | number; currency: string }>,
  currencyCode?: string,
): Money {
  const amounts = rows.map((row) => fromDatabaseValue(row.amount_units, row.currency));
  return Money.sum(amounts, currencyCode);
}
