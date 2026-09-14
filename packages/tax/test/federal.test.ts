import { Money, Rate } from "@finance/money";
import { describe, expect, it } from "vitest";
import {
  federalIncomeTax,
  fica,
  standardDeduction,
  supportedFederalYears,
  federalTaxYear,
} from "../src/federal.js";
import { parseBrackets, taxFromBrackets, TaxDataError } from "../src/brackets.js";
import { FEDERAL_2026 } from "../src/data/2026/federal.js";
import type { FederalFilingStatus } from "../src/types.js";

const usd = (value: string) => Money.parse(value, "USD");

const STATUSES: FederalFilingStatus[] = [
  "single",
  "married_filing_jointly",
  "married_filing_separately",
  "head_of_household",
  "qualifying_surviving_spouse",
];

describe("2026 federal tables are transcribed correctly", () => {
  // The strongest check available without a second source: every cumulative
  // figure printed in Rev. Proc. 2025-32 must equal the tax accrued in the
  // brackets beneath it. A mistyped digit breaks that identity.
  it.each(STATUSES)("%s brackets are internally consistent", (status) => {
    expect(() => parseBrackets(FEDERAL_2026.brackets[status])).not.toThrow();
  });

  it("rejects a table with a mistyped cumulative figure", () => {
    const corrupted = [
      { threshold: "0", base: "0", rate: "0.10" },
      // $1,770 is correct for a $17,700 threshold at 10%; $1,780 is not.
      { threshold: "17700", base: "1780", rate: "0.12" },
    ];
    expect(() => parseBrackets(corrupted)).toThrow(TaxDataError);
  });

  it("rejects thresholds that do not ascend", () => {
    expect(() =>
      parseBrackets([
        { threshold: "0", base: "0", rate: "0.10" },
        { threshold: "10000", base: "1000", rate: "0.12" },
        { threshold: "5000", base: "1600", rate: "0.22" },
      ]),
    ).toThrow(TaxDataError);
  });

  it("matches the published Head of Household bracket boundaries exactly", () => {
    const brackets = parseBrackets(FEDERAL_2026.brackets.head_of_household);

    // Rev. Proc. 2025-32 Table 2: tax at each bracket floor is the printed base.
    expect(taxFromBrackets(usd("17700"), brackets).toString()).toBe("1770.00");
    expect(taxFromBrackets(usd("67450"), brackets).toString()).toBe("7740.00");
    expect(taxFromBrackets(usd("105700"), brackets).toString()).toBe("16155.00");
    expect(taxFromBrackets(usd("201750"), brackets).toString()).toBe("39207.00");
    expect(taxFromBrackets(usd("256200"), brackets).toString()).toBe("56631.00");
    expect(taxFromBrackets(usd("640600"), brackets).toString()).toBe("191171.00");
  });

  it("publishes the 2026 standard deductions from Rev. Proc. 2025-32 §4.14", () => {
    expect(standardDeduction(2026, "head_of_household").toString()).toBe("24150.00");
    expect(standardDeduction(2026, "single").toString()).toBe("16100.00");
    expect(standardDeduction(2026, "married_filing_jointly").toString()).toBe("32200.00");
    expect(standardDeduction(2026, "married_filing_separately").toString()).toBe("16100.00");
  });

  it("adds the larger aged/blind amount for an unmarried filer", () => {
    // § 63(f): $2,050 when unmarried and not a surviving spouse, else $1,650.
    expect(standardDeduction(2026, "head_of_household", { aged: true }).toString()).toBe(
      "26200.00",
    );
    expect(
      standardDeduction(2026, "married_filing_jointly", { aged: true }).toString(),
    ).toBe("33850.00");
    expect(
      standardDeduction(2026, "head_of_household", { aged: true, blind: true }).toString(),
    ).toBe("28250.00");
  });

  it("refuses a year it has no data for, rather than approximating", () => {
    expect(() => federalTaxYear(2027)).toThrow(TaxDataError);
    expect(supportedFederalYears()).toEqual([2026]);
  });
});

describe("federal income tax", () => {
  it("computes tax for a Head of Household filer taking the standard deduction", () => {
    const result = federalIncomeTax({
      year: 2026,
      status: "head_of_household",
      grossIncome: usd("95000.00"),
    });

    // 95,000 - 24,150 standard deduction = 70,850 taxable.
    expect(result.deduction.toString()).toBe("24150.00");
    expect(result.taxableIncome.toString()).toBe("70850.00");

    // 70,850 falls in the 22% band: 7,740 + 22% of (70,850 - 67,450).
    // 7,740 + 0.22 x 3,400 = 7,740 + 748 = 8,488.
    expect(result.tax.toString()).toBe("8488.00");
    expect(result.marginalRate.equals(Rate.parse("0.22"))).toBe(true);
  });

  it("reports effective rate well below marginal rate", () => {
    const result = federalIncomeTax({
      year: 2026,
      status: "head_of_household",
      grossIncome: usd("95000.00"),
    });
    // 8,488 / 95,000 is roughly 8.9%, against a 22% marginal rate.
    expect(result.effectiveRate.lessThan(result.marginalRate)).toBe(true);
    expect(result.effectiveRate.toPercentString(2)).toBe("8.93%");
  });

  it("never produces negative taxable income", () => {
    const result = federalIncomeTax({
      year: 2026,
      status: "head_of_household",
      grossIncome: usd("10000.00"),
    });
    expect(result.taxableIncome.isZero()).toBe(true);
    expect(result.tax.isZero()).toBe(true);
  });

  it("uses itemised deductions when they are supplied", () => {
    const result = federalIncomeTax({
      year: 2026,
      status: "head_of_household",
      grossIncome: usd("95000.00"),
      itemisedDeductions: usd("30000.00"),
    });
    expect(result.deduction.toString()).toBe("30000.00");
    expect(result.taxableIncome.toString()).toBe("65000.00");
  });

  it("is monotonic: earning more never lowers the tax owed", () => {
    let previous = Money.zero("USD");
    for (let income = 0; income <= 300000; income += 2500) {
      const { tax } = federalIncomeTax({
        year: 2026,
        status: "head_of_household",
        grossIncome: usd(`${income}.00`),
      });
      expect(tax.greaterThanOrEqual(previous)).toBe(true);
      previous = tax;
    }
  });
});

describe("FICA", () => {
  it("applies Social Security up to the 2026 wage base and Medicare without limit", () => {
    const result = fica({
      year: 2026,
      status: "head_of_household",
      wages: usd("95000.00"),
    });

    // 6.2% and 1.45% of 95,000.
    expect(result.socialSecurity.toString()).toBe("5890.00");
    expect(result.medicare.toString()).toBe("1377.50");
    expect(result.additionalMedicare.isZero()).toBe(true);
    expect(result.total.toString()).toBe("7267.50");
  });

  it("stops Social Security at the wage base", () => {
    const result = fica({
      year: 2026,
      status: "head_of_household",
      wages: usd("250000.00"),
    });
    // 6.2% of the 184,500 base, not of 250,000.
    expect(result.socialSecurity.toString()).toBe("11439.00");
    expect(result.wagesAboveWageBase.toString()).toBe("65500.00");
  });

  it("splits a cheque that straddles the wage base using year-to-date wages", () => {
    // 180,000 already paid; this cheque takes the total past 184,500, so only
    // 4,500 of it is still subject to Social Security.
    const result = fica({
      year: 2026,
      status: "head_of_household",
      wages: usd("10000.00"),
      yearToDateWages: usd("180000.00"),
    });
    expect(result.socialSecurity.toString()).toBe("279.00"); // 6.2% of 4,500
    expect(result.medicare.toString()).toBe("145.00"); // 1.45% of 10,000
  });

  it("charges Additional Medicare only on wages above the threshold", () => {
    // Head of Household threshold is $200,000 (statutory, not adjusted).
    const result = fica({
      year: 2026,
      status: "head_of_household",
      wages: usd("10000.00"),
      yearToDateWages: usd("195000.00"),
    });
    // Only 5,000 of this cheque is above 200,000: 0.9% = 45.00
    expect(result.additionalMedicare.toString()).toBe("45.00");
  });

  it("uses the joint threshold for a joint filer", () => {
    const single = fica({
      year: 2026,
      status: "single",
      wages: usd("10000.00"),
      yearToDateWages: usd("210000.00"),
    });
    const joint = fica({
      year: 2026,
      status: "married_filing_jointly",
      wages: usd("10000.00"),
      yearToDateWages: usd("210000.00"),
    });

    expect(single.additionalMedicare.toString()).toBe("90.00"); // all above 200k
    expect(joint.additionalMedicare.isZero()).toBe(true); // still below 250k
  });

  it("sums the year exactly when computed cheque by cheque", () => {
    // Twenty-six biweekly cheques must total the same as one annual figure,
    // with no drift from per-cheque rounding.
    const perCheque = usd("5000.00");
    let ytd = Money.zero("USD");
    let socialSecurity = Money.zero("USD");

    for (let i = 0; i < 26; i += 1) {
      const result = fica({
        year: 2026,
        status: "head_of_household",
        wages: perCheque,
        yearToDateWages: ytd,
      });
      socialSecurity = socialSecurity.add(result.socialSecurity);
      ytd = ytd.add(perCheque);
    }

    // 130,000 total wages, all below the base: 6.2% = 8,060.00
    expect(ytd.toString()).toBe("130000.00");
    expect(socialSecurity.toString()).toBe("8060.00");
  });
});
