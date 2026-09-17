#!/usr/bin/env bash
# Contact stages: the contact list as a board.
#
# The rules it has to keep are the Deals board's rules, because it moves the same
# deals: forward-only for a rep, a reason for going back, a reason for losing,
# and the stage gates in between. What it adds is the column the Deals board
# cannot have — people on file that nobody has opened a deal for.
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
AID=$(q "select id from public.profiles where email='admin@st.test'")
D=$(q "insert into public.dealers (name) values ('Helios') returning id")
LOSS=$(q "select id from public.deal_loss_reasons order by sort_order limit 1")
UTIL=$(q "insert into public.utilities (name, state) values ('Austin Energy','TX') returning id")

# Three people: one with nothing open, one at New, one already qualified.
BARE=$(q "insert into public.clients (first_name, last_name, email, phone)
  values ('Bea','Bare','bea@st.test','512-555-0600') returning id")
FRESH=$(q "insert into public.clients (first_name, last_name, email, phone)
  values ('Fred','Fresh','fred@st.test','512-555-0601') returning id")
FRESH_DEAL=$(q "insert into public.deals (client_id, dealer_id, stage, address)
  values ('$FRESH','$D','new','1 First Street') returning id")
QUAL=$(q "insert into public.clients (first_name, last_name, email, phone)
  values ('Quinn','Qualified','quinn@st.test','512-555-0602') returning id")
QUAL_DEAL=$(q "insert into public.deals (client_id, dealer_id, stage, address, homeowner_confirmed,
                 decision_maker_identified, roof_type_id, avg_monthly_bill, credit_band,
                 utility_id, next_action, next_action_at, first_contact_at, contact_count)
  values ('$QUAL','$D','qualified','2 Second Street', true, true,
          (select id from public.roof_types limit 1), 240, 'cash', '$UTIL',
          'Send the proposal', current_date + 2, now(), 2) returning id")
# A second deal on the same person: the board must still show them once.
q "insert into public.deals (client_id, dealer_id, stage, address)
   values ('$QUAL','$D','lost','3 Third Street')" >/dev/null
echo "==> fixture: one contact with no deal, one at New, one at Qualified with a second lost deal"

PORT=$APPPORT nohup npx next start -p $APPPORT >"$W/next.log" 2>&1 &
NEXT_PID=$!
for i in $(seq 1 60); do
  curl -sf "$BASE/api/health" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && fail "app never came up"; sleep 1
done
JAR="$W/admin.txt"
curl -s -o /dev/null -c "$JAR" -H 'content-type: application/json' \
  -d '{"email":"admin@st.test","password":"Password1234!","door":"staff"}' "$BASE/api/auth/login"

# --- 1. the board is in the sidebar, under Contacts --------------------
python3 - <<'CHECK'
import pathlib, re
src = pathlib.Path('/home/user/fable_5_pm_project/src/app/(app)/layout.tsx').read_text()
crm = src[src.index('const CRM'):src.index('const NAV')]
hrefs = re.findall(r"href: '([^']+)', label: '([^']+)'", crm)
labels = [h for h in hrefs]
assert ('/admin/people/stages', 'Contact stages') in labels, f'not in the CRM group: {labels}'
i = [h for h, _ in labels]
assert i.index('/admin/people/stages') == i.index('/admin/people') + 1, \
    f'Contact stages is not directly under Contacts: {i}'
# Sales work contacts too, so it has to be on their sidebar.
sales = src[src.index('  sales: ['):src.index('  designer:')]
assert '/admin/people/stages' in sales, 'sales cannot see the contact board'
print('NAV-OK')
CHECK
pass "Contact stages sits directly under Contacts in the CRM group, for sales too"

# --- 2. the board renders, one card per person -------------------------
CODE=$(curl -s -o "$W/board.html" -w '%{http_code}' -b "$JAR" "$BASE/admin/people/stages")
[ "$CODE" = 200 ] || fail "the board answered $CODE"
for col in "Not being worked" "New" "Contacted" "Qualified" "Proposal" "Negotiation" \
           "Contract out" "Won" "Lost"; do
  grep -q "$col" "$W/board.html" || fail "the board has no $col column"
done
# Counted as rendered cards, not raw occurrences: Next embeds the props in the
# page as well, so a plain grep finds every name twice.
python3 - "$W/board.html" <<'CARDS'
import re, sys
html = open(sys.argv[1], encoding='utf-8').read()
titles = re.findall(r'class="card-title"[^>]*>([^<]+)<', html)
for who in ('Bea Bare', 'Fred Fresh', 'Quinn Qualified'):
    n = titles.count(who)
    assert n == 1, f'{who} has {n} cards on the board — one card per person'
print('ONE-CARD-EACH-OK')
CARDS
grep -q "Start a deal" "$W/board.html" || fail "the intake column offers no way to start a deal"
pass "every contact appears exactly once, in the column for where they have got to"

# --- 3. a contact with nothing open is in the first column -------------
python3 - "$W/board.html" <<'CHECK'
import re, sys
html = open(sys.argv[1], encoding='utf-8').read()
cols = re.split(r'<section class="board-col', html)
def column_of(name):
    for c in cols[1:]:
        if name in c:
            return re.search(r'<span>([^<]+)</span>', c).group(1)
    raise AssertionError(f'{name} is not on the board at all')
assert column_of('Bea Bare') == 'Not being worked', column_of('Bea Bare')
assert column_of('Fred Fresh') == 'New', column_of('Fred Fresh')
# The person with two deals sits on the open one, not the lost one.
assert column_of('Quinn Qualified') == 'Qualified', column_of('Quinn Qualified')
print('COLUMNS-OK')
CHECK
pass "somebody with no deal waits in the first column, and two deals resolve to the open one"

# --- 4. starting a deal from the board ---------------------------------
CODE=$(curl -s -o "$W/start.json" -w '%{http_code}' -X POST -b "$JAR" -H 'content-type: application/json' \
  -d "{\"clientId\":\"$BARE\"}" "$BASE/api/deals")
[ "$CODE" = 201 ] || fail "starting a deal from the board answered $CODE: $(cat "$W/start.json")"
ROW=$(q "select stage || '|' || address from public.deals where client_id = '$BARE'")
[ "$ROW" = "new|Address to be confirmed" ] \
  || fail "the started deal is not a plain New with a placeholder address ($ROW)"
curl -s -o "$W/board2.html" -b "$JAR" "$BASE/admin/people/stages"
python3 - "$W/board2.html" <<'CHECK'
import re, sys
html = open(sys.argv[1], encoding='utf-8').read()
cols = re.split(r'<section class="board-col', html)
for c in cols[1:]:
    if 'Bea Bare' in c:
        assert re.search(r'<span>([^<]+)</span>', c).group(1) == 'New', 'Bea did not move to New'
        break
else:
    raise AssertionError('Bea fell off the board')
print('STARTED-OK')
CHECK
pass "Start a deal puts somebody on the board at New, with no invented address"

# --- 5. the board moves the same deal, under the same gates ------------
# Fred is at New with no two-way contact logged: the gate refuses him.
CODE=$(curl -s -o "$W/gate.json" -w '%{http_code}' -X POST -b "$JAR" -H 'content-type: application/json' \
  -d '{"move":"to","target":"contacted","via":"drag"}' "$BASE/api/deals/$FRESH_DEAL/move")
[ "$CODE" != 200 ] || fail "the board moved a deal out of New with no contact logged"
grep -qi "missing\|contact" "$W/gate.json" || fail "the refusal does not say what is missing"
[ "$(q "select stage from public.deals where id='$FRESH_DEAL'")" = new ] \
  || fail "a refused move changed the stage anyway"
# Quinn has everything Proposal asks for.
CODE=$(curl -s -o "$W/move.json" -w '%{http_code}' -X POST -b "$JAR" -H 'content-type: application/json' \
  -d '{"move":"to","target":"proposal","via":"drag"}' "$BASE/api/deals/$QUAL_DEAL/move")
[ "$CODE" = 200 ] || fail "a legitimate move from the board answered $CODE: $(cat "$W/move.json")"
[ "$(q "select stage from public.deals where id='$QUAL_DEAL'")" = proposal \
  ] || fail "the move did not stick"
# Logged as deal.<target>, with kind stage_move — the same entry the Deals board
# writes, because it is the same service.
[ "$(q "select count(*) from public.audit_log
        where entity_id = '$QUAL_DEAL'::text and action = 'deal.proposal'")" -gt 0 ] \
  || fail "the move was not logged"
pass "dragging on this board moves the deal behind the contact, gates and audit log included"

# --- 6. what the board refuses ------------------------------------------
python3 - <<'CHECK'
import pathlib
src = pathlib.Path(
  '/home/user/fable_5_pm_project/src/app/(app)/admin/people/stages/ContactStageBoard.tsx'
).read_text()
# Every refusal a rep can hit has to be a sentence, not a silent snap-back.
for phrase in ['cannot be un-started', 'no deal yet', 'forward-only', 'won deal is a project']:
    assert phrase in src, f'the board does not explain: {phrase}'
# Won cards are not draggable, and neither is anything in the intake column.
assert "card.column !== NO_DEAL && card.column !== 'won'" in src, 'the wrong cards are draggable'
print('REFUSALS-OK')
CHECK
pass "the board says why in a sentence whenever it refuses a drag"

# --- 7. who can open it --------------------------------------------------
DEALERU=$(q "insert into auth.users (email, encrypted_password, email_confirmed_at, raw_app_meta_data)
  values ('dealer@st.test', extensions.crypt('Password1234!', extensions.gen_salt('bf',12)), now(),
          '{\"user_role\":\"dealer\"}'::jsonb) returning id")
q "insert into public.dealer_users (dealer_id, user_id) values ('$D','$DEALERU')" >/dev/null
curl -s -o /dev/null -c "$W/dealer.txt" -H 'content-type: application/json' \
  -d '{"email":"dealer@st.test","password":"Password1234!","door":"dealer"}' "$BASE/api/auth/login"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$W/dealer.txt" "$BASE/admin/people/stages")
[ "$CODE" != 200 ] || fail "a dealer opened the contact board"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/people/stages")
[ "$CODE" != 200 ] || fail "the contact board is open to anonymous visitors"
pass "the board is staff-only"

mkdir -p "$W/shots"
bash "$ROOT/scripts/e2e/shoot.sh" "$BASE" "$JAR" /admin/people/stages "$W/shots/contact-stages.png" 1600 1000 || true

echo "CONTACT STAGES CHECKS PASSED"
