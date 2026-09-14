import type { FederalTaxYear } from "../../types.js";

/**
 * Federal tax figures for 2026.
 *
 * Transcribed from IRS Rev. Proc. 2025-32 (2026 inflation adjustments, issued
 * under the One Big Beautiful Bill Act, P.L. 119-21) and the Social Security
 * Administration's contribution and benefit base.
 *
 * Every `base` below is the cumulative tax printed in the source table, not a
 * recomputed value. `test/federal.test.ts` asserts that each one equals the sum
 * of the brackets beneath it, so a transcription slip fails the build instead
 * of quietly changing someone's tax.
 *
 * Updating this for a new year is a data edit. Do not assume that is the whole
 * job: rates, thresholds and *methods* all change. The 2026 Publication 15-T,
 * for example, added withholding treatment for the new qualified tips and
 * qualified overtime deductions and a new Form W-4 checkbox — changes no
 * amount of bracket editing would cover.
 */
export const FEDERAL_2026: FederalTaxYear = {
  year: 2026,
  source:
    "IRS Rev. Proc. 2025-32 §4.01 (rate tables), §4.14 (standard deduction); " +
    "SSA contribution and benefit base (ssa.gov/oact/cola/cbb.html)",

  // Rev. Proc. 2025-32 §4.01, Tables 1-4.
  brackets: {
    // TABLE 3 — § 1(j)(2)(C), Unmarried Individuals
    single: [
      { threshold: "0", base: "0", rate: "0.10" },
      { threshold: "12400", base: "1240", rate: "0.12" },
      { threshold: "50400", base: "5800", rate: "0.22" },
      { threshold: "105700", base: "17966", rate: "0.24" },
      { threshold: "201775", base: "41024", rate: "0.32" },
      { threshold: "256225", base: "58448", rate: "0.35" },
      { threshold: "640600", base: "192979.25", rate: "0.37" },
    ],

    // TABLE 1 — § 1(j)(2)(A), Married Filing Jointly and Surviving Spouses
    married_filing_jointly: [
      { threshold: "0", base: "0", rate: "0.10" },
      { threshold: "24800", base: "2480", rate: "0.12" },
      { threshold: "100800", base: "11600", rate: "0.22" },
      { threshold: "211400", base: "35932", rate: "0.24" },
      { threshold: "403550", base: "82048", rate: "0.32" },
      { threshold: "512450", base: "116896", rate: "0.35" },
      { threshold: "768700", base: "206583.50", rate: "0.37" },
    ],

    // TABLE 4 — § 1(j)(2)(D), Married Filing Separately
    married_filing_separately: [
      { threshold: "0", base: "0", rate: "0.10" },
      { threshold: "12400", base: "1240", rate: "0.12" },
      { threshold: "50400", base: "5800", rate: "0.22" },
      { threshold: "105700", base: "17966", rate: "0.24" },
      { threshold: "201775", base: "41024", rate: "0.32" },
      { threshold: "256225", base: "58448", rate: "0.35" },
      { threshold: "384350", base: "103291.75", rate: "0.37" },
    ],

    // TABLE 2 — § 1(j)(2)(B), Heads of Households
    head_of_household: [
      { threshold: "0", base: "0", rate: "0.10" },
      { threshold: "17700", base: "1770", rate: "0.12" },
      { threshold: "67450", base: "7740", rate: "0.22" },
      { threshold: "105700", base: "16155", rate: "0.24" },
      { threshold: "201750", base: "39207", rate: "0.32" },
      { threshold: "256200", base: "56631", rate: "0.35" },
      { threshold: "640600", base: "191171", rate: "0.37" },
    ],

    // § 1(j)(2)(A) covers surviving spouses on the joint schedule.
    qualifying_surviving_spouse: [
      { threshold: "0", base: "0", rate: "0.10" },
      { threshold: "24800", base: "2480", rate: "0.12" },
      { threshold: "100800", base: "11600", rate: "0.22" },
      { threshold: "211400", base: "35932", rate: "0.24" },
      { threshold: "403550", base: "82048", rate: "0.32" },
      { threshold: "512450", base: "116896", rate: "0.35" },
      { threshold: "768700", base: "206583.50", rate: "0.37" },
    ],
  },

  // Rev. Proc. 2025-32 §4.14(1).
  standardDeduction: {
    single: "16100",
    married_filing_jointly: "32200",
    married_filing_separately: "16100",
    head_of_household: "24150",
    qualifying_surviving_spouse: "32200",
  },

  // Rev. Proc. 2025-32 §4.14(3).
  additionalStandardDeduction: {
    perCondition: "1650",
    perConditionUnmarried: "2050",
  },

  fica: {
    socialSecurityRate: "0.062",
    // SSA contribution and benefit base for 2026.
    socialSecurityWageBase: "184500",
    medicareRate: "0.0145",
    // IRC § 3101(b)(2). Thresholds are statutory and not inflation adjusted.
    additionalMedicareRate: "0.009",
    additionalMedicareThreshold: {
      single: "200000",
      married_filing_jointly: "250000",
      married_filing_separately: "125000",
      head_of_household: "200000",
      qualifying_surviving_spouse: "200000",
    },
  },
};
