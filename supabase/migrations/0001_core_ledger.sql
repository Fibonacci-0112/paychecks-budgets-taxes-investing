-- Core tenancy and double-entry ledger.
--
-- Two ideas drive this schema:
--
-- 1. `household_id` is on every row. It is the tenancy boundary, and every RLS
--    policy keys off it. Retrofitting multi-tenancy later is a rewrite, so it
--    is here from the first migration even while there is one user.
--
-- 2. Transactions and postings are append-only facts. A correction is a new
--    reversing entry, never an UPDATE. That gives exact historical balances at
--    any past date, a real audit trail, and — because two offline devices
--    append rather than contend — sync that is very nearly conflict-free.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- tenancy

create table households (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null check (length(trim(name)) > 0),
  base_currency text      not null default 'USD' check (base_currency ~ '^[A-Z]{3}$'),
  created_at  timestamptz not null default now()
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
-- `household_members` would recurse. Marked STABLE and given a fixed
-- search_path so it cannot be hijacked by a caller-controlled schema.
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

-- ---------------------------------------------------------------- accounts

-- The five fundamental account kinds. Sign conventions follow standard
-- accounting: asset and expense balances increase with positive postings;
-- liability, equity and income increase with negative ones.
create type account_kind as enum ('asset', 'liability', 'equity', 'income', 'expense');

create table accounts (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  kind         account_kind not null,
  -- Free-form refinement of `kind`: checking, savings, brokerage, mortgage,
  -- 401k, credit_card. Kept as text rather than an enum so adding an account
  -- type is not a migration.
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

-- ------------------------------------------------------------ transactions

create type transaction_status as enum ('pending', 'cleared', 'reconciled');

create table transactions (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  -- The date the money moved, in the household's local reckoning. A plain DATE
  -- rather than a timestamp: a transaction belongs to a calendar day, and
  -- timezone-shifting one across a month or tax-year boundary is a real bug.
  occurred_on  date not null,
  payee        text,
  memo         text,
  status       transaction_status not null default 'cleared',
  -- How this record came to exist: manual, import, rule, reversal.
  source       text not null default 'manual',
  -- When this entry reverses another, the entry it reverses. Corrections are
  -- new rows, so the original stays readable.
  reverses_id  uuid references transactions(id),
  created_at   timestamptz not null default now()
);

create index transactions_household_date_idx
  on transactions(household_id, occurred_on desc);

create table postings (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references households(id) on delete cascade,
  transaction_id uuid not null references transactions(id) on delete cascade,
  account_id     uuid not null references accounts(id),
  -- NUMERIC(19,4), never a float. Matches MONEY_SCALE in @finance/money, so a
  -- value round-trips through Money.toNumericString() without loss.
  amount         numeric(19, 4) not null,
  currency       text not null check (currency ~ '^[A-Z]{3}$'),
  created_at     timestamptz not null default now()
);

create index postings_transaction_idx on postings(transaction_id);
create index postings_account_idx on postings(account_id);
create index postings_household_idx on postings(household_id);

-- ------------------------------------------------- the balance invariant

-- Every transaction's postings must sum to exactly zero. This is the one rule
-- that makes the ledger a ledger.
--
-- It cannot be a CHECK constraint, which sees a single row. A CONSTRAINT
-- TRIGGER that is DEFERRABLE INITIALLY DEFERRED runs at COMMIT instead, so a
-- client can insert the debit and the credit as separate statements and still
-- be held to the rule.
create function app_assert_transaction_balanced() returns trigger
  language plpgsql
as $$
declare
  target uuid := coalesce(new.transaction_id, old.transaction_id);
  imbalance numeric(19, 4);
  currencies int;
begin
  -- A transaction whose postings were all deleted is vacuously balanced.
  if not exists (select 1 from postings where transaction_id = target) then
    return null;
  end if;

  select count(distinct currency) into currencies
  from postings where transaction_id = target;

  if currencies > 1 then
    raise exception
      'Transaction % mixes % currencies. Record a conversion through an explicit exchange account instead.',
      target, currencies
      using errcode = 'check_violation';
  end if;

  select sum(amount) into imbalance
  from postings where transaction_id = target;

  if imbalance <> 0 then
    raise exception
      'Transaction % is out of balance by %. Postings must sum to zero.',
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

-- ------------------------------------------------------------- append-only

-- Refuse UPDATE and DELETE on the ledger tables. Corrections are reversing
-- entries. This is enforced in the database rather than by convention, because
-- the whole audit story depends on it and a future client bug must not be able
-- to rewrite history.
--
-- The one exception is a deliberate purge — deleting a household for account
-- closure or an erasure request — which would otherwise be impossible, since
-- the ON DELETE CASCADE from `households` reaches these rows.
--
-- A purge needs two things at once: the `app.allow_purge` setting, and a role
-- that is not one of the application's own. Any role may set a custom GUC, so
-- the setting alone would be no protection at all — a compromised client could
-- simply set it and start deleting history.
create function app_purge_allowed() returns boolean
  language plpgsql
  stable
as $$
begin
  if coalesce(current_setting('app.allow_purge', true), 'off') <> 'on' then
    return false;
  end if;
  -- The client-facing roles can set the flag, but must never pass this check.
  return current_user not in ('anon', 'authenticated');
end
$$;

create function app_reject_mutation() returns trigger
  language plpgsql
as $$
begin
  if app_purge_allowed() then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  raise exception
    '% on % is not allowed: the ledger is append-only. Record a reversing entry instead.',
    tg_op, tg_table_name
    using errcode = 'restrict_violation';
end
$$;

create trigger transactions_append_only
  before update or delete on transactions
  for each row execute function app_reject_mutation();

-- DELETE is blocked here too. Without it, deleting every posting of a
-- transaction would leave the balance trigger vacuously satisfied and quietly
-- erase the entry.
create trigger postings_append_only
  before update or delete on postings
  for each row execute function app_reject_mutation();

-- ------------------------------------------------------------------- RLS

alter table households        enable row level security;
alter table household_members enable row level security;
alter table accounts          enable row level security;
alter table transactions      enable row level security;
alter table postings          enable row level security;

create policy households_select on households
  for select using (app_is_household_member(id));

create policy household_members_select on household_members
  for select using (app_is_household_member(household_id));

create policy accounts_all on accounts
  for all using (app_is_household_member(household_id))
  with check (app_is_household_member(household_id));

create policy transactions_all on transactions
  for all using (app_is_household_member(household_id))
  with check (app_is_household_member(household_id));

create policy postings_all on postings
  for all using (app_is_household_member(household_id))
  with check (app_is_household_member(household_id));

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete
  on households, household_members, accounts, transactions, postings
  to authenticated;
grant execute on function app_is_household_member(uuid) to authenticated;
