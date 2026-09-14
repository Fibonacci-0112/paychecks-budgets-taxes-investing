import { Money } from "@finance/money";
import { describe, expect, it } from "vitest";
import {
  computeBudgetPeriod,
  distribute,
  fundingPerPeriod,
  type CategoryBudget,
} from "../src/budget.js";

const usd = (value: string) => Money.parse(value, "USD");

const groceries: CategoryBudget = {
  categoryId: "groceries",
  name: "Groceries",
  allocated: usd("600.00"),
  rollover: "surplus_only",
};

describe("budget period", () => {
  it("computes available as carried in plus allocated plus activity", () => {
    const result = computeBudgetPeriod({
      currency: "USD",
      categories: [groceries],
      activity: [{ categoryId: "groceries", activity: usd("-450.00") }],
      carriedIn: { groceries: usd("50.00") },
    });

    const state = result.categories[0];
    expect(state?.carriedIn.toString()).toBe("50.00");
    expect(state?.available.toString()).toBe("200.00");
    expect(state?.overspent).toBe(false);
  });

  it("flags an overspent category", () => {
    const result = computeBudgetPeriod({
      currency: "USD",
      categories: [groceries],
      activity: [{ categoryId: "groceries", activity: usd("-700.00") }],
    });

    expect(result.categories[0]?.available.toString()).toBe("-100.00");
    expect(result.overspentCategories).toEqual(["groceries"]);
  });

  it("carries a surplus forward but absorbs overspending", () => {
    const surplus = computeBudgetPeriod({
      currency: "USD",
      categories: [groceries],
      activity: [{ categoryId: "groceries", activity: usd("-500.00") }],
    });
    expect(surplus.carryForward["groceries"]?.toString()).toBe("100.00");

    const overspent = computeBudgetPeriod({
      currency: "USD",
      categories: [groceries],
      activity: [{ categoryId: "groceries", activity: usd("-700.00") }],
    });
    // A bad month does not punish the next one under surplus_only.
    expect(overspent.carryForward["groceries"]?.toString()).toBe("0.00");
  });

  it("carries a deficit forward under the full policy", () => {
    const result = computeBudgetPeriod({
      currency: "USD",
      categories: [{ ...groceries, rollover: "full" }],
      activity: [{ categoryId: "groceries", activity: usd("-700.00") }],
    });
    expect(result.carryForward["groceries"]?.toString()).toBe("-100.00");
  });

  it("starts fresh when rollover is off", () => {
    const result = computeBudgetPeriod({
      currency: "USD",
      categories: [{ ...groceries, rollover: "none" }],
      activity: [],
      carriedIn: { groceries: usd("500.00") },
    });
    // The prior surplus is ignored rather than compounding.
    expect(result.categories[0]?.carriedIn.isZero()).toBe(true);
    expect(result.categories[0]?.available.toString()).toBe("600.00");
    expect(result.carryForward["groceries"]?.isZero()).toBe(true);
  });

  it("reports income not yet assigned", () => {
    const result = computeBudgetPeriod({
      currency: "USD",
      categories: [groceries],
      activity: [],
      income: usd("3000.00"),
    });
    expect(result.readyToAssign.toString()).toBe("2400.00");
  });

  it("reports a negative ready-to-assign when over-budgeted", () => {
    const result = computeBudgetPeriod({
      currency: "USD",
      categories: [groceries, { ...groceries, categoryId: "rent", name: "Rent", allocated: usd("2600.00") }],
      activity: [],
      income: usd("3000.00"),
    });
    // Budgeting money that has not arrived.
    expect(result.readyToAssign.toString()).toBe("-200.00");
  });

  it("sums several activity entries for one category", () => {
    const result = computeBudgetPeriod({
      currency: "USD",
      categories: [groceries],
      activity: [
        { categoryId: "groceries", activity: usd("-120.00") },
        { categoryId: "groceries", activity: usd("-80.00") },
        { categoryId: "groceries", activity: usd("15.00") },
      ],
    });
    expect(result.categories[0]?.activity.toString()).toBe("-185.00");
    expect(result.categories[0]?.available.toString()).toBe("415.00");
  });

  it("tracks a sinking-fund target without changing what is owned", () => {
    const result = computeBudgetPeriod({
      currency: "USD",
      categories: [
        {
          categoryId: "tyres",
          name: "New tyres",
          allocated: usd("200.00"),
          rollover: "surplus_only",
          target: usd("800.00"),
        },
      ],
      activity: [],
      carriedIn: { tyres: usd("600.00") },
    });

    const state = result.categories[0];
    expect(state?.available.toString()).toBe("800.00");
    expect(state?.targetMet).toBe(true);
    // Earmarking is a budget fact, not a ledger one: no entry was created.
    expect(result.totalActivity.isZero()).toBe(true);
  });
});

describe("distribute", () => {
  it("assigns the whole amount, with nothing stranded", () => {
    const parts = distribute(usd("1000.00"), [
      { categoryId: "a", weight: 1 },
      { categoryId: "b", weight: 1 },
      { categoryId: "c", weight: 1 },
    ]);

    expect(parts.map((p) => p.amount.toString())).toEqual(["333.34", "333.33", "333.33"]);
    expect(Money.sum(parts.map((p) => p.amount)).toString()).toBe("1000.00");
  });

  it("respects weights", () => {
    const parts = distribute(usd("1000.00"), [
      { categoryId: "rent", weight: 70 },
      { categoryId: "food", weight: 30 },
    ]);
    expect(parts[0]?.amount.toString()).toBe("700.00");
    expect(parts[1]?.amount.toString()).toBe("300.00");
  });
});

describe("fundingPerPeriod", () => {
  it("rounds up so the last period is never short", () => {
    // 1,000 over 3 periods is 333.333...; 333.33 x 3 leaves a cent missing.
    const perPeriod = fundingPerPeriod(usd("1000.00"), Money.zero("USD"), 3);
    expect(perPeriod.toString()).toBe("333.34");
    expect(perPeriod.multiplyInt(3n).greaterThanOrEqual(usd("1000.00"))).toBe(true);
  });

  it("accounts for what is already saved", () => {
    expect(fundingPerPeriod(usd("800.00"), usd("600.00"), 4).toString()).toBe("50.00");
  });

  it("is zero once the target is reached", () => {
    expect(fundingPerPeriod(usd("800.00"), usd("900.00"), 4).isZero()).toBe(true);
  });

  it("rejects a non-positive horizon", () => {
    expect(() => fundingPerPeriod(usd("100.00"), Money.zero("USD"), 0)).toThrow(RangeError);
  });
});

describe("fundingPerPeriod lands on payable amounts", () => {
  it("produces whole cents, never sub-cent contributions", () => {
    for (const [target, periods] of [["1000.00", 3], ["100.00", 7], ["55.55", 13]] as const) {
      const perPeriod = fundingPerPeriod(usd(target), Money.zero("USD"), periods);
      // 100 internal units == one cent at MONEY_SCALE 4.
      expect(perPeriod.scaled % 100n).toBe(0n);
      // And the periods together always cover the target.
      expect(
        perPeriod.multiplyInt(BigInt(periods)).greaterThanOrEqual(usd(target)),
      ).toBe(true);
    }
  });
});
