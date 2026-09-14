-- Core tenancy and double-entry ledger.
--
-- Four ideas drive this schema:
--
-- 1. `household_id` is on every row. It is the tenancy boundary and every RLS
--    policy keys off it. Retrofitting multi-tenancy later is a rewrite, so it
--    is here from the first migration even while there is one user.
--
-- 2. Money is a `bigint` count of scaled minor units, never NUMERIC. PowerSync
--    maps Postgres NUMERIC to SQLite TEXT, and SQLite's SUM() over a text
--    column silently coerces to float: summing '9007199254740993.0001' and
--    '0.0001' gives 9007199254740992. An INTEGER column sums exactly and
--    raises `integer overflow` instead. Columns are named `amount_units` so
--    nobody writing ad-hoc SQL mistakes scaled units for dollars.
--
-- 3. A posted entry's financial facts are immutable; its description is not.
--    Correcting an amount means a reversing entry. Fixing a typo in a payee
--    name is just an UPDATE. Conflating those two is what forces absurd
--    accounting trails for a spelling mistake.
--
-- 4. Postings belong to the underlying financial event, never to the evidence
--    of it. A recorded paycheck and its imported bank deposit are two
--    observations of one event. Without that distinction, income and cash are
--    both counted twice.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- tenancy

create table households (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(trim(name)) > 0),
  base_currency text not null default 'USD' check (base_currency ~ '^[A-Z]{3}$'),
  created_at    timestamptz not null default now()
);

create type household_role as enum ('owner', 'member');

create table household_members (
  household_id uuid not null references households(id) on delete cascade,
  user_id      uuid not null,
  role         household_role not null default 'member',
  created_at   timestamptz not null default now(),
  primary key (household_id, user_id)
);

create index household_members_user_idx on household_members(user_id);

-- Membership lookup used by every policy below.
--
-- SECURITY DEFINER is required: a policy on `household_members` that queried
-- `household_members` would recurse. Marked STABLE with a fixed search_path so
-- it cannot be hijacked by a caller-controlled schema.
create function app_is_household_member(target uuid) returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1 from household_members
    where household_id = target and user_id = auth.uid()
  )
$$;

-- ------------------------------------------------------- financial ownership

-- Household membership says who may *see* the data. It does not say whose
-- asset something is, and it does not say whose tax return it lands on. Those
-- are three different questions; conflating them misstates both net worth and
-- taxable income in a shared household.
--
-- Ownership is modelled now because accounts point at it. The tax filing unit
-- is deliberately not modelled yet — it arrives with the tax engine, and
-- inventing it here would lock in assumptions before any return exists.
create table owners (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  name         text not null check (length(trim(name)) > 0),
  -- A natural person, or an entity such as a trust or sole proprietorship.
  kind         text not null default 'person',
  created_at   timestamptz not null default now()
);

create index owners_household_idx on owners(household_id);

-- ---------------------------------------------------------------- accounts

-- Sign conventions follow standard accounting: asset and expense balances
-- increase with positive postings; liability, equity and income increase with
-- negative ones.
create type account_kind as enum ('asset', 'liability', 'equity', 'income', 'expense');

create table accounts (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  owner_id     uuid references owners(id),
  kind         account_kind not null,
  -- Free-form refinement of `kind`: checking, savings, brokerage, mortgage,
  -- 401k, credit_card. Text rather than an enum so adding an account type is
  -- not a migration.
  subtype      text not null check (length(trim(subtype)) > 0),
  name         text not null check (length(trim(name)) > 0),
  currency     text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  institution  text,
  -- Closed accounts stay for history; they are never deleted.
  closed_at    timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index accounts_household_idx on accounts(household_id);

-- ------------------------------------------------------------- idempotency

-- PowerSync may deliver the same upload more than once, so every write that
-- creates a financial effect carries a client-generated operation id. The
-- primary key does the work: a replayed operation collides and is a no-op
-- rather than a second paycheck.
create table operations (
  id           uuid primary key,
  household_id uuid not null references households(id) on delete cascade,
  -- post_transaction | reverse_transaction | import_batch
  kind         text not null check (length(trim(kind)) > 0),
  created_at   timestamptz not null default now()
);

create index operations_household_idx on operations(household_id);

-- ------------------------------------------------------------ transactions

-- Bank-side status. Distinct from reconciliation, which is a separate record:
-- a cleared transaction has settled at the bank; a reconciled one has been
-- matched against a statement.
create type transaction_status as enum ('pending', 'cleared', 'reconciled');

create table transactions (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,

  -- Bitemporal. `occurred_on` is when the money moved in the world;
  -- `recorded_at` is when this system learned of it. Backdated imports and
  -- revised prices change history, so a report that must reproduce what was
  -- known at a past moment needs both.
  --
  -- A plain DATE, not a timestamp: a transaction belongs to a calendar day,
  -- and timezone-shifting one across a month or tax-year boundary is a real
  -- bug.
  occurred_on  date not null,
  recorded_at  timestamptz not null default now(),

  -- Mutable description. Correcting these is not an accounting event.
  payee        text,
  memo         text,

  -- standard | transfer | paycheck | reversal
  kind         text not null default 'standard',
  status       transaction_status not null default 'cleared',

  -- NULL means draft: under review, freely editable, and excluded from every
  -- balance. Non-NULL means posted: financial facts are frozen from here on.
  posted_at    timestamptz,

  source       text not null default 'manual',
  operation_id uuid references operations(id),

  -- When this entry reverses another. Corrections are new rows, so the
  -- original stays readable.
  reverses_id  uuid references transactions(id),

  created_at   timestamptz not null default now()
);

create index transactions_household_date_idx
  on transactions(household_id, occurred_on desc);

-- A transaction may be reversed at most once. This is what makes two offline
-- devices reversing the same entry converge on one reversal instead of
-- silently doubling it — both reversals balance perfectly, so nothing else
-- would catch it.
create unique index transactions_reversed_once
  on transactions(reverses_id) where reverses_id is not null;

create table postings (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references households(id) on delete cascade,
  transaction_id uuid not null references transactions(id) on delete cascade,
  account_id     uuid not null references accounts(id),
  -- Scaled minor units at MONEY_SCALE (4), matching @finance/money exactly.
  -- See the header note on why this is bigint and not numeric.
  amount_units   bigint not null,
  currency       text not null check (currency ~ '^[A-Z]{3}$'),
  created_at     timestamptz not null default now()
);

create index postings_transaction_idx on postings(transaction_id);
create index postings_account_idx on postings(account_id);
create index postings_household_idx on postings(household_id);

-- Human-readable projection for ad-hoc queries. Never synced, never read by
-- application code — the division produces NUMERIC, which is exactly what must
-- not cross the sync boundary.
create view postings_readable as
  select
    p.id,
    p.household_id,
    p.transaction_id,
    p.account_id,
    (p.amount_units::numeric / 10000) as amount,
    p.currency,
    p.created_at
  from postings p;

-- ------------------------------------------------ observations (evidence)

-- Evidence that a financial event happened: a manually entered row, an
-- imported bank line, a brokerage statement line. Several observations can
-- describe one transaction.
--
-- This is the structural fix for double-counting. When an imported deposit
-- matches an already-recorded paycheck, the observation points at the existing
-- transaction and no new postings are created. The same applies to a transfer
-- that appears in both accounts' exports: one event, two postings, two
-- observations — not two transactions netting to twice the money moved.
create table observations (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references households(id) on delete cascade,
  -- NULL while unmatched: the row is in the review queue, not yet attributed
  -- to an event.
  transaction_id  uuid references transactions(id) on delete cascade,
  account_id      uuid not null references accounts(id),

  source          text not null,
  -- The source's own stable identifier (OFX FITID, or a hash of the row for
  -- formats without one). Unique per account, which makes re-importing a file
  -- idempotent.
  source_id       text,
  import_batch_id uuid,

  occurred_on     date not null,
  amount_units    bigint not null,
  currency        text not null check (currency ~ '^[A-Z]{3}$'),
  description     text,
  -- The original row, retained per the configured retention policy. Extraction
  -- can be re-run; a discarded source cannot be recovered.
  raw             jsonb,

  matched_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index observations_household_idx on observations(household_id);
create index observations_transaction_idx on observations(transaction_id);
create index observations_unmatched_idx
  on observations(household_id, account_id) where transaction_id is null;

-- Re-importing the same file cannot create a second observation of the same
-- bank row. Deliberately keyed on the source's identifier rather than on date
-- + amount + description, which legitimate repeated purchases all share.
create unique index observations_source_unique
  on observations(account_id, source, source_id) where source_id is not null;

-- ------------------------------------------------- the balance invariant

-- Every posted transaction's postings must sum to exactly zero. This is the
-- one rule that makes the ledger a ledger.
--
-- It cannot be a CHECK constraint, which sees a single row. A CONSTRAINT
-- TRIGGER that is DEFERRABLE INITIALLY DEFERRED runs at COMMIT instead, so a
-- client can insert the debit and the credit as separate statements and still
-- be held to the rule — which is how a queued offline write replays.
--
-- Drafts are exempt. An imported row known from one side only is a legitimate
-- intermediate state; requiring it to balance would make the review queue
-- impossible.
create function app_assert_transaction_balanced() returns trigger
  language plpgsql
as $$
declare
  target uuid := coalesce(new.transaction_id, old.transaction_id);
  is_posted boolean;
  imbalance bigint;
  currencies int;
begin
  select posted_at is not null into is_posted
  from transactions where id = target;

  -- Transaction already gone, or still a draft: nothing to enforce.
  if is_posted is null or not is_posted then
    return null;
  end if;

  if not exists (select 1 from postings where transaction_id = target) then
    raise exception
      'Transaction % is posted but has no postings.', target
      using errcode = 'check_violation';
  end if;

  select count(distinct currency) into currencies
  from postings where transaction_id = target;

  if currencies > 1 then
    raise exception
      'Transaction % mixes % currencies. Record a conversion through an explicit exchange account instead.',
      target, currencies
      using errcode = 'check_violation';
  end if;

  select sum(amount_units) into imbalance
  from postings where transaction_id = target;

  if imbalance <> 0 then
    raise exception
      'Transaction % is out of balance by % units. Postings must sum to zero.',
      target, imbalance
      using errcode = 'check_violation';
  end if;

  return null;
end
$$;

create constraint trigger postings_balance_check
  after insert or update or delete on postings
  deferrable initially deferred
  for each row
  execute function app_assert_transaction_balanced();

-- The posting trigger cannot see a draft becoming posted, because no posting
-- row changes. This covers that path.
create function app_assert_posting_on_post() returns trigger
  language plpgsql
as $$
declare
  imbalance bigint;
  currencies int;
begin
  if new.posted_at is null then
    return null;
  end if;

  if not exists (select 1 from postings where transaction_id = new.id) then
    raise exception
      'Transaction % cannot be posted with no postings.', new.id
      using errcode = 'check_violation';
  end if;

  select count(distinct currency), sum(amount_units)
    into currencies, imbalance
  from postings where transaction_id = new.id;

  if currencies > 1 then
    raise exception
      'Transaction % mixes % currencies.', new.id, currencies
      using errcode = 'check_violation';
  end if;

  if imbalance <> 0 then
    raise exception
      'Transaction % cannot be posted: out of balance by % units.',
      new.id, imbalance
      using errcode = 'check_violation';
  end if;

  return null;
end
$$;

create constraint trigger transactions_balance_on_post
  after insert or update on transactions
  deferrable initially deferred
  for each row
  execute function app_assert_posting_on_post();

-- A posting must belong to the same household as its transaction and account.
-- Without this, a caller who can write to their own household could attach a
-- posting to someone else's transaction.
create function app_assert_posting_tenancy() returns trigger
  language plpgsql
as $$
declare
  txn_household uuid;
  acct_household uuid;
begin
  select household_id into txn_household from transactions where id = new.transaction_id;
  select household_id into acct_household from accounts where id = new.account_id;

  if txn_household is distinct from new.household_id
     or acct_household is distinct from new.household_id then
    raise exception
      'Posting household % does not match its transaction (%) and account (%).',
      new.household_id, txn_household, acct_household
      using errcode = 'check_violation';
  end if;

  return new;
end
$$;

create trigger postings_tenancy_check
  before insert or update on postings
  for each row
  execute function app_assert_posting_tenancy();

-- ------------------------------------------------------ posted immutability

-- A deliberate purge — account closure or an erasure request — would otherwise
-- be impossible, since ON DELETE CASCADE from `households` reaches these rows.
--
-- A purge needs two things at once: the `app.allow_purge` setting, and a role
-- that is not one of the application's own. Any role may set a custom GUC, so
-- the setting alone would be no protection: a compromised client could simply
-- set it and start deleting history.
create function app_purge_allowed() returns boolean
  language plpgsql
  stable
as $$
begin
  if coalesce(current_setting('app.allow_purge', true), 'off') <> 'on' then
    return false;
  end if;
  return current_user not in ('anon', 'authenticated');
end
$$;

-- Financial facts of a posted transaction are frozen. Descriptive metadata and
-- bank status are not — fixing a payee spelling, recategorising, or recording
-- that a pending charge cleared are all ordinary edits, and forcing a reversing
-- journal entry for any of them would be absurd.
--
-- A pending card authorisation that settles at a different amount is handled as
-- a draft or a reversal, never as a silent rewrite of a posted amount.
create function app_guard_posted_transaction() returns trigger
  language plpgsql
as $$
begin
  if app_purge_allowed() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  -- Drafts are freely editable and deletable.
  if old.posted_at is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception
      'Cannot delete posted transaction %. Record a reversing entry instead.', old.id
      using errcode = 'restrict_violation';
  end if;

  if new.household_id is distinct from old.household_id
     or new.occurred_on  is distinct from old.occurred_on
     or new.kind         is distinct from old.kind
     or new.posted_at    is distinct from old.posted_at
     or new.reverses_id  is distinct from old.reverses_id
     or new.operation_id is distinct from old.operation_id then
    raise exception
      'Cannot change the financial facts of posted transaction %. Record a reversing entry instead.',
      old.id
      using errcode = 'restrict_violation';
  end if;

  return new;
end
$$;

create trigger transactions_posted_guard
  before update or delete on transactions
  for each row execute function app_guard_posted_transaction();

-- Postings of a posted transaction are immutable. DELETE is blocked as well:
-- deleting every posting would otherwise satisfy the balance check vacuously
-- and erase an entry silently.
create function app_guard_posted_posting() returns trigger
  language plpgsql
as $$
declare
  parent_posted boolean;
  target uuid := coalesce(new.transaction_id, old.transaction_id);
begin
  if app_purge_allowed() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  select posted_at is not null into parent_posted
  from transactions where id = target;

  -- Parent already deleted (cascade), or still a draft.
  if parent_posted is null or not parent_posted then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  raise exception
    '% on a posting of posted transaction % is not allowed. Record a reversing entry instead.',
    tg_op, target
    using errcode = 'restrict_violation';
end
$$;

create trigger postings_posted_guard
  before update or delete on postings
  for each row execute function app_guard_posted_posting();

-- ------------------------------------------------------------------- RLS

alter table households        enable row level security;
alter table household_members enable row level security;
alter table owners            enable row level security;
alter table accounts          enable row level security;
alter table operations        enable row level security;
alter table transactions      enable row level security;
alter table postings          enable row level security;
alter table observations      enable row level security;

create policy households_select on households
  for select using (app_is_household_member(id));

create policy household_members_select on household_members
  for select using (app_is_household_member(household_id));

create policy owners_all on owners
  for all using (app_is_household_member(household_id))
  with check (app_is_household_member(household_id));

create policy accounts_all on accounts
  for all using (app_is_household_member(household_id))
  with check (app_is_household_member(household_id));

create policy operations_all on operations
  for all using (app_is_household_member(household_id))
  with check (app_is_household_member(household_id));

create policy transactions_all on transactions
  for all using (app_is_household_member(household_id))
  with check (app_is_household_member(household_id));

create policy postings_all on postings
  for all using (app_is_household_member(household_id))
  with check (app_is_household_member(household_id));

create policy observations_all on observations
  for all using (app_is_household_member(household_id))
  with check (app_is_household_member(household_id));

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete
  on households, household_members, owners, accounts, operations,
     transactions, postings, observations
  to authenticated;
grant select on postings_readable to authenticated;
grant execute on function app_is_household_member(uuid) to authenticated;
