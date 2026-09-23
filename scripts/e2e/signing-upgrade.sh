#!/usr/bin/env bash
# A database that took the first version of signing, then everything after it.
#
# 003900 was first pushed with a sign_contact that recorded the system and
# moved the contact, but made no project. It was rewritten to make the project,
# and the rewrite could not reach databases that already had the first one: the
# probe for 003900 asked whether sign_contact existed, it did, and Admin →
# Database said "Up to date" while signing failed with "the database has not
# caught up yet". This rebuilds exactly that database — every migration, with
# the first sign_contact in place — and checks that the screen now says what is
# missing, that signing says why it cannot, and that one press of Apply fixes it.
set -euo pipefail

ROOT=/home/user/fable_5_pm_project
W=/tmp/pmdb-upgrade
PGPORT=54433
APPPORT=3163
DB=pm_upgrade
export DATABASE_URL="postgres://postgres@127.0.0.1:$PGPORT/$DB"
BASE="http://127.0.0.1:$APPPORT"
# The commit that shipped the first sign_contact.
FIRST=0f17dde

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

rm -rf "$W"; mkdir -p "$W"; chmod 777 "$W"
fuser -k $APPPORT/tcp 2>/dev/null || true
fuser -k $PGPORT/tcp 2>/dev/null || true
sleep 1
git -C "$ROOT" show "$FIRST:db/migrations/20260803003900_contract_signed_system.sql" > "$W/first-003900.sql"
chmod 644 "$W/first-003900.sql"
runuser -u postgres -- bash -c "
  set -e
  /usr/lib/postgresql/16/bin/initdb -U postgres --no-instructions -E UTF8 '$W/data' >/dev/null 2>&1
  /usr/lib/postgresql/16/bin/pg_ctl -D '$W/data' -o '-p $PGPORT -k $W -c listen_addresses=127.0.0.1' -w start >/dev/null
  createdb -h 127.0.0.1 -p $PGPORT -U postgres $DB
  for f in $ROOT/db/migrations/*.sql; do
    # Everything up to the hold — the state the Database screen showed.
    case \"\$(basename \$f)\" in 20260803004[1-9]*) continue ;; esac
    psql -v ON_ERROR_STOP=1 -q -h 127.0.0.1 -p $PGPORT -U postgres -d $DB --single-transaction -f \"\$f\" >/dev/null 2>&1
  done
  # And the first sign_contact, as that database has it.
  psql -v ON_ERROR_STOP=1 -q -h 127.0.0.1 -p $PGPORT -U postgres -d $DB \
    -c 'drop function if exists public.sign_contact(uuid, jsonb, uuid, text)' >/dev/null 2>&1
  psql -v ON_ERROR_STOP=1 -q -h 127.0.0.1 -p $PGPORT -U postgres -d $DB --single-transaction -f '$W/first-003900.sql' >/dev/null 2>&1
  psql -v ON_ERROR_STOP=1 -q -h 127.0.0.1 -p $PGPORT -U postgres -d $DB -f $ROOT/db/seed.sql >/dev/null 2>&1
"
trap 'kill ${NEXT_PID:-0} 2>/dev/null || true; fuser -k $APPPORT/tcp 2>/dev/null || true; runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D "$W/data" stop -m immediate >/dev/null 2>&1 || true' EXIT
q() { psql -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "$1"; }
cd "$ROOT"

[ "$(q "select pg_get_function_result('public.sign_contact(uuid,jsonb,uuid,text)'::regprocedure)")" \
  = "TABLE(signed_deal_id uuid, deal_created boolean)" ] || fail "the fixture does not have the first sign_contact"
node scripts/create-admin.mjs admin@up.test "Password1234!" "Ada Admin" >/dev/null
D=$(q "insert into public.dealers (name) values ('Helios') returning id")
C=$(q "insert into public.clients (dealer_id, first_name, last_name, email, contact_stage, mailing_street, mailing_city)
  values ('$D','Una','Upgrade','una@up.test','quoted','5 Volt Lane','Austin') returning id")
echo "==> fixture: every migration, with the first sign_contact"

PORT=$APPPORT nohup npx next start -p $APPPORT >"$W/next.log" 2>&1 &
NEXT_PID=$!
for i in $(seq 1 60); do
  curl -sf "$BASE/api/health" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && fail "app never came up"; sleep 1
done
JAR="$W/admin.txt"
curl -s -o /dev/null -c "$JAR" -H 'content-type: application/json' \
  -d '{"email":"admin@up.test","password":"Password1234!","door":"staff"}' "$BASE/api/auth/login"
SIGN="{\"values\":{\"system_size_kw\":7,\"dealer_id\":\"$D\",\"address\":\"5 Volt Lane, Austin\"}}"
sign() { curl -s -o "$W/sign.json" -w '%{http_code}' -X POST -b "$JAR" -H 'content-type: application/json' \
  -d "$SIGN" "$BASE/api/contacts/$C/sign"; }

# --- 1. the screen says what is missing, rather than "Up to date" ---------
H=$(curl -s "$BASE/api/health")
python3 - "$H" <<'PY'
import json, sys
behind = json.loads(sys.argv[1])['migrations']['behind']
assert behind == ['20260803004100_signing_creates_project.sql',
                  '20260803004200_sales_see_deal_projects.sql',
                  '20260803004300_stage_upload_fix.sql',
                  '20260803004400_esignature.sql',
                  '20260803004500_sales_see_dealer_names.sql',
                  '20260803004600_stage_fields_solar.sql',
                  '20260803004700_notifications.sql'], f'health says behind: {behind}'
print('BEHIND-OK', behind)
PY
curl -s -b "$JAR" "$BASE/admin/database" | sed -e 's/<!--[^>]*-->//g' -e 's/<[^>]*>//g' | tr -s ' \n' ' ' \
  | grep -q "7 migrations are missing" || fail "Admin → Database does not say which migrations are missing"
pass "a database with the first sign_contact is reported behind on the file that fixes it, by name"

# --- 2. signing says why it cannot ---------------------------------------
CODE=$(sign)
[ "$CODE" != 200 ] || fail "signing worked against the first sign_contact?"
grep -q "Admin → Database" "$W/sign.json" || fail "the refusal does not say where to go: $(cat "$W/sign.json")"
grep -q "signed_project_id" "$W/sign.json" || fail "the refusal hides PostgreSQL's reason: $(cat "$W/sign.json")"
[ "$(q "select contact_stage from public.clients where id='$C'")" = quoted ] || fail "a failed signing moved Una"
pass "signing names the real reason and where to fix it, and moves nobody"

# --- 3. one press, and signing makes the project ------------------------
CODE=$(curl -s -o "$W/apply.json" -w '%{http_code}' -X POST -b "$JAR" "$BASE/api/admin/migrations")
[ "$CODE" = 200 ] || fail "Apply answered $CODE: $(cat "$W/apply.json")"
python3 - "$W/apply.json" <<'PY'
import json, sys
j = json.load(open(sys.argv[1]))
assert [a['file'] for a in j['applied']] == ['20260803004100_signing_creates_project.sql',
                                           '20260803004200_sales_see_deal_projects.sql',
                                           '20260803004300_stage_upload_fix.sql',
                                           '20260803004400_esignature.sql',
                                           '20260803004500_sales_see_dealer_names.sql',
                                           '20260803004600_stage_fields_solar.sql',
                                           '20260803004700_notifications.sql'], j
assert all(a['ok'] for a in j['applied']), j
assert j['behind'] == [], j
print('APPLIED-OK')
PY
[ "$(sign)" = 200 ] || fail "signing still fails after Apply: $(cat "$W/sign.json")"
grep -q '"projectCode":"PRJ-' "$W/sign.json" || fail "signing did not make the project: $(cat "$W/sign.json")"
ROW=$(q "select c.contact_stage || '|' || d.stage || '|' || p.system_size_kw || '|' || p.address
           from public.clients c join public.deals d on d.client_id = c.id
           join public.projects p on p.id = d.project_id where c.id = '$C'")
[ "$ROW" = "contract_signed|won|7.000|5 Volt Lane, Austin" ] || fail "the project is not what was signed ($ROW)"
pass "one press of Apply, and signing creates the project"

echo "SIGNING-UPGRADE CHECKS PASSED"
