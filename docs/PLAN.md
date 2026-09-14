# Plan: Unified Personal Finance Platform (revision 2)

## Context

Revision 1 was reviewed externally. The review was largely correct, and this
revision adopts most of it. Three findings matter enough to restate plainly:

1. **I made a factually wrong claim.** Revision 1 justified TypeScript by saying
   .NET would put sync on alpha infrastructure. PowerSync's .NET SDK has since
   reached **beta with full feature parity**. Worse, the TypeScript *desktop*
   path is itself alpha: the PowerSync Tauri SDK is alpha, built on the alpha
   Rust SDK, and `connect()` from JavaScript throws — the backend connector must
   be written in Rust. The conclusion survives; the reasoning did not.

2. **The precision contract stopped at Postgres.** PowerSync maps Postgres
   `NUMERIC` to SQLite **`TEXT`**, and SQLite's `SUM()` over a text column
   silently coerces to float. Measured: `SUM('9007199254740993.0001','0.0001')`
   returns `9007199254740992` — the fraction gone, the integer part wrong, no
   error. An exact `Money` type in TypeScript cannot help when the corruption
   happens in SQL. **`postings.amount numeric(19,4)`, already committed, is a
   real defect.**

3. **"Append-only makes sync nearly conflict-free" was overstated.** It removes
   row-level conflicts, not business-level ones. Two offline devices can each
   reverse the same transaction; every entry balances and the result is still
   wrong. PowerSync also delivers uploads repeatedly and requires idempotency.

Two defects are already committed on `claude/finance-app-planning-8nsiks` and
are the first work of this revision.

### What is preserved

The review invalidated specific decisions, not the foundation. These stay as
built and tested, and the changes below are made around them:

- **`packages/money` in full** — `Money`, `Rate`, `allocate`, `divideRound`, 71
  tests. Its scale-4 `bigint` internal representation turns out to be exactly
  the right database representation too, so the precision fix *extends* it
  rather than replacing it.
- **The `DEFERRABLE INITIALLY DEFERRED` balancing trigger.** The review noted a
  cross-row total cannot be an ordinary `CHECK` and needs a deferred constraint
  trigger — which is what is already implemented and tested.
- `app_assert_posting_tenancy`, the purge protection (flag **and** privileged
  role), the RLS policies, the SQL test harness, and the CI wiring.

---

## Corrections to the record

| Revision 1 claim | Correct as of 2026-09-14 |
|---|---|
| PowerSync .NET SDK is alpha | **Beta**, full feature parity. Blazor still unsupported — which is what actually disqualifies .NET here, given 50/50 web usage |
| TypeScript avoids alpha sync infrastructure | True on iOS/Android/Web. **False on desktop**: Tauri SDK is alpha, Rust-only connector |
| Sync is "near conflict-free" | Row conflicts reduced; business conflicts and duplicate delivery remain and need explicit handling |
| Money is exact because Postgres is `NUMERIC(19,4)` | Only to the sync boundary. Client SQLite is where it breaks |
| Reconciliation is "cheap later" | It is Phase 1. Without it the paycheck/deposit double-count is structural |
| Historical net worth is exact | Exact *as recorded*. Backdated imports change history; needs bitemporality |

## Platform / SDK matrix (dated 2026-09-14 — re-verify before Phase 0 closes)

| Target | Client | PowerSync SDK | Status |
|---|---|---|---|
| iOS / Android | Expo / React Native | `@powersync/react-native` | Production |
| Web | Next.js (static export) | `@powersync/web` | Production |
| Desktop | Tauri v2 | `@powersync/tauri-plugin` + `tauri-plugin-powersync` | **Alpha — accepted risk** |

### Desktop: accepting alpha means accepting dependency instability

Taken deliberately, with conditions:

- **Keep the Rust connector small.** One file, one interface — fetch credentials,
  upload a batch, report status. No business logic in Rust. All financial
  behaviour stays in the shared TypeScript engines, so replacing the connector
  is a contained change.
- **Pin exact versions.** No carets or ranges on `@powersync/tauri-plugin`,
  `tauri-plugin-powersync`, or the Rust SDK. `Cargo.lock` and the pnpm lockfile
  are committed. Upgrades are deliberate, isolated commits with the Phase 0
  desktop suite re-run.
- **`SyncStatus.lastSyncedAt`, `hasSynced` and `priorityStatusEntries` are
  unavailable** on this SDK; read status via `SyncStatus.forStream`.
- **Fallback stays live**: the web build is a working desktop shell if the alpha
  proves unworkable. Nothing outside the connector may assume Tauri.

**Phase 0 must prove, on the actual desktop OS — not CI, not a simulator:**

| Property | Evidence required |
|---|---|
| Offline persistence | Data written with no network survives and is readable |
| Restart recovery | Kill the process; local data *and* the pending upload queue are intact |
| Upload retries | Queued writes retry until accepted; repeated delivery produces no second financial event |
| Reconnect behaviour | Sync resumes cleanly after the network returns, with no lost or duplicated writes |

**Tauri requires Next.js `output: 'export'`.** No SSR, server components, API
routes, middleware, or image optimization in any shared surface. For a
local-first app reading from local SQLite this is acceptable — but it is settled
now, before shared code depends on a server feature.

---

## The money precision contract (end to end)

This replaces "Postgres uses `NUMERIC(19,4)`". Every hop is specified.

| Hop | Representation |
|---|---|
| TypeScript | `Money` — `bigint` minor units at scale 4 + currency *(unchanged)* |
| JSON / API | `{ amount: "<scaled integer>", currency: "USD" }` — string, never a JS number |
| **Postgres** | **`bigint`** scaled minor units. *Not* `NUMERIC` |
| PowerSync | `bigint` → SQLite `INTEGER` (exact), *not* `TEXT` |
| Client SQLite | `INTEGER` — `SUM()` stays integer and **throws on overflow** |
| Display | `Money.format()` at the currency's own precision |

Measured: an `INTEGER` column sums exactly past 2^53 and raises `integer
overflow` rather than degrading to float. That loud failure is the whole point —
a `TEXT` column returns a silently wrong float instead.

Range at scale 4 within `bigint`: ±$922 trillion.

**Rules that follow:**
- A human-readable `NUMERIC` **view** may exist for ad-hoc queries. Never synced,
  never read by application code.
- Client SQL may aggregate money **only** on `INTEGER` columns. Authoritative
  totals go through `Money.sum()`.
- Separate scales for things that are not money: **security quantities**
  (scale 8), **unit prices** (scale 6), **FX rates** (reuse `Rate`, scale 12).
- Mandatory round-trip test: Postgres → sync → SQLite → app, **including
  aggregates**, asserting exactness.

---

## Transaction lifecycle

Revision 1 collapsed four ideas into one immutable row — which is why fixing a
typo in a payee name currently requires a reversing journal entry. Separate
them:

| Concept | Mutability |
|---|---|
| **Draft / import review** (`posted_at IS NULL`) | Fully mutable; excluded from all balances |
| **Posted entry** (`posted_at IS NOT NULL`) | Financial columns frozen; postings immutable |
| **Descriptive metadata** (payee, memo, category, tags) | Mutable at any time, with provenance |
| **Bank status** (pending → cleared) | A status transition, not a correction |
| **Statement reconciliation** | Separate records (below) |
| **Scheduled / forecast** | Separate table; never mixed into actual balances |

Replace the blanket `transactions_append_only` trigger with column-level
immutability: reject an UPDATE only when a financially material column changes
on a posted row. A pending card authorization whose amount settles differently
must not generate a trail of accounting reversals.

## One financial event, many observations

This is the structural fix for double-counting, and the reason reconciliation
cannot be deferred.

A **financial event** is the thing that happened in the world. An **observation**
is evidence of it — a manually recorded paycheck, an imported bank row, a
brokerage line. **Postings belong to the event, never to the observation.**

- A recorded paycheck and its imported bank deposit are **two observations of one
  event**. The import matches the existing event, attaches its `source_id`, and
  marks the posting cleared. It creates **no new postings**. Without this, income
  and cash are both counted twice.
- A transfer imported from **both** accounts is likewise one event with exactly
  two postings. The second side matches the existing event rather than creating a
  second transaction — otherwise $500 moved looks like $1,000 moved plus a
  phantom balance.
- Dedupe keys on `(account_id, source_id)` from the file. **Never** on date +
  amount + description: legitimate repeated purchases share all three.
- Anything unmatched goes to a **review queue** as a draft, never silently
  posted.

## Reconciliation (Phase 1, not deferred)

- **`statements`** — account, period, statement date, **closing balance**.
- **`reconciliations`** — links a statement to the cleared postings as of that
  date; records book balance, statement balance, and the **discrepancy**.
- **Discrepancy review** — lists unmatched entries on both sides, with explicit
  outcomes: create a missing entry, accept as a timing difference, or flag for
  investigation. A discrepancy is never silently absorbed.
- A completed reconciliation is **locked**. Later corrections produce a new
  reconciliation rather than editing a closed one.

## Conflict and idempotency model

- **Business operations**, not row writes: `post_transaction`,
  `reverse_transaction`, `import_batch`, each with a **client-generated stable
  operation id**, unique in the database, so repeated delivery is a no-op.
- **A transaction can be reversed at most once** — a unique partial index on
  `reverses_id`, so two offline devices reversing the same entry converge.
- **Sync state is visible in the UI**: saved locally / awaiting acceptance /
  rejected. A silently rejected write is worse than an error.

## Tenancy, ownership, and isolation

Three separate concepts, conflated in revision 1:

- **Household** — application access boundary; drives RLS and sync buckets.
- **Financial ownership** — whose asset or liability it is.
- **Tax filing unit** — whose return it appears on. Not implied by household.

**RLS does not give sync isolation.** PowerSync Sync Streams decide what is
*downloaded*; RLS governs *uploads* reaching Postgres. Two mechanisms, two test
suites. Tests must assert what actually lands on an unauthorized device, not
only what a query returns.

**Per-account privacy within a shared household is explicitly deferred.** It
leaks through counterpart postings, descriptions, documents and household
totals; a partial implementation would be a false promise. Phase 1 households
are all-or-nothing shared, stated plainly in the UI.

## Other schema decisions revised

- **Sinking funds are budget allocations, not equity sub-accounts.** Earmarking
  cash does not change assets or net worth.
- **Bitemporal dates**: `occurred_on` (effective) and `recorded_at` (system), so
  reports can answer "as known then" despite backdated imports.
- **Currency identity now**, though MVP is USD-only. Convention already enforced:
  postings balance within a single currency; cross-currency moves go through an
  explicit exchange account.
- **Investments need more than lots + prices**: corporate actions, inter-brokerage
  transfers, missing basis, and broker reconciliation, before returns are trusted.

---

## Phases

**Phase 0 — Prove the financial infrastructure.**
A balanced transaction survives offline creation, app termination, reconnect,
**repeated upload**, and **concurrent correction from two devices**; unauthorized
data never reaches another device (verified by inspecting what syncs, not only
what queries return); money is exact end to end including aggregates; backup,
export and a **tested restore** work; and the desktop table above passes on real
hardware.

**Phase 1A — Trustworthy daily ledger.**
Import bank files, match transfers and paycheck deposits to single events,
categorize, budget, **reconcile statements with discrepancy review**, export and
restore. Includes import batches, source ids, and duplicate review.

**Phase 1B — Paycheck planning and cash flow.**
A named, closed set of withholding cases passes authoritative fixtures.
Forecasts stay separate from actual balances. Bill calendar and reminders.

**Early distribution milestone.** Installable builds through the real mobile
channels and on actual desktop operating systems — brought forward, not left to
the end.

**Then, gated:** investments → tax → planning → breadth.

**Product gate.** The market thesis is a hypothesis. Before expanding into
investment and tax breadth, this workflow must succeed repeatedly with less
effort than existing tools: *record a paycheck, fund the budget, anticipate
bills, reconcile the month.*

### Scope discipline

Create packages and schema when a working feature needs them — not all up front,
which locks in assumptions before real workflows expose them. Keep tenant
isolation from day one. Raw-document retention is **configurable**, not
unconditional permanent retention.

### Tax scope, restated honestly

Annual maintenance is not a JSON bracket update: IRS Pub 15-T changes methods
and forms, not just amounts. Phase 1B needs an explicitly bounded foundation —
supported tax year, W-4 inputs, pay frequency, YTD wages, deduction treatment,
named jurisdictions.

Deferred items are **"prerequisites identified, effort unestimated"**, not
"cheap later". Tax-loss harvesting does not fall out of lots: wash sales span
accounts, a spouse, and IRAs (Pub 550). Subscription detection needs merchant
normalization, variable amounts, refunds, and false-positive handling.

---

## Immediate work on approval

1. **Fix the precision defect** — `postings.amount` → `bigint` scaled minor
   units; add `Money` ↔ DB binding helpers; add the human-readable `NUMERIC`
   view. `packages/money` itself is unchanged.
2. **Fix the lifecycle defect** — replace the blanket append-only trigger with
   column-level immutability plus a draft state. Keep the deferred balancing
   trigger exactly as is. Test that a payee typo is editable and a posted amount
   is not.
3. Add `reverses_id` unique partial index and the `operations` table with unique
   client operation ids; test double-reversal and repeated upload.
4. Add `financial_events` / observations, `statements`, `reconciliations`.
5. **Update `docs/PLAN.md` and the PR description** to match, retracting the
   overstated claims.
6. Only then continue to Phase 0's sync proof.

## Verification

- `pnpm test` — unit and property suites (71 existing tests must stay green).
- SQL suite against real Postgres 16: RLS, balance invariant, lifecycle rules,
  idempotency constraints, reconciliation.
- **Precision round-trip**: Postgres → PowerSync → SQLite → app, asserting exact
  values *and* exact aggregates.
- **Sync isolation**: two devices, two households; assert the unauthorized device
  never receives the rows at all.
- **Conflict**: two offline devices reverse the same transaction; assert one
  reversal survives.
- **Double-count**: record a paycheck, import the matching bank deposit; assert
  one event, one set of postings, correct income and cash. Repeat for a transfer
  imported from both sides.
- **Desktop**: the four-property table above, on real hardware.
- Backup → wipe → restore, asserting an identical ledger.

## Risks

| Risk | Mitigation |
|---|---|
| Tauri/Rust PowerSync SDK is alpha | Small pinned connector, no business logic in Rust, web build as live fallback, desktop suite re-run on every upgrade |
| Local database grows without bound | Date-bucketed Sync Streams and archiving, designed in Phase 0 |
| Business-level sync conflicts | Stable operation ids, uniqueness constraints, visible sync state |
| Tax maintenance (methods, not just brackets) | Bounded supported set, stated explicitly; authoritative fixtures |
| Two UI shells for a solo developer | Real and unresolved; distribution milestone pulled forward to expose it early |
| Browser storage persistence can be denied | Handle denial explicitly; backup/restore is the safety net |

## Open items

**Sync Streams, not Sync Rules.** PowerSync's own guidance is that Sync
Rules are legacy and new projects use Sync Streams; earlier revisions of this
plan used the old term. The isolation argument is unchanged — what is
*downloaded* is still a separate mechanism from what RLS governs on upload,
and still needs its own tests.

Resident state and filing status; which banks and brokerages, to prioritize
import formats; whether a partner joins the household in Phase 1; Supabase and
PowerSync credentials, which block Phase 0's sync proof; which desktop OS the
Phase 0 desktop suite must pass on.
