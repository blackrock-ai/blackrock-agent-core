#!/usr/bin/env bash
# Apply the full Agent Core migration sequence into a fresh database to
# prove it slots in cleanly. Reads connection settings from PGHOST/PGPORT/
# PGUSER/PGPASSWORD (defaults match the supabase local stack). Creates a
# disposable database, runs every migration in `packages/schema/migrations`
# in lexicographic (numeric) order under --single-transaction
# --set ON_ERROR_STOP=1, then drops the database.
#
# Output format mirrors the verify-*.ts scripts:
#   [ok] migration NNNN — applied cleanly
#   [fail] migration NNNN — <psql error>
#
# Exit 0 on full pass, 1 on any failure, 2 on a setup error. If the host
# Postgres is unreachable or lacks the supabase_vault extension, prints
# `[parked]` and exits 0.

set -u

PGHOST=${PGHOST:-127.0.0.1}
PGPORT=${PGPORT:-54322}
PGUSER=${PGUSER:-postgres}
PGPASSWORD=${PGPASSWORD:-postgres}
export PGPASSWORD

DB="agent_core_verify_$$"
MIGRATIONS_DIR="$(cd "$(dirname "$0")/../migrations" && pwd)"

PSQL_BASE_ARGS=(-h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -v ON_ERROR_STOP=1)

cleanup() {
  psql "${PSQL_BASE_ARGS[@]}" -d postgres -c "drop database if exists ${DB};" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[verify-migrations] target=${PGHOST}:${PGPORT}/${DB}"

if ! psql "${PSQL_BASE_ARGS[@]}" -d postgres -tAc "select 1" >/dev/null 2>&1; then
  echo "[parked] Postgres at ${PGHOST}:${PGPORT} unreachable"
  exit 0
fi

# supabase_vault must be installable; the migrations create it explicitly.
if ! psql "${PSQL_BASE_ARGS[@]}" -d postgres -tAc \
  "select 1 from pg_available_extensions where name='supabase_vault'" \
  | grep -q '^1$'; then
  echo "[parked] supabase_vault extension not available on this Postgres"
  exit 0
fi

if ! psql "${PSQL_BASE_ARGS[@]}" -d postgres -c "create database ${DB};" >/dev/null 2>&1; then
  echo "[fail] could not create disposable database ${DB}"
  exit 2
fi

# Bootstrap the schemas / extensions the migrations expect — these are
# normally provisioned by the full Supabase stack. We mirror only what the
# Agent Core migrations need.
psql "${PSQL_BASE_ARGS[@]}" -d "${DB}" >/dev/null <<'SQL'
create extension if not exists "pgcrypto";
create extension if not exists "supabase_vault" cascade;

create schema if not exists auth;
do $$ begin
  if not exists (select 1 from pg_proc p
                 join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname='auth' and p.proname='jwt') then
    create function auth.jwt() returns jsonb language sql stable as $f$
      select '{}'::jsonb;
    $f$;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname='service_role') then
    create role service_role nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname='anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then
    create role authenticated nologin;
  end if;
end $$;
SQL

passed=0
failed=0
for migration in $(ls "${MIGRATIONS_DIR}"/*.sql | sort); do
  name=$(basename "${migration}" .sql)
  short=${name%%_*}
  out=$(psql "${PSQL_BASE_ARGS[@]}" -d "${DB}" --single-transaction -f "${migration}" 2>&1)
  rc=$?
  if [ ${rc} -eq 0 ]; then
    echo "[ok] migration ${short} — applied cleanly"
    passed=$((passed+1))
  else
    echo "[fail] migration ${short} — ${out}" | head -20
    failed=$((failed+1))
  fi
done

echo "[verify-migrations] ${passed} pass / ${failed} fail"
if [ ${failed} -eq 0 ]; then
  exit 0
else
  exit 1
fi
