# @finance/money

Exact monetary arithmetic. Every dollar amount in the system flows through this
package.

## Why this exists

JavaScript has no decimal type. `0.1 + 0.2` is `0.30000000000000004`, and a
balance summed from a few thousand float transactions will not match the bank.
There is no way to be careful enough about this by hand, so the type system does
it instead.

```ts
import { Money, Rate } from "@finance/money";

const gross = Money.parse("1000.00", "USD");
const fica = gross.multiply(Rate.percent("7.65")); // $76.50
const net = gross.subtract(fica); // $923.50

net.add(fica).equals(gross); // true — always, for every input
```

## The rules

**1. Never put money in a `number`.** `Money` is a class, so TypeScript rejects
`a + b` at compile time. That is the enforcement — not a convention, not a lint
rule that can be disabled.

**2. Conversions that lose precision are named so you can grep for them.**
`Money.unsafeFromNumber` and `Rate.unsafeToNumber` are legitimate at the edges —
a CSV that genuinely contains floats, a Monte Carlo simulation — and suspicious
everywhere else.

**3. Use `allocate`, never `divide`, when the parts must add up.** Dividing
`$100` three ways and rounding each gives `$99.99`. `allocate` distributes the
residue so the parts sum to exactly the original.

```ts
Money.parse("100.00", "USD").split(3);
// [$33.34, $33.33, $33.33] — sums to exactly $100.00
```

By default the parts land on whole minor units (cents), because an allocated
share is normally one that gets paid or displayed. Pass
`{ granularity: "exact" }` for accruals and intermediate splits that are not
themselves settled.

**4. Rounding mode is a domain decision.** `HALF_EVEN` is the default and is
correct for financial reporting — it avoids the upward bias `HALF_UP` introduces
across many rounded values. US tax rules generally specify `HALF_UP`; pass it
explicitly in the tax engine.

## Representation

- `Money` — `bigint` count of units at **4 decimal places**, plus a currency.
  Four exceeds every circulating currency's minor-unit scale (the maximum is 3,
  for KWD and friends), so nothing loses precision at rest, and it leaves
  headroom for per-unit prices and withholding rates.
- `Rate` — `bigint` at **12 decimal places**. Dimensionless, so it cannot be
  accidentally added to an amount.

## Storing money

**Columns are `bigint` scaled minor units, named `amount_units`. Never
`NUMERIC`.** Use `toDatabaseValue` / `fromDatabaseValue`.

This is forced by the sync layer, not by taste. PowerSync maps Postgres
`NUMERIC` to SQLite `TEXT`, and SQLite's `SUM()` over a text column silently
coerces to a float:

```
SUM('9007199254740993.0001', '0.0001')  ->  9007199254740992
```

The fraction is gone, the integer part is wrong, and no error is raised. An
exact `Money` type in TypeScript cannot help when the corruption happens inside
SQL — branded types and lint rules do not see into a query.

An `INTEGER` column sums exactly and raises `integer overflow` rather than
degrading to a float. A loud failure is the property worth having.

`fromDatabaseValue` refuses a value containing a decimal point, so a column that
drifts back to `NUMERIC` fails immediately instead of quietly. A human-readable
`NUMERIC` view exists for ad-hoc queries; it is never synced and never read by
application code.

## Currencies

The registry is deliberately small. An unknown code throws rather than assuming
two decimal places — that assumption silently corrupts JPY (zero decimals) and
KWD (three). Add what you need with `registerCurrency`.

## Tests

`pnpm test` runs both example tests and property-based tests. The properties are
the real contract: addition is associative and commutative, subtraction undoes
addition, allocation always sums back to the original, and serialisation
round-trips exactly — asserted across the full range of representable values
rather than on a handful of cases someone thought to write down.
