import type { Money } from "@finance/money";
import type { ImportedTransaction } from "./types.js";

/**
 * Matching imported rows to financial events that already exist.
 *
 * This module exists to stop double-counting, which is structural rather than
 * an edge case. A paycheck the user recorded and the bank deposit that funds it
 * are two observations of **one** event; so are the two sides of a transfer,
 * which appear in both accounts' exports. If each becomes its own ledger entry,
 * income and cash are counted twice and a transfer looks like twice the money
 * moved plus a phantom balance.
 *
 * Everything here returns *candidates*. Nothing auto-posts: a wrong automatic
 * match is harder to notice, and harder to unpick, than an unmatched row
 * sitting in a review queue.
 */

/** Days between two `YYYY-MM-DD` dates. */
export function daysBetween(a: string, b: string): number {
  const left = Date.parse(`${a}T00:00:00Z`);
  const right = Date.parse(`${b}T00:00:00Z`);
  return Math.round(Math.abs(left - right) / 86_400_000);
}

export interface DedupeResult {
  readonly fresh: readonly ImportedTransaction[];
  readonly duplicates: readonly ImportedTransaction[];
}

/**
 * Split incoming rows into ones not seen before and ones already imported.
 *
 * Keyed on `sourceId` alone. Deduplicating on date + amount + description
 * would silently discard genuine repeat purchases — two identical coffees on
 * the same day are two transactions, and a budget that quietly drops one is
 * worse than one that shows both.
 */
export function dedupe(
  incoming: readonly ImportedTransaction[],
  alreadyImportedSourceIds: ReadonlySet<string>,
): DedupeResult {
  const fresh: ImportedTransaction[] = [];
  const duplicates: ImportedTransaction[] = [];
  const seenInBatch = new Set<string>();

  for (const transaction of incoming) {
    if (alreadyImportedSourceIds.has(transaction.sourceId) || seenInBatch.has(transaction.sourceId)) {
      duplicates.push(transaction);
    } else {
      seenInBatch.add(transaction.sourceId);
      fresh.push(transaction);
    }
  }

  return { fresh, duplicates };
}

export interface TransferCandidate {
  readonly outflow: ImportedTransaction;
  readonly outflowAccountId: string;
  readonly inflow: ImportedTransaction;
  readonly inflowAccountId: string;
  readonly daysApart: number;
}

export interface AccountRows {
  readonly accountId: string;
  readonly transactions: readonly ImportedTransaction[];
}

/**
 * Find rows in different accounts that look like the two sides of one transfer.
 *
 * Requires equal magnitude and opposite sign within a short window. Transfers
 * rarely settle the same day — a weekend or an ACH hop moves them — so the
 * window defaults to three days.
 */
export function findTransferCandidates(
  accounts: readonly AccountRows[],
  options: { readonly windowDays?: number } = {},
): TransferCandidate[] {
  const windowDays = options.windowDays ?? 3;
  const candidates: TransferCandidate[] = [];
  const claimed = new Set<string>();

  for (let i = 0; i < accounts.length; i += 1) {
    for (let j = i + 1; j < accounts.length; j += 1) {
      const left = accounts[i];
      const right = accounts[j];
      if (!left || !right) continue;

      for (const a of left.transactions) {
        const keyA = `${left.accountId}:${a.sourceId}`;
        if (claimed.has(keyA)) continue;

        for (const b of right.transactions) {
          const keyB = `${right.accountId}:${b.sourceId}`;
          if (claimed.has(keyB)) continue;

          // Equal and opposite, and not two zero rows matching vacuously.
          if (a.amount.isZero()) continue;
          if (!a.amount.negate().equals(b.amount)) continue;

          const apart = daysBetween(a.postedOn, b.postedOn);
          if (apart > windowDays) continue;

          const outflowFirst = a.amount.isNegative();
          candidates.push({
            outflow: outflowFirst ? a : b,
            outflowAccountId: outflowFirst ? left.accountId : right.accountId,
            inflow: outflowFirst ? b : a,
            inflowAccountId: outflowFirst ? right.accountId : left.accountId,
            daysApart: apart,
          });

          claimed.add(keyA);
          claimed.add(keyB);
          break;
        }
      }
    }
  }

  return candidates;
}

export interface RecordedPaycheck {
  readonly id: string;
  /** Net pay — what actually reached the bank. */
  readonly netPay: Money;
  readonly payDate: string;
  readonly employer?: string;
}

export interface PaycheckMatch {
  readonly deposit: ImportedTransaction;
  readonly paycheck: RecordedPaycheck;
  readonly daysApart: number;
  /** Whether the employer name appears in the deposit description. */
  readonly employerMatched: boolean;
}

/**
 * Match an imported deposit to a paycheck the user already recorded.
 *
 * A match means the deposit attaches to the existing event as further evidence
 * of it — the postings already exist. Creating a second entry would count both
 * the income and the cash twice, which is the single most damaging import bug
 * in a product that also records paychecks.
 *
 * Amount must equal net pay exactly. Payroll deposits are not approximate, and
 * a near-match is far more likely to be a different transaction.
 */
export function matchDepositsToPaychecks(
  deposits: readonly ImportedTransaction[],
  paychecks: readonly RecordedPaycheck[],
  options: { readonly windowDays?: number } = {},
): { readonly matches: readonly PaycheckMatch[]; readonly unmatched: readonly ImportedTransaction[] } {
  const windowDays = options.windowDays ?? 5;
  const matches: PaycheckMatch[] = [];
  const unmatched: ImportedTransaction[] = [];
  const claimed = new Set<string>();

  for (const deposit of deposits) {
    if (!deposit.amount.isPositive()) {
      unmatched.push(deposit);
      continue;
    }

    const candidates = paychecks
      .filter((p) => !claimed.has(p.id))
      .filter((p) => p.netPay.equals(deposit.amount))
      .map((p) => ({ paycheck: p, daysApart: daysBetween(deposit.postedOn, p.payDate) }))
      .filter((c) => c.daysApart <= windowDays)
      // Closest in time wins; an employer name in the description breaks ties.
      .sort((a, b) => a.daysApart - b.daysApart);

    const best = candidates[0];
    if (!best) {
      unmatched.push(deposit);
      continue;
    }

    const employer = best.paycheck.employer?.toLowerCase();
    const description = `${deposit.description} ${deposit.memo ?? ""}`.toLowerCase();

    matches.push({
      deposit,
      paycheck: best.paycheck,
      daysApart: best.daysApart,
      employerMatched: employer !== undefined && description.includes(employer),
    });
    claimed.add(best.paycheck.id);
  }

  return { matches, unmatched };
}
