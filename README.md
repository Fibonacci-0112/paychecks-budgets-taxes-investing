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
and reconciliation schema are in place and tested. Client apps and sync come
next.

| Piece | State |
|---|---|
| `packages/money` | Done — 78 tests, exact decimal arithmetic |
| `supabase/migrations` | Ledger, lifecycle, reconciliation — 50 assertions |
| CI | Typecheck, tests, and live SQL policy tests |
| Client apps, PowerSync | Not started |

## Getting started

Requires Node 22+ and pnpm 10+.

```bash
pnpm install
pnpm run check      # typecheck + lint + test
```

### Deploying the backend

One command, safe to re-run:

```bash
cp .env.example .env      # fill in DATABASE_URL
./scripts/setup-backend.sh
```

It applies pending migrations (tracked in `schema_migrations`, so a second run
is a no-op), creates a read-only `powersync_role` with a generated password,
writes `PS_DATABASE_URI` to `.env`, and verifies replication end to end. Pass
`--dry-run` to see the plan first.

It refuses to apply `supabase/ci/`, which is a local-only shim for `auth.uid()`
and the anon/authenticated roles — applying that to a real Supabase project
overwrites platform functions.

### Database, by hand

Migrations are plain SQL and run on any Postgres 16. To exercise them locally
with row-level security actually enforced:

```bash
createdb ledger
psql -d ledger -f supabase/ci/00_bootstrap.sql        # local/CI only
for f in supabase/migrations/*.sql; do psql -d ledger -f "$f"; done
for f in supabase/tests/*.sql;      do psql -d ledger -f "$f"; done
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

## Four things to know before changing anything

**Money never lives in a `number`, and never in a `NUMERIC` column.** Columns
are `bigint` scaled minor units named `amount_units`. PowerSync maps `NUMERIC`
to SQLite `TEXT`, where `SUM()` silently returns a float — so exactness in
TypeScript would be thrown away by one aggregate query. See
`packages/money/README.md`.

**A posted entry's financial facts are immutable; its description is not.**
Correcting an amount means a reversing entry. Fixing a typo in a payee name is
an ordinary `UPDATE`. Drafts — imported rows under review — are freely editable
and excluded from every balance.

**Postings belong to the financial event, not to the evidence of it.** A
recorded paycheck and its imported bank deposit are two *observations* of one
event; matching the deposit creates no new postings. Without that, income and
cash are both counted twice. The same applies to a transfer that appears in both
accounts' exports.

**Append-only does not make sync conflict-free.** It removes row conflicts, not
business ones: two offline devices can each reverse the same transaction and
both reversals balance perfectly. Uniqueness constraints on reversals and on
client-generated operation ids are what actually make concurrent devices
converge.
