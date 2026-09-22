#!/usr/bin/env bash
# Contact stages: the contact list as a board, in the stages the business works.
#
# Created · Appointment scheduled · Appointment rescheduled · No-show · Quoted ·
# Financing approved · Contract signed · Lost.
#
# The rule that matters here is the one the deal board does not have: any stage
# to any stage. Half the real movement is sideways or backwards — a no-show goes
# back to rescheduled, somebody quoted in March rings in September — and a board
# that refused those moves would be a board people worked around.
set -euo pipefail

ROOT=/home/user/fable_5_pm_project
W=/tmp/pmdb-stages
PGPORT=54415
APPPORT=3155
DB=pm_stages
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
PSQL=(psql -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1 -qtA)
cd "$ROOT"
q() { "${PSQL[@]}" -c "$1"; }

node scripts/create-admin.mjs admin@st.test "Password1234!" "Ada Admin" >/dev/null
D=$(q "insert into public.dealers (name) values ('Helios') returning id")

# Four people. One plain, one booked in, one already quoted with a deal behind
# them, and one who has been written off.
BEA=$(q "insert into public.clients (first_name, last_name, email, phone)
  values ('Bea','Bare','bea@st.test','512-555-0600') returning id")
FRED=$(q "insert into public.clients (first_name, last_name, email, phone, contact_stage)
  values ('Fred','Fresh','fred@st.test','512-555-0601','appointment_scheduled') returning id")
QUINN=$(q "insert into public.clients (dealer_id, first_name, last_name, email, phone,
             contact_stage, mailing_city, mailing_state)
  values ('$D','Quinn','Quoted','quinn@st.test','512-555-0602','quoted','Austin','TX') returning id")
q "insert into public.deals (client_id, dealer_id, stage, address)
   values ('$QUINN','$D','proposal','2 Second Street')" >/dev/null
LOU=$(q "insert into public.clients (first_name, last_name, email, contact_stage)
  values ('Lou','Lost','lou@st.test','lost') returning id")
echo "==> fixture: four contacts, across four stages"

PORT=$APPPORT nohup npx next start -p $APPPORT >"$W/next.log" 2>&1 &
NEXT_PID=$!
for i in $(seq 1 60); do
  curl -sf "$BASE/api/health" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && fail "app never came up"; sleep 1
done
JAR="$W/admin.txt"
curl -s -o /dev/null -c "$JAR" -H 'content-type: application/json' \
  -d '{"email":"admin@st.test","password":"Password1234!","door":"staff"}' "$BASE/api/auth/login"

# --- 1. the stages asked for, in order, and nothing else ----------------
python3 - <<'CHECK'
import pathlib, re
WANTED = ['Contact created', 'Appointment scheduled', 'Appointment rescheduled', 'No-show',
          'Quoted', 'Financing approved', 'Contract signed', 'Lost']
src = pathlib.Path('/home/user/fable_5_pm_project/src/lib/contacts/stage-columns.ts').read_text()
block = src[src.index('STAGE_COLUMN_LABELS'):src.index('STAGE_COLUMN_MEANS')]
labels = re.findall(r":\s*'([^']+)'", block)
assert labels == WANTED, f'the board has {labels}'
# The database will only accept these eight, so a typo in one place fails here.
sql = pathlib.Path('/home/user/fable_5_pm_project/db/migrations/20260803003800_contact_stages.sql').read_text()
values = re.findall(r"contact_stage in \(([^)]*)\)", sql, re.S)[0]
values = sorted(re.findall(r"'([a-z_]+)'", values))
keys = sorted(re.findall(r"^  '([a-z_]+)',$", src, re.M))
assert values == keys, f'the check constraint has {values}, the board has {keys}'
print('STAGES-OK', len(keys))
CHECK
pass "the eight stages asked for, in order, matching what the database will accept"

# --- 2. the board renders them, one card per contact --------------------
CODE=$(curl -s -o "$W/board.html" -w '%{http_code}' -b "$JAR" "$BASE/admin/people/stages")
[ "$CODE" = 200 ] || fail "the board answered $CODE"
for col in "Contact created" "Appointment scheduled" "Appointment rescheduled" "No-show" \
           "Quoted" "Financing approved" "Contract signed" "Lost"; do
  grep -q "$col" "$W/board.html" || fail "the board has no $col column"
done
python3 - "$W/board.html" <<'CARDS'
import re, sys
html = open(sys.argv[1], encoding='utf-8').read()
titles = re.findall(r'class="card-title"[^>]*>([^<]+)<', html)
for who in ('Bea Bare', 'Fred Fresh', 'Quinn Quoted', 'Lou Lost'):
    assert titles.count(who) == 1, f'{who} has {titles.count(who)} cards'
cols = re.split(r'<section class="board-col', html)
def column_of(name):
    for c in cols[1:]:
        if name in c:
            return re.search(r'<span>([^<]+)</span>', c).group(1)
    raise AssertionError(f'{name} is not on the board')
assert column_of('Bea Bare') == 'Contact created', column_of('Bea Bare')
assert column_of('Fred Fresh') == 'Appointment scheduled', column_of('Fred Fresh')
assert column_of('Quinn Quoted') == 'Quoted', column_of('Quinn Quoted')
assert column_of('Lou Lost') == 'Lost', column_of('Lou Lost')
print('COLUMNS-OK')
CARDS
# Lost is red, the way signed is green: the two ends of the board are the two
# that have to be told apart at a glance, without reading the headings.
python3 - "$W/board.html" <<'RED'
import pathlib, re, sys
html = open(sys.argv[1], encoding='utf-8').read()
lost = [c for c in re.split(r'<section class="', html)[1:] if 'Lou Lost' in c][0]
classes = lost[:lost.index('"')].split()
assert 'lost' in classes, f'the Lost column carries no lost class: {classes}'
css = pathlib.Path('/home/user/fable_5_pm_project/src/app/globals.css').read_text()
block = css[css.index('.contact-board .board-col.lost {'):][:200]
assert 'background: #f7e6e4' in block, block
assert '--danger' in block, block
assert '.contact-board .board-col.lost > header' in css, 'the Lost heading is not coloured'
print('RED-OK')
RED
# Every contact is on it from the moment they exist — no waiting room.
grep -q "Start a deal" "$W/board.html" && fail "the board still asks for a deal to be started"
pass "every contact has a card, in the column their own stage says"

# --- 3. the board is given the width --------------------------------------
grep -q "full-bleed" "$W/board.html" || fail "the board is still held to the narrow page width"
grep -q "contact-board" "$W/board.html" || fail "the board does not use the eight-column layout"
python3 - <<'CHECK'
import pathlib
css = pathlib.Path('/home/user/fable_5_pm_project/src/app/globals.css').read_text()
block = css[css.index('.surface.full-bleed'):]
assert 'max-width: none' in block[:200], 'full-bleed does not drop the max width'
print('WIDTH-OK')
CHECK
pass "the board runs the full width of the window"

# --- 4. dragging: forwards, sideways and back ---------------------------
move() {
  curl -s -o "$W/move.json" -w '%{http_code}' -X POST -b "$JAR" \
    -H 'content-type: application/json' -d "{\"stage\":\"$2\"}" \
    "$BASE/api/contacts/$1/stage"
}
[ "$(move "$BEA" appointment_scheduled)" = 200 ] || fail "booking Bea in was refused: $(cat "$W/move.json")"
[ "$(q "select contact_stage from public.clients where id='$BEA'")" = appointment_scheduled ] \
  || fail "Bea did not move"
# Sideways: scheduled to rescheduled, then to a no-show.
[ "$(move "$BEA" appointment_rescheduled)" = 200 ] || fail "rescheduling was refused"
[ "$(move "$BEA" no_show)" = 200 ] || fail "a no-show was refused"
# And back again, which a forward-only board would not allow.
[ "$(move "$BEA" appointment_rescheduled)" = 200 ] || fail "going back to rescheduled was refused"
[ "$(q "select contact_stage from public.clients where id='$BEA'")" = appointment_rescheduled \
  ] || fail "the backwards move did not stick"
# A lost contact comes back to life.
[ "$(move "$LOU" appointment_scheduled)" = 200 ] || fail "reviving a lost contact was refused"
# Straight to the end, skipping everything between — which is allowed, but
# Contract signed is a step rather than a drop: the plain move is sent back to
# the signing form, and the contact stays put until the system is recorded.
[ "$(move "$FRED" contract_signed)" = 409 ] || fail "a bare move into Contract signed was not sent to signing: $(cat "$W/move.json")"
grep -q '"needsSigning":true' "$W/move.json" || fail "the refusal does not say to sign"
[ "$(q "select contact_stage from public.clients where id='$FRED'")" = appointment_scheduled \
  ] || fail "a refused move into Contract signed moved Fred anyway"
sign() {
  curl -s -o "$W/sign.json" -w '%{http_code}' -X POST -b "$JAR" \
    -H 'content-type: application/json' -d "$2" "$BASE/api/contacts/$1/sign"
}
[ "$(sign "$FRED" "{\"values\":{\"system_size_kw\":6.6,\"dealer_id\":\"$D\",\"address\":\"1 Fresh Lane, Austin, TX\"}}")" = 200 ] \
  || fail "signing Fred was refused: $(cat "$W/sign.json")"
[ "$(q "select contact_stage from public.clients where id='$FRED'")" = contract_signed \
  ] || fail "the skip did not stick"
pass "any stage to any stage: forwards, sideways, backwards and skipping — signing through its form"

# --- 5. what it refuses, and what it records ----------------------------
[ "$(move "$BEA" "not_a_stage")" = 400 ] || fail "an invented stage was accepted"
grep -qi "not a contact stage" "$W/move.json" || fail "the refusal does not say what was wrong"
[ "$(q "select contact_stage from public.clients where id='$BEA'")" = appointment_rescheduled ] \
  || fail "a refused move changed the stage anyway"
# Every move is in the activity log, with where it came from and where it went.
N=$(q "select count(*) from public.audit_log
        where action = 'contact.stage_moved' and entity_id = '$BEA'::text")
[ "$N" = 4 ] || fail "expected four logged moves for Bea, found $N"
ROW=$(q "select (context ->> 'from') || '→' || (context ->> 'to') from public.audit_log
          where action = 'contact.stage_moved' and entity_id = '$BEA'::text
          order by occurred_at desc, id desc limit 1")
[ "$ROW" = "no_show→appointment_rescheduled" ] || fail "the log does not carry the move ($ROW)"
# The clock restarts on a move, and only on a move.
q "update public.clients set phone = '512-555-9999' where id = '$BEA'" >/dev/null
DAYS=$(q "select floor(extract(epoch from (now() - contact_stage_at)))::int from public.clients where id='$BEA'")
[ "$DAYS" -lt 60 ] || fail "editing a phone number restarted the stage clock"
pass "an invented stage is refused, and every real move is logged with its direction"

# --- 6. the same stage on the contact record ----------------------------
R=$(curl -s -b "$JAR" "$BASE/api/customers/$QUINN/intake")
grep -q '"contact_stage":"quoted"' <<<"$R" || fail "the record does not carry the stage: $R"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -b "$JAR" -H 'content-type: application/json' \
  -d '{"values":{"contact_stage":"financing_approved"}}' "$BASE/api/customers/$QUINN/intake")
[ "$CODE" = 200 ] || fail "setting the stage from the record answered $CODE"
[ "$(q "select contact_stage from public.clients where id='$QUINN'")" = financing_approved \
  ] || fail "the record's Lead status does not move the contact"
pass "Lead status on the record and the column on the board are the same field"

# --- 7. who may move a contact -------------------------------------------
DEALERU=$(q "insert into auth.users (email, encrypted_password, email_confirmed_at, raw_app_meta_data)
  values ('dealer@st.test', extensions.crypt('Password1234!', extensions.gen_salt('bf',12)), now(),
          '{\"user_role\":\"dealer\"}'::jsonb) returning id")
q "insert into public.dealer_users (dealer_id, user_id) values ('$D','$DEALERU')" >/dev/null
curl -s -o /dev/null -c "$W/dealer.txt" -H 'content-type: application/json' \
  -d '{"email":"dealer@st.test","password":"Password1234!","door":"dealer"}' "$BASE/api/auth/login"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$W/dealer.txt" \
  -H 'content-type: application/json' -d '{"stage":"lost"}' "$BASE/api/contacts/$QUINN/stage")
[ "$CODE" != 200 ] || fail "a dealer moved a contact"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -d '{"stage":"lost"}' "$BASE/api/contacts/$QUINN/stage")
[ "$CODE" != 200 ] || fail "an anonymous visitor moved a contact"
[ "$(q "select contact_stage from public.clients where id='$QUINN'")" = financing_approved ] \
  || fail "a refused move changed the stage anyway"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$W/dealer.txt" "$BASE/admin/people/stages")
[ "$CODE" != 200 ] || fail "a dealer opened the contact board"
pass "the board and the move are staff-only"

# --- 8. signing records the system, and only then does the record show it --
# Quinn is quoted-then-approved with an open proposal deal and no system on it.
tabs() { curl -s -b "$JAR" "$BASE/admin/people/$1" | grep -c '>System</button>' || true; }
[ "$(tabs "$QUINN")" = 0 ] || fail "an unsigned contact already shows a System tab"
QDEAL=$(q "select id from public.deals where client_id='$QUINN'")
# The signed agreement, filed against the deal before signing as the record's
# uploads do. It has to survive the project being deleted later.
q "insert into public.documents (deal_id, bucket, object_path, category, title)
   values ('$QDEAL','documents','deal/agreement.pdf','signed_installation_agreement','agreement.pdf')" >/dev/null

# The project cannot be made without a dealer or a site: Bea has neither.
[ "$(sign "$BEA" '{"values":{"system_size_kw":5}}')" = 400 ] || fail "signing with no dealer was accepted"
grep -q '"missing":\["dealer_id"\]' "$W/sign.json" || fail "the refusal does not point at the dealer: $(cat "$W/sign.json")"
[ "$(sign "$BEA" "{\"values\":{\"system_size_kw\":5,\"dealer_id\":\"$D\"}}")" = 400 ] || fail "signing with no site address was accepted"
grep -q '"missing":\["address"\]' "$W/sign.json" || fail "the refusal does not point at the address: $(cat "$W/sign.json")"
[ "$(q "select count(*) from public.deals where client_id='$BEA'")" = 0 ] || fail "a refused signing left a deal behind"

# Nothing without a size, and nothing moves.
[ "$(sign "$QUINN" '{"values":{"contract_value":28000}}')" = 400 ] || fail "signing with no system size was accepted"
grep -q '"missing":\["system_size_kw"\]' "$W/sign.json" || fail "the refusal does not point at the size: $(cat "$W/sign.json")"
[ "$(q "select contact_stage from public.clients where id='$QUINN'")" = financing_approved ] \
  || fail "a refused signing moved Quinn"
[ "$(q "select system_recorded_at is null from public.deals where id='$QDEAL'")" = t ] \
  || fail "a refused signing marked the deal"

# With a size: on to the deal they already have — its dealer and address
# carried from the contact and the deal — 12.4 panels rounded to 12, and the
# owner left alone however the request dresses it up. And the project, made in
# the same step: the deal Won, the system and price copied across.
[ "$(sign "$QUINN" '{"values":{"system_size_kw":7.2,"module_quantity":12.4,"contract_value":28000,"financing_route":"loan","owner_id":null}}')" = 200 ] \
  || fail "signing Quinn was refused: $(cat "$W/sign.json")"
grep -q '"dealCreated":false' "$W/sign.json" || fail "Quinn's open deal was not the one signed: $(cat "$W/sign.json")"
grep -q '"projectCode":"PRJ-' "$W/sign.json" || fail "signing did not say which project it made: $(cat "$W/sign.json")"
ROW=$(q "select c.contact_stage || '|' || d.stage || '|' || d.system_size_kw || '|' || d.module_quantity || '|' ||
                d.contract_value || '|' || d.financing_route || '|' || (d.system_recorded_at is not null)
           from public.clients c join public.deals d on d.client_id = c.id where c.id = '$QUINN'")
[ "$ROW" = "contract_signed|won|7.200|12|28000.00|loan|true" ] || fail "the signing wrote the wrong thing ($ROW)"
QPRJ=$(q "select project_id from public.deals where id='$QDEAL'")
QCODE=$(q "select code from public.projects where id='$QPRJ'")
ROW=$(q "select stage || '|' || system_size_kw || '|' || module_quantity || '|' || contract_value || '|' || address || '|' || (dealer_id='$D')
           from public.projects where id='$QPRJ'")
[ "$ROW" = "survey|7.200|12|28000.00|2 Second Street|true" ] || fail "the project is not the signed contract ($ROW)"
[ "$(q "select project_id='$QPRJ' from public.documents where object_path='deal/agreement.pdf'")" = t ] \
  || fail "the signed agreement did not gain the project"

# Fred had no deal at all: signing made one with his size, and it is Won, with
# its project, and the dealer written onto Fred himself.
ROW=$(q "select count(*) || '|' || min(d.stage) || '|' || min(d.system_size_kw) || '|' || count(d.project_id)
           from public.deals d where d.client_id='$FRED'")
[ "$ROW" = "1|won|6.600|1" ] || fail "signing a contact with no deal did not make one and its project ($ROW)"
[ "$(q "select dealer_id='$D' from public.clients where id='$FRED'")" = t ] || fail "Fred did not gain the dealer"

# The record: no System tab before, one now — for both.
[ "$(tabs "$QUINN")" = 1 ] || fail "Quinn's record does not show the System tab after signing"
[ "$(tabs "$FRED")" = 1 ] || fail "Fred's record does not show the System tab after signing"
[ "$(tabs "$BEA")" = 0 ] || fail "Bea, who has not signed, shows a System tab"

# The Lead status box is the same door: a change to Contract signed is sent to
# the form, a save that leaves an already-signed contact signed is not.
CODE=$(curl -s -o "$W/patch.json" -w '%{http_code}' -X PATCH -b "$JAR" -H 'content-type: application/json' \
  -d '{"values":{"contact_stage":"contract_signed"}}' "$BASE/api/customers/$BEA/intake")
[ "$CODE" = 409 ] || fail "Lead status → Contract signed skipped the signing form ($CODE)"
[ "$(q "select contact_stage from public.clients where id='$BEA'")" = appointment_rescheduled ] \
  || fail "the refused Lead status change moved Bea"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -b "$JAR" -H 'content-type: application/json' \
  -d '{"values":{"contact_stage":"contract_signed","description":"Signed at the kitchen table"}}' \
  "$BASE/api/customers/$QUINN/intake")
[ "$CODE" = 200 ] || fail "saving an already-signed contact was refused ($CODE)"

# Written down, and staff-only.
[ "$(q "select count(*) from public.audit_log where action='contact.contract_signed' and client_id='$QUINN'")" = 1 ] \
  || fail "the signing is not in the activity log"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$W/dealer.txt" -H 'content-type: application/json' \
  -d '{"values":{"system_size_kw":5}}' "$BASE/api/contacts/$BEA/sign")
[ "$CODE" != 200 ] || fail "a dealer signed a contact"
pass "signing records the system and creates the project, and only then does the contact show it"

# --- 9. the project holds them in Contract signed until it is deleted ----
[ "$(move "$QUINN" quoted)" = 409 ] || fail "Quinn moved out of Contract signed with a project: $(cat "$W/move.json")"
grep -q '"projectHeld":true' "$W/move.json" || fail "the refusal does not say a project holds them"
grep -q "$QCODE" "$W/move.json" || fail "the refusal does not name the project"
[ "$(move "$QUINN" lost)" = 409 ] || fail "Quinn moved to Lost with a live project"
CODE=$(curl -s -o "$W/patch.json" -w '%{http_code}' -X PATCH -b "$JAR" -H 'content-type: application/json' \
  -d '{"values":{"contact_stage":"quoted"}}' "$BASE/api/customers/$QUINN/intake")
[ "$CODE" = 409 ] || fail "Lead status moved a held contact ($CODE)"
if q "update public.clients set contact_stage='created' where id='$QUINN'" >/dev/null 2>&1; then
  fail "SQL moved a held contact — the hold is not on the table"
fi
[ "$(q "select contact_stage from public.clients where id='$QUINN'")" = contract_signed ] || fail "a refused move moved Quinn"
# The screens say so before anybody tries.
curl -s -b "$JAR" "$BASE/api/customers/$QUINN/intake" | grep -q "\"code\":\"$QCODE\"" \
  || fail "the record does not know the project holds Quinn"
curl -s -o "$W/board2.html" -b "$JAR" "$BASE/admin/people/stages"
python3 - "$W/board2.html" "$QCODE" <<'HELD'
import re, sys
html, code = open(sys.argv[1], encoding='utf-8').read(), sys.argv[2]
card = [c for c in re.split(r'<article ', html)[1:] if 'Quinn Quoted' in c.split('</article>')[0]][0]
head = card[:card.index('>')]
assert 'held' in head, f'the card is not marked held: {head}'
assert 'draggable="false"' in head, f'the held card can still be picked up: {head}'
assert f'Project {code}' in card.split('</article>')[0], 'the card does not link its project'
bea = [c for c in re.split(r'<article ', html)[1:] if 'Bea Bare' in c.split('</article>')[0]][0]
assert 'draggable="true"' in bea[:bea.index('>')], 'an unheld card cannot be picked up'
print('HELD-OK')
HELD

# Deleting: admin only, the code typed back, and it keeps what the sale owns.
OPSU=$(q "insert into auth.users (email, encrypted_password, email_confirmed_at, raw_app_meta_data)
  values ('ops@st.test', extensions.crypt('Password1234!', extensions.gen_salt('bf',12)), now(),
          '{\"user_role\":\"ops\"}'::jsonb) returning id")
q "update public.profiles set role = 'ops', is_active = true where id = '$OPSU'" >/dev/null
curl -s -o /dev/null -c "$W/ops.txt" -H 'content-type: application/json' \
  -d '{"email":"ops@st.test","password":"Password1234!","door":"staff"}' "$BASE/api/auth/login"
del() { curl -s -o "$W/del.json" -w '%{http_code}' -X DELETE -b "$1" -H 'content-type: application/json' \
  -d "{\"confirm\":\"$2\"}" "$BASE/api/projects/$QPRJ"; }
[ "$(del "$W/ops.txt" "$QCODE")" = 403 ] || fail "ops deleted a project: $(cat "$W/del.json")"
[ "$(del "$JAR" "PRJ-WRONG")" = 400 ] || fail "a project was deleted with the wrong code: $(cat "$W/del.json")"
[ "$(q "select count(*) from public.projects where id='$QPRJ'")" = 1 ] || fail "a refused delete deleted anyway"
[ "$(del "$JAR" "$QCODE")" = 200 ] || fail "the admin could not delete the project: $(cat "$W/del.json")"
grep -q "\"clientId\":\"$QUINN\"" "$W/del.json" || fail "the delete does not say whose record to go back to"
[ "$(q "select count(*) from public.projects where id='$QPRJ'")" = 0 ] || fail "the project is still there"
ROW=$(q "select stage || '|' || (won_at is null) || '|' || (project_id is null) || '|' || system_size_kw from public.deals where id='$QDEAL'")
[ "$ROW" = "contract_out|true|true|7.200" ] || fail "the deal was not reopened with its system ($ROW)"
[ "$(q "select count(*) || '|' || (max(project_id::text) is null) from public.documents where object_path='deal/agreement.pdf'")" = "1|true" ] \
  || fail "deleting the project took the deal's signed agreement with it"
[ "$(q "select count(*) from public.audit_log where action='project.deleted' and client_id='$QUINN'")" = 1 ] \
  || fail "the delete is not in the activity log"
# Released: the move goes through now.
[ "$(move "$QUINN" quoted)" = 200 ] || fail "Quinn is still held after the project was deleted: $(cat "$W/move.json")"
pass "a project holds its contact in Contract signed on every path, until an admin deletes it"

mkdir -p "$W/shots"
bash "$ROOT/scripts/e2e/shoot.sh" "$BASE" "$JAR" /admin/people/stages "$W/shots/contact-stages.png" 1800 900 || true

echo "CONTACT STAGES CHECKS PASSED"
