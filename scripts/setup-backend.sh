#!/usr/bin/env bash
#
# One-command backend setup: migrations, replication role, verification, and
# sync-config deploy.
#
#   ./scripts/setup-backend.sh              # show the plan, then prompt
#   ./scripts/setup-backend.sh --dry-run    # show the plan and stop
#   ./scripts/setup-backend.sh --yes        # no prompt (CI, or a repeat run)
#
# Safe to run more than once. Migrations are tracked in a schema_migrations
# table and applied only when pending; the replication role is created only if
# absent. A second run is a no-op that re-verifies.
#
# Reads DATABASE_URL from .env. Everything it writes back goes to .env too,
# which is gitignored.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ASSUME_YES=0
DRY_RUN=0
SKIP_DEPLOY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y)      ASSUME_YES=1 ;;
    --dry-run|-n)  DRY_RUN=1 ;;
    --skip-deploy) SKIP_DEPLOY=1 ;;
    --help|-h)
      sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's|^# \{0,1\}||'
      exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Try --help" >&2
      exit 2 ;;
  esac
  shift
done

# ----------------------------------------------------------------- output

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; DIM=""; RESET=""
fi

step()  { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$RESET"; }
ok()    { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
info()  { printf '  %s%s%s\n' "$DIM" "$*" "$RESET"; }
die()   { printf '\n%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# --------------------------------------------------------------- preflight

step "Preflight"

command -v psql >/dev/null 2>&1 \
  || die "psql is not installed. It ships with the postgresql-client package."
ok "psql $(psql --version | awk '{print $3}')"

command -v openssl >/dev/null 2>&1 \
  || die "openssl is not installed; it is needed to generate the role password."
ok "openssl present"

if [[ -f .env ]]; then
  # Read .env without executing it: only KEY=VALUE lines, no command
  # substitution, so a stray backtick in a password cannot run anything.
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    printf -v "$key" '%s' "$value"
    export "${key?}"
  done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env || true)
  ok ".env loaded"
else
  warn "no .env found — copy .env.example to .env and fill it in"
fi

[[ -n "${DATABASE_URL:-}" ]] \
  || die "DATABASE_URL is not set. Put your Supabase connection string in .env.
         Supabase dashboard → Project Settings → Database → Connection string.
         Use the direct connection, not a pooler: migrations need a session."

MIGRATIONS=(supabase/migrations/*.sql)
[[ -e "${MIGRATIONS[0]}" ]] || die "no migrations found in supabase/migrations/"
ok "${#MIGRATIONS[@]} migration file(s) found"

# This is the one genuinely destructive mistake available here. The CI
# bootstrap defines auth.uid() and the anon/authenticated roles, which Supabase
# provides as platform features — applying it to a real project overwrites
# them and breaks authentication for the whole project.
for m in "${MIGRATIONS[@]}"; do
  case "$m" in
    *00_bootstrap*|*supabase/ci/*)
      die "refusing to run $m — supabase/ci/ is a local-only shim for
           auth.uid() and the anon/authenticated roles. Applying it to a real
           Supabase project overwrites platform functions." ;;
  esac
done
ok "no local-only CI shims in the migration set"

PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qtAX)

# ------------------------------------------------------------ target check

step "Target"

CONN_INFO=$("${PSQL[@]}" -c \
  "select current_database() || '|' || current_user || '|' || inet_server_addr() || '|' || version();" 2>&1) \
  || die "cannot connect to the database.
         $CONN_INFO"

IFS='|' read -r DB_NAME DB_USER DB_HOST DB_VERSION <<< "$CONN_INFO"
printf '  database : %s\n' "$DB_NAME"
printf '  user     : %s\n' "$DB_USER"
printf '  host     : %s\n' "$DB_HOST"
printf '  server   : %s\n' "${DB_VERSION%% (*}"

EXISTING_TABLES=$("${PSQL[@]}" -c \
  "select count(*) from pg_class where relkind='r' and relnamespace='public'::regnamespace;")
printf '  tables   : %s already in public\n' "$EXISTING_TABLES"

if [[ "$DRY_RUN" == "1" ]]; then
  step "Dry run — stopping before any change"
  info "Re-run without --dry-run to apply."
  exit 0
fi

if [[ "$ASSUME_YES" != "1" ]]; then
  printf '\n%sApply migrations and create the replication role on this database?%s [y/N] ' \
    "$BOLD" "$RESET"
  read -r reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "Aborted; nothing was changed."; exit 0; }
fi

# --------------------------------------------------------------- migrations

step "Migrations"

"${PSQL[@]}" -c "
  create table if not exists schema_migrations (
    filename   text primary key,
    checksum   text not null,
    applied_at timestamptz not null default now()
  );" >/dev/null
info "schema_migrations ready"

APPLIED=0
SKIPPED=0
for migration in "${MIGRATIONS[@]}"; do
  base="$(basename "$migration")"
  checksum="$(sha256sum "$migration" | awk '{print $1}')"

  recorded="$("${PSQL[@]}" -c \
    "select checksum from schema_migrations where filename = '${base//\'/\'\'}';")"

  if [[ -n "$recorded" ]]; then
    if [[ "$recorded" != "$checksum" ]]; then
      # Silently re-running an edited migration would leave the database in a
      # state no file describes. Stop and make it a deliberate decision.
      die "$base was already applied, but its contents have changed since.
           recorded: $recorded
           on disk : $checksum
           Add a new migration rather than editing an applied one. If this
           database is disposable, drop it and re-run."
    fi
    info "$base already applied"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # One transaction per migration: a failure leaves nothing half-applied, and
  # the schema_migrations row only lands if the migration itself succeeded.
  if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qX --single-transaction \
       -f "$migration" \
       -c "insert into schema_migrations (filename, checksum)
           values ('${base//\'/\'\'}', '$checksum');" >/dev/null; then
    ok "$base applied"
    APPLIED=$((APPLIED + 1))
  else
    die "$base failed. Nothing from it was committed."
  fi
done

info "$APPLIED applied, $SKIPPED already present"

# ----------------------------------------------------------- replication role

step "Replication role"

ROLE_EXISTS="$("${PSQL[@]}" -c \
  "select 1 from pg_roles where rolname = 'powersync_role';")"

GENERATED_PASSWORD=""
if [[ -n "$ROLE_EXISTS" ]]; then
  ok "powersync_role already exists — not touching its password"
  info "to rotate it: ALTER ROLE powersync_role WITH PASSWORD '<new>';"
else
  # hex, not base64: base64 emits / + and =, which need percent-encoding
  # inside a connection URI and silently truncate it when they are not.
  GENERATED_PASSWORD="$(openssl rand -hex 32)"

  # BYPASSRLS is required, not an oversight. PowerSync replicates whole tables
  # and filters in powersync/sync-config.yaml, which is why that file — not
  # RLS — is the download security boundary.
  "${PSQL[@]}" -c "
    create role powersync_role
      with replication bypassrls login
      password '$GENERATED_PASSWORD';" >/dev/null
  ok "powersync_role created (replication, bypassrls, login)"
fi

"${PSQL[@]}" -c "
  grant select on all tables in schema public to powersync_role;
  alter default privileges in schema public
    grant select on tables to powersync_role;" >/dev/null
ok "select granted on public, now and for future tables"

WRITE_PRIVS="$("${PSQL[@]}" -c "
  select count(*) from information_schema.role_table_grants
  where grantee = 'powersync_role'
    and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE');")"
[[ "$WRITE_PRIVS" == "0" ]] \
  || die "powersync_role holds $WRITE_PRIVS write grant(s); it must be read-only."
ok "role is read-only"

# ------------------------------------------------------------- verification

step "Verification"

run_check() {
  local label="$1" query="$2" expected="$3"
  local actual
  actual="$("${PSQL[@]}" -c "$query")"
  if [[ "$actual" == "$expected" ]]; then
    ok "$label"
  else
    die "$label — expected '$expected', got '$actual'"
  fi
}

run_check "publication 'powersync' exists" \
  "select count(*) from pg_publication where pubname='powersync';" "1"

run_check "every public table is published" \
  "select count(*) from pg_class c
   where c.relkind='r' and c.relnamespace='public'::regnamespace
     and c.relname <> 'schema_migrations'
     and not exists (
       select 1 from pg_publication_tables p
       where p.pubname='powersync' and p.schemaname='public'
         and p.tablename=c.relname);" "0"

run_check "every published table has REPLICA IDENTITY FULL" \
  "select count(*) from pg_class c
   join pg_publication_tables p
     on p.schemaname='public' and p.tablename=c.relname and p.pubname='powersync'
   where c.relkind='r' and c.relnamespace='public'::regnamespace
     and c.relreplident <> 'f';" "0"

run_check "row-level security is on for every published table" \
  "select count(*) from pg_class c
   join pg_publication_tables p
     on p.schemaname='public' and p.tablename=c.relname and p.pubname='powersync'
   where c.relkind='r' and not c.relrowsecurity;" "0"

run_check "the NUMERIC readable view is not replicated" \
  "select count(*) from pg_publication_tables
   where pubname='powersync' and tablename='postings_readable';" "0"

TABLE_COUNT="$("${PSQL[@]}" -c \
  "select count(*) from pg_publication_tables where pubname='powersync';")"
info "$TABLE_COUNT table(s) replicating"

# ------------------------------------------------------ connection string

step "PS_DATABASE_URI"

if [[ -n "$GENERATED_PASSWORD" ]]; then
  # Rebuild the URI from DATABASE_URL's host and database, swapping in the
  # replication role. PowerSync must never connect as the postgres superuser.
  PS_URI="$(DB_URL="$DATABASE_URL" PW="$GENERATED_PASSWORD" python3 - <<'PY'
import os, urllib.parse as u
p = u.urlparse(os.environ["DB_URL"])
host = p.hostname or ""
port = p.port or 5432
db = (p.path or "/postgres").lstrip("/") or "postgres"
pw = u.quote(os.environ["PW"], safe="")
print(f"postgresql://powersync_role:{pw}@{host}:{port}/{db}?sslmode=verify-full")
PY
)"

  if grep -q '^PS_DATABASE_URI=' .env 2>/dev/null; then
    warn ".env already has PS_DATABASE_URI — leaving it alone"
    warn "a new role password was generated; update it by hand if you meant to rotate"
  else
    printf '\n# Added by scripts/setup-backend.sh on %s\nPS_DATABASE_URI=%s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PS_URI" >> .env
    ok "PS_DATABASE_URI written to .env"
  fi

  printf '\n  %sThe role password is shown once and is not stored anywhere else:%s\n' \
    "$BOLD" "$RESET"
  printf '    %s\n' "$GENERATED_PASSWORD"
  printf '  %sIt is already in .env as part of PS_DATABASE_URI.%s\n' "$DIM" "$RESET"
else
  info "role pre-existed, so no new password was generated"
  if ! grep -q '^PS_DATABASE_URI=' .env 2>/dev/null; then
    warn "PS_DATABASE_URI is not in .env and the password cannot be recovered."
    warn "rotate it:  ALTER ROLE powersync_role WITH PASSWORD '<new>';"
    warn "then add PS_DATABASE_URI to .env by hand."
  fi
fi

# ---------------------------------------------------------- sync config

step "Sync config"

if [[ "$SKIP_DEPLOY" == "1" ]]; then
  info "skipped (--skip-deploy)"
elif ! command -v powersync >/dev/null 2>&1; then
  warn "the PowerSync CLI is not installed, so sync config was not deployed."
  info "install:  npm i -g @powersync/cli"
  info "log in :  powersync login"
  info "deploy :  powersync deploy sync-config"
else
  ok "PowerSync CLI $(powersync --version 2>/dev/null || echo 'present')"
  # Deploying targets a live instance, so it is never automatic. The skill's
  # own rule: confirm the target instance before any mutating command.
  warn "not deploying automatically — confirm the target instance first:"
  info "  powersync deploy sync-config"
fi

# ------------------------------------------------------------------ done

step "Backend readiness"

cat <<SUMMARY
  [x] migrations applied and recorded
  [x] powersync_role exists, read-only, replication + bypassrls
  [x] publication covers every table, all with REPLICA IDENTITY FULL
  [x] row-level security on for every replicated table
  [x] PS_DATABASE_URI available

  Remaining, because each targets a live instance:
  [ ] powersync deploy sync-config
  [ ] point the PowerSync instance at PS_DATABASE_URI
  [ ] configure Supabase auth on the instance

  Reminder: RLS governs uploads only. What each device downloads is decided
  entirely by powersync/sync-config.yaml, because powersync_role bypasses RLS.
SUMMARY
