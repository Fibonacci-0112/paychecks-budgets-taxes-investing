import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Money } from "../src/money.js";
import { Rate } from "../src/rate.js";

/**
 * Invariants, not examples.
 *
 * Hand-written cases only prove the paths someone thought to write down. These
 * assert the properties the ledger will depend on for every value the type can
 * hold — which is the actual contract, and the reason a balance can be trusted.
 */

/** Roughly ±1 trillion dollars at scale 4: far beyond any real balance. */
const BOUND = 10_000_000_000_000_000n;

const money = fc
  .bigInt({ min: -BOUND, max: BOUND })
  .map((scaled) => Money.fromScaled(scaled, "USD"));

const weights = fc.array(fc.integer({ min: 0, max: 1_000_000 }), {
  minLength: 1,
  maxLength: 12,
});

describe("Money algebraic properties", () => {
  it("addition is commutative", () => {
    fc.assert(
      fc.property(money, money, (a, b) => {
        expect(a.add(b).equals(b.add(a))).toBe(true);
      }),
    );
  });

  it("addition is associative", () => {
    fc.assert(
      fc.property(money, money, money, (a, b, c) => {
        expect(a.add(b).add(c).equals(a.add(b.add(c)))).toBe(true);
      }),
    );
  });

  it("zero is the additive identity", () => {
    fc.assert(
      fc.property(money, (a) => {
        expect(a.add(Money.zero("USD")).equals(a)).toBe(true);
      }),
    );
  });

  it("subtraction undoes addition", () => {
    fc.assert(
      fc.property(money, money, (a, b) => {
        expect(a.add(b).subtract(b).equals(a)).toBe(true);
      }),
    );
  });

  it("negation is an involution and its own additive inverse", () => {
    fc.assert(
      fc.property(money, (a) => {
        expect(a.negate().negate().equals(a)).toBe(true);
        expect(a.add(a.negate()).isZero()).toBe(true);
      }),
    );
  });

  it("multiplying by a rate of one is the identity", () => {
    fc.assert(
      fc.property(money, (a) => {
        expect(a.multiply(Rate.ONE).equals(a)).toBe(true);
      }),
    );
  });

  it("comparison is a total order consistent with subtraction", () => {
    fc.assert(
      fc.property(money, money, (a, b) => {
        const cmp = a.compare(b);
        const reverse = b.compare(a);

        // Antisymmetry, asserted as a sum rather than as `cmp === -reverse`.
        // Negating zero in JavaScript produces -0, and `toBe` uses Object.is,
        // under which Object.is(0, -0) is false — so the negated form fails
        // whenever a and b happen to be equal. Addition yields +0 in every
        // case, so this states the property without depending on zero's sign.
        expect(cmp + reverse).toBe(0);

        if (cmp === 0) expect(a.equals(b)).toBe(true);
        if (cmp < 0) expect(b.subtract(a).isPositive()).toBe(true);
        if (cmp > 0) expect(a.subtract(b).isPositive()).toBe(true);
      }),
    );
  });

  it("compares equal values as equal, whichever way round", () => {
    // The case the antisymmetry assertion above used to trip over: two equal
    // amounts compare to zero in both directions.
    fc.assert(
      fc.property(money, (a) => {
        const copy = Money.fromScaled(a.scaled, a.currencyCode);
        expect(a.compare(copy)).toBe(0);
        expect(copy.compare(a)).toBe(0);
        expect(a.equals(copy)).toBe(true);
      }),
    );
  });
});

describe("Money.allocate invariants", () => {
  it("always sums back to the original amount", () => {
    fc.assert(
      fc.property(money, weights, (amount, rawWeights) => {
        // Skip weight vectors that are entirely zero; those are rejected by design.
        fc.pre(rawWeights.some((w) => w > 0));

        const parts = amount.allocate(rawWeights);
        expect(Money.sum(parts, "USD").equals(amount)).toBe(true);
      }),
    );
  });

  it("returns exactly one part per weight", () => {
    fc.assert(
      fc.property(money, weights, (amount, rawWeights) => {
        fc.pre(rawWeights.some((w) => w > 0));
        expect(amount.allocate(rawWeights)).toHaveLength(rawWeights.length);
      }),
    );
  });

  it("keeps every part within one sub-unit of its exact share, at exact granularity", () => {
    fc.assert(
      fc.property(money, weights, (amount, rawWeights) => {
        fc.pre(rawWeights.some((w) => w > 0));

        const total = rawWeights.reduce((sum, w) => sum + BigInt(w), 0n);
        const parts = amount.allocate(rawWeights, { granularity: "exact" });

        parts.forEach((part, index) => {
          const exact = (amount.scaled * BigInt(rawWeights[index] ?? 0)) / total;
          const drift = part.scaled - exact;
          expect(drift >= -1n && drift <= 1n).toBe(true);
        });
      }),
    );
  });

  it("produces only whole minor units when the amount is itself whole cents", () => {
    // Money that lands exactly on a cent: the payable case, which is the
    // overwhelming majority of real allocations.
    const wholeCents = fc
      .bigInt({ min: -BOUND / 100n, max: BOUND / 100n })
      .map((cents) => Money.fromMinor(cents, "USD"));

    fc.assert(
      fc.property(wholeCents, weights, (amount, rawWeights) => {
        fc.pre(rawWeights.some((w) => w > 0));

        const parts = amount.allocate(rawWeights);
        expect(Money.sum(parts, "USD").equals(amount)).toBe(true);

        // 100 scaled units == one cent, given MONEY_SCALE 4 and USD's 2 decimals.
        for (const part of parts) {
          expect(part.scaled % 100n).toBe(0n);
        }
      }),
    );
  });

  it("splits evenly into parts that differ by at most one minor unit", () => {
    fc.assert(
      fc.property(money, fc.integer({ min: 1, max: 24 }), (amount, count) => {
        const parts = amount.split(count, { granularity: "exact" });
        expect(Money.sum(parts, "USD").equals(amount)).toBe(true);

        const scaled = parts.map((p) => p.scaled);
        const min = scaled.reduce((a, b) => (a < b ? a : b));
        const max = scaled.reduce((a, b) => (a > b ? a : b));
        expect(max - min <= 1n).toBe(true);
      }),
    );
  });
});

describe("Money serialisation round-trips", () => {
  it("survives JSON exactly", () => {
    fc.assert(
      fc.property(money, (a) => {
        const restored = Money.fromJSON(JSON.parse(JSON.stringify(a)));
        expect(restored.equals(a)).toBe(true);
      }),
    );
  });

  it("survives the Postgres NUMERIC string form exactly", () => {
    fc.assert(
      fc.property(money, (a) => {
        expect(Money.parse(a.toNumericString(), "USD").equals(a)).toBe(true);
      }),
    );
  });
});

describe("Money.sum is order-independent", () => {
  it("gives the same total regardless of the order of the terms", () => {
    fc.assert(
      fc.property(fc.array(money, { maxLength: 50 }), (values) => {
        const forward = Money.sum(values, "USD");
        const backward = Money.sum([...values].reverse(), "USD");
        expect(forward.equals(backward)).toBe(true);
      }),
    );
  });
});
