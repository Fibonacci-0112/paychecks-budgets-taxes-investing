import { Money } from "@finance/money";
import { describe, expect, it } from "vitest";
import { parseOfx, parseOfxDate } from "../src/ofx.js";
import {
  detectMapping,
  parseAmountCell,
  parseCsv,
  parseCsvDate,
  parseCsvRow,
} from "../src/csv.js";
import {
  dedupe,
  findTransferCandidates,
  matchDepositsToPaychecks,
} from "../src/matching.js";
import { ImportError } from "../src/types.js";

const usd = (value: string) => Money.parse(value, "USD");

// OFX 1.x, the SGML dialect most banks still export: tags are left unclosed.
const OFX_SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>USD
<BANKACCTFROM><ACCTID>000123456789</ACCTID></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260301120000[-6:CST]
<TRNAMT>-85.50
<FITID>2026030100001
<NAME>FARMERS MARKET
<MEMO>weekly shop
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260315
<TRNAMT>+3000.00
<FITID>2026031500002
<NAME>ACME PAYROLL DIRECT DEP
</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

// OFX 2.x: well-formed XML, same structure.
const OFX_XML = `<?xml version="1.0"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>USD</CURDEF>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT</TRNTYPE>
<DTPOSTED>20260402</DTPOSTED>
<TRNAMT>-12.34</TRNAMT>
<FITID>xml-1</FITID>
<NAME>Coffee &amp; Co</NAME>
</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe("OFX / QFX", () => {
  it("parses the SGML dialect with unclosed tags", () => {
    const result = parseOfx(OFX_SGML);

    expect(result.transactions).toHaveLength(2);
    expect(result.accountId).toBe("000123456789");
    expect(result.currency).toBe("USD");

    const [debit, credit] = result.transactions;
    expect(debit?.amount.toString()).toBe("-85.50");
    expect(debit?.postedOn).toBe("2026-03-01");
    expect(debit?.description).toBe("FARMERS MARKET");
    expect(debit?.memo).toBe("weekly shop");
    expect(debit?.sourceId).toBe("2026030100001");
    expect(debit?.sourceIdDerived).toBe(false);

    // A leading + is legal in OFX and must not break parsing.
    expect(credit?.amount.toString()).toBe("3000.00");
  });

  it("parses the XML dialect and decodes entities", () => {
    const result = parseOfx(OFX_XML);
    expect(result.transactions[0]?.description).toBe("Coffee & Co");
    expect(result.transactions[0]?.amount.toString()).toBe("-12.34");
  });

  it("keeps the bank's posting date without timezone shifting", () => {
    // 20260301120000[-6:CST] is 1 March at the bank. Applying the offset could
    // move it to February and across a month boundary.
    expect(parseOfxDate("20260301120000[-6:CST]")).toBe("2026-03-01");
    expect(parseOfxDate("20260315")).toBe("2026-03-15");
  });

  it("rejects a file with no statement records", () => {
    expect(() => parseOfx("<OFX></OFX>")).toThrow(ImportError);
  });

  it("collects unparseable records instead of dropping them", () => {
    const broken = OFX_SGML.replace("<TRNAMT>-85.50", "<TRNAMT>not-a-number");
    const result = parseOfx(broken);
    expect(result.transactions).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toMatch(/parse|amount/i);
  });

  it("derives a stable id when the bank omits FITID", () => {
    const noFitId = OFX_SGML.replace(/<FITID>[^\n]*\n/g, "");
    const first = parseOfx(noFitId);
    const second = parseOfx(noFitId);

    expect(first.transactions[0]?.sourceIdDerived).toBe(true);
    // Re-importing the same file yields the same ids, so it stays idempotent.
    expect(first.transactions[0]?.sourceId).toBe(second.transactions[0]?.sourceId);
  });
});

describe("CSV", () => {
  it("splits quoted fields containing commas", () => {
    expect(parseCsvRow('2026-03-01,"MARKET, FARMERS",-85.50')).toEqual([
      "2026-03-01",
      "MARKET, FARMERS",
      "-85.50",
    ]);
    expect(parseCsvRow('a,"say ""hi""",b')).toEqual(["a", 'say "hi"', "b"]);
  });

  it("reads a single signed amount column", () => {
    const csv = [
      "Date,Description,Amount",
      "03/01/2026,FARMERS MARKET,-85.50",
      "03/15/2026,ACME PAYROLL,3000.00",
    ].join("\n");

    const result = parseCsv(csv, { date: "Date", description: "Description", amount: "Amount" });
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]?.amount.toString()).toBe("-85.50");
    expect(result.transactions[0]?.postedOn).toBe("2026-03-01");
  });

  it("reads separate debit and credit columns, signing debits negative", () => {
    const csv = [
      "Date,Description,Debit,Credit",
      "03/01/2026,FARMERS MARKET,85.50,",
      "03/15/2026,ACME PAYROLL,,3000.00",
    ].join("\n");

    const result = parseCsv(csv, {
      date: "Date",
      description: "Description",
      debit: "Debit",
      credit: "Credit",
    });

    // The bank prints the debit unsigned; it must still become an outflow.
    expect(result.transactions[0]?.amount.toString()).toBe("-85.50");
    expect(result.transactions[1]?.amount.toString()).toBe("3000.00");
  });

  it("reads parenthesised negatives, the accounting convention", () => {
    // (45.00) is -45.00. Reading it as positive flips every debit in the file.
    expect(parseAmountCell("(45.00)", "USD").toString()).toBe("-45.00");
    expect(parseAmountCell("$1,234.56", "USD").toString()).toBe("1234.56");
    expect(parseAmountCell("-$99.99", "USD").toString()).toBe("-99.99");
  });

  it("respects the declared date order", () => {
    expect(parseCsvDate("03/04/2026", "MDY")).toBe("2026-03-04");
    expect(parseCsvDate("03/04/2026", "DMY")).toBe("2026-04-03");
    expect(parseCsvDate("2026-03-04")).toBe("2026-03-04");
  });

  it("proposes a mapping from common header names", () => {
    const mapping = detectMapping(["Posted Date", "Payee", "Amount", "Notes"]);
    expect(mapping.date).toBe("Posted Date");
    expect(mapping.description).toBe("Payee");
    expect(mapping.amount).toBe("Amount");
    expect(mapping.memo).toBe("Notes");
  });

  it("refuses a mapping with no amount information", () => {
    expect(() =>
      parseCsv("Date,Description\n03/01/2026,x", {
        date: "Date",
        description: "Description",
      }),
    ).toThrow(ImportError);
  });

  it("retains the original row for later re-extraction", () => {
    const csv = "Date,Description,Amount,Category\n03/01/2026,MARKET,-85.50,Groceries";
    const result = parseCsv(csv, {
      date: "Date",
      description: "Description",
      amount: "Amount",
    });
    expect(result.transactions[0]?.raw["Category"]).toBe("Groceries");
  });
});

describe("deduplication", () => {
  it("keys on source id, not on date and amount", () => {
    const csv = [
      "Date,Description,Amount,Id",
      // Two identical coffees on one day: two transactions, not a duplicate.
      "03/01/2026,COFFEE,-4.75,a1",
      "03/01/2026,COFFEE,-4.75,a2",
    ].join("\n");

    const result = parseCsv(csv, {
      date: "Date",
      description: "Description",
      amount: "Amount",
      sourceId: "Id",
    });

    const { fresh, duplicates } = dedupe(result.transactions, new Set());
    expect(fresh).toHaveLength(2);
    expect(duplicates).toHaveLength(0);
  });

  it("treats a re-imported row as already seen", () => {
    const result = parseOfx(OFX_SGML);
    const { fresh, duplicates } = dedupe(
      result.transactions,
      new Set(["2026030100001"]),
    );
    expect(fresh).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
  });

  it("catches a row repeated within one file", () => {
    const result = parseOfx(OFX_SGML);
    const doubled = [...result.transactions, ...result.transactions];
    const { fresh, duplicates } = dedupe(doubled, new Set());
    expect(fresh).toHaveLength(2);
    expect(duplicates).toHaveLength(2);
  });
});

describe("transfer matching", () => {
  it("pairs the two sides of one transfer across accounts", () => {
    const checking = parseCsv(
      "Date,Description,Amount,Id\n03/20/2026,Transfer to savings,-500.00,c1",
      { date: "Date", description: "Description", amount: "Amount", sourceId: "Id" },
    );
    const savings = parseCsv(
      "Date,Description,Amount,Id\n03/21/2026,Transfer from checking,500.00,s1",
      { date: "Date", description: "Description", amount: "Amount", sourceId: "Id" },
    );

    const candidates = findTransferCandidates([
      { accountId: "checking", transactions: checking.transactions },
      { accountId: "savings", transactions: savings.transactions },
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.outflowAccountId).toBe("checking");
    expect(candidates[0]?.inflowAccountId).toBe("savings");
    expect(candidates[0]?.daysApart).toBe(1);
  });

  it("does not pair rows outside the settlement window", () => {
    const a = parseCsv("Date,Description,Amount,Id\n03/01/2026,Out,-500.00,a1", {
      date: "Date", description: "Description", amount: "Amount", sourceId: "Id",
    });
    const b = parseCsv("Date,Description,Amount,Id\n03/20/2026,In,500.00,b1", {
      date: "Date", description: "Description", amount: "Amount", sourceId: "Id",
    });

    expect(
      findTransferCandidates([
        { accountId: "a", transactions: a.transactions },
        { accountId: "b", transactions: b.transactions },
      ]),
    ).toHaveLength(0);
  });
});

describe("paycheck / deposit matching", () => {
  it("matches a deposit to a recorded paycheck so it is not counted twice", () => {
    const { transactions } = parseOfx(OFX_SGML);
    const deposits = transactions.filter((t) => t.amount.isPositive());

    const { matches, unmatched } = matchDepositsToPaychecks(deposits, [
      {
        id: "paycheck-1",
        netPay: usd("3000.00"),
        payDate: "2026-03-15",
        employer: "ACME",
      },
    ]);

    expect(matches).toHaveLength(1);
    expect(unmatched).toHaveLength(0);
    expect(matches[0]?.paycheck.id).toBe("paycheck-1");
    expect(matches[0]?.daysApart).toBe(0);
    // "ACME PAYROLL DIRECT DEP" contains the employer name.
    expect(matches[0]?.employerMatched).toBe(true);
  });

  it("requires the amount to equal net pay exactly", () => {
    const { transactions } = parseOfx(OFX_SGML);
    const deposits = transactions.filter((t) => t.amount.isPositive());

    // A cent out is a different transaction, not an approximate match.
    const { matches, unmatched } = matchDepositsToPaychecks(deposits, [
      { id: "p", netPay: usd("3000.01"), payDate: "2026-03-15" },
    ]);

    expect(matches).toHaveLength(0);
    expect(unmatched).toHaveLength(1);
  });

  it("claims each recorded paycheck at most once", () => {
    const csv = [
      "Date,Description,Amount,Id",
      "03/15/2026,ACME PAYROLL,3000.00,d1",
      "03/16/2026,ACME PAYROLL,3000.00,d2",
    ].join("\n");
    const { transactions } = parseCsv(csv, {
      date: "Date", description: "Description", amount: "Amount", sourceId: "Id",
    });

    const { matches, unmatched } = matchDepositsToPaychecks(transactions, [
      { id: "p1", netPay: usd("3000.00"), payDate: "2026-03-15" },
    ]);

    // One paycheck, two candidate deposits: only one can match.
    expect(matches).toHaveLength(1);
    expect(unmatched).toHaveLength(1);
  });
});
