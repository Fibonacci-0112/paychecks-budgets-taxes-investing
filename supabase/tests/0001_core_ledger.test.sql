-- Tests for the core ledger schema.
--
-- These run against a real Postgres with the real policies and triggers. RLS
-- is bypassed by a table's owner, so every assertion below deliberately runs
-- as the `authenticated` role with a JWT subject set, exactly as PostgREST
-- would present a signed-in user.

\set ON_ERROR_STOP on
-- Assertions report through NOTICE; suppress the result-set chrome so the CI
-- log shows the checks and nothing else.
\pset tuples_only on
\pset format unaligned

create or replace function test_assert(condition boolean, description text)
  returns void language plpgsql as $$
begin
  if condition then
    raise notice '  ok   %', description;
  else
    raise exception 'FAILED: %', description using errcode = 'assert_failure';
  end if;
end
$$;

-- Asserts that `statement` fails. Runs it in a subtransaction so the rollback
-- leaves no trace.
create or replace function test_assert_rejects(statement text, description text)
  returns void language plpgsql as $$
declare
  rejected boolean := false;
begin
  begin
    execute statement;
    -- Force deferred constraint triggers to fire now rather than at COMMIT,
    -- which is the only way to observe them from inside a single script.
    set constraints all immediate;
  exception
    when others then rejected := true;
  end;
  perform test_assert(rejected, description);
end
$$;

-- ------------------------------------------------------------------- seed

insert into households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alice household'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Bob household');

insert into household_members (household_id, user_id, role) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner');

insert into accounts (id, household_id, kind, subtype, name) values
  ('a1111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'asset', 'checking', 'Alice Checking'),
  ('a2222222-2222-2222-2222-222222222222',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'expense', 'groceries', 'Groceries'),
  ('a3333333-3333-3333-3333-333333333333',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'asset', 'savings', 'Alice Savings'),
  ('a4444444-4444-4444-4444-444444444444',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'income', 'salary', 'Salary'),
  ('b1111111-1111-1111-1111-111111111111',
   'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'asset', 'checking', 'Bob Checking');

-- ------------------------------------------------- tenant isolation (RLS)

set role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111"}', false);

do $$ begin
  perform test_assert(
    (select count(*) from accounts) = 4,
    'Alice sees exactly her own four accounts');

  perform test_assert(
    (select count(*) from accounts
      where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') = 0,
    'Alice cannot read Bob''s accounts');

  perform test_assert(
    (select count(*) from households) = 1,
    'Alice sees only her own household');
end $$;

select test_assert_rejects($$
  insert into accounts (household_id, kind, subtype, name)
  values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'asset', 'checking', 'Injected')
$$, 'Alice cannot write into Bob''s household');

reset role;
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-2222-2222-222222222222"}', false);
set role authenticated;

do $$ begin
  perform test_assert(
    (select count(*) from accounts) = 1,
    'Bob sees exactly his own one account');
end $$;

-- --------------------------------------------------- the balance invariant

reset role;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111"}', false);
set role authenticated;

-- A balanced entry: $85.50 leaves checking and lands in groceries.
--
-- The two sides go in as separate statements on purpose. Mid-transaction the
-- entry is unbalanced, and the constraint being DEFERRABLE INITIALLY DEFERRED
-- is what lets a client write a debit and a credit as two operations — exactly
-- how the sync layer replays a queued offline write.
begin;

insert into transactions (id, household_id, occurred_on, payee, posted_at)
values ('c1111111-1111-1111-1111-111111111111',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', date '2026-03-01', 'Market', now());

insert into postings (household_id, transaction_id, account_id, amount_units, currency)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'c1111111-1111-1111-1111-111111111111',
        'a2222222-2222-2222-2222-222222222222', 855000, 'USD');

do $$ begin
  perform test_assert(
    (select sum(amount_units) from postings
      where transaction_id = 'c1111111-1111-1111-1111-111111111111') <> 0,
    'A half-written entry is tolerated mid-transaction, as deferral intends');
end $$;

insert into postings (household_id, transaction_id, account_id, amount_units, currency)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'c1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-111111111111', -855000, 'USD');

commit;

do $$ begin
  perform test_assert(
    (select sum(amount_units) from postings
      where transaction_id = 'c1111111-1111-1111-1111-111111111111') = 0,
    'A balanced transaction is accepted and sums to zero');

  perform test_assert(
    (select amount_units from postings
      where transaction_id = 'c1111111-1111-1111-1111-111111111111'
        and account_id = 'a2222222-2222-2222-2222-222222222222') = 855000,
    'Amounts are stored as exact scaled integer units, not NUMERIC');

  perform test_assert(
    (select amount from postings_readable
      where transaction_id = 'c1111111-1111-1111-1111-111111111111'
        and account_id = 'a2222222-2222-2222-2222-222222222222') = 85.50,
    'The readable view projects scaled units back to decimal for humans');
end $$;

select test_assert_rejects($$
  insert into transactions (id, household_id, occurred_on, posted_at)
  values ('c2222222-2222-2222-2222-222222222222',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', date '2026-03-02', now());
  insert into postings (household_id, transaction_id, account_id, amount_units, currency)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'c2222222-2222-2222-2222-222222222222',
          'a1111111-1111-1111-1111-111111111111', -100000, 'USD')
$$, 'A one-sided posted transaction is rejected at constraint check time');

select test_assert_rejects($$
  insert into transactions (id, household_id, occurred_on, posted_at)
  values ('c3333333-3333-3333-3333-333333333333',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', date '2026-03-03', now());
  insert into postings (household_id, transaction_id, account_id, amount_units, currency) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'c3333333-3333-3333-3333-333333333333',
     'a2222222-2222-2222-2222-222222222222',  100000, 'USD'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'c3333333-3333-3333-3333-333333333333',
     'a1111111-1111-1111-1111-111111111111', -100000, 'EUR')
$$, 'A transaction mixing currencies is rejected');

select test_assert_rejects($$
  insert into transactions (id, household_id, occurred_on, posted_at)
  values ('c4444444-4444-4444-4444-444444444444',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', date '2026-03-04', now());
  insert into postings (household_id, transaction_id, account_id, amount_units, currency)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'c4444444-4444-4444-4444-444444444444',
          'b1111111-1111-1111-1111-111111111111', 100000, 'USD')
$$, 'A posting against another household''s account is rejected');

-- ------------------------------------------------------ draft lifecycle

-- A draft is an imported row under review: known from one side only, freely
-- editable, and excluded from balances. Requiring it to balance would make the
-- review queue impossible.
insert into transactions (id, household_id, occurred_on, payee, posted_at)
values ('e1111111-1111-1111-1111-111111111111',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', date '2026-03-06', 'Unknown', null);

insert into postings (household_id, transaction_id, account_id, amount_units, currency)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'e1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-111111111111', -42000, 'USD');

do $$ begin
  perform test_assert(
    (select count(*) from transactions where id = 'e1111111-1111-1111-1111-111111111111') = 1,
    'A one-sided draft is allowed to exist while under review');
end $$;

update transactions set occurred_on = date '2026-03-07'
 where id = 'e1111111-1111-1111-1111-111111111111';

update postings set amount_units = -43000
 where transaction_id = 'e1111111-1111-1111-1111-111111111111';

do $$ begin
  perform test_assert(
    (select occurred_on from transactions
      where id = 'e1111111-1111-1111-1111-111111111111') = date '2026-03-07',
    'A draft''s financial facts are freely editable');
end $$;

select test_assert_rejects($$
  update transactions set posted_at = now()
   where id = 'e1111111-1111-1111-1111-111111111111'
$$, 'A draft cannot be posted while it is still out of balance');

-- Balance it, then post.
insert into postings (household_id, transaction_id, account_id, amount_units, currency)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'e1111111-1111-1111-1111-111111111111',
        'a2222222-2222-2222-2222-222222222222', 43000, 'USD');

update transactions set posted_at = now()
 where id = 'e1111111-1111-1111-1111-111111111111';

do $$ begin
  perform test_assert(
    (select posted_at is not null from transactions
      where id = 'e1111111-1111-1111-1111-111111111111'),
    'A balanced draft can be posted');
end $$;

-- ----------------------------------------- posted immutability, selectively

-- The point of column-level immutability: correcting an amount is an
-- accounting event, correcting a spelling is not.
update transactions set payee = 'Farmers Market', memo = 'weekly shop'
 where id = 'c1111111-1111-1111-1111-111111111111';

update transactions set status = 'cleared'
 where id = 'c1111111-1111-1111-1111-111111111111';

do $$ begin
  perform test_assert(
    (select payee from transactions
      where id = 'c1111111-1111-1111-1111-111111111111') = 'Farmers Market',
    'A payee typo on a posted entry is an ordinary edit, not a reversal');
end $$;

select test_assert_rejects($$
  update transactions set occurred_on = date '2026-04-01'
   where id = 'c1111111-1111-1111-1111-111111111111'
$$, 'The date of a posted entry cannot be changed');

select test_assert_rejects($$
  update transactions set posted_at = null
   where id = 'c1111111-1111-1111-1111-111111111111'
$$, 'A posted entry cannot be un-posted');

select test_assert_rejects($$
  delete from transactions
   where id = 'c1111111-1111-1111-1111-111111111111'
$$, 'DELETE on a posted transaction is refused');

select test_assert_rejects($$
  update postings set amount_units = 999999
   where transaction_id = 'c1111111-1111-1111-1111-111111111111'
$$, 'The amount of a posted entry cannot be changed');

select test_assert_rejects($$
  delete from postings
   where transaction_id = 'c1111111-1111-1111-1111-111111111111'
$$, 'DELETE on a posted posting is refused, so an entry cannot be quietly erased');

-- ----------------------------------------------- reversal and idempotency

begin;

insert into transactions (id, household_id, occurred_on, payee, kind, reverses_id, posted_at)
values ('d1111111-1111-1111-1111-111111111111',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', date '2026-03-05', 'Farmers Market',
        'reversal', 'c1111111-1111-1111-1111-111111111111', now());

insert into postings (household_id, transaction_id, account_id, amount_units, currency) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'd1111111-1111-1111-1111-111111111111',
   'a2222222-2222-2222-2222-222222222222', -855000, 'USD'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'd1111111-1111-1111-1111-111111111111',
   'a1111111-1111-1111-1111-111111111111',  855000, 'USD');

commit;

do $$ begin
  perform test_assert(
    (select count(*) from transactions
      where reverses_id = 'c1111111-1111-1111-1111-111111111111') = 1,
    'A reversing entry corrects without rewriting history');
end $$;

-- Two offline devices can each decide to reverse the same entry. Both
-- reversals balance perfectly, so nothing but this constraint would catch the
-- duplication — the ledger would be internally consistent and financially
-- wrong by $85.50.
select test_assert_rejects($$
  insert into transactions (id, household_id, occurred_on, kind, reverses_id, posted_at)
  values ('d2222222-2222-2222-2222-222222222222',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', date '2026-03-05',
          'reversal', 'c1111111-1111-1111-1111-111111111111', now())
$$, 'A transaction cannot be reversed twice, so concurrent devices converge');

-- A replayed upload carries the same client-generated operation id and must be
-- a no-op rather than a second financial event.
insert into operations (id, household_id, kind)
values ('0a000000-0000-0000-0000-000000000001',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'post_transaction');

select test_assert_rejects($$
  insert into operations (id, household_id, kind)
  values ('0a000000-0000-0000-0000-000000000001',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'post_transaction')
$$, 'A replayed operation id is refused, making repeated upload idempotent');

-- ----------------------------------- one event, many observations (no double count)

-- The paycheck as recorded by the user: $3,000 gross salary into checking.
begin;
insert into transactions (id, household_id, occurred_on, payee, kind, posted_at)
values ('f1111111-1111-1111-1111-111111111111',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', date '2026-03-15', 'ACME Payroll',
        'paycheck', now());

insert into postings (household_id, transaction_id, account_id, amount_units, currency) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'f1111111-1111-1111-1111-111111111111',
   'a1111111-1111-1111-1111-111111111111',  30000000, 'USD'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'f1111111-1111-1111-1111-111111111111',
   'a4444444-4444-4444-4444-444444444444', -30000000, 'USD');

insert into observations
  (household_id, transaction_id, account_id, source, occurred_on,
   amount_units, currency, description, matched_at)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'f1111111-1111-1111-1111-111111111111',
   'a1111111-1111-1111-1111-111111111111', 'manual', date '2026-03-15',
   30000000, 'USD', 'Recorded paycheck', now());
commit;

-- The bank import of the very same deposit. It attaches to the existing event
-- and creates NO new postings. Doing otherwise would count the income and the
-- cash twice.
insert into observations
  (household_id, transaction_id, account_id, source, source_id, occurred_on,
   amount_units, currency, description, matched_at)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'f1111111-1111-1111-1111-111111111111',
   'a1111111-1111-1111-1111-111111111111', 'ofx', 'FITID-88213', date '2026-03-15',
   30000000, 'USD', 'ACME PAYROLL DIRECT DEP', now());

do $$ begin
  perform test_assert(
    (select count(*) from observations
      where transaction_id = 'f1111111-1111-1111-1111-111111111111') = 2,
    'A paycheck and its bank deposit are two observations of one event');

  perform test_assert(
    (select count(*) from postings
      where transaction_id = 'f1111111-1111-1111-1111-111111111111') = 2,
    'Matching the deposit creates no additional postings');

  perform test_assert(
    (select count(*) from postings
      where transaction_id = 'f1111111-1111-1111-1111-111111111111'
        and account_id = 'a1111111-1111-1111-1111-111111111111') = 1,
    'Checking receives exactly one posting from the paycheck event');

  perform test_assert(
    (select sum(amount_units) from postings
      where transaction_id = 'f1111111-1111-1111-1111-111111111111'
        and account_id = 'a1111111-1111-1111-1111-111111111111') = 30000000,
    'Cash from the paycheck is counted once, not twice');

  perform test_assert(
    (select sum(amount_units) from postings
      where account_id = 'a4444444-4444-4444-4444-444444444444') = -30000000,
    'Income is counted once, not twice');
end $$;

-- Re-importing the same file must not create a second observation of the same
-- bank row. Keyed on the source's own identifier rather than date + amount +
-- description, which legitimate repeated purchases all share.
select test_assert_rejects($$
  insert into observations
    (household_id, transaction_id, account_id, source, source_id, occurred_on,
     amount_units, currency)
  values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'f1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-111111111111', 'ofx', 'FITID-88213', date '2026-03-15',
     30000000, 'USD')
$$, 'Re-importing the same bank row is refused, making import idempotent');

-- A transfer appears in BOTH accounts' exports. One event, two postings, two
-- observations — not two transactions netting to twice the money moved.
begin;
insert into transactions (id, household_id, occurred_on, payee, kind, posted_at)
values ('f2222222-2222-2222-2222-222222222222',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', date '2026-03-20', 'Transfer to savings',
        'transfer', now());

insert into postings (household_id, transaction_id, account_id, amount_units, currency) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'f2222222-2222-2222-2222-222222222222',
   'a1111111-1111-1111-1111-111111111111', -5000000, 'USD'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'f2222222-2222-2222-2222-222222222222',
   'a3333333-3333-3333-3333-333333333333',  5000000, 'USD');

insert into observations
  (household_id, transaction_id, account_id, source, source_id, occurred_on,
   amount_units, currency, matched_at)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'f2222222-2222-2222-2222-222222222222',
   'a1111111-1111-1111-1111-111111111111', 'ofx', 'FITID-CHK-991', date '2026-03-20',
   -5000000, 'USD', now()),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'f2222222-2222-2222-2222-222222222222',
   'a3333333-3333-3333-3333-333333333333', 'ofx', 'FITID-SAV-337', date '2026-03-20',
    5000000, 'USD', now());
commit;

do $$ begin
  perform test_assert(
    (select count(*) from transactions
      where kind = 'transfer'
        and household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') = 1,
    'Both sides of an imported transfer resolve to a single transaction');

  perform test_assert(
    (select sum(amount_units) from postings
      where transaction_id = 'f2222222-2222-2222-2222-222222222222') = 0,
    'The transfer nets to zero across the two accounts');

  perform test_assert(
    (select sum(amount_units) from postings p
       join accounts a on a.id = p.account_id
      where a.kind = 'asset'
        and p.transaction_id = 'f2222222-2222-2222-2222-222222222222') = 0,
    'A transfer moves money without changing total assets');
end $$;

-- ------------------------------------------------------ purge protection

-- The purge flag must not be enough on its own: an application role that sets
-- it must still be refused.
select set_config('app.allow_purge', 'on', false);

select test_assert_rejects($$
  delete from transactions
   where id = 'c1111111-1111-1111-1111-111111111111'
$$, 'The authenticated role cannot purge even with app.allow_purge set');

select set_config('app.allow_purge', 'off', false);
reset role;

-- A privileged role holding the same flag can, so account closure and erasure
-- requests remain possible.
select set_config('app.allow_purge', 'on', false);
delete from households where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

do $$ begin
  perform test_assert(
    (select count(*) from accounts
      where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') = 0,
    'A privileged purge cascades through to accounts');
end $$;

select set_config('app.allow_purge', 'off', false);

\echo 'All core ledger assertions passed.'
