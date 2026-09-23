#!/usr/bin/env bash
# Notifications (migration 004700): the catalogue, the triggers, the timed
# rules, delivery by email, the feeds and the admin switches.
#
# Checked: creating a project tells the homeowner, the dealer, the PM and the
# admins; a stage form's status changes tell the homeowner in plain words; a
# stage moved back and forth is announced once; a hold and a resume are told;
# the scheduled job raises ageing, expiring-permit, install-readiness and
# quiet-contact notifications and delivers everything by email (dev log) —
# and does nothing twice; a homeowner's notifications wait through quiet
# hours while staff's do not; each role's feed shows only its own; an admin
# can switch a kind off; and the pages render.
set -euo pipefail

ROOT=/home/user/fable_5_pm_project
W=/tmp/pmdb-notify
PGPORT=54437
APPPORT=3167
DB=pm_notify
export DATABASE_URL="postgres://postgres@127.0.0.1:$PGPORT/$DB"
BASE="http://127.0.0.1:$APPPORT"
CRON=cron-secret

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

rm -rf "$W"; mkdir -p "$W"; chmod 777 "$W"
fuser -k $APPPORT/tcp $PGPORT/tcp 2>/dev/null || true
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

node scripts/create-admin.mjs admin@nt.test "Password1234!" "Ada Admin" >/dev/null
node scripts/create-admin.mjs pm@nt.test "Password1234!" "Pat Manager" >/dev/null
node scripts/create-admin.mjs rep@nt.test "Password1234!" "Ray Rep" >/dev/null
ADMIN=$(q "select id from public.profiles where email='admin@nt.test'")
PM=$(q "select id from public.profiles where email='pm@nt.test'")
REP=$(q "select id from public.profiles where email='rep@nt.test'")
q "update public.profiles set role='ops' where id='$PM'" >/dev/null
q "update public.profiles set role='sales' where id='$REP'" >/dev/null
D=$(q "insert into public.dealers (name) values ('Apex Solar') returning id")
mkuser() { q "insert into auth.users (email, encrypted_password, email_confirmed_at, raw_app_meta_data)
  values ('$1', extensions.crypt('Password1234!', extensions.gen_salt('bf',12)), now(), '{\"user_role\":\"$2\"}'::jsonb) returning id"; }
DEALERU=$(mkuser dealer@nt.test dealer)
q "insert into public.dealer_users (dealer_id, user_id) values ('$D','$DEALERU')" >/dev/null
HOMEU=$(mkuser home@nt.test customer)
# Hana has a portal login; Ed is email-only; Olga opted out of email.
HANA=$(q "insert into public.clients (dealer_id, first_name, last_name, email, user_id) values ('$D','Hana','Home','home@nt.test','$HOMEU') returning id")
ED=$(q "insert into public.clients (dealer_id, first_name, last_name, email) values ('$D','Ed','Emailonly','ed@nt.test') returning id")
OLGA=$(q "insert into public.clients (dealer_id, first_name, last_name, email, email_opt_out) values ('$D','Olga','Optout','olga@nt.test', true) returning id")
echo "==> fixture: admin, PM, rep, a dealer login, three homeowners"

EMAIL_DEV_LOG=1 CRON_SECRET=$CRON PORT=$APPPORT nohup npx next start -p $APPPORT >"$W/next.log" 2>&1 &
NEXT_PID=$!
for i in $(seq 1 60); do
  curl -sf "$BASE/api/health" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && fail "app never came up"; sleep 1
done
login() { curl -s -o /dev/null -c "$W/$1.txt" -H 'content-type: application/json' \
  -d "{\"email\":\"$1@nt.test\",\"password\":\"Password1234!\",\"door\":\"$2\"}" "$BASE/api/auth/login"; }
login admin staff; login pm staff; login rep staff; login dealer dealer; login home customer
api() { curl -s -o "$W/r.json" -w '%{http_code}' -X "$2" -b "$W/$1.txt" -H 'content-type: application/json' ${4:+-d "$4"} "$BASE$3"; }
j() { python3 -c "import json,sys; d=json.load(open('$W/r.json')); print($1)"; }
cron() { curl -s -o "$W/cron.json" -w '%{http_code}' -X POST -H "authorization: Bearer $CRON" "$BASE/api/push/reminders"; }
n() { q "select count(*) from public.notifications n where n.kind='$1' ${2:-}"; }
text() { sed -e 's/<!--[^>]*-->//g' -e 's/<[^>]*>//g' "$1" | tr -s ' \n' ' '; }
# Quiet hours are 9pm–8am in the company's timezone, so the suite chooses a
# timezone in which it is now the given hour: daytime for most of it, 23:00
# for the quiet-hours check. (Etc/GMT+N is UTC−N.)
settz() { python3 - "$PGPORT" "$DB" "$1" <<'PY'
import subprocess, sys, datetime
utc = datetime.datetime.now(datetime.timezone.utc).hour
want = int(sys.argv[3])
offset = (want - utc) % 24
if offset > 12: offset -= 24
tz = 'Etc/GMT%+d' % (-offset) if offset else 'Etc/UTC'
subprocess.run(['psql','-h','127.0.0.1','-p',sys.argv[1],'-U','postgres','-d',sys.argv[2],'-qtA','-c',
  f"update public.app_settings set company_timezone = '{tz}' where id"], check=True)
print('TZ', tz, 'local hour', want)
PY
}
settz 12

# --- 1. a project is created ----------------------------------------------
PA=$(q "insert into public.projects (name, dealer_id, client_id, stage, address, assigned_pm) values ('Hana Home','$D','$HANA','survey','1 Sun Rd','$PM') returning id")
PB=$(q "insert into public.projects (name, dealer_id, client_id, stage, address) values ('Ed Emailonly','$D','$ED','survey','2 Sun Rd') returning id")
PC=$(q "insert into public.projects (name, dealer_id, client_id, stage, address, assigned_pm) values ('Olga Optout','$D','$OLGA','survey','3 Sun Rd','$PM') returning id")
[ "$(n project_created "and user_id='$HOMEU'")" = 1 ] || fail "Hana was not told her project started"
[ "$(n project_created "and recipient_email='ed@nt.test' and user_id is null")" = 1 ] || fail "Ed (no login) has no email notification"
[ "$(n project_created "and client_id='$OLGA'")" = 0 ] || fail "an opted-out homeowner with no login was notified"
[ "$(n dealer_project_created "and user_id='$DEALERU'")" = 3 ] || fail "the dealer was not told about each project ($(n dealer_project_created))"
[ "$(n project_assigned "and user_id='$PM'")" = 2 ] || fail "the PM was not told about the assignments ($(n project_assigned))"
[ "$(n admin_project_created "and user_id='$ADMIN'")" = 3 ] || fail "admins were not told about new projects"
pass "a new project tells the homeowner (login or email), the dealer, the PM and the admins"

# --- 2. stage forms tell the homeowner in plain words -----------------------
CODE=$(api pm PATCH /api/projects/$PA/stages/survey '{"values":{"survey_status":"scheduled","survey_scheduled_date":"2026-10-05","down_payment_status":"requested"}}')
[ "$CODE" = 200 ] || fail "saving the survey form answered $CODE: $(cat "$W/r.json")"
[ "$(n survey_scheduled "and user_id='$HOMEU'")" = 1 ] || fail "no survey_scheduled notification"
[ "$(n payment_requested "and user_id='$HOMEU'")" = 1 ] || fail "no payment_requested notification"
api pm PATCH /api/projects/$PA/stages/permits '{"values":{"permit_status":"approved","permit_number":"BP-2026-118","permit_received_date":"2026-10-20","permit_applied_date":"2026-10-01"}}' >/dev/null
[ "$(n permit_approved "and user_id='$HOMEU'")" = 1 ] || fail "no permit_approved notification"
api pm PATCH /api/projects/$PA/stages/permits '{"values":{"ica_status":"revision_requested","ica_revision_notes":"Single-line diagram missing labels"}}' >/dev/null
[ "$(n permit_revision "and user_id='$PM'")" = 1 ] || fail "the PM was not told the ICA came back"
api pm PATCH /api/projects/$PA/stages/permits '{"values":{"permit_status":"approved"}}' >/dev/null
[ "$(n permit_approved "and user_id='$HOMEU'")" = 1 ] || fail "saving the form again re-announced the permit"
pass "status changes on the forms raise the homeowner's and the PM's notifications, once each"

# --- 3. moves: once per stage, and holds -----------------------------------
q "update public.projects set stage='design' where id='$PA'" >/dev/null
q "update public.projects set stage='survey' where id='$PA'" >/dev/null
q "update public.projects set stage='design' where id='$PA'" >/dev/null
[ "$(n stage_advanced "and user_id='$HOMEU' and payload->>'stage'='design'")" = 1 ] || fail "back-and-forth announced Design more than once"
[ "$(n dealer_stage_advanced "and user_id='$DEALERU' and project_id='$PA' and payload->>'stage'='design'")" = 1 ] || fail "the dealer was not told (or told twice)"
CODE=$(api pm POST /api/projects/$PA/move '{"direction":"hold","reason":"Awaiting documents","notes":"HOA letter outstanding"}')
[ "$CODE" = 200 ] || fail "hold answered $CODE: $(cat "$W/r.json")"
[ "$(n project_on_hold "and user_id='$HOMEU'")" = 1 ] || fail "no on-hold notification"
[ "$(q "select payload->>'reason' from public.notifications where kind='project_on_hold' and user_id='$HOMEU'")" = "Awaiting documents" ] || fail "the hold reason is not on the notification"
[ "$(n dealer_project_on_hold "and user_id='$DEALERU'")" = 1 ] || fail "the dealer was not told about the hold"
CODE=$(api pm POST /api/projects/$PA/move '{"direction":"resume"}')
[ "$CODE" = 200 ] || fail "resume answered $CODE: $(cat "$W/r.json")"
[ "$(n project_resumed "and user_id='$HOMEU'")" = 1 ] || fail "no resumed notification"
pass "a stage is announced once however often it is corrected; holds and resumes are told with their reason"

# --- 4. delivery by email, and nothing twice --------------------------------
[ "$(cron)" = 200 ] || fail "the scheduled job answered $(cat "$W/cron.json")"
python3 -c "import json; d=json.load(open('$W/cron.json')); assert d['notificationsDelivered']['delivered'] > 0, d"
sleep 1
grep -q "to=home@nt.test subject=Your solar project has started" "$W/next.log" || fail "Hana's welcome email was not sent"
grep -q "to=ed@nt.test subject=Your solar project has started" "$W/next.log" || fail "Ed's email-only notification was not sent"
grep -q "to=home@nt.test subject=Your building permit is approved" "$W/next.log" || fail "the permit email was not sent"
grep -q "permit BP-2026-118" "$W/next.log" || fail "the permit email lacks the permit number"
grep -q "to=pm@nt.test subject=Assigned to you: PRJ-" "$W/next.log" || fail "the PM's assignment email was not sent"
grep -q "to=dealer@nt.test subject=Project started for Hana Home" "$W/next.log" || fail "the dealer's email was not sent"
grep -q "to=olga@nt.test" "$W/next.log" && fail "an opted-out homeowner was emailed"
[ "$(q "select count(*) from public.notifications where delivered_at is null")" = 0 ] || fail "some notifications were not marked delivered"
BEFORE=$(grep -c "email dev-log" "$W/next.log")
[ "$(cron)" = 200 ] || fail "second cron failed"
sleep 1
[ "$(grep -c "email dev-log" "$W/next.log")" = "$BEFORE" ] || fail "a second run sent emails again"
pass "one scheduled run emails every recipient with the right words, respects opt-out, and a second run sends nothing"

# --- 5. the timed rules ------------------------------------------------------
q "update public.stage_thresholds set attention_days = 1 where stage in ('design', 'permits')" >/dev/null
q "update public.project_stage_events set changed_at = now() - interval '9 days' where project_id='$PA'" >/dev/null
q "update public.stage3_permit set permit_expiry_date = current_date + 5 where project_id='$PA'" >/dev/null
q "update public.projects set stage='permits' where id='$PA'" >/dev/null
q "update public.project_stage_events set changed_at = now() - interval '9 days' where project_id='$PA'" >/dev/null
q "insert into public.stage5_install (project_id, install_status, install_scheduled_date) values ('$PC','scheduled', current_date + 1)" >/dev/null
q "update public.clients set owner_id='$REP', contact_stage='quoted', last_contacted_at = now() - interval '12 days' where id='$ED'" >/dev/null
[ "$(n lead_assigned "and user_id='$REP'")" = 1 ] || fail "the rep was not told about the assigned lead"
[ "$(cron)" = 200 ] || fail "cron failed"
python3 - "$W/cron.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))['notificationsRaised']
assert d['ageing'] >= 1 and d['permits'] == 1 and d['readiness'] == 1 and d['contacts'] == 1, d
print('TIMED-OK', d)
PY
[ "$(n stage_ageing "and user_id='$PM' and project_id='$PA'")" = 1 ] || fail "no ageing notification for the PM"
[ "$(n permit_expiring "and user_id='$PM'")" = 1 ] || fail "no permit_expiring notification"
[ "$(n install_readiness "and user_id='$PM' and project_id='$PC'")" = 1 ] || fail "no install_readiness notification"
[ "$(q "select payload->>'problems' from public.notifications where kind='install_readiness'")" = "permit not approved, materials not delivered." ] || fail "the readiness problems are wrong"
[ "$(n contact_stale "and user_id='$REP'")" = 1 ] || fail "no contact_stale notification for the rep"
[ "$(cron)" = 200 ] || fail "cron failed"
python3 -c "import json; d=json.load(open('$W/cron.json'))['notificationsRaised']; assert all(v == 0 for v in d.values()), d"
pass "ageing, expiring permits, tomorrow's install and quiet contacts are raised once and delivered"

# --- 6. quiet hours hold the homeowner's, not the PM's ------------------------
settz 23
q "insert into public.stage4_procurement (project_id, material_status, material_delivered_date) values ('$PA','delivered', current_date)
   on conflict (project_id) do update set material_status='delivered', material_delivered_date=current_date" >/dev/null
[ "$(n material_delivered "and user_id='$HOMEU'")" = 1 ] || fail "no material_delivered notification"
q "update public.projects set assigned_pm='$ADMIN' where id='$PB'" >/dev/null
[ "$(cron)" = 200 ] || fail "cron failed"
[ "$(q "select delivered_at is null from public.notifications where kind='material_delivered' and user_id='$HOMEU'")" = t ] || fail "a homeowner's notification was sent during quiet hours"
[ "$(q "select delivered_at is not null from public.notifications where kind='project_assigned' and user_id='$ADMIN'")" = t ] || fail "staff notifications were held by quiet hours"
settz 12
q "update public.notifications set deliver_after = now() where kind='material_delivered'" >/dev/null
[ "$(cron)" = 200 ] || fail "cron failed"
[ "$(q "select delivered_at is not null from public.notifications where kind='material_delivered' and user_id='$HOMEU'")" = t ] || fail "the held notification was not sent in the morning"
pass "quiet hours hold a homeowner's notifications until morning and never a PM's"

# --- 7. each feed is its own ------------------------------------------------
[ "$(api home GET '/api/notifications')" = 200 ] || fail "the homeowner's feed answered $(cat "$W/r.json")"
python3 - "$W/r.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
titles = [i['title'] for i in d['items']]
assert 'Your building permit is approved' in titles and 'Your solar project has started' in titles, titles
assert not any('Assigned to you' in t or 'PRJ-' in t for t in titles), titles
assert d['unread'] >= 5, d['unread']
assert all(i['url'].startswith('/portal') for i in d['items']), [i['url'] for i in d['items']]
PY
api home POST /api/notifications '{"all":true}' >/dev/null
api home GET '/api/notifications' >/dev/null
[ "$(j "d['unread']")" = 0 ] || fail "mark all read did not clear the homeowner's count"
api pm GET '/api/notifications' >/dev/null
python3 - "$W/r.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
titles = [i['title'] for i in d['items']]
assert any(t.startswith('Assigned to you: PRJ-') for t in titles), titles
assert any(t.startswith('Ageing: PRJ-') for t in titles), titles
assert any(t.startswith('Install tomorrow is not ready') for t in titles), titles
assert not any('Your ' in t for t in titles), titles
assert all(i['url'].startswith('/projects/') or i['url'].startswith('/pipeline') for i in d['items']), [i['url'] for i in d['items']]
PY
api dealer GET '/api/notifications' >/dev/null
python3 -c "
import json; d=json.load(open('$W/r.json')); t=[i['title'] for i in d['items']]
assert 'Project started for Hana Home' in t and 'Hana Home moved to Design' in t, t
assert all(i['url'].startswith('/dealers') for i in d['items']), t"
api rep GET '/api/notifications' >/dev/null
python3 -c "
import json; d=json.load(open('$W/r.json')); t=[i['title'] for i in d['items']]
assert 'New contact for you: Ed Emailonly' in t and 'Ed Emailonly has gone quiet' in t, t"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/notifications")" = 401 ] || fail "an anonymous feed request was answered"
pass "each person's feed holds their own notifications with links into their own screens"

# --- 8. the admin's switches -----------------------------------------------
[ "$(api admin GET /api/admin/notification-rules)" = 200 ] || fail "rules answered $(cat "$W/r.json")"
python3 -c "
import json; d=json.load(open('$W/r.json'))
kinds={r['kind']:r for r in d['rules']}; assert len(kinds) >= 50, len(kinds)
assert kinds['permit_approved']['last_30_days'] == 1, kinds['permit_approved']
assert d['settings']['contact_stale_days'] == 7, d['settings']"
[ "$(api pm PUT /api/admin/notification-rules '{"kind":"survey_completed","enabled":false}')" = 403 ] || fail "a PM changed the rules"
[ "$(api admin PUT /api/admin/notification-rules '{"kind":"survey_completed","enabled":false}')" = 200 ] || fail "disabling a rule failed: $(cat "$W/r.json")"
api pm PATCH /api/projects/$PA/stages/survey '{"values":{"survey_status":"completed","survey_completed_date":"2026-10-05"}}' >/dev/null
[ "$(n survey_completed)" = 0 ] || fail "a disabled notification was still raised"
[ "$(api admin PUT /api/admin/notification-rules '{"settings":{"contact_stale_days":3,"deal_stale_days":10,"permit_expiry_warning_days":21,"briefing_hour":6}}')" = 200 ] || fail "saving timing failed"
[ "$(q "select contact_stale_days || '|' || permit_expiry_warning_days || '|' || briefing_hour from public.app_settings")" = "3|21|6" ] || fail "the timing settings did not save"
[ "$(api admin PUT /api/admin/notification-rules '{"kind":"nonsense","enabled":false}')" = 404 ] || fail "an unknown kind was accepted"
pass "an admin can switch any notification off, and set the timing; nobody else can"

# --- 9. the pages ----------------------------------------------------------
CODE=$(curl -s -o "$W/p.html" -w '%{http_code}' -b "$W/pm.txt" "$BASE/notifications")
[ "$CODE" = 200 ] || fail "/notifications answered $CODE"
text "$W/p.html" | grep -q "Assigned to you" || fail "the PM's notifications page is empty"
CODE=$(curl -s -o "$W/p.html" -w '%{http_code}' -b "$W/home.txt" "$BASE/portal/updates")
[ "$CODE" = 200 ] || fail "/portal/updates answered $CODE"
text "$W/p.html" | grep -q "Your building permit is approved" || fail "the homeowner's updates page is empty"
CODE=$(curl -s -o "$W/p.html" -w '%{http_code}' -b "$W/admin.txt" "$BASE/admin/notifications")
[ "$CODE" = 200 ] || fail "/admin/notifications answered $CODE"
CODE=$(curl -s -o "$W/p.html" -w '%{http_code}' -b "$W/pm.txt" "$BASE/pipeline")
text "$W/p.html" | grep -q "Notifications" || fail "the sidebar has no bell"
[ "$(curl -s -o /dev/null -w '%{http_code}' -b "$W/home.txt" "$BASE/notifications")" != 200 ] || fail "a homeowner reached the staff page"
pass "the notifications page, the homeowner's updates and the admin screen render"

echo "NOTIFICATIONS CHECKS PASSED"
