import { Money } from "@finance/money";
import { TaxDataError } from "./brackets.js";
import { OK_2026 } from "./data/2026/ok.js";
import type { PayFrequency, StateFilingStatus, StateTaxYear } from "./types.js";

const STATES: Readonly<Record<string, Readonly<Record<number, StateTaxYear>>>> = {
  OK: { 2026: OK_2026 },
};

export function supportedStates(): string[] {
  return Object.keys(STATES).sort();
}

export function stateTaxYear(state: string, year: number): StateTaxYear {
  const byYear = STATES[state.toUpperCase()];
  if (!byYear) {
    throw new TaxDataError(
      `No tax data for ${state}. Supported states: ${supportedStates().join(", ")}.`,
    );
  }
  const data = byYear[year];
  if (!data) {
    throw new TaxDataError(`No ${state} tax data for ${year}.`);
  }
  return data;
}

/**
 * Confirm a state recognises a filing status before computing anything with it.
 *
 * State filing statuses are not the federal ones. Oklahoma publishes
 * withholding tables for single and married persons only — there is no Head of
 * Household table — so a federal Head of Household filer is Single for Oklahoma
 * withholding. Falling back to "the closest status" would produce a confident,
 * wrong number, so an unsupported status is refused and the caller has to say
 * what it means.
 */
export function assertStatusSupported(
  data: StateTaxYear,
  status: StateFilingStatus,
): void {
  if (!data.supportedStatuses.includes(status)) {
    throw new TaxDataError(
      `${data.state} does not recognise the filing status "${status}" for ${data.year}. ` +
        `Supported: ${data.supportedStatuses.join(", ")}. ` +
        `State filing statuses are not the federal ones — map the taxpayer's ` +
        `state status explicitly rather than reusing the federal one.`,
    );
  }
}

/**
 * Refuse to compute from data that has not been checked against its source.
 *
 * A rate schedule transcribed from secondary reporting is worse than no
 * schedule: it produces a plausible number nobody thinks to question. Until the
 * brackets are verified line by line against the Commission's own tables, this
 * throws and names the document to check.
 */
export function assertBracketsVerified(
  data: StateTaxYear,
  status: StateFilingStatus,
): void {
  const brackets = data.brackets[status];
  if (!brackets || brackets.length === 0) {
    throw new TaxDataError(
      `${data.state} ${data.year} rate schedule for "${status}" has not been ` +
        `verified against the primary source yet. Verify against: ${data.source}. ` +
        `Computing from unverified tax tables produces a confident wrong answer, ` +
        `so this is refused rather than approximated.`,
    );
  }
}

/**
 * Value of one withholding allowance for a pay frequency, as published.
 *
 * Carried as data rather than divided at runtime because a state publishes its
 * own rounded figures and employers are expected to use those, not a more
 * precise quotient.
 */
export function allowanceAmount(
  data: StateTaxYear,
  frequency: PayFrequency,
): Money {
  const published = data.withholding?.allowancePerPeriod[frequency];
  if (!published) {
    throw new TaxDataError(
      `${data.state} publishes no withholding allowance amount for a ` +
        `${frequency} payroll period.`,
    );
  }
  return Money.parse(published, "USD");
}
