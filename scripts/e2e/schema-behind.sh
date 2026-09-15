#!/usr/bin/env bash
# Every screen, against a database that has not caught up.
#
# The deployment and the database move separately here: code reaches Vercel the
# moment it is pushed, and the SQL is pasted into a console by a person, maybe an
# hour later — or a week later. In that window the app is newer than the schema,
# and a screen belonging to the newest module must degrade rather than fall over.
#
# This suite boots the app against a database stopped at each of the last few
# migrations and walks the whole navigation. It exists because the opposite kept
# happening: the Create Contact page returned "This page could not load" on a
# database that had never had the CRM files pasted into it, because one dropdown
# asked for a role the enum did not have yet.
set -euo pipefail

ROOT=/home/user/fable_5_pm_project
W=/tmp/pmdb-behind
PGPORT=54414
APPPORT=3154
DB=pm_behind
BASE="http://127.0.0.1:$APPPORT"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

# The screens a member of staff can reach, with the role that reaches them.
PAGES=(
  /dashboard /projects /pipeline /leads /tasks /messages /feedback /reports
  /deals /deals/new /admin /admin/people /admin/people/new /admin/dealers /admin/users
)

cut_at() {
  local cut=$1
  rm -rf "$W"; mkdir -p "$W"; chmod 777 "$W"
  fuser -k $APPPORT/tcp 2>/dev/null || true
  fuser -k $PGPORT/tcp 2>/dev/null || true
  sleep 1
  runuser -u postgres -- bash -c "
    set -e
    /usr/lib/postgresql/16/bin/initdb -U postgres --no-instructions -E UTF8 '$W/data' >/dev/null 2>&1
    /usr/lib/postgresql/16/bin/pg_ctl -D '$W/data' -o '-p $PGPORT -k $W -c listen_addresses=127.0.0.1' -w start >/dev/null
    createdb -h 127.0.0.1 -p $PGPORT -U postgres $DB
    for f in $ROOT/db/migrations/*.sql; do
      psql -v ON_ERROR_STOP=1 -q -h 127.0.0.1 -p $PGPORT -U postgres -d $DB --single-transaction -f \"\$f\" >/dev/null 2>&1
      [ \"\$(basename \$f)\" = '$cut' ] && break
    done
    psql -v ON_ERROR_STOP=1 -q -h 127.0.0.1 -p $PGPORT -U postgres -d $DB -f $ROOT/db/seed.sql >/dev/null 2>&1
  "
}

stop_all() {
  kill "${NEXT_PID:-0}" 2>/dev/null || true
  fuser -k $APPPORT/tcp 2>/dev/null || true
  runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D "$W/data" stop -m immediate >/dev/null 2>&1 || true
}
trap stop_all EXIT

cd "$ROOT"
export DATABASE_URL="postgres://postgres@127.0.0.1:$PGPORT/$DB"

# Each cut-off is a real state somebody's database is in: nothing of the CRM
# pasted at all, then each file of it in turn.
for CUT in 20260803003200_stage_feedback.sql \
           20260803003300_add_sales_role.sql \
           20260803003400_crm_foundation.sql \
           20260803003500_deals.sql \
           20260803003600_contact_intake.sql \
           20260803003700_contact_create.sql; do
  cut_at "$CUT"
  node scripts/create-admin.mjs admin@in.test "Password1234!" "Ada Admin" >/dev/null
  PORT=$APPPORT nohup npx next start -p $APPPORT >"$W/next.log" 2>&1 &
  NEXT_PID=$!
  for i in $(seq 1 60); do
    curl -sf "$BASE/api/health" >/dev/null 2>&1 && break
    [ "$i" = 60 ] && fail "the app never came up at $CUT"; sleep 1
  done
  curl -s -o /dev/null -c "$W/jar" -H 'content-type: application/json' \
    -d '{"email":"admin@in.test","password":"Password1234!","door":"staff"}' "$BASE/api/auth/login"

  BAD=()
  for page in "${PAGES[@]}"; do
    CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$W/jar" "$BASE$page")
    # 200 renders, 3xx is a redirect the route matrix made on purpose, 404 is a
    # screen that does not exist at this cut-off. A 5xx is the failure this
    # suite exists to catch.
    case "$CODE" in 2*|3*|404) ;; *) BAD+=("$page=$CODE") ;; esac
  done
  [ ${#BAD[@]} -eq 0 ] || {
    echo "---- server log ----" >&2
    tail -30 "$W/next.log" >&2
    fail "at $CUT these screens broke: ${BAD[*]}"
  }
  # Create Contact must say so before fifty fields are typed, not after.
  BODY=$(curl -s -b "$W/jar" "$BASE/admin/people/new")
  if [ "$CUT" = 20260803003700_contact_create.sql ]; then
    if grep -qi "has not caught up" <<<"$BODY"; then
      fail "Create Contact claims the database is behind when it is not"
    fi
  elif ! grep -qi "has not caught up" <<<"$BODY"; then
    fail "at $CUT Create Contact would take a whole form and then refuse to save it"
  fi
  pass "every screen loads with the database stopped at $CUT"
  stop_all
done

echo "SCHEMA-BEHIND CHECKS PASSED"
