#!/usr/bin/env bash
# Verify the Supabase foundation on a throwaway local PostgreSQL cluster:
#   1. boot an ephemeral cluster (no Docker needed)
#   2. apply the Supabase platform shim (supabase/tests/local_shim.sql)
#   3. apply every migration in supabase/migrations, then supabase/seed.sql
#   4. run the §2 RLS verification suite (supabase/tests/rls_verification.sql)
#
# Usage: scripts/verify-local.sh
# Requires: PostgreSQL server binaries (initdb/pg_ctl/psql) v15+.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="${PG_BIN:-$(dirname "$(command -v initdb 2>/dev/null || echo /usr/lib/postgresql/16/bin/initdb)")}"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/pmdb-verify.XXXXXX")"
export PGDATA="$WORKDIR/data"
export PGHOST="$WORKDIR"
export PGPORT="${PGPORT:-54329}"
export PGUSER="postgres"
export PGDATABASE="postgres"
DB="pm_verify"

cleanup() {
  "$PG_BIN/pg_ctl" -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "==> initdb ($WORKDIR)"
"$PG_BIN/initdb" -U postgres --no-instructions -E UTF8 "$PGDATA" >/dev/null

echo "==> starting postgres on unix socket $PGHOST:$PGPORT"
"$PG_BIN/pg_ctl" -D "$PGDATA" -o "-p $PGPORT -k $PGHOST -c listen_addresses=''" -w start >/dev/null

createdb "$DB"

PSQL=(psql -v ON_ERROR_STOP=1 -q -d "$DB")

echo "==> applying platform shim"
"${PSQL[@]}" -f "$REPO_ROOT/supabase/tests/local_shim.sql"

echo "==> applying migrations"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  echo "    - $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done

echo "==> applying seed"
"${PSQL[@]}" -f "$REPO_ROOT/supabase/seed.sql"

echo "==> running RLS verification suite"
psql -v ON_ERROR_STOP=1 -d "$DB" -f "$REPO_ROOT/supabase/tests/rls_verification.sql"

echo "==> OK: schema, RLS, storage policies, and audit log all verified"
