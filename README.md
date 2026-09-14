# paychecks-budgets-taxes-investing

An app that covers everything in your financial world: paychecks, budgets, taxes,
investments. Calculate and track/log paychecks, create budgets specific to your
life and estimate/simulate how different investments/investing methods will
perform. Also, included a plethora of different calculators specifically for any
of your finance needs.

Targets iOS, Android, web and desktop, works fully offline, and keeps every
amount exact.

See [`docs/PLAN.md`](docs/PLAN.md) for the architecture and phased delivery plan.

## Status

**Phase 0 — foundation.** The monorepo, the `Money` type, and the core ledger
schema with its policies are in place and tested. Client apps and sync come
next.

| Piece | State |
|---|---|
| `packages/money` | Done — 71 tests, exact decimal arithmetic |
| `supabase/migrations` | Core ledger + RLS — 18 assertions |
| CI | Typecheck, tests, and live SQL policy tests |
| Client apps, PowerSync | Not started |

## Getting started

Requires Node 22+ and pnpm 10+.

```bash
pnpm install
pnpm run check      # typecheck + lint + test
```

### Database

Migrations are plain SQL and run on any Postgres 16. To exercise them locally
with the row-level security policies actually enforced:

```bash
createdb ledger
psql -d ledger -f supabase/ci/00_bootstrap.sql        # local/CI only
psql -d ledger -f supabase/migrations/0001_core_ledger.sql
psql -d ledger -f supabase/tests/0001_core_ledger.test.sql
```

`supabase/ci/` supplies the `auth` schema and the anon/authenticated roles that
Supabase provides as platform features. It is never applied to a real project.

## Layout

```
packages/money/        Exact Money and Rate types — read its README first
supabase/migrations/   Schema, constraints and RLS policies
supabase/tests/        Policy and invariant tests, run against real Postgres
docs/PLAN.md           Architecture and delivery plan
```

## Two things worth knowing before changing anything

**Money never lives in a `number`.** See `packages/money/README.md`. This is
enforced by the type system, not by convention.

**The ledger is append-only.** Transactions and postings are immutable facts;
a correction is a new reversing entry. The database refuses `UPDATE` and
`DELETE` on them. This is what makes historical balances exact, gives a real
audit trail, and lets two offline devices sync by appending rather than
contending.
