import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Rate } from "../src/rate.js";
import { Money } from "../src/money.js";
import { ParseError } from "../src/errors.js";

describe("Rate", () => {
  it("parses decimals and percentages to the same value", () => {
    expect(Rate.parse("0.0765").equals(Rate.percent("7.65"))).toBe(true);
  });

  it("keeps precision that a float would lose", () => {
    // 0.07 * 3 is 0.21000000000000002 in IEEE 754.
    const tripled = Rate.parse("0.07").multiply(Rate.parse("3"));
    expect(tripled.equals(Rate.parse("0.21"))).toBe(true);
  });

  it("renders without trailing zero noise", () => {
    expect(Rate.parse("0.0765").toString()).toBe("0.0765");
    expect(Rate.ONE.toString()).toBe("1");
    expect(Rate.ZERO.toString()).toBe("0");
  });

  it("renders as a percentage", () => {
    expect(Rate.parse("0.0765").toPercentString()).toBe("7.65%");
    expect(Rate.parse("0.22").toPercentString(0)).toBe("22%");
  });

  it("computes the withholding complement", () => {
    expect(Rate.parse("0.22").complement().equals(Rate.parse("0.78"))).toBe(true);
  });

  it("rejects exponent notation", () => {
    expect(() => Rate.parse("1e-3")).toThrow(ParseError);
  });

  it("round-trips through JSON", () => {
    const rate = Rate.parse("0.123456789012");
    expect(Rate.fromJSON(rate.toJSON()).equals(rate)).toBe(true);
  });

  it("names its lossy conversions so they are greppable", () => {
    expect(Rate.unsafeFromNumber(0.075).toString()).toBe("0.075");
    expect(Rate.unsafeFromNumber(0.075).unsafeToNumber()).toBeCloseTo(0.075, 12);
    expect(() => Rate.unsafeFromNumber(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("Rate applied to Money", () => {
  it("splits a gross amount into a withheld part and a remainder that sum back", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 100_000_000_000n }),
        fc.integer({ min: 0, max: 10_000 }),
        (cents, basisPoints) => {
          const gross = Money.fromMinor(cents, "USD");
          const rate = Rate.fromScaled(BigInt(basisPoints) * 100_000_000n); // bp -> 1e12

          const withheld = gross.multiply(rate);
          const net = gross.subtract(withheld);

          // Whatever the rounding, nothing is created or destroyed.
          expect(net.add(withheld).equals(gross)).toBe(true);
        },
      ),
    );
  });

  it("applies a bracket rate the way a tax table would", () => {
    // 22% of $50,000.00
    expect(Money.parse("50000.00", "USD").multiply(Rate.percent("22")).toString()).toBe(
      "11000.00",
    );
  });
});

describe("Rate comparison", () => {
  it("orders rates consistently with their values", () => {
    const low = Rate.percent("8.93");
    const high = Rate.percent("22");

    expect(low.lessThan(high)).toBe(true);
    expect(high.greaterThan(low)).toBe(true);
    expect(low.lessThanOrEqual(low)).toBe(true);
    expect(low.greaterThanOrEqual(low)).toBe(true);
    expect(Rate.min(low, high).equals(low)).toBe(true);
    expect(Rate.max(low, high).equals(high)).toBe(true);
  });
});
