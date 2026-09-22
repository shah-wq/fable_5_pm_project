#!/usr/bin/env bash
# Admin → Database: the application applies its own migrations.
#
# This replaces pasting SQL into a hosted console, which is where weeks of "the
# database has not caught up" came from: the console would take a 48 KB paste,
# do nothing, and say nothing. The database here is left in the exact state that
# produced that — everything through 003300 applied, the four CRM files not —
# and the button is pressed through the API as an admin would press it.
set -euo pipefail

ROOT=/home/user/fable_5_pm_project
W=/tmp/pmdb-apply
PGPORT=54416
APPPORT=3156
DB=pm_apply
export DATABASE_URL="postgres://postgres@127.0.0.1:$PGPORT/$DB"
BASE="http://127.0.0.1:$APPPORT"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

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
    [ \"\$(basename \$f)\" = 20260803003300_add_sales_role.sql ] && break
  done
"
trap 'kill ${NEXT_PID:-0} 2>/dev/null || true; fuser -k $APPPORT/tcp 2>/dev/null || true; runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D "$W/data" stop -m immediate >/dev/null 2>&1 || true' EXIT
PSQL=(psql -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1 -qtA)
cd "$ROOT"
q() { "${PSQL[@]}" -c "$1"; }

# Real rows, so the backfills in 003400 have work to do.
node scripts/create-admin.mjs admin@ap.test "Password1234!" "Ada Admin" >/dev/null
D=$(q "insert into public.dealers (name) values ('Helios') returning id")
q "insert into public.clients (dealer_id, first_name, last_name, email, phone)
   values ('$D','Amy','Ash','Amy@Example.COM ','512-555-0001')" >/dev/null
q "insert into public.leads (dealer_id, customer_first, customer_last, customer_email, address, status)
   values ('$D','Lee','Lead','lee@example.com','3 Ray Street','submitted')" >/dev/null
# A member of staff who is not an admin.
OPS=$(q "insert into auth.users (email, encrypted_password, email_confirmed_at, raw_app_meta_data)
  values ('ops@ap.test', extensions.crypt('Password1234!', extensions.gen_salt('bf',12)), now(),
          '{\"user_role\":\"ops\"}'::jsonb) returning id")
q "update public.profiles set role = 'ops', is_active = true where id = '$OPS'" >/dev/null 2>&1 || true
echo "==> fixture: a database at 003300 with a contact and a lead"

PORT=$APPPORT nohup npx next start -p $APPPORT >"$W/next.log" 2>&1 &
NEXT_PID=$!
for i in $(seq 1 60); do
  curl -sf "$BASE/api/health" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && fail "app never came up"; sleep 1
done
JAR="$W/admin.txt"
curl -s -o /dev/null -c "$JAR" -H 'content-type: application/json' \
  -d '{"email":"admin@ap.test","password":"Password1234!","door":"staff"}' "$BASE/api/auth/login"

# --- 1. the screen knows what is missing --------------------------------
CODE=$(curl -s -o "$W/page.html" -w '%{http_code}' -b "$JAR" "$BASE/admin/database")
[ "$CODE" = 200 ] || fail "Admin → Database answered $CODE"
# Read as text: React's server output puts <!-- --> between adjacent
# expressions, so "4 migrations" arrives as "4<!-- --> migration<!-- -->s".
text() { sed -e 's/<!--[^>]*-->//g' -e 's/<[^>]*>//g' "$1" | tr -s ' \n' ' '; }
text "$W/page.html" | grep -q "12 migrations are missing" || fail "the screen does not say twelve are missing"
text "$W/page.html" | grep -q "003400" || fail "the screen does not name 003400"
text "$W/page.html" | grep -q "Apply them now" || fail "no Apply button"
R=$(curl -s -b "$JAR" "$BASE/api/admin/migrations")
python3 - "$R" <<'PY'
import json, sys
j = json.loads(sys.argv[1])
assert j['behind'] == ['20260803003400_crm_foundation.sql', '20260803003500_deals.sql',
                       '20260803003600_contact_intake.sql', '20260803003700_contact_create.sql',
                       '20260803003800_contact_stages.sql',
                       '20260803003900_contract_signed_system.sql',
                       '20260803004000_project_holds_contact.sql',
                       '20260803004100_signing_creates_project.sql',
                       '20260803004200_sales_see_deal_projects.sql',
                       '20260803004300_stage_upload_fix.sql',
                       '20260803004400_esignature.sql',
                       '20260803004500_sales_see_dealer_names.sql'], j['behind']
assert '20260803004500_sales_see_dealer_names.sql' in j['bundled'], 'the deployment does not carry its own files'
print('STATE-OK')
PY
pass "Admin → Database names the missing files, and the deployment carries them"

# --- 2. only an admin may press it --------------------------------------
curl -s -o /dev/null -c "$W/ops.txt" -H 'content-type: application/json' \
  -d '{"email":"ops@ap.test","password":"Password1234!","door":"staff"}' "$BASE/api/auth/login"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$W/ops.txt" "$BASE/api/admin/migrations")
[ "$CODE" != 200 ] || fail "ops applied migrations"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/admin/migrations")
[ "$CODE" != 200 ] || fail "an anonymous visitor applied migrations"
[ "$(q "select to_regclass('public.deals') is null")" = t ] || fail "something applied 003400 before the admin did"
pass "the button is admin-only, and a refused press changes nothing"

# --- 3. the press ---------------------------------------------------------
CODE=$(curl -s -o "$W/apply.json" -w '%{http_code}' -X POST -b "$JAR" "$BASE/api/admin/migrations")
[ "$CODE" = 200 ] || fail "applying answered $CODE: $(cat "$W/apply.json")"
python3 - "$W/apply.json" <<'PY'
import json, sys
j = json.load(open(sys.argv[1]))
files = [a['file'] for a in j['applied']]
assert files == ['20260803003400_crm_foundation.sql', '20260803003500_deals.sql',
                 '20260803003600_contact_intake.sql', '20260803003700_contact_create.sql',
                 '20260803003800_contact_stages.sql',
                 '20260803003900_contract_signed_system.sql',
                 '20260803004000_project_holds_contact.sql',
                 '20260803004100_signing_creates_project.sql',
                 '20260803004200_sales_see_deal_projects.sql',
                 '20260803004300_stage_upload_fix.sql',
                 '20260803004400_esignature.sql',
                 '20260803004500_sales_see_dealer_names.sql'], files
bad = [a for a in j['applied'] if not a['ok']]
assert not bad, 'refused: ' + '; '.join(f"{a['file']}: {a['error']}" for a in bad)
assert j['behind'] == [], f"still behind: {j['behind']}"
print('APPLIED-OK', [a['ms'] for a in j['applied']], 'ms')
PY
# The database, not the response, is the judge.
ROW=$(q "select coalesce(to_regclass('public.deals')::text,'MISSING') || '|' ||
         (select count(*) from public.deals) || '|' ||
         (select count(*) from public.client_channels) || '|' ||
         coalesce(to_regprocedure('public.create_contact(jsonb,jsonb)')::text,'MISSING')")
[ "$ROW" = "deals|1|2|create_contact(jsonb,jsonb)" ] || fail "the database does not match a clean apply ($ROW)"
# The lead crossed over to a deal with its person intact.
[ "$(q "select customer_last from public.deals limit 1")" = Lead ] || fail "the lead did not become a deal"
# And the bookkeeping npm run db:migrate reads agrees.
[ "$(q "select count(*) from public.schema_migrations where name >= '20260803003400'")" = 12 ] \
  || fail "schema_migrations was not kept in step"
pass "one press applies them all, in order, and the database is what a clean apply produces"

# --- 4. everything that was waiting now works ---------------------------
H=$(curl -s "$BASE/api/health")
grep -q '"behind":\[\]' <<<"$H" || fail "health still reports files behind: $H"
CODE=$(curl -s -o "$W/stages.html" -w '%{http_code}' -b "$JAR" "$BASE/admin/people/stages")
[ "$CODE" = 200 ] || fail "Contact stages answered $CODE"
if grep -q "has not caught up" "$W/stages.html"; then fail "Contact stages still says the database is behind"; fi
grep -q "Contact created" "$W/stages.html" || fail "the board did not render"
# The board shows contacts. Lee Lead came in as an unlinked dealer submission
# and became a deal with no person behind it, so the contact on file is who
# appears — which is the distinction the board is built on.
grep -q "Amy Ash" "$W/stages.html" || fail "the contact on file is not on the board"
CODE=$(curl -s -o "$W/new.html" -w '%{http_code}' -b "$JAR" "$BASE/admin/people/new")
[ "$CODE" = 200 ] || fail "Create Contact answered $CODE"
if grep -q "has not caught up" "$W/new.html"; then fail "Create Contact still says the database is behind"; fi
pass "health, Contact stages and Create Contact all work the moment it is done"

# --- 5. pressing again is harmless --------------------------------------
CODE=$(curl -s -o "$W/again.json" -w '%{http_code}' -X POST -b "$JAR" "$BASE/api/admin/migrations")
[ "$CODE" = 200 ] || fail "a second press answered $CODE"
grep -q '"applied":\[\]' "$W/again.json" || fail "a second press did work it should not have: $(cat "$W/again.json")"
curl -s -o "$W/page2.html" -b "$JAR" "$BASE/admin/database"
text "$W/page2.html" | grep -q "Up to date" || fail "the screen does not say it is up to date"
pass "a second press applies nothing, and the screen says so"

# --- 6. a refusal is reported in PostgreSQL's own words -----------------
# Break something 003500 needs so that a fresh copy of it cannot apply, then
# make the probe think it is missing, and press.
q "drop function if exists public.convert_deal_to_project(uuid, public.project_stage)" >/dev/null
q "alter table public.deals rename column client_id to client_id_x" >/dev/null
CODE=$(curl -s -o "$W/refused.json" -w '%{http_code}' -X POST -b "$JAR" "$BASE/api/admin/migrations")
[ "$CODE" = 200 ] || fail "a refused apply answered $CODE"
python3 - "$W/refused.json" <<'PY'
import json, sys
j = json.load(open(sys.argv[1]))
assert j['applied'] and j['applied'][0]['file'] == '20260803003500_deals.sql', j
a = j['applied'][0]
assert not a['ok'] and a['error'] and 'client_id' in a['error'], a
print('REFUSAL-OK:', a['error'][:90])
PY
q "alter table public.deals rename column client_id_x to client_id" >/dev/null
pass "when PostgreSQL refuses a file, the screen gets its exact words"

echo "APPLY-MIGRATIONS CHECKS PASSED"
