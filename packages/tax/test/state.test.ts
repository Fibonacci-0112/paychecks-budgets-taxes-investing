import { describe, expect, it } from "vitest";
import {
  allowanceAmount,
  assertBracketsVerified,
  assertStatusSupported,
  stateTaxYear,
  supportedStates,
} from "../src/state.js";
import { TaxDataError } from "../src/brackets.js";

describe("Oklahoma 2026", () => {
  const ok = stateTaxYear("OK", 2026);

  it("is the only state currently supported", () => {
    expect(supportedStates()).toEqual(["OK"]);
  });

  it("recognises single and married, but NOT head of household", () => {
    // Packet OW-2 publishes tables "calculated for single and married
    // taxpayers" only. This is the whole reason state and federal filing
    // status are modelled as separate types.
    expect(() => assertStatusSupported(ok, "single")).not.toThrow();
    expect(() => assertStatusSupported(ok, "married_filing_jointly")).not.toThrow();
    expect(() => assertStatusSupported(ok, "head_of_household")).toThrow(TaxDataError);
  });

  it("explains what to do when a status is unsupported", () => {
    expect(() => assertStatusSupported(ok, "head_of_household")).toThrow(
      /State filing statuses are not the federal ones/,
    );
  });

  it("publishes withholding allowance amounts per pay frequency", () => {
    // Packet OW-2, Table of Withholding Allowance Amounts: the $1,000 personal
    // exemption spread across each payroll frequency, as the Commission rounds
    // it rather than as an exact quotient.
    expect(allowanceAmount(ok, "weekly").toString()).toBe("19.23");
    expect(allowanceAmount(ok, "biweekly").toString()).toBe("38.46");
    expect(allowanceAmount(ok, "semimonthly").toString()).toBe("41.67");
    expect(allowanceAmount(ok, "monthly").toString()).toBe("83.33");
    expect(allowanceAmount(ok, "annual").toString()).toBe("1000.00");
    expect(allowanceAmount(ok, "daily").toString()).toBe("3.85");
  });

  it("rounds withholding to the nearest whole dollar", () => {
    // Packet OW-2 states amounts under 50 cents drop and 50-99 cents round up.
    // That is HALF_UP at dollar granularity, not the HALF_EVEN used for
    // financial reporting.
    expect(ok.withholding?.rounding).toBe("nearest_dollar");
  });

  it("records the personal exemption per allowance", () => {
    expect(ok.personalExemption).toBe("1000");
  });

  it("refuses to compute from rate tables that are not yet verified", () => {
    // The HB 2764 brackets are known in shape but have not been checked line by
    // line against Packet OW-2 pages 8-9. Computing from secondary reporting
    // would produce a plausible, unverifiable number — so it throws instead.
    expect(() => assertBracketsVerified(ok, "single")).toThrow(TaxDataError);
    expect(() => assertBracketsVerified(ok, "single")).toThrow(
      /has not been verified against the primary source/,
    );
  });

  it("names the document to verify against", () => {
    expect(ok.source).toMatch(/Packet OW-2/);
    expect(() => assertBracketsVerified(ok, "single")).toThrow(/Packet OW-2/);
  });

  it("refuses unknown states and years rather than guessing", () => {
    expect(() => stateTaxYear("TX", 2026)).toThrow(TaxDataError);
    expect(() => stateTaxYear("OK", 2027)).toThrow(TaxDataError);
  });
});
