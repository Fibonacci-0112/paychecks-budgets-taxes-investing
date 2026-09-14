import { Money, Rate } from "@finance/money";
import {
  effectiveRate,
  marginalRate,
  parseBrackets,
  taxFromBrackets,
  TAX_ROUNDING,
  TaxDataError,
} from "./brackets.js";
import { FEDERAL_2026 } from "./data/2026/federal.js";
import type { FederalFilingStatus, FederalTaxYear } from "./types.js";

const YEARS: Readonly<Record<number, FederalTaxYear>> = {
  2026: FEDERAL_2026,
};

/** Tax years this package can compute. Deliberately a closed set. */
export function supportedFederalYears(): number[] {
  return Object.keys(YEARS)
    .map(Number)
    .sort((a, b) => a - b);
}

export function federalTaxYear(year: number): FederalTaxYear {
  const data = YEARS[year];
  if (!data) {
    throw new TaxDataError(
      `No federal tax data for ${year}. Supported years: ` +
        `${supportedFederalYears().join(", ")}. Rates, thresholds and methods ` +
        `all change annually, so an unsupported year is refused rather than ` +
        `approximated from a neighbouring one.`,
    );
  }
  return data;
}

export interface StandardDeductionOptions {
  /** Taxpayer is 65 or older. */
  readonly aged?: boolean;
  readonly blind?: boolean;
  /** Spouse is 65 or older (joint returns). */
  readonly spouseAged?: boolean;
  readonly spouseBlind?: boolean;
}

/** Standard deduction, including the additional amounts for age and blindness. */
export function standardDeduction(
  year: number,
  status: FederalFilingStatus,
  options: StandardDeductionOptions = {},
): Money {
  const data = federalTaxYear(year);
  const base = Money.parse(data.standardDeduction[status], "USD");

  // IRC § 63(f): the larger per-condition amount applies to a taxpayer who is
  // unmarried and not a surviving spouse.
  const unmarried =
    status === "single" || status === "head_of_household";
  const perCondition = Money.parse(
    unmarried
      ? data.additionalStandardDeduction.perConditionUnmarried
      : data.additionalStandardDeduction.perCondition,
    "USD",
  );

  const joint =
    status === "married_filing_jointly" ||
    status === "qualifying_surviving_spouse";

  let conditions = 0;
  if (options.aged) conditions += 1;
  if (options.blind) conditions += 1;
  if (joint) {
    if (options.spouseAged) conditions += 1;
    if (options.spouseBlind) conditions += 1;
  }

  return base.add(perCondition.multiplyInt(BigInt(conditions)));
}

export interface FederalIncomeTaxResult {
  readonly grossIncome: Money;
  readonly deduction: Money;
  readonly taxableIncome: Money;
  readonly tax: Money;
  readonly marginalRate: Rate;
  readonly effectiveRate: Rate;
}

export interface FederalIncomeTaxInput {
  readonly year: number;
  readonly status: FederalFilingStatus;
  readonly grossIncome: Money;
  /** Itemised total. When absent, the standard deduction is used. */
  readonly itemisedDeductions?: Money;
  readonly standardDeductionOptions?: StandardDeductionOptions;
}

/**
 * Federal income tax on ordinary income.
 *
 * Scope is deliberately narrow and stated rather than implied: ordinary income
 * against the § 1(j) rate schedules, reduced by the standard or itemised
 * deduction. It does **not** model credits, the alternative minimum tax,
 * preferential rates on capital gains and qualified dividends, the net
 * investment income tax, the qualified business income deduction, or the new
 * tips and overtime deductions. Each of those is real and each changes the
 * answer; none is silently approximated here.
 */
export function federalIncomeTax(
  input: FederalIncomeTaxInput,
): FederalIncomeTaxResult {
  const data = federalTaxYear(input.year);
  const brackets = parseBrackets(data.brackets[input.status]);

  const deduction =
    input.itemisedDeductions ??
    standardDeduction(input.year, input.status, input.standardDeductionOptions);

  const zero = Money.zero(input.grossIncome.currencyCode);
  const taxableIncome = Money.max(zero, input.grossIncome.subtract(deduction));
  const tax = taxFromBrackets(taxableIncome, brackets);

  return {
    grossIncome: input.grossIncome,
    deduction,
    taxableIncome,
    tax,
    marginalRate: marginalRate(taxableIncome, brackets),
    effectiveRate: effectiveRate(tax, input.grossIncome),
  };
}

export interface FicaResult {
  readonly socialSecurity: Money;
  readonly medicare: Money;
  readonly additionalMedicare: Money;
  readonly total: Money;
  /** Wages that were above the Social Security wage base. */
  readonly wagesAboveWageBase: Money;
}

export interface FicaInput {
  readonly year: number;
  readonly status: FederalFilingStatus;
  /** Medicare wages for the period being computed. */
  readonly wages: Money;
  /**
   * Wages already paid this year before this period. Social Security stops at
   * the wage base and Additional Medicare starts at a threshold, so both depend
   * on the year to date rather than on this cheque alone.
   */
  readonly yearToDateWages?: Money;
}

/**
 * Employee-side FICA.
 *
 * Employer-side is deliberately excluded: it is not withheld from the employee
 * and including it would misstate net pay.
 */
export function fica(input: FicaInput): FicaResult {
  const data = federalTaxYear(input.year);
  const currency = input.wages.currencyCode;
  const zero = Money.zero(currency);

  const priorWages = input.yearToDateWages ?? zero;
  const wageBase = Money.parse(data.fica.socialSecurityWageBase, currency);

  // Social Security applies only to wages up to the base, counting the year to
  // date — so a cheque that straddles the base is taxed on part of itself.
  const remainingBase = Money.max(zero, wageBase.subtract(priorWages));
  const socialSecurityWages = Money.min(input.wages, remainingBase);
  const socialSecurity = socialSecurityWages.multiply(
    Rate.parse(data.fica.socialSecurityRate),
    TAX_ROUNDING,
  );

  // Medicare has no wage cap.
  const medicare = input.wages.multiply(
    Rate.parse(data.fica.medicareRate),
    TAX_ROUNDING,
  );

  // Additional Medicare applies to wages above a statutory threshold. Employers
  // withhold it on wages over $200,000 regardless of filing status; the
  // status-specific threshold is what the return reconciles against.
  const threshold = Money.parse(
    data.fica.additionalMedicareThreshold[input.status],
    currency,
  );
  const totalWages = priorWages.add(input.wages);
  const excessTotal = Money.max(zero, totalWages.subtract(threshold));
  const excessPrior = Money.max(zero, priorWages.subtract(threshold));
  const excessThisPeriod = excessTotal.subtract(excessPrior);
  const additionalMedicare = excessThisPeriod.multiply(
    Rate.parse(data.fica.additionalMedicareRate),
    TAX_ROUNDING,
  );

  return {
    socialSecurity,
    medicare,
    additionalMedicare,
    total: socialSecurity.add(medicare).add(additionalMedicare),
    wagesAboveWageBase: input.wages.subtract(socialSecurityWages),
  };
}
