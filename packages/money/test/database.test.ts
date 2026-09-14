import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Money } from "../src/money.js";
import {
  DatabaseValueError,
  fromDatabaseValue,
  sumDatabaseValues,
  toDatabaseValue,
} from "../src/database.js";

const usd = (value: string) => Money.parse(value, "USD");

describe("database binding", () => {
  it("binds as an integer string, never a JS number", () => {
    expect(toDatabaseValue(usd("1234.56"))).toBe("12345600");
    expect(toDatabaseValue(usd("-0.0001"))).toBe("-1");
    expect(toDatabaseValue(Money.zero("USD"))).toBe("0");
  });

  it("reads back the shapes drivers actually return", () => {
    expect(fromDatabaseValue(12345600n, "USD").equals(usd("1234.56"))).toBe(true);
    expect(fromDatabaseValue("12345600", "USD").equals(usd("1234.56"))).toBe(true);
    expect(fromDatabaseValue(12345600, "USD").equals(usd("1234.56"))).toBe(true);
  });

  it("refuses a number that has already lost precision", () => {
    // Past 2^53 the driver has silently rounded before we ever see the value.
    expect(() => fromDatabaseValue(Number.MAX_SAFE_INTEGER + 2, "USD")).toThrow(
      DatabaseValueError,
    );
  });

  it("refuses a decimal string, which means the column is not bigint", () => {
    // This is the tripwire for the defect that motivated the whole design:
    // a NUMERIC column syncs to SQLite as TEXT, where SUM() silently goes float.
    expect(() => fromDatabaseValue("1234.5600", "USD")).toThrow(DatabaseValueError);
  });

  it("sums rows read from the database", () => {
    const rows = [
      { amount_units: "1000", currency: "USD" },
      { amount_units: 2000n, currency: "USD" },
      { amount_units: 3000, currency: "USD" },
    ];
    expect(sumDatabaseValues(rows).toString()).toBe("0.60");
  });
});

describe("round-trip through the database representation", () => {
  it("survives bind and read-back exactly, for every representable amount", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -10_000_000_000_000_000n, max: 10_000_000_000_000_000n }),
        (scaled) => {
          const original = Money.fromScaled(scaled, "USD");
          const restored = fromDatabaseValue(toDatabaseValue(original), "USD");
          expect(restored.equals(original)).toBe(true);
        },
      ),
    );
  });

  it("keeps a sum exact where a float representation would not", () => {
    // The canonical failure, expressed the way the database sees it.
    const rows = [
      { amount_units: toDatabaseValue(usd("0.1")), currency: "USD" },
      { amount_units: toDatabaseValue(usd("0.2")), currency: "USD" },
    ];
    expect(sumDatabaseValues(rows).equals(usd("0.3"))).toBe(true);

    // And the value that exposed the SQLite TEXT path: stored exactly, summed
    // exactly, where `SUM()` over a text column returned 9007199254740992.
    const large = [
      { amount_units: "90071992547409930001", currency: "USD" },
      { amount_units: "1", currency: "USD" },
    ];
    expect(sumDatabaseValues(large).toNumericString()).toBe("9007199254740993.0002");
  });
});
