-- Test-only shim so the migrations can run against a plain Postgres in CI.
--
-- Supabase provides the `auth` schema, `auth.uid()`, and the anon/authenticated
-- /service_role roles as part of the platform. None of that exists in a bare
-- postgres:16 container, so CI creates just enough of it to exercise the real
-- RLS policies. This file is NEVER applied to a Supabase project.

create schema if not exists auth;

-- Mirrors Supabase's own implementation: read the subject claim out of the
-- JWT that PostgREST puts into the session.
create or replace function auth.uid() returns uuid
  language sql stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

grant usage on schema auth to anon, authenticated, service_role;
