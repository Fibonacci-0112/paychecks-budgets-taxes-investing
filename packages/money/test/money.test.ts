import { describe, expect, it } from "vitest";
import { Money } from "../src/money.js";
import { Rate } from "../src/rate.js";
import {
  AllocationError,
  CurrencyMismatchError,
  ParseError,
  UnknownCurrencyError,
} from "../src/errors.js";

const usd = (value: string) => Money.parse(value, "USD");

describe("Money construction", () => {
  it("parses exact decimals without floating point drift", () => {
    expect(usd("0.1").add(usd("0.2")).toString()).toBe("0.30");
    // The canonical float failure: 0.1 + 0.2 === 0.30000000000000004
    expect(usd("0.1").add(usd("0.2")).equals(usd("0.3"))).toBe(true);
  });

  it("keeps precision beyond the currency's display scale", () => {
    const fraction = usd("0.0001");
    expect(fraction.isZero()).toBe(false);
    expect(fraction.toNumericString()).toBe("0.0001");
    // Displays as 0.00 at USD's two places, but the value is still there.
    expect(fraction.toString()).toBe("0.00");
  });

  it("refuses to silently discard precision", () => {
    expect(() => usd("1.23456")).toThrow(ParseError);
  });

  it("rounds excess precision only when explicitly told to", () => {
    const rounded = Money.parse("1.23455", "USD", { excessPrecision: "HALF_EVEN" });
    expect(rounded.toNumericString()).toBe("1.2346");
  });

  it("rejects exponent notation, which signals a leaked float", () => {
    expect(() => usd("1e3")).toThrow(ParseError);
  });

  it("rejects unknown currencies rather than assuming two decimals", () => {
    expect(() => Money.parse("1.00", "XYZ")).toThrow(UnknownCurrencyError);
  });

  it("converts minor units according to the currency, not a fixed 100", () => {
    expect(Money.fromMinor(12345n, "USD").toString()).toBe("123.45");
    expect(Money.fromMinor(12345n, "JPY").toString()).toBe("12345"); // 0 decimals
    expect(Money.fromMinor(12345n, "KWD").toString()).toBe("12.345"); // 3 decimals
  });

  it("marks number-based construction as unsafe but keeps it usable", () => {
    expect(Money.unsafeFromNumber(19.99, "USD").toString()).toBe("19.99");
    expect(() => Money.unsafeFromNumber(Number.NaN, "USD")).toThrow(RangeError);
  });
});

describe("Money arithmetic", () => {
  it("refuses to mix currencies", () => {
    expect(() => usd("1.00").add(Money.parse("1.00", "EUR"))).toThrow(
      CurrencyMismatchError,
    );
  });

  it("applies a rate with explicit rounding", () => {
    // 7.65% FICA on $1,000.00
    const fica = usd("1000.00").multiply(Rate.parse("0.0765"));
    expect(fica.toString()).toBe("76.50");
  });

  it("multiplies by an integer exactly", () => {
    expect(usd("19.99").multiplyInt(3n).toString()).toBe("59.97");
  });

  it("computes a ratio between two amounts", () => {
    const ratio = usd("25.00").ratioTo(usd("200.00"));
    expect(ratio.toString()).toBe("0.125");
  });

  it("sums an empty collection only with an explicit currency", () => {
    expect(Money.sum([], "USD").isZero()).toBe(true);
    expect(() => Money.sum([])).toThrow(AllocationError);
  });

  it("sums a collection exactly", () => {
    const values = Array.from({ length: 1000 }, () => usd("0.01"));
    expect(Money.sum(values).toString()).toBe("10.00");
  });
});

describe("Money.allocate", () => {
  it("splits without losing or inventing sub-units", () => {
    const parts = usd("100.00").split(3);
    expect(parts.map((p) => p.toString())).toEqual(["33.34", "33.33", "33.33"]);
    expect(Money.sum(parts).equals(usd("100.00"))).toBe(true);
  });

  it("respects weights", () => {
    const parts = usd("100.00").allocate([70, 30]);
    expect(parts.map((p) => p.toString())).toEqual(["70.00", "30.00"]);
  });

  it("distributes the residue to the largest fractional claims", () => {
    // 5c across three buckets: 2c, 2c, 1c — never 1.67c each.
    const parts = Money.fromMinor(5n, "USD").split(3);
    expect(parts.map((p) => p.toString())).toEqual(["0.02", "0.02", "0.01"]);
    expect(Money.sum(parts).toNumericString()).toBe("0.0500");
  });

  it("lands on whole cents by default, because shares get paid", () => {
    const parts = usd("10.00").split(3);
    expect(parts.map((p) => p.toString())).toEqual(["3.34", "3.33", "3.33"]);
    // Every part is a payable amount, not 3.3334.
    for (const part of parts) {
      expect(part.scaled % 100n).toBe(0n);
    }
  });

  it("allocates at full internal precision when asked", () => {
    const parts = usd("10.00").split(3, { granularity: "exact" });
    expect(parts.map((p) => p.toNumericString())).toEqual([
      "3.3334",
      "3.3333",
      "3.3333",
    ]);
    expect(Money.sum(parts).equals(usd("10.00"))).toBe(true);
  });

  it("still sums exactly when the amount carries sub-cent precision", () => {
    // $1.0050 cannot be split into whole cents that sum back exactly, so one
    // bucket carries the half-cent rather than it being silently dropped.
    const amount = Money.parse("1.0050", "USD");
    const parts = amount.split(2);
    expect(Money.sum(parts).equals(amount)).toBe(true);
  });

  it("respects a currency with no minor unit", () => {
    const parts = Money.parse("100", "JPY").split(3);
    expect(parts.map((p) => p.toString())).toEqual(["34", "33", "33"]);
    expect(Money.sum(parts).equals(Money.parse("100", "JPY"))).toBe(true);
  });

  it("allocates negative amounts so the parts still sum exactly", () => {
    const parts = usd("-100.00").split(3);
    expect(Money.sum(parts).equals(usd("-100.00"))).toBe(true);
    expect(parts.map((p) => p.toString())).toEqual(["-33.34", "-33.33", "-33.33"]);
  });

  it("rejects invalid weights", () => {
    expect(() => usd("10.00").allocate([])).toThrow(AllocationError);
    expect(() => usd("10.00").allocate([0, 0])).toThrow(AllocationError);
    expect(() => usd("10.00").allocate([-1, 2])).toThrow(AllocationError);
    expect(() => usd("10.00").allocate([1.5, 2])).toThrow(AllocationError);
  });
});

describe("Money rendering", () => {
  it("renders a Postgres NUMERIC(19,4)-compatible string", () => {
    expect(usd("1234.5").toNumericString()).toBe("1234.5000");
    expect(usd("-0.01").toNumericString()).toBe("-0.0100");
  });

  it("round-trips through JSON exactly", () => {
    const original = Money.parse("98765.4321", "USD");
    const restored = Money.fromJSON(JSON.parse(JSON.stringify(original)));
    expect(restored.equals(original)).toBe(true);
  });

  it("formats for display", () => {
    expect(usd("1234.56").format("en-US")).toBe("$1,234.56");
  });
});
