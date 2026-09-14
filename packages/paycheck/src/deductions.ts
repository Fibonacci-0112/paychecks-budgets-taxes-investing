import type { Money } from "@finance/money";

/**
 * A payroll deduction and, critically, **which wage bases it reduces**.
 *
 * These are not the same base, and treating them as one is the classic payroll
 * bug. A traditional 401(k) deferral reduces federal and state taxable wages
 * but **not** Social Security and Medicare wages — you still pay FICA on money
 * you defer. A Section 125 cafeteria-plan deduction (health premiums, FSA, an
 * HSA funded through the plan) reduces all three.
 *
 * Getting this wrong overstates net pay by roughly 7.65% of every 401(k)
 * dollar, which looks plausible on a single cheque and is thousands of dollars
 * wrong across a year.
 */
export interface Deduction {
  readonly name: string;
  readonly amount: Money;
  readonly reducesFederalTaxable: boolean;
  readonly reducesFicaWages: boolean;
  readonly reducesStateTaxable: boolean;
}

/**
 * Traditional 401(k)/403(b) elective deferral.
 *
 * Reduces income tax wages, not FICA wages. IRC § 3121(v)(1)(A) keeps elective
 * deferrals in the Social Security and Medicare wage base.
 */
export function traditional401k(amount: Money, name = "401(k)"): Deduction {
  return {
    name,
    amount,
    reducesFederalTaxable: true,
    reducesFicaWages: false,
    reducesStateTaxable: true,
  };
}

/** Roth deferral — after tax, so it reduces no wage base at all. */
export function roth401k(amount: Money, name = "Roth 401(k)"): Deduction {
  return {
    name,
    amount,
    reducesFederalTaxable: false,
    reducesFicaWages: false,
    reducesStateTaxable: false,
  };
}

/**
 * Section 125 cafeteria plan: health, dental and vision premiums, FSA
 * contributions, and HSA contributions made through the plan.
 *
 * Reduces every wage base, which is what makes payroll-deducted HSA
 * contributions strictly better than writing a cheque to the same account.
 */
export function section125(amount: Money, name: string): Deduction {
  return {
    name,
    amount,
    reducesFederalTaxable: true,
    reducesFicaWages: true,
    reducesStateTaxable: true,
  };
}

/**
 * HSA funded directly rather than through a cafeteria plan.
 *
 * Deductible for income tax but **not** exempt from FICA, unlike the same
 * contribution routed through payroll.
 */
export function hsaDirect(amount: Money, name = "HSA"): Deduction {
  return {
    name,
    amount,
    reducesFederalTaxable: true,
    reducesFicaWages: false,
    reducesStateTaxable: true,
  };
}

/** A plain after-tax deduction: union dues, garnishments, parking. */
export function afterTax(amount: Money, name: string): Deduction {
  return {
    name,
    amount,
    reducesFederalTaxable: false,
    reducesFicaWages: false,
    reducesStateTaxable: false,
  };
}
