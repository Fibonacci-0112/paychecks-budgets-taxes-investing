# @finance/tax

Federal and state tax computation. Pure functions over `@finance/money`, with
every published figure carried as data.

## Verification status

This is the part to read first. **Nothing here computes from a number that has
not been read out of a primary source.**

| Data | Status | Source |
|---|---|---|
| Federal 2026 rate tables (all five statuses) | ✅ Verified | Rev. Proc. 2025-32 §4.01 |
| Federal 2026 standard deductions | ✅ Verified | Rev. Proc. 2025-32 §4.14 |
| FICA rates, wage base, thresholds | ✅ Verified | SSA contribution and benefit base; IRC § 3101(b)(2) |
| Oklahoma withholding allowances and rounding | ✅ Verified | OTC Packet OW-2 (rev. 11-2025) |
| Oklahoma rate schedule (HB 2764) | ❌ **Not verified** | Needs Packet OW-2 pp. 8–9 |
| Oklahoma standard deduction | ❌ **Not verified** | Needs Form 511 instructions |
| Federal withholding (Pub. 15-T percentage method) | ⬜ Not implemented | Needs Pub. 15-T §1 tables |

Unverified data is stored empty, and `assertBracketsVerified` throws rather than
falling back. A tax table transcribed from secondary reporting is worse than no
table: it produces a plausible number nobody thinks to question.

## Filing status is not one thing

**Federal and state filing status are separate types, and neither is derived
from the other.**

States do not share the federal set. Oklahoma publishes withholding tables
"calculated for single and married taxpayers" — there is **no Head of Household
table at all**. So a federal Head of Household filer is Single for Oklahoma
withholding. That is not a preference; it is what the state publishes.

```ts
assertStatusSupported(stateTaxYear("OK", 2026), "head_of_household");
// TaxDataError: OK does not recognise the filing status "head_of_household"
```

Mapping "the closest status" automatically would produce confidently wrong
withholding for precisely the filers who most need it right.

## Transcription safety

A tax table is typed in by hand from a PDF once a year, and a mistyped digit
gives an answer that looks entirely reasonable.

Every schedule carries the cumulative tax (`base`) exactly as printed, and
`parseBrackets` asserts that each one equals the tax accrued in the brackets
beneath it. The 2026 Head of Household table, for instance, must satisfy
`$1,770 + 49,750 × 12% = $7,740` and so on up to `$191,171`. A slipped digit
breaks the identity and fails the build.

## Rounding

Tax uses **HALF_UP**, not the HALF_EVEN that `@finance/money` defaults to for
financial reporting. Every call passes it explicitly. Oklahoma rounds
withholding to the **nearest whole dollar** — a third rule, carried as data.

## Scope

`federalIncomeTax` covers ordinary income against the § 1(j) schedules, less the
standard or itemised deduction. It does **not** model credits, AMT, preferential
rates on capital gains and qualified dividends, NIIT, the QBI deduction, or the
new qualified tips and overtime deductions. Each is real and each changes the
answer; none is silently approximated.

## Annual updates are not just numbers

Updating a year is a data edit, but do not assume that is the whole job. The
2026 Publication 15-T added withholding treatment for the new qualified tips and
qualified overtime deductions and a new Form W-4 checkbox — changes no amount of
bracket editing would have covered.
