import type { StateTaxYear } from "../../types.js";

/**
 * Oklahoma tax figures for 2026.
 *
 * Structural facts below are transcribed from Oklahoma Tax Commission Packet
 * OW-2, "2026 Oklahoma Income Tax Withholding Tables" (revised 11-2025,
 * effective 1 January 2026).
 *
 * Two things worth knowing before using this:
 *
 * 1. **Oklahoma has no Head of Household withholding table.** Packet OW-2
 *    publishes tables "calculated for single and married taxpayers" only. A
 *    federal Head of Household filer is therefore Single for Oklahoma
 *    withholding. `supportedStatuses` encodes that, and the loader refuses a
 *    status that is not listed rather than falling back to something plausible.
 *
 * 2. **Oklahoma rounds withholding to the nearest whole dollar** — amounts
 *    under 50 cents drop, 50 cents and above round up. That is HALF_UP at
 *    dollar granularity, not the HALF_EVEN used for reporting.
 *
 * HB 2764 restructured the brackets for 2026, cutting the top rate to 4.5% and
 * adding a zero-rate band. The bracket figures below are NOT yet verified
 * against the primary source — see the note on `brackets`.
 */
export const OK_2026: StateTaxYear = {
  year: 2026,
  state: "OK",
  source:
    "Oklahoma Tax Commission Packet OW-2, 2026 Oklahoma Income Tax Withholding " +
    "Tables (rev. 11-2025, effective 2026-01-01)",

  // Packet OW-2: tables are published for single and married persons only.
  // A "married but withhold at higher single rate" election uses the single
  // table, which is a presentation choice rather than a separate status.
  supportedStatuses: ["single", "married_filing_jointly"],

  // NOT YET VERIFIED against Packet OW-2 pages 8-9 (the percentage rate
  // tables). The shape reflects HB 2764's restructuring — a zero-rate band then
  // three rates topping out at 4.5% — but the thresholds below come from
  // secondary reporting, not the Commission's own tables.
  //
  // `assertVerified()` refuses to use this data until it is checked line by
  // line against the source, so nothing can quietly compute Oklahoma tax from
  // unconfirmed numbers.
  brackets: {},

  // Also unverified. Secondary reporting gives $6,350 for a single filer, but
  // the standard deduction lives in the Form 511 instructions rather than in
  // Packet OW-2, so it has not been read from a primary source yet. Left empty
  // so nothing computes taxable income from an unconfirmed figure.
  standardDeduction: {},

  // Packet OW-2 states the personal exemption is $1,000 per allowance.
  personalExemption: "1000",

  withholding: {
    rounding: "nearest_dollar",
    // Packet OW-2, "Table of Withholding Allowance Amounts": the $1,000
    // exemption divided across each payroll frequency. Carried as published
    // rather than divided at runtime, because the Commission's own rounding of
    // these figures is what employers are expected to use.
    allowancePerPeriod: {
      weekly: "19.23",
      biweekly: "38.46",
      semimonthly: "41.67",
      monthly: "83.33",
      quarterly: "250.00",
      semiannual: "500.00",
      annual: "1000.00",
      daily: "3.85",
    },
  },
};
