-- Replication setup for PowerSync.
--
-- Two things PowerSync needs from the database itself, both schema-level and
-- therefore migrations rather than one-off setup:
--
-- 1. REPLICA IDENTITY FULL on every replicated table. Postgres logical
--    replication otherwise emits only the primary key for a DELETE, and
--    PowerSync needs the whole row to know which client buckets the deleted
--    row belonged to. Without this, deletes do not reach devices: the row
--    stays on the client forever, and a household that stops being yours
--    keeps its data on your phone.
--
-- 2. A publication naming the tables to replicate.
--
-- The replication ROLE is deliberately not here — it carries a password, so it
-- lives in supabase/powersync/01_replication_role.sql.example and is run by
-- hand with a generated secret.
--
-- NOTE ON SECURITY BOUNDARY: that role is created WITH BYPASSRLS, because
-- PowerSync replicates whole tables and does its filtering in the sync config.
-- So the row-level security policies in 0001 protect the *upload* path only.
-- What each device *downloads* is governed entirely by powersync/sync-config.yaml.
-- They are two separate mechanisms and each needs its own tests; an RLS policy
-- alone will not stop one household's rows reaching another's device.

-- ------------------------------------------------------- replica identity

alter table households                   replica identity full;
alter table household_members            replica identity full;
alter table owners                       replica identity full;
alter table accounts                     replica identity full;
alter table operations                   replica identity full;
alter table transactions                 replica identity full;
alter table postings                     replica identity full;
alter table observations                 replica identity full;
alter table import_batches               replica identity full;
alter table statements                   replica identity full;
alter table reconciliations              replica identity full;
alter table reconciliation_entries       replica identity full;
alter table reconciliation_discrepancies replica identity full;

-- ------------------------------------------------------------ publication

-- Named explicitly rather than FOR ALL TABLES. A new table then has to be
-- added here deliberately, which is the moment to decide whether it should
-- reach client devices at all — an easy thing to get wrong silently with a
-- catch-all publication.
--
-- `postings_readable` is a view and is intentionally absent: publications take
-- tables, and the view exists only for humans running ad-hoc SQL. Its NUMERIC
-- projection is exactly what must not cross the sync boundary.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'powersync') then
    create publication powersync for table
      households,
      household_members,
      owners,
      accounts,
      operations,
      transactions,
      postings,
      observations,
      import_batches,
      statements,
      reconciliations,
      reconciliation_entries,
      reconciliation_discrepancies;
  end if;
end
$$;
