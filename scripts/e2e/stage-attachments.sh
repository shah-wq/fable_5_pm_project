#!/usr/bin/env bash
# Attachments close each stage, in place of the old "Drive Updated" tick.
#
# The stage form offers the stage's attachment fields and no Drive Updated
# box; advancing is refused, by name, until the required files are on the
# project; the upload that satisfies it lets the project through; a stage
# closed under the old tick stays closed; and the report field that used to be
# "Drive Updated" now answers "Attachments complete" the same way the gate does.
set -euo pipefail

ROOT=/home/user/fable_5_pm_project
W=/tmp/pmdb-attach
PGPORT=54434
APPPORT=3164
DB=pm_attach
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
  done
  psql -v ON_ERROR_STOP=1 -q -h 127.0.0.1 -p $PGPORT -U postgres -d $DB -f $ROOT/db/seed.sql >/dev/null 2>&1
"
trap 'kill ${NEXT_PID:-0} 2>/dev/null || true; fuser -k $APPPORT/tcp 2>/dev/null || true; runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D "$W/data" stop -m immediate >/dev/null 2>&1 || true' EXIT
q() { psql -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "$1"; }
cd "$ROOT"

node scripts/create-admin.mjs admin@at.test "Password1234!" "Ada Admin" >/dev/null
D=$(q "insert into public.dealers (name) values ('Helios') returning id")
C=$(q "insert into public.clients (dealer_id, first_name, last_name, email) values ('$D','Ann','Attach','ann@at.test') returning id")
# Three projects in Survey with every survey field done: one with nothing
# attached, one about to get its photos, one closed out under the old tick.
mk() {
  local P
  P=$(q "insert into public.projects (name, dealer_id, client_id, stage, address) values ('$1', '$D', '$C', 'survey', '1 Array Way') returning id")
  q "insert into public.stage1_survey (project_id, down_payment_status, down_payment_received_date, cash_m1_status,
       survey_status, survey_completed_date, drive_updated)
     values ('$P', 'received', '2026-09-01', 'na', 'completed', '2026-09-02', $2)" >/dev/null
  echo "$P"
}
BARE=$(mk 'Bare Survey' false)
READY=$(mk 'Ready Survey' false)
OLD=$(mk 'Old Survey' true)
# And a finished project, which is the only kind whose every stage form opens.
DONE=$(q "insert into public.projects (name, dealer_id, client_id, stage, status, address)
  values ('Done Deal', '$D', '$C', 'complete', 'complete', '2 Array Way') returning id")
echo "==> fixture: three surveyed projects and a finished one"

PORT=$APPPORT nohup npx next start -p $APPPORT >"$W/next.log" 2>&1 &
NEXT_PID=$!
for i in $(seq 1 60); do
  curl -sf "$BASE/api/health" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && fail "app never came up"; sleep 1
done
JAR="$W/admin.txt"
curl -s -o /dev/null -c "$JAR" -H 'content-type: application/json' \
  -d '{"email":"admin@at.test","password":"Password1234!","door":"staff"}' "$BASE/api/auth/login"
text() { sed -e 's/<!--[^>]*-->//g' -e 's/<[^>]*>//g' "$1" | tr -s ' \n' ' '; }

# --- 1. the form offers attachments, and no Drive Updated -----------------
for stage in survey design permits procurement install inspection_pto complete; do
  CODE=$(curl -s -o "$W/form.html" -w '%{http_code}' -b "$JAR" "$BASE/projects/$DONE/stages/$stage")
  [ "$CODE" = 200 ] || fail "the $stage form answered $CODE"
  text "$W/form.html" | grep -q "Attachments" || fail "the $stage form has no Attachments card"
  if text "$W/form.html" | grep -q "Drive Updated"; then fail "the $stage form still asks for Drive Updated"; fi
done
text "$W/form.html" | grep -q "Completion certificate / final documents" || fail "Complete does not offer its final documents"
curl -s -o "$W/form.html" -b "$JAR" "$BASE/projects/$READY/stages/survey"
text "$W/form.html" | grep -q "Site survey photos" || fail "the survey form does not ask for its photos"
pass "every stage form offers its attachments, and none asks for Drive Updated"

# --- 2. no photos, no advance — and the refusal says which file -----------
move() { curl -s -o "$W/move.json" -w '%{http_code}' -X POST -b "$JAR" -H 'content-type: application/json' \
  -d '{"direction":"forward","via":"button"}' "$BASE/api/projects/$1/move"; }
CODE=$(move "$BARE")
[ "$CODE" != 200 ] || fail "a survey with no photos advanced"
grep -q "Site survey photos not attached" "$W/move.json" || fail "the refusal does not name the missing file: $(cat "$W/move.json")"
[ "$(q "select stage from public.projects where id='$BARE'")" = survey ] || fail "a refused advance moved the project"
pass "a stage with its paperwork missing is refused, naming the attachment"

# --- 3. upload the photos, and it goes through ----------------------------
printf '\xff\xd8\xff\xe0 fake jpeg' > "$W/roof.jpg"
CODE=$(curl -s -o "$W/up.json" -w '%{http_code}' -b "$JAR" -F category=survey_photos -F "file=@$W/roof.jpg;type=image/jpeg" \
  "$BASE/api/projects/$READY/documents")
[ "$CODE" = 200 ] || [ "$CODE" = 201 ] || fail "uploading survey photos answered $CODE: $(cat "$W/up.json")"
[ "$(q "select count(*) from public.documents where project_id='$READY' and category='survey_photos'")" = 1 ] \
  || fail "the upload did not land as a survey_photos document"
[ "$(q "select customer_visible from public.documents where project_id='$READY' and category='survey_photos'")" = f ] \
  || fail "a stage attachment is visible to the homeowner by default"
CODE=$(move "$READY")
[ "$CODE" = 200 ] || fail "the survey with its photos was refused: $(cat "$W/move.json")"
[ "$(q "select stage from public.projects where id='$READY'")" = design ] || fail "the project did not move to Design"
pass "attaching the survey photos is what lets the project through, and the file stays internal"

# --- 4. a stage closed under the old tick stays closed ---------------------
CODE=$(move "$OLD")
[ "$CODE" = 200 ] || fail "a survey closed out under Drive Updated was blocked: $(cat "$W/move.json")"
pass "a stage already closed under Drive Updated is not asked again"

# --- 5. the report field answers the way the gate does ---------------------
CODE=$(curl -s -o "$W/rep.json" -w '%{http_code}' -X POST -b "$JAR" -H 'content-type: application/json' \
  -d '{"definition":{"columns":[{"field":"project.code"},{"field":"s1.drive"}],"groupBy":[],"filters":[],"summarise":[],"stages":[],"stageMode":"passed_through","includeHold":true,"includeCancelled":true}}' \
  "$BASE/api/reports/preview")
[ "$CODE" = 200 ] || fail "a report on attachments answered $CODE: $(cat "$W/rep.json")"
python3 - "$W/rep.json" "$(q "select code from public.projects where id='$BARE'")" \
  "$(q "select code from public.projects where id='$READY'")" "$(q "select code from public.projects where id='$OLD'")" <<'PY'
import json, sys
j = json.load(open(sys.argv[1])); bare, ready, old = sys.argv[2:5]
labels = [c.get('label') for c in j['columns']]
assert 'Attachments complete (S1)' in labels, labels
rows = {str(r[0] if isinstance(r, list) else list(r.values())[0]): (r[1] if isinstance(r, list) else list(r.values())[1]) for r in j['rows']}
truthy = lambda v: v in (True, 'true', 'Yes', 'yes', 't', 1)
assert not truthy(rows[bare]), f'bare survey reported complete: {rows[bare]}'
assert truthy(rows[ready]), f'photographed survey reported incomplete: {rows[ready]}'
assert truthy(rows[old]), f'old Drive Updated survey reported incomplete: {rows[old]}'
print('REPORT-OK', rows)
PY
pass "the report's Attachments complete matches the stage gate, old ticks included"

echo "STAGE-ATTACHMENTS CHECKS PASSED"
