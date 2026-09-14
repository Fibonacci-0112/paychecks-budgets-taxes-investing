import { Money } from "@finance/money";
import { describe, expect, it } from "vitest";
import {
  estimatePeriodFederalTax,
  grossForTargetNet,
  paycheck,
  wageBases,
} from "../src/paycheck.js";
import {
  afterTax,
  hsaDirect,
  roth401k,
  section125,
  traditional401k,
} from "../src/deductions.js";

const usd = (value: string) => Money.parse(value, "USD");

describe("wage bases diverge", () => {
  it("keeps a traditional 401(k) deferral inside the FICA wage base", () => {
    // The classic payroll bug: deferring $500 cuts income tax wages but you
    // still pay Social Security and Medicare on it.
    const bases = wageBases(usd("5000.00"), [traditional401k(usd("500.00"))]);

    expect(bases.gross.toString()).toBe("5000.00");
    expect(bases.federalTaxable.toString()).toBe("4500.00");
    expect(bases.ficaWages.toString()).toBe("5000.00"); // NOT reduced
    expect(bases.stateTaxable.toString()).toBe("4500.00");
  });

  it("reduces every base for a Section 125 cafeteria plan deduction", () => {
    const bases = wageBases(usd("5000.00"), [section125(usd("300.00"), "Health premium")]);

    expect(bases.federalTaxable.toString()).toBe("4700.00");
    expect(bases.ficaWages.toString()).toBe("4700.00"); // also reduced
    expect(bases.stateTaxable.toString()).toBe("4700.00");
  });

  it("distinguishes a payroll HSA from one funded directly", () => {
    const throughPayroll = wageBases(usd("5000.00"), [section125(usd("300.00"), "HSA")]);
    const direct = wageBases(usd("5000.00"), [hsaDirect(usd("300.00"))]);

    // Same income tax treatment, different FICA treatment. This is why payroll
    // HSA contributions beat writing a cheque to the same account.
    expect(throughPayroll.federalTaxable.equals(direct.federalTaxable)).toBe(true);
    expect(throughPayroll.ficaWages.toString()).toBe("4700.00");
    expect(direct.ficaWages.toString()).toBe("5000.00");
  });

  it("leaves every base untouched for Roth and after-tax deductions", () => {
    const bases = wageBases(usd("5000.00"), [
      roth401k(usd("500.00")),
      afterTax(usd("50.00"), "Parking"),
    ]);

    expect(bases.federalTaxable.toString()).toBe("5000.00");
    expect(bases.ficaWages.toString()).toBe("5000.00");
    expect(bases.stateTaxable.toString()).toBe("5000.00");
  });
});

describe("period tax estimate", () => {
  it("annualises, applies the rate schedule, and divides back down", () => {
    const estimate = estimatePeriodFederalTax({
      year: 2026,
      status: "head_of_household",
      frequency: "biweekly",
      periodTaxableWages: usd("3653.85"),
    });

    // 3,653.85 x 26 = 95,000.10 annualised.
    expect(estimate.annualisedWages.toString()).toBe("95000.10");
    expect(estimate.marginalRate.toPercentString(0)).toBe("22%");
  });

  it("splits the annual tax across periods with nothing lost", () => {
    const wages = usd("3653.85");
    const estimate = estimatePeriodFederalTax({
      year: 2026,
      status: "head_of_household",
      frequency: "biweekly",
      periodTaxableWages: wages,
    });

    // Twenty-six periods must reconstruct the annual figure exactly. Dividing
    // instead of allocating would strand a few cents.
    const parts = estimate.annualTax.allocate(new Array<number>(26).fill(1));
    expect(Money.sum(parts).equals(estimate.annualTax)).toBe(true);
    expect(parts[0]?.equals(estimate.periodTax)).toBe(true);
  });
});

describe("paycheck", () => {
  const base = {
    year: 2026,
    frequency: "biweekly" as const,
    federalStatus: "head_of_household" as const,
  };

  it("computes a full cheque that reconciles exactly", () => {
    const result = paycheck({
      ...base,
      gross: usd("4000.00"),
      deductions: [
        traditional401k(usd("400.00")),
        section125(usd("200.00"), "Health premium"),
      ],
    });

    // Gross - pre-tax - taxes - post-tax = net, with nothing unaccounted for.
    const reconstructed = result.gross
      .subtract(result.preTaxDeductions)
      .subtract(result.totalTaxes)
      .subtract(result.afterTaxDeductions);
    expect(reconstructed.equals(result.net)).toBe(true);

    // FICA applies to 3,800 (gross less the Section 125 deduction only).
    expect(result.wageBases.ficaWages.toString()).toBe("3800.00");
    expect(result.socialSecurity.toString()).toBe("235.60"); // 6.2% of 3,800
    expect(result.medicare.toString()).toBe("55.10"); // 1.45% of 3,800

    // Federal taxable is 3,400 (less both deductions).
    expect(result.wageBases.federalTaxable.toString()).toBe("3400.00");
  });

  it("charges FICA on deferred pay, so a bigger 401(k) does not cut it", () => {
    const small = paycheck({
      ...base,
      gross: usd("4000.00"),
      deductions: [traditional401k(usd("100.00"))],
    });
    const large = paycheck({
      ...base,
      gross: usd("4000.00"),
      deductions: [traditional401k(usd("1000.00"))],
    });

    expect(small.socialSecurity.equals(large.socialSecurity)).toBe(true);
    expect(small.medicare.equals(large.medicare)).toBe(true);
    // But income tax does fall.
    expect(large.federalIncomeTax.lessThan(small.federalIncomeTax)).toBe(true);
  });

  it("stops Social Security once the year-to-date wage base is reached", () => {
    const result = paycheck({
      ...base,
      gross: usd("10000.00"),
      yearToDateFicaWages: usd("184500.00"),
    });
    expect(result.socialSecurity.isZero()).toBe(true);
    // Medicare continues without limit.
    expect(result.medicare.toString()).toBe("145.00");
  });

  it("adds requested extra withholding from Form W-4 Step 4(c)", () => {
    const without = paycheck({ ...base, gross: usd("4000.00") });
    const with_ = paycheck({
      ...base,
      gross: usd("4000.00"),
      additionalFederalWithholding: usd("150.00"),
    });

    expect(
      with_.federalIncomeTax.subtract(without.federalIncomeTax).toString(),
    ).toBe("150.00");
    expect(with_.net.lessThan(without.net)).toBe(true);
  });

  it("never lets net pay exceed gross", () => {
    for (const gross of ["100.00", "1000.00", "5000.00", "25000.00"]) {
      const result = paycheck({ ...base, gross: usd(gross) });
      expect(result.net.lessThanOrEqual(result.gross)).toBe(true);
      expect(result.totalTaxes.isNegative()).toBe(false);
    }
  });
});

describe("grossForTargetNet", () => {
  it("finds the gross that produces a requested take-home", () => {
    const target = usd("3000.00");
    const gross = grossForTargetNet(target, {
      year: 2026,
      frequency: "biweekly",
      federalStatus: "head_of_household",
    });

    const achieved = paycheck({
      year: 2026,
      frequency: "biweekly",
      federalStatus: "head_of_household",
      gross,
    }).net;

    // Converged to within a cent, never under the target.
    expect(achieved.greaterThanOrEqual(target)).toBe(true);
    expect(achieved.subtract(target).lessThanOrEqual(Money.fromMinor(2n, "USD"))).toBe(
      true,
    );
  });

  it("accounts for deductions when solving", () => {
    const target = usd("3000.00");
    const shared = {
      year: 2026,
      frequency: "biweekly" as const,
      federalStatus: "head_of_household" as const,
    };

    const plain = grossForTargetNet(target, shared);
    const withDeferral = grossForTargetNet(target, {
      ...shared,
      deductions: [traditional401k(usd("500.00"))],
    });

    // Deferring $500 means needing more gross to land on the same net.
    expect(withDeferral.greaterThan(plain)).toBe(true);
  });
});
