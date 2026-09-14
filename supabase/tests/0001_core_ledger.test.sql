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
-- leaves no trace, and reports the SQLSTATE when it unexpectedly succeeds.
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
  ('b1111111-1111-1111-1111-111111111111',
   'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'asset', 'checking', 'Bob Checking');

-- ------------------------------------------------- tenant isolation (RLS)

set role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111"}', false);

do $$ begin
  perform test_assert(
    (select count(*) from accounts) = 2,
    'Alice sees exactly her own two accounts');

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
-- how the sync layer will replay a queued offline write.
begin;

insert into transactions (id, household_id, occurred_on, payee)
values ('c1111111-1111-1111-1111-111111111111',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', date '2026-03-01', 'Market');

insert into postings (household_id, transaction_id, account_id, amount, currency)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'c1111111-1111-1111-1111-111111111111',
        'a2222222-2222-2222-2222-222222222222', 85.5000, 'USD');

do $$ begin
  perform test_assert(
    (select sum(amount) from postings
      where transaction_id = 'c1111111-1111-1111-1111-111111111111') <> 0,
    'A half-written entry is tolerated mid-transaction, as deferral intends');
end $$;

insert into postings (household_id, transaction_id, account_id, amount, currency)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'c1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-111111111111', -85.5000, 'USD');

commit;

do $$ begin
  perform test_assert(
    (select sum(amount) from postings
      where transaction_id = 'c1111111-1111-1111-1111-111111111111') = 0,
    'A balanced transaction is accepted and sums to zero');

  perform test_assert(
    (select amount from postings
      where transaction_id = 'c1111111-1111-1111-1111-111111111111'
        and account_id = 'a2222222-2222-2222-2222-222222222222') = 85.5000,
    'NUMERIC(19,4) stores the amount at full scale');
end $$;

select test_assert_rejects($$
  insert into transactions (id, household_id, occurred_on)
  values ('c2222222-2222-2222-2222-222222222222',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', date '2026-03-02');
  insert into postings (household_id, transaction_id, account_id, amount, currency)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'c2222222-2222-2222-2222-222222222222',
          'a1111111-1111-1111-1111-111111111111', -10.0000, 'USD')
$$, 'A one-sided transaction is rejected at constraint check time');

select test_assert_rejects($$
  insert into transactions (id, household_id, occurred_on)
  values ('c3333333-3333-3333-3333-333333333333',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', date '2026-03-03');
  insert into postings (household_id, transaction_id, account_id, amount, currency) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'c3333333-3333-3333-3333-333333333333',
     'a2222222-2222-2222-2222-222222222222',  10.0000, 'USD'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'c3333333-3333-3333-3333-333333333333',
     'a1111111-1111-1111-1111-111111111111', -10.0000, 'EUR')
$$, 'A transaction mixing currencies is rejected');

select test_assert_rejects($$
  insert into transactions (id, household_id, occurred_on)
  values ('c4444444-4444-4444-4444-444444444444',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', date '2026-03-04');
  insert into postings (household_id, transaction_id, account_id, amount, currency)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'c4444444-4444-4444-4444-444444444444',
          'b1111111-1111-1111-1111-111111111111', 10.0000, 'USD')
$$, 'A posting against another household''s account is rejected');

-- ----------------------------------------------------------- append-only

select test_assert_rejects($$
  update transactions set payee = 'Rewritten'
   where id = 'c1111111-1111-1111-1111-111111111111'
$$, 'UPDATE on transactions is refused: the ledger is append-only');

select test_assert_rejects($$
  delete from transactions
   where id = 'c1111111-1111-1111-1111-111111111111'
$$, 'DELETE on transactions is refused');

select test_assert_rejects($$
  delete from postings
   where transaction_id = 'c1111111-1111-1111-1111-111111111111'
$$, 'DELETE on postings is refused, so an entry cannot be quietly erased');

-- A correction is a new, reversing entry rather than an edit.
begin;

insert into transactions (id, household_id, occurred_on, payee, source, reverses_id)
values ('d1111111-1111-1111-1111-111111111111',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', date '2026-03-05', 'Market',
        'reversal', 'c1111111-1111-1111-1111-111111111111');

insert into postings (household_id, transaction_id, account_id, amount, currency) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'd1111111-1111-1111-1111-111111111111',
   'a2222222-2222-2222-2222-222222222222', -85.5000, 'USD'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'd1111111-1111-1111-1111-111111111111',
   'a1111111-1111-1111-1111-111111111111',  85.5000, 'USD');

commit;

do $$ begin
  perform test_assert(
    (select sum(amount) from postings
      where account_id = 'a1111111-1111-1111-1111-111111111111') = 0,
    'A reversing entry restores the balance without rewriting history');

  perform test_assert(
    (select count(*) from transactions
      where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') = 2,
    'Both the original entry and its reversal remain readable');
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
