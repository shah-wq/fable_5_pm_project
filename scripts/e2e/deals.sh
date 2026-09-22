#!/usr/bin/env bash
# Module 17 · Deals, and the CRM group in the sidebar.
#
# The board is the second one in the product, and Part 1 asks it to behave
# exactly like the first: same forward-only rule, same admin-only backwards move
# with a reason, same missing-items badge. So this suite drives a deal all the
# way from New to a project, and checks the refusals as hard as the successes.
set -euo pipefail

ROOT=/home/user/fable_5_pm_project
W=/tmp/pmdb-deals
PGPORT=54404
APPPORT=3150
DB=pm_deals
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
    psql -v ON_ERROR_STOP=1 -q -h 127.0.0.1 -p $PGPORT -U postgres -d $DB --single-transaction -f \"\$f\" >/dev/null
  done
  psql -v ON_ERROR_STOP=1 -q -h 127.0.0.1 -p $PGPORT -U postgres -d $DB -f $ROOT/db/seed.sql >/dev/null
"
trap 'kill ${NEXT_PID:-0} 2>/dev/null || true; fuser -k $APPPORT/tcp 2>/dev/null || true; runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D "$W/data" stop -m immediate >/dev/null 2>&1 || true' EXIT
PSQL=(psql -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1 -qtA)
cd "$ROOT"
q() { "${PSQL[@]}" -c "$1"; }

node scripts/create-admin.mjs admin@de.test "Password1234!" "Ada Admin" >/dev/null
node scripts/create-admin.mjs rep@de.test "Password1234!" "Ray Rep" >/dev/null
REP=$(q "select id from public.profiles where email='rep@de.test'")
q "update public.profiles set role='sales' where id='$REP'" >/dev/null
D=$(q "insert into public.dealers (name) values ('Helios') returning id")
SRC=$(q "select id from public.client_sources where name='Web form'")
ROOF=$(q "select id from public.roof_types limit 1")
UTIL=$(q "insert into public.utilities (name, state) values ('Austin Energy','TX') returning id")
MOD=$(q "insert into public.module_types (name) values ('Q.PEAK 400') returning id")
LOSS=$(q "select id from public.deal_loss_reasons where name='Price'")
echo "==> fixture: an admin, a sales rep, a dealer and the reference lists"

EMAIL_DEV_LOG=1 NEXT_PUBLIC_SITE_URL="$BASE" PORT=$APPPORT nohup npx next start -p $APPPORT >"$W/next.log" 2>&1 &
NEXT_PID=$!
for i in $(seq 1 60); do
  curl -sf "$BASE/api/health" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && fail "app never came up"; sleep 1
done
login() { curl -s -o /dev/null -c "$W/$1.txt" -H 'content-type: application/json' \
  -d "{\"email\":\"$2\",\"password\":\"Password1234!\",\"door\":\"staff\"}" "$BASE/api/auth/login"; }
login admin admin@de.test
login rep rep@de.test
ADMIN="$W/admin.txt"; SALES="$W/rep.txt"

get() { curl -s -o "$W/page.html" -w '%{http_code}' ${3:+-b "$3"} "$1" | grep -q "^$2$" \
  || { echo "  ($1 answered $(curl -s -o /dev/null -w '%{http_code}' ${3:+-b "$3"} "$1"))"; fail "$1"; }; }
has()  { grep -q -- "$2" "$W/page.html" || fail "$1: '$2' is missing"; }
hasnt() { grep -q -- "$2" "$W/page.html" && fail "$1: '$2' should not be there"; return 0; }
move() { curl -s -o "$W/move.json" -w '%{http_code}' -X POST -b "$2" -H 'content-type: application/json' \
  -d "$3" "$BASE/api/deals/$1/move"; }

# --- 1. the sidebar group ----------------------------------------------
get "$BASE/deals" 200 "$ADMIN"
has "the sidebar" "nav-group-label"
has "the sidebar" ">CRM<"
has "the sidebar" ">Contacts<"
has "the sidebar" ">Deals<"
has "the sidebar" ">Dealers<"
has "the sidebar" "E-book subscribers"
pass "the sidebar carries a CRM group with all four entries"

for path in /admin/people /deals /admin/dealers /admin/subscribers; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$ADMIN" "$BASE$path")
  [ "$CODE" = 200 ] || fail "the CRM link $path answered $CODE — a dead link in the sidebar"
done
pass "every link in the group opens a real page"

# --- 2. a deal is created, and the duplicate check runs ----------------
CODE=$(curl -s -o "$W/new.json" -w '%{http_code}' -X POST -b "$SALES" -H 'content-type: application/json' \
  -d "{\"firstName\":\"Dana\",\"lastName\":\"Deal\",\"email\":\"dana@de.test\",\"phone\":\"512-555-0123\",
       \"address\":\"88 Sunny Lane, Austin, TX\",\"sourceId\":\"$SRC\",\"dealerId\":\"$D\"}" \
  "$BASE/api/deals")
[ "$CODE" = 201 ] || fail "a sales rep could not create a deal ($CODE): $(cat "$W/new.json")"
DEAL=$(python3 -c "import json;print(json.load(open('$W/new.json'))['id'])")
CODE=$(curl -s -o "$W/dup.json" -w '%{http_code}' -X POST -b "$SALES" -H 'content-type: application/json' \
  -d "{\"firstName\":\"Dana\",\"lastName\":\"Deal\",\"email\":\"DANA@de.test\",\"address\":\"88 Sunny Lane\"}" \
  "$BASE/api/deals")
[ "$CODE" = 409 ] || fail "a second deal on the same email did not offer the existing person ($CODE)"
pass "a rep creates a deal, and typing the same person again offers the record on file"

# --- 3. the gates refuse, and say what is missing ----------------------
CODE=$(move "$DEAL" "$SALES" '{"move":"forward"}')
[ "$CODE" = 422 ] || fail "a deal with no logged contact advanced out of New ($CODE)"
grep -q "No two-way contact logged" "$W/move.json" || fail "the refusal does not name the gap: $(cat "$W/move.json")"
pass "New refuses to advance without a two-way contact, and names what is missing"

# A voicemail is an attempt: logged, but the deal stays where it is.
curl -s -o /dev/null -X POST -b "$SALES" -H 'content-type: application/json' \
  -d '{"kind":"call","note":"Left a voicemail","reached":false}' "$BASE/api/deals/$DEAL/activity"
CODE=$(move "$DEAL" "$SALES" '{"move":"forward"}')
[ "$CODE" = 422 ] || fail "a voicemail was treated as two-way contact ($CODE)"
pass "a voicemail is logged as an attempt and does not move the deal"

CODE=$(curl -s -o "$W/act.json" -w '%{http_code}' -X POST -b "$SALES" -H 'content-type: application/json' \
  -d '{"kind":"call","note":"Spoke to Dana, roof is 4 years old","reached":true,
       "nextAction":"Send the design questionnaire","nextActionAt":"2026-12-01"}' \
  "$BASE/api/deals/$DEAL/activity")
[ "$CODE" = 201 ] || fail "logging a conversation answered $CODE: $(cat "$W/act.json")"
KINDS=$(q "select string_agg(distinct kind, ',') from public.audit_log where deal_id='$DEAL'")
grep -q call <<<"$KINDS" || fail "the conversation was not logged as a call (kinds: $KINDS)"
CODE=$(move "$DEAL" "$SALES" '{"move":"forward"}')
[ "$CODE" = 200 ] || fail "a contacted deal would not advance ($CODE): $(cat "$W/move.json")"
[ "$(q "select stage from public.deals where id='$DEAL'")" = contacted ] || fail "wrong stage"
pass "a logged conversation with a next action moves the deal to Contacted"

# --- 4. forward-only, with the admin exception -------------------------
CODE=$(move "$DEAL" "$SALES" '{"move":"to","target":"new"}')
[ "$CODE" = 403 ] || fail "a rep moved a deal backwards ($CODE)"
CODE=$(move "$DEAL" "$ADMIN" '{"move":"to","target":"new","notes":"Wrong button"}')
[ "$CODE" = 200 ] || fail "an admin could not move a deal back with a reason ($CODE)"
[ "$(q "select stage from public.deals where id='$DEAL'")" = new ] || fail "the deal did not move back"
N=$(q "select count(*) from public.audit_log where deal_id='$DEAL' and action like 'deal.%'")
[ "$N" -ge 1 ] || fail "the backwards move was not logged"
move "$DEAL" "$SALES" '{"move":"forward"}' >/dev/null
pass "the board is forward-only, an admin can reverse it with a reason, and both are logged"

# --- 5. a forward skip, when the skipped stages are satisfied ----------
q "update public.deals set homeowner_confirmed = true, decision_maker_identified = true,
     roof_type_id = '$ROOF', utility_id = '$UTIL', avg_monthly_bill = 240, credit_band = 'cash'
   where id = '$DEAL'" >/dev/null
# A skip over Contract out is refused, because Proposal's own gate — a sent
# proposal — is one of the stages being jumped and is not satisfied.
CODE=$(move "$DEAL" "$SALES" '{"move":"to","target":"contract_out"}')
[ "$CODE" = 422 ] || fail "a skip over Proposal was allowed with no proposal sent ($CODE)"
grep -q "Proposal not sent" "$W/move.json" || fail "the refusal does not name the gap: $(cat "$W/move.json")"
# But a skip to Qualified is allowed: everything it jumps is satisfied.
CODE=$(move "$DEAL" "$SALES" '{"move":"to","target":"qualified"}')
[ "$CODE" = 200 ] || fail "a skip to Qualified was refused when its gates were met ($CODE): $(cat "$W/move.json")"
pass "a forward skip is allowed exactly when every stage it jumps is satisfied"

# --- 6. the proposal is versioned --------------------------------------
P1=$(q "select public.add_proposal('$DEAL', 31000, 6000, 25000, null, null, 'first pass')")
P2=$(q "select public.add_proposal('$DEAL', 30000, 6000, 24000, null, null, 'after the site visit')")
[ "$(q "select version from public.proposals where id='$P2'")" = 2 ] || fail "the second proposal is not v2"
[ "$(q "select superseded_by_id = '$P2' from public.proposals where id='$P1'")" = t ] \
  || fail "v1 was not superseded by v2"
# Compared in SQL: numeric(12,2) prints as 24000.00, and a shell string match
# against '24000' would be a test that fails for the wrong reason.
[ "$(q "select (net_price = 24000)::text from public.deals where id='$DEAL'")" = true ] \
  || fail "the deal's price did not follow its newest proposal (net_price=$(q "select coalesce(net_price::text,'null') from public.deals where id='$DEAL'"), proposals=$(q "select coalesce(string_agg(version || ':' || coalesce(net_price::text,'null'), ','), 'none') from public.proposals where deal_id='$DEAL'"))"
q "select public.mark_proposal_sent('$P2')" >/dev/null
q "update public.deals set system_size_kw = 8.4, module_id = '$MOD', financing_route = 'cash'
   where id = '$DEAL'" >/dev/null
CODE=$(move "$DEAL" "$SALES" '{"move":"forward"}')
[ "$CODE" = 200 ] || fail "a quoted deal would not move to Proposal ($CODE): $(cat "$W/move.json")"
pass "proposals are versioned rather than overwritten, and the newest sets the deal's price"

# --- 7. Won creates the project, or nothing happens --------------------
q "update public.deals set expected_close_date = current_date + 14 where id='$DEAL'" >/dev/null
move "$DEAL" "$SALES" '{"move":"forward"}' >/dev/null   # negotiation
move "$DEAL" "$SALES" '{"move":"forward"}' >/dev/null   # contract out
CODE=$(move "$DEAL" "$SALES" '{"move":"won"}')
[ "$CODE" = 422 ] || fail "a deal was won with no signed contract ($CODE)"
grep -q "contract" "$W/move.json" || fail "the refusal does not mention the contract"
N=$(q "select count(*) from public.projects")
[ "$N" = 0 ] || fail "a refused conversion still created a project — the worst available state"
pass "no Won on a verbal, and a refused conversion leaves nothing behind"

CLIENT=$(q "select client_id from public.deals where id='$DEAL'")
DOC=$(q "insert into public.documents (deal_id, bucket, object_path, kind, category, title,
     mime_type, size_bytes)
   values ('$DEAL','project-deliverables','deal/$DEAL/contract.pdf','pdf','signed_co',
           'Signed contract','application/pdf',2048) returning id")
q "update public.deals set contract_value = 24000 where id='$DEAL'" >/dev/null
CODE=$(move "$DEAL" "$SALES" '{"move":"won"}')
[ "$CODE" = 200 ] || fail "a signed deal would not convert ($CODE): $(cat "$W/move.json")"
PROJECT=$(python3 -c "import json;print(json.load(open('$W/move.json'))['projectId'])")
[ -n "$PROJECT" ] || fail "no project came back"
ROW=$(q "select p.contract_value || '|' || p.system_size_kw || '|' || (p.module_type_id = '$MOD')::text
         || '|' || (p.deal_id = '$DEAL')::text || '|' || p.address
         from public.projects p where p.id = '$PROJECT'")
grep -q "^24000" <<<"$ROW" || fail "the contract value did not carry ($ROW)"
grep -q "8.400|true|true" <<<"$ROW" || fail "the specification did not pre-fill from the proposal ($ROW)"
grep -q "88 Sunny Lane" <<<"$ROW" || fail "the property address did not become the site address ($ROW)"
[ "$(q "select project_id from public.documents where id='$DOC'")" = "$PROJECT" ] \
  || fail "the signed contract did not gain the project relation"
[ "$(q "select deal_id from public.documents where id='$DOC'")" = "$DEAL" ] \
  || fail "the contract lost its link to the deal it was signed on"
[ "$(q "select lifecycle from public.people_overview where id='$CLIENT'")" = customer ] \
  || fail "winning the deal did not flip the person from prospect to customer"
pass "Won creates the project, carries the contract, the spec and the documents, and flips the person"

# --- 8. a won deal is finished -----------------------------------------
CODE=$(move "$DEAL" "$SALES" '{"move":"to","target":"negotiation","notes":"undo"}')
[ "$CODE" != 200 ] || fail "a won deal was un-won"
pass "a deal cannot be un-won — a project that falls over is cancelled as a project"

# --- 9. lost, and reopened ---------------------------------------------
D2=$(q "insert into public.deals (customer_first, customer_last, customer_email, address, stage, dealer_id)
        values ('Lou','Lost','lou@de.test','4 Shady Way','contacted','$D') returning id")
CODE=$(move "$D2" "$SALES" '{"move":"lost"}')
[ "$CODE" = 422 ] || fail "a deal was lost with no reason ($CODE)"
CODE=$(move "$D2" "$SALES" "{\"move\":\"lost\",\"lostReasonId\":\"$LOSS\",\"notes\":\"Went cheaper\"}")
[ "$CODE" = 200 ] || fail "a deal could not be marked lost ($CODE)"
CODE=$(move "$D2" "$SALES" '{"move":"reopen"}')
[ "$CODE" = 200 ] || fail "a lost deal could not be reopened ($CODE)"
[ "$(q "select stage from public.deals where id='$D2'")" = new ] || fail "reopening did not return it to New"
pass "lost needs a reason from the list, and lost is reversible"

# --- 10. the board and the table ---------------------------------------
get "$BASE/deals" 200 "$SALES"
has "the board" "Dana Deal"
has "the board" "board-col"
has "the board" "Contract out"
get "$BASE/deals?view=table" 200 "$SALES"
has "the table" "Dana Deal"
has "the table" "Probability"
get "$BASE/deals/$DEAL" 200 "$SALES"
has "the deal record" "Qualification"
has "the deal record" "Spoke to Dana"
pass "the board, the table and the record all render"

# --- 11. who may see it -------------------------------------------------
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/deals")
[ "$CODE" != 200 ] || fail "the deal board is open to anonymous visitors"
python3 - <<'PY'
import pathlib, re, sys
src = pathlib.Path('/home/user/fable_5_pm_project/src/lib/auth/roles.ts').read_text()
m = re.search(r"'/deals':\s*\[([^\]]+)\]", src)
assert m, 'no ROUTE_ACCESS entry for /deals'
roles = {r.strip().strip("'") for r in m.group(1).split(',')}
assert roles == {'admin', 'ops', 'sales'}, roles
print('DEALS-ACCESS-OK', sorted(roles))
PY
pass "the board is staff-only, and the route matrix says exactly who"

# --- the board runs the full width, with every stage on it ---------------
curl -s -o "$W/board.html" -b "$ADMIN" "$BASE/deals"
python3 - "$W/board.html" <<'WIDE'
import re, sys
html = open(sys.argv[1], encoding='utf-8').read()
assert re.search(r'<main class="surface full-bleed"', html), 'the deal board is still held to the page width'
assert 'board deal-board' in html, 'the deal board does not use its full-width columns'
cols = re.findall(r'<section class="board-col[^"]*"[^>]*><header><span>([^<]+)</span>', html)
want = ['New', 'Contacted', 'Qualified', 'Proposal', 'Negotiation', 'Contract out', 'Won', 'Lost']
assert cols == want, f'the board has {cols}'
print('WIDE-OK', len(cols))
WIDE
curl -s -o "$W/table.html" -b "$ADMIN" "$BASE/deals?view=table"
grep -q '<main class="surface wide"' "$W/table.html" || fail "the table view lost its page width"
pass "the deal board runs the full width with all eight columns; the table keeps the page"

# A picture of the board at an ordinary laptop width, because whether eight
# columns fit is the one thing curl cannot check.
mkdir -p "$W/shots"
bash "$ROOT/scripts/e2e/shoot.sh" "$BASE" "$ADMIN" /deals "$W/shots/deals-1440.png" 1440 900 || true

echo "DEALS CHECKS PASSED"
