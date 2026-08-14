#!/usr/bin/env bash
# Verify the database layer on a throwaway local PostgreSQL cluster:
#   1. boot an ephemeral cluster
#   2. apply every migration in db/migrations, then db/seed.sql
#   3. run the RLS suite (db/tests/rls_verification.sql)
#   4. run the auth-engine suite (db/tests/auth_flows.sql)
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

echo "==> applying migrations"
for f in "$REPO_ROOT"/db/migrations/*.sql; do
  echo "    - $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done

# Re-running a migration must be safe: a browser-pasted batch can stop
# half-way (a truncated copy, a dropped connection), and the fix is to paste
# it again. Migrations from 001400 on are written to survive that, so the
# whole set is applied a second time here and any error fails the suite.
# (Only 001400 and later: the earlier ones ran once, before any database was
# maintained by hand.)
echo "==> re-applying migrations 001400+ (idempotency check)"
for f in "$REPO_ROOT"/db/migrations/*.sql; do
  name="$(basename "$f")"
  [[ "$name" > "20260803001399" ]] || continue
  echo "    - $name"
  "${PSQL[@]}" -f "$f" >/dev/null
done

echo "==> applying seed"
"${PSQL[@]}" -f "$REPO_ROOT/db/seed.sql"

echo "==> running RLS verification suite"
psql -v ON_ERROR_STOP=1 -d "$DB" -f "$REPO_ROOT/db/tests/rls_verification.sql"

echo "==> running auth-engine suite"
psql -v ON_ERROR_STOP=1 -d "$DB" -f "$REPO_ROOT/db/tests/auth_flows.sql"

echo "==> OK: schema, RLS, storage, audit, and auth engine all verified"
