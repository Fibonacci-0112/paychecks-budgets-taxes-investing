-- Tests for import batches and statement reconciliation.
--
-- Reconciliation is what proves the ledger matches the bank. These assertions
-- cover the parts that make it trustworthy: the discrepancy is recorded rather
-- than recomputed, no reconciliation completes while a difference is
-- unexplained, and a completed one cannot be quietly edited afterwards.

\set ON_ERROR_STOP on
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

create or replace function test_assert_rejects(statement text, description text)
  returns void language plpgsql as $$
declare
  rejected boolean := false;
begin
  begin
    execute statement;
    set constraints all immediate;
  exception
    when others then rejected := true;
  end;
  perform test_assert(rejected, description);
end
$$;

-- ------------------------------------------------------------------- seed

insert into households (id, name) values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Reconciliation household');

insert into household_members (household_id, user_id, role) values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc',
   '33333333-3333-3333-3333-333333333333', 'owner');

insert into accounts (id, household_id, kind, subtype, name) values
  ('c1111111-aaaa-1111-1111-111111111111',
   'cccccccc-cccc-cccc-cccc-cccccccccccc', 'asset', 'checking', 'Checking'),
  ('c2222222-aaaa-2222-2222-222222222222',
   'cccccccc-cccc-cccc-cccc-cccccccccccc', 'expense', 'general', 'General');

set role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"33333333-3333-3333-3333-333333333333"}', false);

-- Two posted entries: $500.00 in, $120.25 out. Book balance $379.75.
begin;
insert into transactions (id, household_id, occurred_on, payee, posted_at) values
  ('d1111111-aaaa-1111-1111-111111111111',
   'cccccccc-cccc-cccc-cccc-cccccccccccc', date '2026-04-02', 'Opening', now()),
  ('d2222222-aaaa-2222-2222-222222222222',
   'cccccccc-cccc-cccc-cccc-cccccccccccc', date '2026-04-10', 'Store', now());

insert into postings (id, household_id, transaction_id, account_id, amount_units, currency) values
  ('e1111111-aaaa-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
   'd1111111-aaaa-1111-1111-111111111111', 'c1111111-aaaa-1111-1111-111111111111',  5000000, 'USD'),
  ('e1222222-aaaa-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
   'd1111111-aaaa-1111-1111-111111111111', 'c2222222-aaaa-2222-2222-222222222222', -5000000, 'USD'),
  ('e2111111-aaaa-2222-2222-222222222222', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
   'd2222222-aaaa-2222-2222-222222222222', 'c1111111-aaaa-1111-1111-111111111111', -1202500, 'USD'),
  ('e2222222-aaaa-2222-2222-222222222222', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
   'd2222222-aaaa-2222-2222-222222222222', 'c2222222-aaaa-2222-2222-222222222222',  1202500, 'USD');
commit;

do $$ begin
  perform test_assert(
    (select sum(amount_units) from postings
      where account_id = 'c1111111-aaaa-1111-1111-111111111111') = 3797500,
    'Book balance is $379.75, summed exactly as integers');
end $$;

-- ---------------------------------------------------------- import batch

insert into operations (id, household_id, kind)
values ('0b000000-0000-0000-0000-000000000001',
        'cccccccc-cccc-cccc-cccc-cccccccccccc', 'import_batch');

insert into import_batches (id, household_id, account_id, operation_id, filename, format, row_count, matched_count)
values ('7a000000-0000-0000-0000-000000000001',
        'cccccccc-cccc-cccc-cccc-cccccccccccc', 'c1111111-aaaa-1111-1111-111111111111',
        '0b000000-0000-0000-0000-000000000001', 'april.ofx', 'ofx', 2, 2);

do $$ begin
  perform test_assert(
    (select matched_count from import_batches
      where id = '7a000000-0000-0000-0000-000000000001') = 2,
    'An import batch records how many rows matched an existing event');
end $$;

-- ------------------------------------------------------------- statement

-- The bank says $369.75 — ten dollars less than the books.
insert into statements
  (id, household_id, account_id, period_start, period_end, statement_date,
   closing_balance_units, currency)
values
  ('8a000000-0000-0000-0000-000000000001',
   'cccccccc-cccc-cccc-cccc-cccccccccccc', 'c1111111-aaaa-1111-1111-111111111111',
   date '2026-04-01', date '2026-04-30', date '2026-04-30', 3697500, 'USD');

select test_assert_rejects($$
  insert into statements
    (household_id, account_id, period_start, period_end, statement_date,
     closing_balance_units, currency)
  values
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c1111111-aaaa-1111-1111-111111111111',
     date '2026-04-01', date '2026-04-30', date '2026-04-30', 3697500, 'USD')
$$, 'A second statement for the same account and period is refused');

-- --------------------------------------------------------- reconciliation

insert into reconciliations
  (id, household_id, statement_id, book_balance_units, statement_balance_units,
   discrepancy_units)
values
  ('9a000000-0000-0000-0000-000000000001',
   'cccccccc-cccc-cccc-cccc-cccccccccccc', '8a000000-0000-0000-0000-000000000001',
   3797500, 3697500, 100000);

insert into reconciliation_entries (reconciliation_id, posting_id, household_id) values
  ('9a000000-0000-0000-0000-000000000001', 'e1111111-aaaa-1111-1111-111111111111',
   'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  ('9a000000-0000-0000-0000-000000000001', 'e2111111-aaaa-2222-2222-222222222222',
   'cccccccc-cccc-cccc-cccc-cccccccccccc');

do $$ begin
  perform test_assert(
    (select discrepancy_units from reconciliations
      where id = '9a000000-0000-0000-0000-000000000001') = 100000,
    'The $10.00 discrepancy is recorded, not left implicit');

  perform test_assert(
    (select count(*) from reconciliation_entries
      where reconciliation_id = '9a000000-0000-0000-0000-000000000001') = 2,
    'The reconciliation records which postings it cleared');
end $$;

select test_assert_rejects($$
  insert into reconciliations
    (household_id, statement_id, book_balance_units, statement_balance_units,
     discrepancy_units)
  values
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', '8a000000-0000-0000-0000-000000000001',
     3797500, 3697500, 100000)
$$, 'A second in-progress reconciliation for one statement is refused');

-- ------------------------------------------------------ discrepancy review

insert into reconciliation_discrepancies
  (id, household_id, reconciliation_id, kind, amount_units, currency)
values
  ('9b000000-0000-0000-0000-000000000001',
   'cccccccc-cccc-cccc-cccc-cccccccccccc', '9a000000-0000-0000-0000-000000000001',
   'missing_in_ledger', 100000, 'USD');

-- A difference nobody has explained must block completion. Silently absorbing
-- it into the next period is how a ledger drifts away from reality.
select test_assert_rejects($$
  update reconciliations set status = 'completed'
   where id = '9a000000-0000-0000-0000-000000000001'
$$, 'A reconciliation cannot complete while a discrepancy is unexplained');

update reconciliation_discrepancies
   set resolution = 'timing_difference',
       note = 'Cheque presented in May'
 where id = '9b000000-0000-0000-0000-000000000001';

update reconciliations set status = 'completed'
 where id = '9a000000-0000-0000-0000-000000000001';

do $$ begin
  perform test_assert(
    (select locked from reconciliations
      where id = '9a000000-0000-0000-0000-000000000001'),
    'Completing a reconciliation locks it');

  perform test_assert(
    (select completed_at is not null from reconciliations
      where id = '9a000000-0000-0000-0000-000000000001'),
    'Completion stamps the time it was accepted');
end $$;

select test_assert_rejects($$
  update reconciliations set notes = 'after the fact'
   where id = '9a000000-0000-0000-0000-000000000001'
$$, 'A locked reconciliation cannot be edited; corrections need a new one');

-- ------------------------------------------------------ tenant isolation

reset role;
insert into households (id, name) values
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Outsider household');
insert into household_members (household_id, user_id, role) values
  ('dddddddd-dddd-dddd-dddd-dddddddddddd',
   '44444444-4444-4444-4444-444444444444', 'owner');

select set_config('request.jwt.claims',
  '{"sub":"44444444-4444-4444-4444-444444444444"}', false);
set role authenticated;

do $$ begin
  perform test_assert(
    (select count(*) from statements) = 0,
    'An outsider sees no statements');
  perform test_assert(
    (select count(*) from reconciliations) = 0,
    'An outsider sees no reconciliations');
  perform test_assert(
    (select count(*) from reconciliation_discrepancies) = 0,
    'An outsider sees no discrepancies');
  perform test_assert(
    (select count(*) from import_batches) = 0,
    'An outsider sees no import batches');
end $$;

reset role;

\echo 'All reconciliation assertions passed.'
