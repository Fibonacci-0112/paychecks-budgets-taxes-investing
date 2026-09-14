# Plan: Unified Personal Finance Platform

## Context

The repo (`paychecks-budgets-taxes-investing`) is empty except a README. The goal is a
one-stop personal finance application covering paychecks, budgets, investments, taxes,
net worth and a large calculator suite, running on desktop, mobile and web.

Market research (126-app feature survey, plus reviews of Monarch/YNAB/Copilot,
Boldin/ProjectionLab, Kubera/Sharesight/Snowball) confirms the premise: individual
features are well covered, but *combinations* are the gap — subscription detection
appears in only 1 of 21 budgeting apps, debt-payoff optimization is rarely paired with
cash-flow forecasting, and no consumer product credibly spans ledger + tax planning +
retirement modeling. Users today stitch together 3-4 paid subscriptions. That seam is
the product thesis.

The intended outcome: a local-first, double-entry financial system the user runs daily,
architected so it can become a multi-tenant product later without a rewrite.

---

## Decisions locked

| Area | Decision |
|---|---|
| **Audience** | Build multi-tenant + security-correct from day one; no billing/marketing until proven |
| **Data ingestion** | Manual entry + CSV/OFX/QFX import first; aggregator (Plaid/SimpleFIN) behind an interface, added later |
| **Platforms** | iOS, Android, Web, Desktop — genuine 50/50 desktop/mobile usage |
| **App stores** | Real App Store + Play Store presence |
| **Device features** | Biometric unlock, camera document capture, push notifications, full offline |
| **Stack** | TypeScript end-to-end |
| **Data model** | Double-entry ledger, hidden behind plain-language UI |
| **Backend** | Supabase (Postgres + Auth + Storage + RLS) |
| **Offline** | Full local-first — complete local SQLite on every device |
| **Tax depth** | Planning, projections, return prep organization, tax-aware calculators. **No e-file.** |
| **AI** | None now; three ports designed so it can be added later |
| **MVP** | Ledger + paycheck + budget |

### Why TypeScript and not .NET

.NET was evaluated seriously and rejected on evidence, not preference. `System.Decimal`
is a real advantage for money math, and ASP.NET Core is excellent. But the four
constraints above are jointly satisfiable in TypeScript today and not in .NET:

- **MAUI cannot target the web at all** — Microsoft's browser answer is Blazor, not MAUI.
- **PowerSync's .NET SDK is alpha** (`PowerSync.Maui 0.0.4-alpha.1`, "strictly for
  testing"; Blazor support not yet shipped). Full local-first over Supabase means
  PowerSync — Zero rejects offline writes outright, ElectricSQL hit reconnection
  problems in production evaluations. Going .NET puts the *least forgiving* part of the
  system (offline sync + conflict resolution over financial records) on an alpha SDK.
- **Blazor WASM AOT** grows the bundle ~1.5-2x to gain runtime speed.

The cost of this choice is that JS has no decimal type. That is mitigated explicitly
below and is a solved problem; alpha sync infrastructure under a ledger is not.

---

## Architecture

### Monorepo layout (pnpm workspaces + Turborepo)

```
packages/
  money/             Money + Rate value types, currency, allocation      <- write first
  schema/            Zod schemas, shared types, DB type generation
  ledger/            Double-entry engine, accounts, postings, lots
  paycheck/          Gross->net, withholding, pre/post-tax deductions
  budget/            Periods, envelopes, rollover, sinking funds
  tax/               Tax engine + versioned bracket data
  projection/        TVM, amortization, Monte Carlo, retirement
  calculators/       ~100 pure calculator functions, schema-described
  import/            CSV/OFX/QFX parsers, column mapping, dedupe
  providers/         Ports: Categorization, DocumentExtractor, Insight, Aggregator
  client-data/       PowerSync setup, typed queries, sync rules
  ui/                Design tokens, chart primitives, shared components
apps/
  mobile/            Expo — iOS + Android
  web/               Next.js
  desktop/           Tauri wrapper over the web build
supabase/
  migrations/        SQL schema + RLS policies
  functions/         Edge functions
```

All financial logic lives in `packages/*` as pure, platform-free TypeScript. Apps are
presentation only. This is what makes three UI targets affordable and keeps the engines
portable if the UI layer is ever revisited.

### The Money type — do this before anything else

JS `number` must never touch a monetary value.

- `Money` — wraps `bigint` minor units at **scale 4** (displayed at 2), with explicit
  currency. Immutable. Provides `allocate()` for splitting without losing pennies.
- `Rate` — `decimal.js` for percentages, tax rates, and intermediate math needing more
  than 4dp.
- Branded types + an ESLint rule rejecting raw arithmetic on money-shaped values.
- Postgres: `NUMERIC(19,4)`. **Never** `float8`/`double precision`.

Getting this wrong is discovered years later, in the form of totals that are off by
cents and cannot be reconciled.

### Core schema

| Table | Purpose |
|---|---|
| `households`, `household_members` | Multi-user from day one |
| `accounts` | type (asset/liability/equity/income/expense) + subtype (checking/brokerage/mortgage/401k/...) |
| `transactions` | date, payee, memo, status (pending/cleared/reconciled), source |
| `postings` | transaction_id, account_id, signed amount — **must sum to zero per transaction** (DB constraint) |
| `securities`, `prices` | Instrument reference + price time series |
| `lots`, `lot_disposals` | Per-lot cost basis; FIFO/LIFO/SpecID disposal |
| `categories` | Hierarchical, mapped onto income/expense accounts |
| `budgets`, `budget_periods`, `budget_allocations` | Budgeting |
| `goals` | Sinking funds as **equity sub-accounts** so earmarked money isn't double-counted |
| `rules` | Categorization rules |
| `documents` | Supabase Storage refs, linked to entity + tax year |
| `tax_profiles`, `tax_years`, `tax_facts` | Tax inputs and results |
| `provenance` | What set each derived value (rule / user / model + confidence) |

**Append-only is the key design decision.** Transactions and postings are immutable
facts; corrections are reversing entries, never mutations. This makes historical net
worth at any past date exact, gives a real audit trail, and — critically — makes offline
sync nearly conflict-free, because concurrent devices append rather than contend.

### RLS and tenancy

Every table carries `household_id`; policies check membership. A second layer handles
per-account visibility, for individual accounts inside a shared household. Written and
tested at Phase 0, not retrofitted.

### Local-first sync

PowerSync sync rules bucket by `household_id`; each client mirrors to local SQLite.
Reads and writes are local and instant; writes queue and upload. Given append-only
entries, conflicts are rare by construction — reserve last-write-wins for genuinely
mutable rows (categories, budget targets, settings).

### AI-later seams

Ports in `packages/providers/`, each with a deterministic implementation now:

| Port | Now | Later |
|---|---|---|
| `CategorizationProvider` | Rules engine + string match | Classifier |
| `DocumentExtractor` | Structured parsers (CSV/OFX), regex paystub templates | Vision model |
| `InsightProvider` | Typed report queries | NL → query mapping |

Plus: retain raw import rows and original files permanently, and record provenance on
every derived value.

---

## Phases

**Phase 0 — Foundation (de-risks everything).** Monorepo, `Money`, schema + RLS,
PowerSync, auth with biometric unlock, CI. Exit criterion: one trivial screen creating a
record offline on iOS, Android, web and desktop, syncing correctly on reconnect, with
RLS proven to block cross-household reads. *Do not proceed until this works.*

**Phase 1 — MVP: Ledger + Paycheck + Budget.** Accounts, double-entry ledger, manual
entry, CSV/OFX/QFX import with dedupe, categorization rules, budgets, paycheck
calculator with real withholding, cash-flow forecasting, bill calendar and reminders.

**Phase 2 — Investments & net worth.** Lots, securities, prices, holdings, dividend
tracking and growth, rebalancing vs. target allocation, fee-drag comparison, IRR and
time-weighted return, multi-currency, net worth over time.

**Phase 3 — Tax.** Federal + state engine, projections, withholding adequacy, quarterly
estimates with safe-harbor, Roth conversion and bracket optimization (against bracket
tops, IRMAA cliffs, NIIT, AMT), return-prep organization.

**Phase 4 — Planning & calculators.** Monte Carlo, historical backtesting,
sequence-of-returns risk, Social Security claiming, RMDs, side-by-side scenarios, goals
and sinking funds, debt payoff (avalanche/snowball), and the calculator suite.

**Phase 5 — Breadth.** Equity comp (RSU/ISO/ESPP vesting, 83(b), AMT on exercise), real
estate and mortgages, crypto, tax-advantaged account rules, document vault with camera
capture.

**Phase 6 — Release.** App Store and Play Store submission, push notifications. AI layer
optional, behind the existing ports.

### Deferred but cheap to add later

Deselected during planning, noted because each is nearly free once its prerequisite
exists: **reconciliation** (a `cleared` flag + statement-balance view — the ledger
already supports it), **tax-loss harvesting / asset location** (falls out of per-lot
cost basis from Phase 2 plus the Phase 3 tax engine), **subscription detection** (a
query over recurring-transaction detection already built in Phase 1).

---

## Testing

A money app earns trust through tests, not features.

- **Property-based** (`fast-check`) for ledger invariants: postings always sum to zero;
  account balance equals the sum of its postings; balance reconstructed at any date T is
  stable regardless of insertion order.
- **Golden-file** tests for tax and paycheck math against published IRS examples and real
  paystubs. Bracket data is versioned per year and jurisdiction as JSON, so annual
  updates are a data change with a test fixture — not a code change.
- **Sync tests**: two simulated offline clients, divergent edits, verified convergence.
- **RLS tests**: every table, asserting cross-household reads and writes are denied.
- No `number` arithmetic on money anywhere — enforced by lint, verified in CI.

## Verification

1. `pnpm test` — unit, property, and golden-file suites across all packages.
2. `supabase start && pnpm test:rls` — policies against a local Postgres.
3. Offline scenario: airplane-mode on device, create and edit records, reconnect,
   confirm convergence across all four clients.
4. Import a real bank CSV and a real paystub PDF; confirm balances and net pay match the
   source documents exactly.
5. `pnpm dev` per app; manual pass on iOS simulator, Android emulator, browser, Tauri.

## Risks

| Risk | Mitigation |
|---|---|
| Scope is genuinely multi-year | Strict phase gates; Phase 1 must be daily-usable alone |
| Tax data maintenance (annual x 50 states) | Data-driven brackets; start federal + resident state |
| PowerSync cost/limits at scale | Interface-isolated; self-hosted PowerSync is an option |
| App Store scrutiny for finance apps | Phase 6, with no financial-institution claims |
| Money precision bugs | `Money` type + lint + property tests from day one |

## Open items (setup data, not blockers)

Resident state and filing status (determines which state module ships first); which
brokerages and banks, to prioritize import formats; whether a partner joins the
household in Phase 1 or later.

## First actions on approval

1. Scaffold the monorepo and CI.
2. Implement and fully test `packages/money`.
3. Write the Phase 0 schema + RLS policies and prove isolation.
4. Stand up PowerSync and ship the Phase 0 exit-criterion screen on all four clients.
