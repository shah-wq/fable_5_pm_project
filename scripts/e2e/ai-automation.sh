#!/usr/bin/env bash
# AI automation (migration 004800), against the Claude API stand-in
# (anthropic-mock.mjs via ANTHROPIC_BASE_URL).
#
# Checked: a PDF attached to a stage form is read and its values proposed —
# invalid values and unknown fields are dropped, low confidence is kept as a
# suggestion, one exception per document asks the PM, and nothing is written
# until Accept; accepting writes the form through its own allowlist and
# rejecting does not; resolving the exception closes the rest; with auto-apply
# on, confident values are written at once and nothing asks; a file that is
# not what it was filed as becomes a high-severity exception; auto-advance
# moves a complete project through the same gate as the button and holds a
# project with undecided suggestions; a homeowner's message gets a draft built
# from the project's facts, which the PM sends (edited) or dismisses, and with
# auto-send on a confident one goes out signed as automatic while a refund
# question waits for a person; the morning briefing is written once per PM per
# day at the chosen hour; the switches and the admin API are admin-only; and
# the screens render.
set -euo pipefail

ROOT=/home/user/fable_5_pm_project
W=/tmp/pmdb-ai
PGPORT=54439
APPPORT=3168
MOCKPORT=3178
DB=pm_ai
export DATABASE_URL="postgres://postgres@127.0.0.1:$PGPORT/$DB"
BASE="http://127.0.0.1:$APPPORT"
MOCK="http://127.0.0.1:$MOCKPORT"
CRON=cron-secret

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

rm -rf "$W"; mkdir -p "$W"; chmod 777 "$W"
fuser -k $APPPORT/tcp $MOCKPORT/tcp $PGPORT/tcp 2>/dev/null || true
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
trap 'kill ${NEXT_PID:-0} ${MOCK_PID:-0} 2>/dev/null || true; fuser -k $APPPORT/tcp $MOCKPORT/tcp 2>/dev/null || true; runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D "$W/data" stop -m immediate >/dev/null 2>&1 || true' EXIT
q() { psql -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "$1"; }
cd "$ROOT"

node scripts/create-admin.mjs admin@ai.test "Password1234!" "Ada Admin" >/dev/null
node scripts/create-admin.mjs pm@ai.test "Password1234!" "Pat Manager" >/dev/null
ADMIN=$(q "select id from public.profiles where email='admin@ai.test'")
PM=$(q "select id from public.profiles where email='pm@ai.test'")
q "update public.profiles set role='ops' where id='$PM'" >/dev/null
D=$(q "insert into public.dealers (name) values ('Apex Solar') returning id")
HOMEU=$(q "insert into auth.users (email, encrypted_password, email_confirmed_at, raw_app_meta_data)
  values ('home@ai.test', extensions.crypt('Password1234!', extensions.gen_salt('bf',12)), now(), '{\"user_role\":\"customer\"}'::jsonb) returning id")
HANA=$(q "insert into public.clients (dealer_id, first_name, last_name, email, user_id) values ('$D','Hana','Home','home@ai.test','$HOMEU') returning id")
BEN=$(q "insert into public.clients (dealer_id, first_name, last_name, email) values ('$D','Ben','Blue','ben@ai.test') returning id")
CARA=$(q "insert into public.clients (dealer_id, first_name, last_name, email) values ('$D','Cara','Cyan','cara@ai.test') returning id")
PA=$(q "insert into public.projects (name, dealer_id, client_id, stage, address, assigned_pm) values ('Hana Home','$D','$HANA','permits','1 Sun Rd','$PM') returning id")
PB=$(q "insert into public.projects (name, dealer_id, client_id, stage, address, assigned_pm) values ('Ben Blue','$D','$BEN','survey','2 Sun Rd','$PM') returning id")
PC=$(q "insert into public.projects (name, dealer_id, client_id, stage, address, assigned_pm) values ('Cara Cyan','$D','$CARA','survey','3 Sun Rd','$PM') returning id")
q "insert into public.stage3_permit (project_id, permit_status, permit_applied_date) values ('$PA','applied','2026-09-01')" >/dev/null
q "delete from public.notifications; delete from public.ai_jobs" >/dev/null
echo "==> fixture: an admin, a PM, a homeowner with a login, three projects"

MOCK_PORT=$MOCKPORT nohup node scripts/e2e/anthropic-mock.mjs >"$W/mock.log" 2>&1 &
MOCK_PID=$!
ANTHROPIC_API_KEY=test-anthropic-key ANTHROPIC_BASE_URL=$MOCK EMAIL_DEV_LOG=1 CRON_SECRET=$CRON \
  PORT=$APPPORT nohup npx next start -p $APPPORT >"$W/next.log" 2>&1 &
NEXT_PID=$!
for i in $(seq 1 60); do
  curl -sf "$BASE/api/health" >/dev/null 2>&1 && curl -sf "$MOCK/__requests" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && fail "app or mock never came up"; sleep 1
done
login() { curl -s -o /dev/null -c "$W/$1.txt" -H 'content-type: application/json' \
  -d "{\"email\":\"$1@ai.test\",\"password\":\"Password1234!\",\"door\":\"$2\"}" "$BASE/api/auth/login"; }
login admin staff; login pm staff; login home customer
api() { curl -s -o "$W/r.json" -w '%{http_code}' -X "$2" -b "$W/$1.txt" -H 'content-type: application/json' ${4:+-d "$4"} "$BASE$3"; }
j() { python3 -c "import json,sys; d=json.load(open('$W/r.json')); print($1)"; }
cron() { curl -s -o "$W/cron.json" -w '%{http_code}' -X POST -H "authorization: Bearer $CRON" "$BASE/api/push/reminders"; }
text() { sed -e 's/<!--[^>]*-->//g' -e 's/<[^>]*>//g' "$1" | tr -s ' \n' ' '; }
# A one-page PDF saying $1, at $2. Enough of a PDF for the app's checks; the
# stand-in reads the bytes for a marker rather than rendering it.
mkpdf() { python3 - "$1" "$2" <<'PY'
import sys
text, path = sys.argv[1], sys.argv[2]
content = f"BT /F1 18 Tf 40 700 Td ({text}) Tj ET".encode()
objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
out = b"%PDF-1.4\n"; offs = []
for i, o in enumerate(objs, 1):
    offs.append(len(out)); out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
xref = len(out)
out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
for o in offs: out += b"%010d 00000 n \n" % o
out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
open(path, 'wb').write(out)
PY
}
python3 -c "import base64; open('$W/px.png','wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='))"
upload() { curl -s -o "$W/up.json" -w '%{http_code}' -b "$W/$1.txt" -F "category=$3" -F "file=@$4;type=$5" "$BASE/api/projects/$2/documents"; }
# The upload route runs the queue in the background; wait for it, and fall back
# to the scheduled job if it is slow.
settle() {
  for i in $(seq 1 40); do
    [ "$(q "select count(*) from public.ai_jobs where status in ('queued','running')")" = 0 ] && return 0
    sleep 0.5
  done
  cron >/dev/null; [ "$(q "select count(*) from public.ai_jobs where status in ('queued','running')")" = 0 ] || fail "jobs never settled: $(q "select kind||':'||status||':'||coalesce(error,'') from public.ai_jobs")"
}
settz() { python3 - "$PGPORT" "$DB" "$1" <<'PY'
import subprocess, sys, datetime
utc = datetime.datetime.now(datetime.timezone.utc).hour
want = int(sys.argv[3]); offset = (want - utc) % 24
if offset > 12: offset -= 24
tz = 'Etc/GMT%+d' % (-offset) if offset else 'Etc/UTC'
subprocess.run(['psql','-h','127.0.0.1','-p',sys.argv[1],'-U','postgres','-d',sys.argv[2],'-qtA','-c',
  f"update public.app_settings set company_timezone = '{tz}' where id"], check=True)
print('TZ', tz, 'local hour', want)
PY
}
settz 12

# --- 1. a permit letter is read; nothing is written; the PM is asked -----------
mkpdf "PERMIT APPROVED BP-2026-0042" "$W/permit.pdf"
[ "$(upload pm $PA permit_approval "$W/permit.pdf" application/pdf)" = 201 ] || fail "upload answered $(cat "$W/up.json")"
DOC=$(python3 -c "import json; print(json.load(open('$W/up.json'))['documentIds'][0])")
[ "$(q "select count(*) from public.ai_jobs where kind='read_document' and entity_id='$DOC'")" = 1 ] || fail "the upload queued no read_document job"
settle
[ "$(q "select status from public.ai_jobs where entity_id='$DOC'")" = done ] || fail "the read job did not finish: $(q "select error from public.ai_jobs where entity_id='$DOC'")"
ROW=$(q "select string_agg(field||'='||(value #>> '{}')||'@'||confidence||':'||status, ',' order by field) from public.ai_suggestions where document_id='$DOC'")
[ "$ROW" = "permit_expiry_date=2027-03-15@0.92:pending,permit_fee=350@0.55:pending,permit_number=BP-2026-0042@0.97:pending,permit_received_date=2026-09-15@0.90:pending,permit_status=approved@0.95:pending" ] \
  || fail "unexpected suggestions: $ROW"
[ "$(q "select permit_number is null and permit_fee is null and permit_status='applied' from public.stage3_permit where project_id='$PA'")" = t ] || fail "the reader wrote to the form without being asked"
EX=$(q "select id from public.exceptions where raised_by='ai' and entity_id='$DOC'")
[ -n "$EX" ] || fail "no exception was raised for the document"
[ "$(q "select severity||'|'||status||'|'||assigned_to from public.exceptions where id='$EX'")" = "medium|open|$PM" ] || fail "the exception is not medium/open/assigned to the PM"
q "select summary from public.exceptions where id='$EX'" | grep -q "5 values to confirm, 2 notes" || fail "the exception summary is off: $(q "select summary from public.exceptions where id='$EX'")"
q "select details->'issues' from public.exceptions where id='$EX'" | grep -q "not a valid value" || fail "the invalid 'fax' value was not reported"
q "select details->'issues' from public.exceptions where id='$EX'" | grep -q "conditional on a final inspection" || fail "the model's issue was dropped"
[ "$(q "select count(*) from public.notifications where kind='ai_exception' and user_id='$PM' and project_id='$PA'")" = 1 ] || fail "the PM was not told"
[ "$(q "select count(*) from public.audit_log where action='ai.document_read' and entity_id='$DOC'")" = 1 ] || fail "the read was not logged"
python3 - "$MOCK" <<'PY'
import json, sys, urllib.request
reqs = json.load(urllib.request.urlopen(sys.argv[1] + '/__requests'))
r = [x for x in reqs if x['body']['system'][0]['text'].startswith('You read documents')][0]['body']
assert r['model'] == 'claude-opus-5' and r['fallbacks'] == 'default' and r['thinking'] == {'type': 'adaptive'}, r
assert r['output_config'] == {'effort': 'low'}, r['output_config']
assert r['system'][0]['cache_control'] == {'type': 'ephemeral'}
blocks = r['messages'][0]['content']
assert blocks[0]['type'] == 'document' and blocks[0]['bytes'] > 100, blocks[0]
text = blocks[1]['text']
assert 'as "Building permit approval"' in text and '"field":"permit_number"' in text and 'Permits' in text, text[:300]
assert '"permit_status":"applied"' in text, 'the current form values were not sent'
print('REQUEST-OK')
PY
pass "a permit letter is read into pending suggestions with evidence; invalid and unknown fields are dropped; one exception asks the PM; the form is untouched"

# --- 2. the stage form shows them; accept writes, reject does not --------------
CODE=$(curl -s -o "$W/p.html" -w '%{http_code}' -b "$W/pm.txt" "$BASE/projects/$PA/stages/permits")
[ "$CODE" = 200 ] || fail "the permits form answered $CODE"
text "$W/p.html" | grep -q "Read from the attachments" || fail "the form does not show the reader's panel"
text "$W/p.html" | grep -q "BP-2026-0042" || fail "the suggested permit number is not on the form"
SNUM=$(q "select id from public.ai_suggestions where document_id='$DOC' and field='permit_number'")
SFEE=$(q "select id from public.ai_suggestions where document_id='$DOC' and field='permit_fee'")
[ "$(api pm PATCH /api/ai/suggestions "{\"id\":\"$SNUM\",\"accept\":true}")" = 200 ] || fail "accept answered $(cat "$W/r.json")"
[ "$(q "select permit_number from public.stage3_permit where project_id='$PA'")" = "BP-2026-0042" ] || fail "accepting did not write the permit number"
[ "$(api pm PATCH /api/ai/suggestions "{\"id\":\"$SFEE\",\"accept\":false}")" = 200 ] || fail "reject answered $(cat "$W/r.json")"
[ "$(q "select permit_fee is null from public.stage3_permit where project_id='$PA'")" = t ] || fail "rejecting wrote the fee"
[ "$(q "select status||'|'||decided_by from public.ai_suggestions where id='$SNUM'")" = "applied|$PM" ] || fail "the accepted suggestion is not marked applied by the PM"
[ "$(api pm PATCH /api/ai/suggestions "{\"id\":\"$SNUM\",\"accept\":true}")" = 409 ] || fail "deciding twice was allowed"
[ "$(q "select count(*) from public.audit_log where action='ai.suggestion_applied'")" = 1 ] || fail "the acceptance was not logged"
[ "$(q "select status from public.exceptions where id='$EX'")" = open ] || fail "the exception closed with suggestions still pending"
[ "$(api pm GET /api/exceptions)" = 200 ] || fail "the queue answered $(cat "$W/r.json")"
python3 - "$W/r.json" "$EX" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); it = [x for x in d['items'] if x['id'] == sys.argv[2]][0]
assert it['pending_suggestions'] == 3 and len(it['suggestions']) == 3, it
assert it['project_code'].startswith('PRJ-') and it['customer_name'] == 'Hana Home', it
assert {s['field'] for s in it['suggestions']} == {'permit_status', 'permit_received_date', 'permit_expiry_date'}
assert all(s['display'] for s in it['suggestions']), it['suggestions']
print('QUEUE-OK')
PY
[ "$(api pm PATCH /api/exceptions "{\"id\":\"$EX\",\"status\":\"resolved\",\"notes\":\"Checked against the letter\"}")" = 200 ] || fail "resolving answered $(cat "$W/r.json")"
[ "$(q "select status||'|'||resolved_by||'|'||resolution_notes from public.exceptions where id='$EX'")" = "resolved|$PM|Checked against the letter" ] || fail "the exception was not resolved"
[ "$(q "select count(*) from public.ai_suggestions where document_id='$DOC' and status='pending'")" = 0 ] || fail "resolving left suggestions pending"
[ "$(q "select permit_status from public.stage3_permit where project_id='$PA'")" = applied ] || fail "resolving applied a suggestion"
pass "the form shows the suggestions; Accept writes through the form's allowlist, Reject does not; resolving the exception closes the rest unapplied"

# --- 3. auto-apply: confident values are written; the rest still ask -------------
[ "$(api pm PUT /api/admin/ai-settings '{"autoApply":true}')" = 403 ] || fail "a PM changed the AI settings"
[ "$(api admin PUT /api/admin/ai-settings '{"autoApply":true,"confidenceThreshold":0.9}')" = 200 ] || fail "saving the switches failed: $(cat "$W/r.json")"
[ "$(api admin PUT /api/admin/ai-settings '{"confidenceThreshold":0.2}')" = 400 ] || fail "a silly threshold was accepted"
mkpdf "DELIVERED PO-7781" "$W/slip.pdf"
[ "$(upload pm $PA delivery_confirmation "$W/slip.pdf" application/pdf)" = 201 ] || fail "upload answered $(cat "$W/up.json")"
DOC2=$(python3 -c "import json; print(json.load(open('$W/up.json'))['documentIds'][0])")
settle
[ "$(q "select po_number||'|'||material_status||'|'||material_delivered_date from public.stage4_procurement where project_id='$PA'")" = "PO-7781|delivered|2026-09-20" ] || fail "confident values were not written: $(q "select * from public.stage4_procurement where project_id='$PA'")"
[ "$(q "select count(*) from public.ai_suggestions where document_id='$DOC2' and status='applied' and decided_by is null")" = 3 ] || fail "applied suggestions are not recorded as automatic"
[ "$(q "select count(*) from public.exceptions where entity_id='$DOC2'")" = 0 ] || fail "an exception was raised with nothing to decide"
[ "$(q "select count(*) from public.notifications where kind='material_delivered' and user_id='$HOMEU'")" = 1 ] || fail "the homeowner was not told the equipment arrived"
# The same letter again, now with auto-apply: the 0.55 fee still waits, the rest is written.
mkpdf "PERMIT APPROVED again" "$W/permit2.pdf"
q "update public.stage3_permit set permit_number = null where project_id='$PA'" >/dev/null
[ "$(upload pm $PA permit_approval "$W/permit2.pdf" application/pdf)" = 201 ] || fail "upload answered $(cat "$W/up.json")"
DOC3=$(python3 -c "import json; print(json.load(open('$W/up.json'))['documentIds'][0])")
settle
[ "$(q "select permit_status||'|'||permit_number||'|'||permit_expiry_date||'|'||coalesce(permit_fee::text,'null') from public.stage3_permit where project_id='$PA'")" = "approved|BP-2026-0042|2027-03-15|null" ] || fail "the second letter was not applied as expected: $(q "select permit_status, permit_number, permit_expiry_date, permit_fee from public.stage3_permit where project_id='$PA'")"
[ "$(q "select string_agg(field||':'||status, ',' order by field) from public.ai_suggestions where document_id='$DOC3'")" = "permit_expiry_date:applied,permit_fee:pending,permit_number:applied,permit_received_date:applied,permit_status:applied" ] || fail "mixed apply/pending is wrong"
[ "$(q "select count(*) from public.notifications where kind='permit_approved' and user_id='$HOMEU'")" = 1 ] || fail "writing the approval did not tell the homeowner"
EX3=$(q "select id from public.exceptions where entity_id='$DOC3' and status='open'")
[ -n "$EX3" ] || fail "the low-confidence fee raised no exception"
SFEE3=$(q "select id from public.ai_suggestions where document_id='$DOC3' and field='permit_fee'")
[ "$(api pm PATCH /api/ai/suggestions "{\"id\":\"$SFEE3\",\"accept\":true}")" = 200 ] || fail "accept answered $(cat "$W/r.json")"
[ "$(q "select permit_fee from public.stage3_permit where project_id='$PA'")" = "350.00" ] || fail "the fee was not written"
[ "$(q "select status from public.exceptions where id='$EX3'")" = resolved ] || fail "deciding the last suggestion did not close its exception"
pass "with auto-apply on, values above the threshold are written at once and tell the homeowner; the one below waits, and deciding it closes the exception"

# --- 4. a file that is not what it says ------------------------------------------
mkpdf "NOTAPERMIT woof" "$W/dog.pdf"
[ "$(upload pm $PA hoa_approval "$W/dog.pdf" application/pdf)" = 201 ] || fail "upload answered $(cat "$W/up.json")"
DOC4=$(python3 -c "import json; print(json.load(open('$W/up.json'))['documentIds'][0])")
settle
ROW=$(q "select severity||'|'||summary from public.exceptions where entity_id='$DOC4'")
echo "$ROW" | grep -q "^high|HOA approval: the file does not look like one (a photo of a dog)" || fail "the mismatch was not flagged: $ROW"
[ "$(q "select count(*) from public.ai_suggestions where document_id='$DOC4'")" = 0 ] || fail "values were proposed from the wrong document"
pass "a file that is not what it was filed as becomes a high-severity exception with nothing proposed"

# --- 5. auto-advance --------------------------------------------------------
[ "$(api admin PUT /api/admin/ai-settings '{"autoAdvanceStages":["survey","complete","nonsense"]}')" = 200 ] || fail "saving stages failed"
[ "$(q "select ai_auto_advance_stages from public.app_settings")" = "{survey}" ] || fail "the stage list was not cleaned: $(q "select ai_auto_advance_stages from public.app_settings")"
for P in $PB $PC; do
  q "insert into public.stage1_survey (project_id, down_payment_status, down_payment_received_date, cash_m1_status, survey_status, survey_completed_date)
     values ('$P','received',current_date,'na','completed',current_date)
     on conflict (project_id) do update set down_payment_status='received', down_payment_received_date=current_date, cash_m1_status='na', survey_status='completed', survey_completed_date=current_date" >/dev/null
  [ "$(upload pm $P survey_photos "$W/px.png" image/png)" = 201 ] || fail "photo upload answered $(cat "$W/up.json")"
done
settle
# Cara's project has an undecided suggestion: it must wait.
q "insert into public.ai_suggestions (project_id, stage, field, value, confidence) values ('$PC','survey','roof_pitch','\"5/12\"',0.6)" >/dev/null
[ "$(cron)" = 200 ] || fail "cron answered $(cat "$W/cron.json")"
python3 -c "import json; a=json.load(open('$W/cron.json'))['automation']; assert a['autoAdvanced'] == 1, a; print('AUTO-OK', a)"
[ "$(q "select stage from public.projects where id='$PB'")" = design ] || fail "Ben's complete survey was not advanced"
[ "$(q "select stage from public.projects where id='$PC'")" = survey ] || fail "Cara's project advanced with a suggestion undecided"
[ "$(q "select context->>'via' from public.audit_log where action='stage.advanced' and entity_id='$PB'")" = automation ] || fail "the move is not logged as the automation's"
[ "$(q "select count(*) from public.notifications where kind='stage_advanced' and project_id='$PB' and payload->>'stage'='design'")" = 1 ] || fail "the homeowner was not told about the move"
[ "$(q "select count(*) from public.project_messages where project_id='$PB' and sender_role='system' and body like 'Moved to Design%'")" = 1 ] || fail "no system line in the thread"
[ "$(cron)" = 200 ]
python3 -c "import json; a=json.load(open('$W/cron.json'))['automation']; assert a['autoAdvanced'] == 0, a"
pass "auto-advance moves a complete project through the same gate, tells the homeowner and logs the move; it waits while a suggestion is undecided; a second run moves nothing"

# --- 6. reply drafts -------------------------------------------------------------
[ "$(curl -s -o "$W/r.json" -w '%{http_code}' -b "$W/home.txt" -F "body=When will my permit be approved?" "$BASE/api/chat/$PA")" = 201 ] || fail "the homeowner could not write: $(cat "$W/r.json")"
MSG=$(j "d['message']['id']")
[ "$(q "select count(*) from public.ai_jobs where kind='draft_reply' and entity_id='$MSG'")" = 1 ] || fail "no draft job was queued"
settle
[ "$(q "select status from public.ai_jobs where entity_id='$MSG'")" = done ] || fail "the draft job failed: $(q "select error from public.ai_jobs where entity_id='$MSG'")"
BODY=$(q "select body from public.ai_reply_drafts where message_id='$MSG'")
echo "$BODY" | grep -q "^Hi Hana! Your project is in the Permits stage. Building permit: approved. Equipment: delivered." || fail "the draft did not use the project's facts: $BODY"
ROW=$(q "select status||'|'||needs_human::text||'|'||confidence::text from public.ai_reply_drafts where message_id='$MSG'")
[ "$ROW" = "draft|false|0.93" ] || fail "the draft row is wrong: $ROW"
[ "$(q "select count(*) from public.project_messages where project_id='$PA' and sender_role='staff'")" = 0 ] || fail "a reply was sent with auto-send off"
CODE=$(curl -s -o "$W/p.html" -w '%{http_code}' -b "$W/pm.txt" "$BASE/projects/$PA/chat")
[ "$CODE" = 200 ] || fail "the chat page answered $CODE"
text "$W/p.html" | grep -q "Suggested reply to" || fail "the chat page does not show the draft"
text "$W/p.html" | grep -q "Send to Hana Home" || fail "the send button does not name the homeowner"
[ "$(api pm GET "/api/ai/drafts?project=$PA")" = 200 ] || fail "drafts answered $(cat "$W/r.json")"
DRAFT=$(j "d['items'][0]['id']")
[ "$(api pm PATCH /api/ai/drafts "{\"id\":\"$DRAFT\",\"action\":\"send\",\"body\":\"Hi Hana — your permit was approved on 15 September. Pat\"}")" = 200 ] || fail "sending the draft failed: $(cat "$W/r.json")"
[ "$(q "select body||'|'||sender_user_id from public.project_messages where project_id='$PA' and sender_role='staff' order by created_at desc limit 1")" = "Hi Hana — your permit was approved on 15 September. Pat|$PM" ] || fail "the edited reply was not posted as the PM"
[ "$(q "select status||'|'||decided_by from public.ai_reply_drafts where id='$DRAFT'")" = "sent|$PM" ] || fail "the draft is not marked sent"
[ "$(q "select count(*) from public.notifications where kind='new_message' and user_id='$HOMEU'")" = 1 ] || fail "the homeowner was not told about the reply"
# A money question: needs a person, and is dismissed.
[ "$(curl -s -o "$W/r.json" -w '%{http_code}' -b "$W/home.txt" -F "body=Can I get a refund on the deposit?" "$BASE/api/chat/$PA")" = 201 ]
MSG2=$(j "d['message']['id']"); settle
ROW=$(q "select needs_human::text||'|'||reason from public.ai_reply_drafts where message_id='$MSG2'")
[ "$ROW" = "true|money or cancellation" ] || fail "the refund question was not flagged for a person: $ROW"
DRAFT2=$(q "select id from public.ai_reply_drafts where message_id='$MSG2'")
[ "$(api pm PATCH /api/ai/drafts "{\"id\":\"$DRAFT2\",\"action\":\"dismiss\"}")" = 200 ] || fail "dismiss failed"
[ "$(q "select status from public.ai_reply_drafts where id='$DRAFT2'")" = dismissed ] || fail "the draft is not dismissed"
[ "$(api pm GET "/api/ai/drafts?project=$PA")" = 200 ]; [ "$(j "len(d['items'])")" = 0 ] || fail "decided drafts still listed"
# Auto-send: a confident answer goes out as the PM, signed as automatic; a refund question does not.
[ "$(api admin PUT /api/admin/ai-settings '{"replyAutoSend":true}')" = 200 ]
[ "$(curl -s -o "$W/r.json" -w '%{http_code}' -b "$W/home.txt" -F "body=Has my equipment been delivered?" "$BASE/api/chat/$PA")" = 201 ]
MSG3=$(j "d['message']['id']"); settle
[ "$(q "select status from public.ai_reply_drafts where message_id='$MSG3'")" = sent_auto ] || fail "the confident draft was not sent automatically: $(q "select status, confidence from public.ai_reply_drafts where message_id='$MSG3'")"
LAST=$(q "select body from public.project_messages where project_id='$PA' and sender_role='staff' order by created_at desc limit 1")
echo "$LAST" | grep -q "Equipment: delivered" || fail "the automatic reply lacks the fact: $LAST"
echo "$LAST" | grep -q "Sent automatically by the SolarFlow assistant" || fail "the automatic reply is not signed as automatic"
[ "$(q "select sender_user_id from public.project_messages where project_id='$PA' and sender_role='staff' order by created_at desc limit 1")" = "$PM" ] || fail "the automatic reply is not from the PM"
[ "$(q "select count(*) from public.audit_log where action='ai.reply_sent_auto'")" = 1 ] || fail "the automatic send was not logged"
[ "$(curl -s -o "$W/r.json" -w '%{http_code}' -b "$W/home.txt" -F "body=I want to cancel and get a refund." "$BASE/api/chat/$PA")" = 201 ]
MSG4=$(j "d['message']['id']"); settle
[ "$(q "select status from public.ai_reply_drafts where message_id='$MSG4'")" = draft ] || fail "a refund question was answered automatically"
pass "a homeowner's message gets a draft from the project's facts; the PM sends it edited or dismisses it; with auto-send on, a confident answer goes out signed as automatic and a refund question waits"

# --- 7. the morning briefing --------------------------------------------------
[ "$(api admin PUT /api/admin/ai-settings '{"briefingHour":9}')" = 200 ]
settz 8
[ "$(cron)" = 200 ]
[ "$(q "select count(*) from public.ai_jobs where kind='briefing'")" = 0 ] || fail "a briefing was queued outside its hour"
settz 9
[ "$(cron)" = 200 ]
python3 -c "import json; a=json.load(open('$W/cron.json'))['automation']; assert a['briefingsQueued'] == 2, a"
settle
[ "$(q "select count(*) from public.ai_jobs where kind='briefing' and status='done'")" = 2 ] || fail "briefings did not finish: $(q "select entity_id, status, error from public.ai_jobs where kind='briefing'")"
[ "$(q "select count(*) from public.notifications where kind='daily_briefing' and user_id='$PM'")" = 1 ] || fail "the PM has no briefing notification"
q "select payload->>'summary' from public.notifications where kind='daily_briefing' and user_id='$PM'" | grep -q "RESULT pm_report" || fail "the briefing is not the PM report"
q "select payload->>'summary' from public.notifications where kind='daily_briefing' and user_id='$PM'" | grep -q "Hana Home" || fail "the briefing does not name the PM's project"
[ "$(cron)" = 200 ]
python3 -c "import json; a=json.load(open('$W/cron.json'))['automation']; assert a['briefingsQueued'] == 0, a"
grep -q "to=pm@ai.test subject=Your briefing for" "$W/next.log" || fail "the briefing was not emailed"
pass "the briefing is written once per project manager at the chosen hour, from the PM report under their own permissions, and emailed"

# --- 8. the switches --------------------------------------------------------------
[ "$(api admin PUT /api/admin/ai-settings '{"documentReading":false,"replyDrafts":false}')" = 200 ]
N=$(q "select count(*) from public.ai_jobs")
mkpdf "PERMIT APPROVED" "$W/permit3.pdf"
[ "$(upload pm $PB permit_approval "$W/permit3.pdf" application/pdf)" = 201 ]
[ "$(curl -s -o /dev/null -w '%{http_code}' -b "$W/home.txt" -F "body=Hello?" "$BASE/api/chat/$PA")" = 201 ]
[ "$(q "select count(*) from public.ai_jobs")" = "$N" ] || fail "switched-off automation still queued work"
[ "$(api admin GET /api/admin/ai-settings)" = 200 ] || fail "settings answered $(cat "$W/r.json")"
python3 - "$W/r.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d['configured'] is True and d['settings']['documentReading'] is False and d['settings']['autoApply'] is True, d['settings']
assert d['settings']['autoAdvanceStages'] == ['survey'] and d['settings']['briefingHour'] == 9
done = {(s['kind'], s['status']): s['n'] for s in d['stats']}
assert done[('read_document', 'done')] >= 6 and done[('draft_reply', 'done')] >= 4 and done[('briefing', 'done')] == 2, done
assert len(d['recent']) >= 10 and all('kind' in r for r in d['recent'])
print('SETTINGS-OK')
PY
[ "$(api pm GET /api/admin/ai-settings)" = 403 ] || fail "a PM read the AI settings"
[ "$(curl -s -o /dev/null -w '%{http_code}' -b "$W/home.txt" "$BASE/api/exceptions")" != 200 ] || fail "a homeowner reached the exceptions API"
[ "$(curl -s -o /dev/null -w '%{http_code}' -b "$W/home.txt" "$BASE/api/ai/drafts")" != 200 ] || fail "a homeowner reached the drafts API"
pass "switching a job off stops it being queued; the settings are admin-only; the queue and drafts are staff-only"

# --- 9. the screens -----------------------------------------------------------------
CODE=$(curl -s -o "$W/p.html" -w '%{http_code}' -b "$W/pm.txt" "$BASE/exceptions")
[ "$CODE" = 200 ] || fail "/exceptions answered $CODE"
text "$W/p.html" | grep -q "Exceptions" || fail "the exceptions page is empty"
CODE=$(curl -s -o "$W/p.html" -w '%{http_code}' -b "$W/admin.txt" "$BASE/admin/ai")
[ "$CODE" = 200 ] || fail "/admin/ai answered $CODE"
text "$W/p.html" | grep -q "AI automation" || fail "the admin page is empty"
CODE=$(curl -s -o "$W/p.html" -w '%{http_code}' -b "$W/pm.txt" "$BASE/pipeline")
text "$W/p.html" | grep -q "Exceptions" || fail "the sidebar has no Exceptions entry"
[ "$(curl -s -o /dev/null -w '%{http_code}' -b "$W/home.txt" "$BASE/exceptions")" != 200 ] || fail "a homeowner reached the exceptions page"
pass "the exceptions queue, the admin screen and the sidebar entry render for the right people"

echo "AI AUTOMATION CHECKS PASSED"
