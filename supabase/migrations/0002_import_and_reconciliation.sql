-- Import batches and statement reconciliation.
--
-- Reconciliation is the mechanism that proves the ledger matches the bank.
-- Without it there is no way to know the books are right, and the
-- paycheck/deposit double-count is structural rather than an edge case — which
-- is why this is Phase 1 work and not deferred.
--
-- The matching model lives in `observations` (migration 0001): postings belong
-- to the financial event, and an imported row that matches an existing event
-- attaches to it rather than creating a second one.

-- ----------------------------------------------------------- import batches

create table import_batches (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  account_id   uuid not null references accounts(id),
  -- The operation that produced this batch, so a replayed upload is a no-op.
  operation_id uuid references operations(id),
  filename     text,
  -- csv | ofx | qfx
  format       text not null,
  row_count    integer not null default 0 check (row_count >= 0),
  -- Rows that matched an existing event rather than creating a new one. A
  -- healthy paycheck or transfer import shows a high matched count; a zero
  -- here on a transfer-heavy file is a sign the matcher is not working.
  matched_count integer not null default 0 check (matched_count >= 0),
  imported_at  timestamptz not null default now()
);

create index import_batches_household_idx on import_batches(household_id);

alter table observations
  add constraint observations_import_batch_fk
  foreign key (import_batch_id) references import_batches(id) on delete set null;

-- ---------------------------------------------------------------- statements

create table statements (
  id                    uuid primary key default gen_random_uuid(),
  household_id          uuid not null references households(id) on delete cascade,
  account_id            uuid not null references accounts(id),
  period_start          date not null,
  period_end            date not null,
  statement_date        date not null,
  -- The balance the institution reports at period_end. Scaled minor units,
  -- same representation as postings.
  closing_balance_units bigint not null,
  currency              text not null check (currency ~ '^[A-Z]{3}$'),
  created_at            timestamptz not null default now(),

  check (period_end >= period_start)
);

create index statements_account_idx on statements(account_id, period_end desc);

-- One statement per account per period.
create unique index statements_period_unique
  on statements(account_id, period_start, period_end);

-- ------------------------------------------------------------ reconciliation

create type reconciliation_status as enum ('in_progress', 'completed', 'abandoned');

create table reconciliations (
  id                      uuid primary key default gen_random_uuid(),
  household_id            uuid not null references households(id) on delete cascade,
  statement_id            uuid not null references statements(id) on delete cascade,

  -- What the ledger says, what the bank says, and the gap between them. The
  -- discrepancy is stored rather than recomputed so a completed reconciliation
  -- records what was actually true when it was accepted.
  book_balance_units      bigint not null,
  statement_balance_units bigint not null,
  discrepancy_units       bigint not null,

  status                  reconciliation_status not null default 'in_progress',
  completed_at            timestamptz,
  -- A completed reconciliation is locked. Later corrections produce a new
  -- reconciliation rather than editing a closed one, so the historical record
  -- of what was agreed at the time survives.
  locked                  boolean not null default false,
  notes                   text,
  created_at              timestamptz not null default now()
);

create index reconciliations_statement_idx on reconciliations(statement_id);

-- Only one active reconciliation per statement at a time.
create unique index reconciliations_active_unique
  on reconciliations(statement_id) where status = 'in_progress';

-- Which postings were counted as cleared in this reconciliation.
create table reconciliation_entries (
  reconciliation_id uuid not null references reconciliations(id) on delete cascade,
  posting_id        uuid not null references postings(id) on delete cascade,
  household_id      uuid not null references households(id) on delete cascade,
  created_at        timestamptz not null default now(),
  primary key (reconciliation_id, posting_id)
);

create index reconciliation_entries_posting_idx on reconciliation_entries(posting_id);

-- Every difference is named and given an outcome. A discrepancy is never
-- silently absorbed into the next period.
create type discrepancy_resolution as enum (
  'unresolved',
  'timing_difference',  -- real, will clear next period
  'entry_created',      -- the ledger was missing something
  'flagged'             -- needs investigation; possible bank error or fraud
);

create table reconciliation_discrepancies (
  id                uuid primary key default gen_random_uuid(),
  household_id      uuid not null references households(id) on delete cascade,
  reconciliation_id uuid not null references reconciliations(id) on delete cascade,
  -- missing_in_ledger | missing_at_bank | amount_mismatch
  kind              text not null,
  amount_units      bigint not null,
  currency          text not null check (currency ~ '^[A-Z]{3}$'),
  -- The observation or posting the difference was noticed on, when there is one.
  observation_id    uuid references observations(id) on delete set null,
  posting_id        uuid references postings(id) on delete set null,
  resolution        discrepancy_resolution not null default 'unresolved',
  note              text,
  created_at        timestamptz not null default now()
);

create index reconciliation_discrepancies_recon_idx
  on reconciliation_discrepancies(reconciliation_id);

-- A reconciliation cannot be completed while differences are unexplained, and
-- cannot be edited once locked.
create function app_guard_reconciliation() returns trigger
  language plpgsql
as $$
declare
  unresolved int;
begin
  if tg_op = 'UPDATE' and old.locked then
    raise exception
      'Reconciliation % is locked. Create a new reconciliation instead of editing a completed one.',
      old.id
      using errcode = 'restrict_violation';
  end if;

  if new.status = 'completed' then
    select count(*) into unresolved
    from reconciliation_discrepancies
    where reconciliation_id = new.id and resolution = 'unresolved';

    if unresolved > 0 then
      raise exception
        'Reconciliation % has % unresolved discrepancy(ies). Each difference needs an explicit outcome.',
        new.id, unresolved
        using errcode = 'check_violation';
    end if;

    new.completed_at := coalesce(new.completed_at, now());
    new.locked := true;
  end if;

  return new;
end
$$;

create trigger reconciliations_guard
  before update on reconciliations
  for each row execute function app_guard_reconciliation();

-- ------------------------------------------------------------------- RLS

alter table import_batches                enable row level security;
alter table statements                    enable row level security;
alter table reconciliations               enable row level security;
alter table reconciliation_entries        enable row level security;
alter table reconciliation_discrepancies  enable row level security;

create policy import_batches_all on import_batches
  for all using (app_is_household_member(household_id))
  with check (app_is_household_member(household_id));

create policy statements_all on statements
  for all using (app_is_household_member(household_id))
  with check (app_is_household_member(household_id));

create policy reconciliations_all on reconciliations
  for all using (app_is_household_member(household_id))
  with check (app_is_household_member(household_id));

create policy reconciliation_entries_all on reconciliation_entries
  for all using (app_is_household_member(household_id))
  with check (app_is_household_member(household_id));

create policy reconciliation_discrepancies_all on reconciliation_discrepancies
  for all using (app_is_household_member(household_id))
  with check (app_is_household_member(household_id));

grant select, insert, update, delete
  on import_batches, statements, reconciliations,
     reconciliation_entries, reconciliation_discrepancies
  to authenticated;
