import type { Money } from "@finance/money";

/**
 * A transaction as read from a bank file, before it becomes a ledger entry.
 *
 * This is an *observation*, not a financial event. Several observations can
 * describe one event — a recorded paycheck and its imported bank deposit, or a
 * transfer that appears in both accounts' exports. Postings belong to the
 * event; matching an observation to an existing event must never create new
 * postings, or income and cash get counted twice.
 */
export interface ImportedTransaction {
  /**
   * The source's own stable identifier — an OFX `FITID`, or a content hash for
   * formats that have none.
   *
   * Deduplication keys on this and nothing else. Keying on date + amount +
   * description would collapse legitimate repeated purchases: two identical
   * coffees on the same day are two transactions, not one duplicate.
   */
  readonly sourceId: string;
  /** True when `sourceId` was derived rather than supplied by the source. */
  readonly sourceIdDerived: boolean;
  /** Date the transaction posted, as `YYYY-MM-DD` in the file's own reckoning. */
  readonly postedOn: string;
  readonly amount: Money;
  readonly description: string;
  readonly memo?: string;
  /** The source's transaction type, where it gives one (OFX `TRNTYPE`). */
  readonly type?: string;
  readonly checkNumber?: string;
  /** The original record, retained so extraction can be re-run later. */
  readonly raw: Readonly<Record<string, string>>;
}

export interface ImportResult {
  readonly transactions: readonly ImportedTransaction[];
  /** Rows that could not be parsed, with the reason, rather than dropped. */
  readonly rejected: readonly { readonly row: string; readonly reason: string }[];
  readonly format: "csv" | "ofx";
  /** Account identifier declared in the file, when it declares one. */
  readonly accountId?: string;
  readonly currency?: string;
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}
