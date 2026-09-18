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
# Straight to the end, skipping everything between.
[ "$(move "$FRED" contract_signed)" = 200 ] || fail "a skip to Contract signed was refused"
[ "$(q "select contact_stage from public.clients where id='$FRED'")" = contract_signed \
  ] || fail "the skip did not stick"
pass "any stage to any stage: forwards, sideways, backwards and skipping"

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

mkdir -p "$W/shots"
bash "$ROOT/scripts/e2e/shoot.sh" "$BASE" "$JAR" /admin/people/stages "$W/shots/contact-stages.png" 1800 900 || true

echo "CONTACT STAGES CHECKS PASSED"
