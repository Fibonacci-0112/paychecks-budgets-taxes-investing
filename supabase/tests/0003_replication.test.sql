-- Tests for PowerSync replication setup.
--
-- These exist to catch the silent failure mode. A table added later without
-- being published simply stops syncing, and a table without REPLICA IDENTITY
-- FULL syncs inserts and updates but not deletes — so a row removed on the
-- server stays on every device indefinitely. Neither raises an error anywhere.
-- Both are caught here instead.

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

do $$
declare
  missing text;
  count_unpublished int;
  count_partial int;
begin
  perform test_assert(
    exists (select 1 from pg_publication where pubname = 'powersync'),
    'The powersync publication exists');

  -- Every ordinary table in public must be published. Catches a new table
  -- whose migration forgot 0003, which would otherwise just never sync.
  select count(*), string_agg(c.relname, ', ' order by c.relname)
    into count_unpublished, missing
  from pg_class c
  where c.relkind = 'r'
    and c.relnamespace = 'public'::regnamespace
    and not exists (
      select 1 from pg_publication_tables p
      where p.pubname = 'powersync'
        and p.schemaname = 'public'
        and p.tablename = c.relname
    );

  if count_unpublished > 0 then
    raise exception
      'FAILED: % table(s) are not in the powersync publication: %. Add them to supabase/migrations/0003_powersync_replication.sql, or decide deliberately that they must not reach client devices.',
      count_unpublished, missing
      using errcode = 'assert_failure';
  end if;
  perform test_assert(true, 'Every public table is in the powersync publication');

  -- REPLICA IDENTITY FULL on all of them, so a DELETE carries the whole row
  -- and PowerSync can work out which client buckets it belonged to.
  select count(*), string_agg(c.relname, ', ' order by c.relname)
    into count_partial, missing
  from pg_class c
  where c.relkind = 'r'
    and c.relnamespace = 'public'::regnamespace
    and c.relreplident <> 'f';

  if count_partial > 0 then
    raise exception
      'FAILED: % table(s) lack REPLICA IDENTITY FULL: %. Deletes would not reach client devices; the rows would stay on every phone forever.',
      count_partial, missing
      using errcode = 'assert_failure';
  end if;
  perform test_assert(true, 'Every public table has REPLICA IDENTITY FULL');
end $$;

-- A publication takes tables, not views. `postings_readable` projects amounts
-- as NUMERIC, which is exactly the representation that must never cross the
-- sync boundary — PowerSync maps NUMERIC to SQLite TEXT, where SUM() silently
-- returns a float.
do $$ begin
  perform test_assert(
    not exists (
      select 1 from pg_publication_tables
      where pubname = 'powersync' and tablename = 'postings_readable'
    ),
    'The NUMERIC readable view is not replicated to clients');
end $$;

-- The sync config filters on household_id, so anything replicated must carry
-- one. A published table without it could not be scoped to a household at all.
do $$
declare
  missing text;
  offenders int;
begin
  select count(*), string_agg(p.tablename, ', ' order by p.tablename)
    into offenders, missing
  from pg_publication_tables p
  where p.pubname = 'powersync'
    and p.schemaname = 'public'
    and p.tablename <> 'households'  -- its own id IS the household
    and not exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = p.tablename
        and c.column_name = 'household_id'
    );

  if offenders > 0 then
    raise exception
      'FAILED: % replicated table(s) have no household_id: %. Sync streams filter on it, so such a table cannot be scoped to a household and would sync to everyone.',
      offenders, missing
      using errcode = 'assert_failure';
  end if;
  perform test_assert(true,
    'Every replicated table can be scoped by household_id');
end $$;

\echo 'All replication assertions passed.'
