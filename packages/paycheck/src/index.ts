export {
  wageBases,
  estimatePeriodFederalTax,
  paycheck,
  grossForTargetNet,
  type WageBases,
  type PeriodTaxEstimate,
  type PaycheckInput,
  type PaycheckResult,
} from "./paycheck.js";

export {
  traditional401k,
  roth401k,
  section125,
  hsaDirect,
  afterTax,
  type Deduction,
} from "./deductions.js";
