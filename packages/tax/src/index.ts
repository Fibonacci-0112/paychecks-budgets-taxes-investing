export type {
  FederalFilingStatus,
  StateFilingStatus,
  PayFrequency,
  BracketRow,
  FederalTaxYear,
  StateTaxYear,
} from "./types.js";
export { PERIODS_PER_YEAR } from "./types.js";

export {
  parseBrackets,
  taxFromBrackets,
  marginalRate,
  effectiveRate,
  TaxDataError,
  TAX_ROUNDING,
  type ParsedBracket,
} from "./brackets.js";

export {
  federalIncomeTax,
  federalTaxYear,
  standardDeduction,
  supportedFederalYears,
  fica,
  type FederalIncomeTaxInput,
  type FederalIncomeTaxResult,
  type FicaInput,
  type FicaResult,
  type StandardDeductionOptions,
} from "./federal.js";

export {
  stateTaxYear,
  supportedStates,
  assertStatusSupported,
  assertBracketsVerified,
  allowanceAmount,
} from "./state.js";

export { FEDERAL_2026 } from "./data/2026/federal.js";
export { OK_2026 } from "./data/2026/ok.js";
