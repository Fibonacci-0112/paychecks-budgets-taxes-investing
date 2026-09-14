import {
  divideRound,
  getCurrency,
  Money,
  MONEY_SCALE,
  pow10,
} from "@finance/money";

/**
 * Budgeting as a dimension over ledger balances, not as ledger entries.
 *
 * Earmarking cash does not change what you own. Moving $200 into a "new tyres"
 * bucket leaves assets and net worth exactly where they were — the money is
 * still in the checking account. Modelling sinking funds as equity sub-accounts
 * (the earlier design) would either misstate net worth or require contra
 * entries that mean nothing to an accountant.
 *
 * So a budget allocates *against* balances the ledger already records. The
 * ledger stays the single source of truth for what exists; the budget says
 * what it is spoken for.
 */

export type RolloverPolicy =
  /** Each period starts fresh; anything left over returns to be re-assigned. */
  | "none"
  /** Surplus carries forward, overspending does not. The usual envelope rule. */
  | "surplus_only"
  /** Both carry, so an overspent category starts the next period in the hole. */
  | "full";

export interface CategoryBudget {
  readonly categoryId: string;
  readonly name: string;
  readonly allocated: Money;
  readonly rollover: RolloverPolicy;
  /**
   * A savings target, for sinking funds. Purely informational: the money is
   * still an ordinary asset balance, and reaching the target changes nothing
   * about what is owned.
   */
  readonly target?: Money;
}

export interface CategoryActivity {
  readonly categoryId: string;
  /** Net movement this period. Spending is negative, refunds positive. */
  readonly activity: Money;
}

export interface CategoryState {
  readonly categoryId: string;
  readonly name: string;
  readonly carriedIn: Money;
  readonly allocated: Money;
  readonly activity: Money;
  readonly available: Money;
  readonly overspent: boolean;
  /** What carries into the next period under this category's policy. */
  readonly carriesOut: Money;
  readonly target?: Money;
  readonly targetMet?: boolean;
}

export interface BudgetPeriodInput {
  readonly currency: string;
  readonly categories: readonly CategoryBudget[];
  readonly activity: readonly CategoryActivity[];
  /** Available balances carried from the previous period, by category. */
  readonly carriedIn?: Readonly<Record<string, Money>>;
  /** Income received this period, which is what there is to assign. */
  readonly income?: Money;
}

export interface BudgetPeriodResult {
  readonly categories: readonly CategoryState[];
  readonly totalAllocated: Money;
  readonly totalActivity: Money;
  readonly totalAvailable: Money;
  /**
   * Income not yet assigned to a category. Negative means more has been
   * allocated than came in — budgeting money that does not exist.
   */
  readonly readyToAssign: Money;
  readonly overspentCategories: readonly string[];
  /** Carry-in map for the next period. */
  readonly carryForward: Readonly<Record<string, Money>>;
}

export function computeBudgetPeriod(input: BudgetPeriodInput): BudgetPeriodResult {
  const zero = Money.zero(input.currency);

  const activityByCategory = new Map<string, Money>();
  for (const entry of input.activity) {
    const existing = activityByCategory.get(entry.categoryId) ?? zero;
    activityByCategory.set(entry.categoryId, existing.add(entry.activity));
  }

  const carriedInMap = input.carriedIn ?? {};
  const states: CategoryState[] = [];
  const carryForward: Record<string, Money> = {};

  for (const category of input.categories) {
    const carriedIn =
      category.rollover === "none"
        ? zero
        : (carriedInMap[category.categoryId] ?? zero);

    const activity = activityByCategory.get(category.categoryId) ?? zero;
    const available = carriedIn.add(category.allocated).add(activity);
    const overspent = available.isNegative();

    // What survives into next period depends on the policy. "surplus_only" is
    // the usual envelope rule: a good month carries forward, a bad one is
    // absorbed rather than punishing the next month too.
    let carriesOut: Money;
    switch (category.rollover) {
      case "none":
        carriesOut = zero;
        break;
      case "surplus_only":
        carriesOut = overspent ? zero : available;
        break;
      case "full":
        carriesOut = available;
        break;
    }

    carryForward[category.categoryId] = carriesOut;

    states.push({
      categoryId: category.categoryId,
      name: category.name,
      carriedIn,
      allocated: category.allocated,
      activity,
      available,
      overspent,
      carriesOut,
      ...(category.target !== undefined
        ? {
            target: category.target,
            targetMet: available.greaterThanOrEqual(category.target),
          }
        : {}),
    });
  }

  const totalAllocated = Money.sum(
    input.categories.map((c) => c.allocated),
    input.currency,
  );
  const totalActivity = Money.sum(
    states.map((s) => s.activity),
    input.currency,
  );
  const totalAvailable = Money.sum(
    states.map((s) => s.available),
    input.currency,
  );

  return {
    categories: states,
    totalAllocated,
    totalActivity,
    totalAvailable,
    readyToAssign: (input.income ?? zero).subtract(totalAllocated),
    overspentCategories: states.filter((s) => s.overspent).map((s) => s.categoryId),
    carryForward,
  };
}

/**
 * Split an amount across categories by weight, landing on whole cents.
 *
 * Uses `Money.allocate`, so the parts sum to exactly the amount distributed —
 * budgeting $1,000 across three categories assigns all $1,000, not $999.99.
 */
export function distribute(
  amount: Money,
  weights: readonly { readonly categoryId: string; readonly weight: number }[],
): { readonly categoryId: string; readonly amount: Money }[] {
  if (weights.length === 0) return [];
  const parts = amount.allocate(weights.map((w) => w.weight));
  return weights.map((w, index) => ({
    categoryId: w.categoryId,
    amount: parts[index] ?? Money.zero(amount.currencyCode),
  }));
}

/**
 * Per-period contribution needed to reach a sinking-fund target on time.
 *
 * Rounds up **to a whole minor unit**, not to internal precision. Rounding up
 * at scale 4 gives $333.3334 for $1,000 over three periods — which displays as
 * $333.33, is not a payable amount, and leaves the fund a cent short at the
 * end. Saving "about enough" for a known bill is exactly the failure this is
 * meant to prevent, so the rounding happens at the granularity money is
 * actually moved in.
 */
export function fundingPerPeriod(
  target: Money,
  alreadySaved: Money,
  periodsRemaining: number,
): Money {
  if (periodsRemaining <= 0) {
    throw new RangeError("periodsRemaining must be positive");
  }

  const currency = target.currencyCode;
  const zero = Money.zero(currency);
  const shortfall = Money.max(zero, target.subtract(alreadySaved));

  // One minor unit expressed in internal units: 100 for USD at MONEY_SCALE 4.
  const minorUnit = pow10(MONEY_SCALE - getCurrency(currency).decimals);
  const periods = BigInt(Math.trunc(periodsRemaining));

  const perPeriodInMinorUnits = divideRound(shortfall.scaled, periods * minorUnit, "CEIL");
  return Money.fromScaled(perPeriodInMinorUnits * minorUnit, currency);
}
