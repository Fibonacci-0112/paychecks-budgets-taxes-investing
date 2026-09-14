import { Money } from "@finance/money";
import { derivedSourceId } from "./ofx.js";
import { ImportError, type ImportResult, type ImportedTransaction } from "./types.js";

/**
 * CSV statement parsing.
 *
 * Every bank exports a different shape, so the column mapping is explicit —
 * with detection to propose one. Guessing silently is how a "Credit" column
 * gets read as a debit and every sign in the file comes out backwards.
 */

export interface CsvMapping {
  readonly date: string;
  readonly description: string;
  /** Single signed amount column. Mutually exclusive with debit/credit. */
  readonly amount?: string;
  /** Separate columns, as many banks export. Debits are treated as negative. */
  readonly debit?: string;
  readonly credit?: string;
  readonly memo?: string;
  readonly sourceId?: string;
  readonly checkNumber?: string;
  /**
   * Date layout in the file. `MDY` is the US convention, `DMY` most of Europe.
   * ISO `YYYY-MM-DD` is detected regardless.
   */
  readonly dateOrder?: "MDY" | "DMY";
}

/** RFC 4180 splitter: handles quoted fields, embedded commas, and "" escapes. */
export function parseCsvRow(line: string, delimiter = ","): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields.map((f) => f.trim());
}

/** Split on newlines, respecting quoted fields that contain them. */
function splitRecords(text: string): string[] {
  const records: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      if (current.trim() !== "") records.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim() !== "") records.push(current);
  return records;
}

const HEADER_HINTS: Readonly<Record<keyof CsvMapping, readonly string[]>> = {
  date: ["date", "transaction date", "posted date", "posting date", "trans date"],
  description: ["description", "payee", "name", "merchant", "transaction"],
  amount: ["amount", "transaction amount"],
  debit: ["debit", "withdrawal", "withdrawals", "money out"],
  credit: ["credit", "deposit", "deposits", "money in"],
  memo: ["memo", "notes", "note"],
  sourceId: ["transaction id", "reference", "reference number", "id", "fitid"],
  checkNumber: ["check", "check number", "cheque number"],
  dateOrder: [],
};

/**
 * Propose a mapping from the header row.
 *
 * A proposal, not a decision: the caller confirms it. An unreviewed guess that
 * swaps debit and credit inverts every sign in the file, and the totals still
 * look superficially reasonable.
 */
export function detectMapping(header: readonly string[]): Partial<CsvMapping> {
  const normalised = header.map((h) => h.toLowerCase().trim());
  const mapping: Record<string, string> = {};

  for (const [field, hints] of Object.entries(HEADER_HINTS)) {
    if (hints.length === 0) continue;
    const index = normalised.findIndex((h) => hints.includes(h));
    if (index >= 0) {
      const column = header[index];
      if (column !== undefined) mapping[field] = column;
    }
  }
  return mapping as Partial<CsvMapping>;
}

/** Normalise a date cell to `YYYY-MM-DD`. */
export function parseCsvDate(value: string, order: "MDY" | "DMY" = "MDY"): string {
  const text = value.trim();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) {
    const [, year = "", month = "", day = ""] = iso;
    return `${year}-${pad(month)}-${pad(day)}`;
  }

  const parts = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(text);
  if (parts) {
    const [, a = "", b = "", yearRaw = ""] = parts;
    const month = order === "MDY" ? a : b;
    const day = order === "MDY" ? b : a;
    const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
    return `${year}-${pad(month)}-${pad(day)}`;
  }

  throw new ImportError(`Cannot read date ${JSON.stringify(value)}`);
}

function pad(value: string): string {
  return value.padStart(2, "0");
}

/**
 * Normalise an amount cell.
 *
 * Handles currency symbols, thousands separators, and the accounting
 * convention of parenthesising negatives — `(45.00)` means −45.00, and reading
 * it as positive flips the sign of every debit in the file.
 */
export function parseAmountCell(value: string, currency: string): Money {
  let text = value.trim();
  if (text === "") throw new ImportError("empty amount");

  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }

  text = text.replace(/[$£€¥]/g, "").replace(/,/g, "").replace(/\s/g, "");
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }

  if (!/^\d*\.?\d*$/.test(text) || text === "" || text === ".") {
    throw new ImportError(`Cannot read amount ${JSON.stringify(value)}`);
  }

  const amount = Money.parse(text, currency, { excessPrecision: "HALF_EVEN" });
  return negative ? amount.negate() : amount;
}

export function parseCsv(
  text: string,
  mapping: CsvMapping,
  options: { readonly currency?: string; readonly delimiter?: string } = {},
): ImportResult {
  const currency = options.currency ?? "USD";
  const delimiter = options.delimiter ?? ",";

  const records = splitRecords(text);
  const headerLine = records[0];
  if (headerLine === undefined) {
    throw new ImportError("File is empty");
  }

  const header = parseCsvRow(headerLine, delimiter);
  const columnIndex = (name: string): number => {
    const index = header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
    if (index < 0) {
      throw new ImportError(
        `Column ${JSON.stringify(name)} is not in the header: ${header.join(", ")}`,
      );
    }
    return index;
  };

  if (!mapping.amount && !mapping.debit && !mapping.credit) {
    throw new ImportError(
      "Mapping needs either an amount column, or debit and/or credit columns.",
    );
  }

  const dateAt = columnIndex(mapping.date);
  const descriptionAt = columnIndex(mapping.description);
  const amountAt = mapping.amount ? columnIndex(mapping.amount) : undefined;
  const debitAt = mapping.debit ? columnIndex(mapping.debit) : undefined;
  const creditAt = mapping.credit ? columnIndex(mapping.credit) : undefined;
  const memoAt = mapping.memo ? columnIndex(mapping.memo) : undefined;
  const sourceIdAt = mapping.sourceId ? columnIndex(mapping.sourceId) : undefined;
  const checkAt = mapping.checkNumber ? columnIndex(mapping.checkNumber) : undefined;

  const transactions: ImportedTransaction[] = [];
  const rejected: { row: string; reason: string }[] = [];

  for (const record of records.slice(1)) {
    try {
      const cells = parseCsvRow(record, delimiter);
      const cell = (index: number | undefined): string =>
        index === undefined ? "" : (cells[index] ?? "");

      const postedOn = parseCsvDate(cell(dateAt), mapping.dateOrder ?? "MDY");

      let amount: Money;
      if (amountAt !== undefined) {
        amount = parseAmountCell(cell(amountAt), currency);
      } else {
        // Separate debit and credit columns: exactly one is normally filled.
        // Debits are outflows and become negative regardless of how the bank
        // signs them, which is the only way two banks' files agree.
        const debitText = cell(debitAt);
        const creditText = cell(creditAt);
        const debit = debitText === "" ? null : parseAmountCell(debitText, currency);
        const credit = creditText === "" ? null : parseAmountCell(creditText, currency);

        if (debit && credit && !debit.isZero() && !credit.isZero()) {
          throw new ImportError("both debit and credit columns are populated");
        }
        if (debit && !debit.isZero()) {
          amount = debit.abs().negate();
        } else if (credit && !credit.isZero()) {
          amount = credit.abs();
        } else {
          throw new ImportError("no amount in either the debit or credit column");
        }
      }

      const description = cell(descriptionAt) || "(no description)";
      const memo = memoAt === undefined ? undefined : cell(memoAt) || undefined;
      const supplied = sourceIdAt === undefined ? "" : cell(sourceIdAt);
      const checkNumber = checkAt === undefined ? undefined : cell(checkAt) || undefined;

      const raw: Record<string, string> = {};
      header.forEach((name, index) => {
        const value = cells[index];
        if (value !== undefined && value !== "") raw[name] = value;
      });

      transactions.push({
        sourceId:
          supplied !== ""
            ? supplied
            : derivedSourceId(
                [postedOn, amount.toNumericString(), description, memo ?? ""].join(" "),
              ),
        sourceIdDerived: supplied === "",
        postedOn,
        amount,
        description,
        ...(memo !== undefined ? { memo } : {}),
        ...(checkNumber !== undefined ? { checkNumber } : {}),
        raw,
      });
    } catch (cause) {
      rejected.push({
        row: record.slice(0, 200),
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return { transactions, rejected, format: "csv", currency };
}
