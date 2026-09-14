import { Money, Rate } from "@finance/money";
import {
  federalIncomeTax,
  fica,
  PERIODS_PER_YEAR,
  type FederalFilingStatus,
  type PayFrequency,
} from "@finance/tax";
import type { Deduction } from "./deductions.js";

export interface WageBases {
  readonly gross: Money;
  readonly federalTaxable: Money;
  readonly ficaWages: Money;
  readonly stateTaxable: Money;
}

/**
 * Apply deductions to produce the three wage bases.
 *
 * They diverge, and the divergence is the whole point of doing this
 * separately: a traditional 401(k) deferral leaves FICA wages untouched while
 * reducing income tax wages.
 */
export function wageBases(gross: Money, deductions: readonly Deduction[]): WageBases {
  const zero = Money.zero(gross.currencyCode);

  let federal = gross;
  let ficaBase = gross;
  let state = gross;

  for (const deduction of deductions) {
    if (deduction.reducesFederalTaxable) federal = federal.subtract(deduction.amount);
    if (deduction.reducesFicaWages) ficaBase = ficaBase.subtract(deduction.amount);
    if (deduction.reducesStateTaxable) state = state.subtract(deduction.amount);
  }

  return {
    gross,
    federalTaxable: Money.max(zero, federal),
    ficaWages: Money.max(zero, ficaBase),
    stateTaxable: Money.max(zero, state),
  };
}

export interface PeriodTaxEstimate {
  readonly annualisedWages: Money;
  readonly annualTax: Money;
  readonly periodTax: Money;
  readonly marginalRate: Rate;
}

/**
 * Estimate federal income tax for one pay period.
 *
 * **This is an estimate, not employer withholding.** It annualises the period's
 * taxable wages, applies the § 1(j) rate schedule, and divides back down. That
 * is the same shape as Publication 15-T's percentage method, but 15-T applies
 * specific Form W-4 adjustments — Step 2 multiple-jobs treatment, Step 3
 * credits, Step 4 other income and deductions, and for 2026 the new qualified
 * tips and overtime deductions — which are not modelled here.
 *
 * So this answers "what will I actually owe on this rate of pay", which is the
 * question worth asking. It will not reproduce the figure on a payslip to the
 * cent, and it is not represented as doing so.
 */
export function estimatePeriodFederalTax(input: {
  readonly year: number;
  readonly status: FederalFilingStatus;
  readonly frequency: PayFrequency;
  readonly periodTaxableWages: Money;
}): PeriodTaxEstimate {
  const periods = BigInt(PERIODS_PER_YEAR[input.frequency]);
  const annualised = input.periodTaxableWages.multiplyInt(periods);

  const annual = federalIncomeTax({
    year: input.year,
    status: input.status,
    grossIncome: annualised,
  });

  // Allocate rather than divide, so the periods sum back to the annual figure
  // exactly instead of leaving a few cents unaccounted for across the year.
  const perPeriod = annual.tax.allocate(
    new Array<number>(Number(periods)).fill(1),
  );

  return {
    annualisedWages: annualised,
    annualTax: annual.tax,
    periodTax: perPeriod[0] ?? Money.zero(input.periodTaxableWages.currencyCode),
    marginalRate: annual.marginalRate,
  };
}

export interface PaycheckInput {
  readonly year: number;
  readonly frequency: PayFrequency;
  readonly gross: Money;
  readonly federalStatus: FederalFilingStatus;
  readonly deductions?: readonly Deduction[];
  /** Wages paid earlier this year, for the wage base and Medicare threshold. */
  readonly yearToDateFicaWages?: Money;
  /** Extra federal withholding requested on Form W-4, Step 4(c). */
  readonly additionalFederalWithholding?: Money;
}

export interface PaycheckResult {
  readonly gross: Money;
  readonly wageBases: WageBases;
  readonly preTaxDeductions: Money;
  readonly afterTaxDeductions: Money;
  readonly federalIncomeTax: Money;
  readonly socialSecurity: Money;
  readonly medicare: Money;
  readonly additionalMedicare: Money;
  readonly totalTaxes: Money;
  readonly net: Money;
  readonly marginalRate: Rate;
  readonly effectiveTaxRate: Rate;
}

/**
 * Compute a single paycheck.
 *
 * Federal income tax is the estimate described above. FICA is exact: rates,
 * the wage base and the Additional Medicare thresholds are all verified
 * against primary sources, and the year-to-date figure is respected so a cheque
 * straddling the wage base is handled correctly.
 *
 * State income tax is **not** included. Oklahoma's rate schedule has not been
 * verified against the Commission's own tables yet, and a plausible wrong
 * number is worse than an absent one. `@finance/tax` refuses to compute it.
 */
export function paycheck(input: PaycheckInput): PaycheckResult {
  const currency = input.gross.currencyCode;
  const zero = Money.zero(currency);
  const deductions = input.deductions ?? [];

  const bases = wageBases(input.gross, deductions);

  const preTax = Money.sum(
    deductions
      .filter((d) => d.reducesFederalTaxable || d.reducesFicaWages || d.reducesStateTaxable)
      .map((d) => d.amount),
    currency,
  );
  const postTax = Money.sum(
    deductions
      .filter((d) => !d.reducesFederalTaxable && !d.reducesFicaWages && !d.reducesStateTaxable)
      .map((d) => d.amount),
    currency,
  );

  const estimate = estimatePeriodFederalTax({
    year: input.year,
    status: input.federalStatus,
    frequency: input.frequency,
    periodTaxableWages: bases.federalTaxable,
  });

  const federal = estimate.periodTax.add(input.additionalFederalWithholding ?? zero);

  const ficaResult = fica({
    year: input.year,
    status: input.federalStatus,
    wages: bases.ficaWages,
    ...(input.yearToDateFicaWages ? { yearToDateWages: input.yearToDateFicaWages } : {}),
  });

  const totalTaxes = federal.add(ficaResult.total);
  const net = input.gross.subtract(preTax).subtract(totalTaxes).subtract(postTax);

  return {
    gross: input.gross,
    wageBases: bases,
    preTaxDeductions: preTax,
    afterTaxDeductions: postTax,
    federalIncomeTax: federal,
    socialSecurity: ficaResult.socialSecurity,
    medicare: ficaResult.medicare,
    additionalMedicare: ficaResult.additionalMedicare,
    totalTaxes,
    net,
    marginalRate: estimate.marginalRate,
    effectiveTaxRate: input.gross.isPositive()
      ? totalTaxes.ratioTo(input.gross)
      : Rate.ZERO,
  };
}

/**
 * Gross needed to reach a target net — the "I need $4,000 in hand" question.
 *
 * Solved by bisection rather than algebraically: the relationship is piecewise
 * linear with kinks at every bracket boundary and at the Social Security wage
 * base, so there is no closed form that stays correct as the tables change.
 * Bisection is immune to that, and converges to the cent in well under a
 * hundred iterations.
 */
export function grossForTargetNet(
  target: Money,
  input: Omit<PaycheckInput, "gross">,
  options: { readonly maxIterations?: number } = {},
): Money {
  const currency = target.currencyCode;
  let low = Money.zero(currency);
  // Start well above any plausible answer; taxes never exceed 100% of gross.
  let high = target.multiplyInt(4n).add(Money.parse("10000", currency));

  const maxIterations = options.maxIterations ?? 200;
  const oneCent = Money.fromMinor(1n, currency);

  for (let i = 0; i < maxIterations; i += 1) {
    const spread = high.subtract(low);
    if (spread.lessThanOrEqual(oneCent)) break;

    const midpoint = low.add(spread.divideInt(2n));
    const net = paycheck({ ...input, gross: midpoint }).net;

    if (net.lessThan(target)) {
      low = midpoint;
    } else {
      high = midpoint;
    }
  }

  return high;
}
