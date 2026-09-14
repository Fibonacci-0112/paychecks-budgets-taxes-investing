/**
 * Filing status, pay frequency, and the shapes tax data files must satisfy.
 *
 * The central point of this file: **federal and state filing status are
 * different types, and one is never derived from the other.** States do not
 * share the federal set. Oklahoma's withholding tables, for instance, are
 * published for Single and Married only — there is no Head of Household table
 * at all, so a Head of Household filer federally is Single for Oklahoma
 * withholding. Deriving one status from the other would silently produce wrong
 * withholding for exactly the filers who most need it right.
 */

/** Federal filing statuses, per IRC § 1(j)(2). */
export type FederalFilingStatus =
  | "single"
  | "married_filing_jointly"
  | "married_filing_separately"
  | "head_of_household"
  | "qualifying_surviving_spouse";

/**
 * Statuses a state may offer. A given state supports only a subset, declared in
 * its data file and enforced at load time.
 */
export type StateFilingStatus =
  | "single"
  | "married_filing_jointly"
  | "married_filing_separately"
  | "head_of_household";

export type PayFrequency =
  | "weekly"
  | "biweekly"
  | "semimonthly"
  | "monthly"
  | "quarterly"
  | "semiannual"
  | "annual"
  | "daily";

/** Pay periods per year, used to annualise and de-annualise wages. */
export const PERIODS_PER_YEAR: Readonly<Record<PayFrequency, number>> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
  quarterly: 4,
  semiannual: 2,
  annual: 1,
  // Publication 15-T and Oklahoma's Packet OW-2 both treat a "daily or
  // miscellaneous" period as 260 working days.
  daily: 260,
};

/**
 * One row of a progressive rate schedule.
 *
 * Amounts are decimal strings rather than numbers so no value in a tax table
 * ever passes through a float. `base` is the cumulative tax at `threshold`,
 * exactly as the published tables state it — carrying it rather than
 * recomputing means the data can be checked line by line against the source
 * document, and a transcription error shows up as an inconsistency rather than
 * as a quietly wrong answer.
 */
export interface BracketRow {
  /** Taxable income at which this bracket starts. */
  readonly threshold: string;
  /** Cumulative tax on all income below `threshold`. */
  readonly base: string;
  /** Marginal rate applied to income above `threshold`, as a decimal. */
  readonly rate: string;
}

export interface FederalTaxYear {
  readonly year: number;
  /** Where every figure in this file came from, for annual re-verification. */
  readonly source: string;
  readonly brackets: Readonly<Record<FederalFilingStatus, readonly BracketRow[]>>;
  readonly standardDeduction: Readonly<Record<FederalFilingStatus, string>>;
  readonly additionalStandardDeduction: {
    /** Per qualifying condition (65 or older, blind). */
    readonly perCondition: string;
    /** Larger amount when unmarried and not a surviving spouse. */
    readonly perConditionUnmarried: string;
  };
  readonly fica: {
    readonly socialSecurityRate: string;
    readonly socialSecurityWageBase: string;
    readonly medicareRate: string;
    readonly additionalMedicareRate: string;
    /** Statutory, not inflation adjusted. */
    readonly additionalMedicareThreshold: Readonly<
      Record<FederalFilingStatus, string>
    >;
  };
}

export interface StateTaxYear {
  readonly year: number;
  /** Two-letter postal code. */
  readonly state: string;
  readonly source: string;
  /**
   * The statuses this state actually recognises. A status absent here cannot be
   * used, which is what stops a federal Head of Household filer being silently
   * treated as one in a state that has no such category.
   */
  readonly supportedStatuses: readonly StateFilingStatus[];
  readonly brackets: Partial<
    Readonly<Record<StateFilingStatus, readonly BracketRow[]>>
  >;
  readonly standardDeduction: Partial<Readonly<Record<StateFilingStatus, string>>>;
  /** Per-allowance personal exemption, where the state uses allowances. */
  readonly personalExemption?: string;
  readonly withholding?: {
    /** How the state rounds computed withholding. */
    readonly rounding: "nearest_dollar" | "nearest_cent";
    /**
     * Value of one withholding allowance per pay period. Published explicitly
     * by some states rather than derived, so it is carried as data.
     */
    readonly allowancePerPeriod: Partial<Readonly<Record<PayFrequency, string>>>;
  };
}
