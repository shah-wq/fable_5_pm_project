#!/usr/bin/env bash
# Module 16 · People — the Customers screen, now holding people who have not
# signed anything yet.
#
# The point of the module is that nothing existing changed: the same screen, the
# same four tabs plus two, the same merge and portal controls. So this suite
# checks the new behaviour *and* re-checks the old, because "we renamed it and
# broke it" is the failure this design was chosen to avoid.
set -euo pipefail

ROOT=/home/user/fable_5_pm_project
W=/tmp/pmdb-people
PGPORT=54394
APPPORT=3148
DB=pm_people
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

node scripts/create-admin.mjs admin@pe.test "Password1234!" "Ada Admin" >/dev/null
AID=$(q "select id from public.profiles where email='admin@pe.test'")
D=$(q "insert into public.dealers (name) values ('Helios') returning id")
CUST=$(q "insert into public.clients (dealer_id, first_name, last_name, email, phone)
  values ('$D','Maria','Martinez','maria@pe.test','512-555-0100') returning id")
PAST=$(q "insert into public.clients (dealer_id, first_name, last_name, email)
  values ('$D','Ben','Baker','ben@pe.test') returning id")
PROSPECT=$(q "insert into public.clients (first_name, last_name, email)
  values ('Pat','Prospect','pat@pe.test') returning id")
P1=$(q "insert into public.projects (name, address, dealer_id, client_id, stage, status)
  values ('Maria Martinez','12 Sunbeam Road, Austin, TX','$D','$CUST','survey','active') returning id")
q "insert into public.projects (name, address, dealer_id, client_id, stage, status)
  values ('Ben Baker','9 Solar Way, Round Rock, TX','$D','$PAST','complete','complete')" >/dev/null
# A second email on the prospect: the case the old duplicate check walked past.
q "insert into public.client_channels (client_id, kind, value, value_normalised, is_primary)
   values ('$PROSPECT','email','PAT.WORK@pe.test','',false)" >/dev/null
LIST=$(q "insert into public.lists (name) values ('Solar basics') returning id")
q "insert into public.subscriptions (client_id, list_id, status, consent_source)
   values ('$PROSPECT','$LIST','subscribed','E-book download')" >/dev/null
DEAL=$(q "insert into public.deals (client_id, dealer_id, stage, contract_value)
   values ('$PROSPECT','$D','qualified', 24000) returning id")
echo "==> fixture: a customer, a past customer, and a prospect with a deal and a subscription"

EMAIL_DEV_LOG=1 NEXT_PUBLIC_SITE_URL="$BASE" PORT=$APPPORT nohup npx next start -p $APPPORT >"$W/next.log" 2>&1 &
NEXT_PID=$!
for i in $(seq 1 60); do
  curl -sf "$BASE/api/health" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && fail "app never came up"; sleep 1
done
JAR="$W/admin.txt"
curl -s -o /dev/null -c "$JAR" -H 'content-type: application/json' \
  -d '{"email":"admin@pe.test","password":"Password1234!","door":"staff"}' "$BASE/api/auth/login"

get() { curl -s -o "$W/page.html" -w '%{http_code}' ${3:+-b "$3"} "$1" | grep -q "^$2$" \
  || { echo "  ($1 answered $(curl -s -o /dev/null -w '%{http_code}' ${3:+-b "$3"} "$1"))"; fail "$1"; }; }
has()  { grep -q -- "$2" "$W/page.html" || fail "$1: '$2' is missing"; }
hasnt() { grep -q -- "$2" "$W/page.html" && fail "$1: '$2' should not be there"; return 0; }

# --- 1. the screen, renamed but not rebuilt ----------------------------
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$BASE/admin/customers")
[ "$CODE" = 307 ] || [ "$CODE" = 308 ] || fail "the old Customers URL does not redirect ($CODE)"
get "$BASE/admin/people" 200 "$JAR"
has "the People screen" "People"
has "the People screen" "Maria"
# Everything the Customers screen already did is still on it.
has "the People screen" "Export CSV"
has "the People screen" "Show archived"
# Portal access is no longer a column — Contacts lists the person, not their
# login — but it is still reachable: the Invite button appears on anybody who
# has an email address and no login yet.
has "the People screen" "Invite"
python3 - "$W/page.html" <<'COLUMNS'
import re, sys
html = open(sys.argv[1], encoding='utf-8').read()
head = re.search(r'<thead>(.*?)</thead>', html, re.S)
assert head, 'no table header on the People screen'
cols = [re.sub(r'<[^>]*>', '', c).strip() for c in re.findall(r'<th[^>]*>(.*?)</th>', head.group(1), re.S)]
cols = [c for c in cols if c]
assert cols == ['Name', 'Lifecycle', 'Email', 'Phone', 'City / state', 'Last activity'], cols
print('CONTACT-COLUMNS-OK', cols)
COLUMNS
# Merge lives on the bulk bar, which appears once rows are selected — checked
# in the component rather than the first render.
grep -q 'Merge…' "$ROOT/src/app/(app)/admin/people/PeopleManager.tsx" \
  || fail "the guided merge disappeared with the rename"
pass "the Customers screen is now People, at a new path, with its old controls intact"

# --- 1b. one contact, at its own address --------------------------------
# Open is a link to a page now, not a panel over the list: editing a contact and
# creating one are the same screen at the same width.
python3 - "$W/page.html" <<'OPENS'
import re, sys
html = open(sys.argv[1], encoding='utf-8').read()
assert re.search(r'<a[^>]+href="/admin/people/[0-9a-f-]{36}"[^>]*>\s*Open\s*</a>', html), \
    'Open is not a link to the contact page'
assert 'drawer-backdrop' not in html, 'the list still renders the drawer'
print('OPEN-IS-A-PAGE-OK')
OPENS
CUST_ID=$(q "select id from public.clients where last_name = 'Martinez'")
get "$BASE/admin/people/$CUST_ID" 200 "$JAR"
has "the contact page" "Maria"
# The same tabs the drawer had, and the contact's own fields open first.
for t in "Contact details" "Projects" "Deals" "Subscriptions" "Portal access" "Activity"; do
  has "the contact page" "$t"
done
# It opens on the contact's own fields — the same registry Create Contact
# renders — and lays them out on the page rather than in a 440px panel. The
# fields themselves arrive from the intake endpoint once the page is running,
# so what the server HTML can show is which tab is selected and where it is.
python3 - "$W/page.html" <<'RECORD'
import re, sys
html = open(sys.argv[1], encoding='utf-8').read()
assert 'drawer-backdrop' not in html, 'the contact page renders as a drawer'
assert 'record-body' in html, 'the contact page is not laid out as a page'
active = re.findall(r'class="linklike active"[^>]*>([^<]+)<', html)
assert active == ['Contact details'], f'the page opens on {active}, not the contact fields'
print('RECORD-PAGE-OK')
RECORD
# A contact that does not exist is a 404, not an empty record.
get "$BASE/admin/people/00000000-0000-0000-0000-000000000000" 404 "$JAR"
pass "a contact opens as its own page, with every tab and the Create Contact layout"
# The sections below read the list again, since this one left a record in the
# buffer they share.
get "$BASE/admin/people" 200 "$JAR"

# --- 2. lifecycle, derived and filtered --------------------------------
has "the People screen" "Lifecycle"
has "the People screen" "Prospects"
python3 - "$W/page.html" <<'PY'
import re, sys
html = open(sys.argv[1], encoding='utf-8').read()
# The filter must offer Customers. It no longer opens on it: Contacts holds
# everybody, and which lifecycle the screen starts on is checked in
# contact-intake.sh, where the decision was made.
sel = re.search(r'<select[^>]*aria-label="Lifecycle"(.*?)</select>', html, re.S)
assert sel, 'no lifecycle filter'
chosen = re.search(r'<option[^>]*selected[^>]*value="([^"]+)"|value="([^"]+)"[^>]*selected', sel.group(1))
assert 'value="customer"' in sel.group(1), 'the filter has no Customers option'
print('LIFECYCLE-FILTER-OK')
PY
[ "$(q "select lifecycle from public.people_overview where id='$CUST'")" = customer ] || fail "wrong lifecycle"
[ "$(q "select lifecycle from public.people_overview where id='$PROSPECT'")" = prospect ] || fail "wrong lifecycle"
pass "the list carries a lifecycle chip and a filter that can narrow to customers"

# --- 3. the two new tabs -----------------------------------------------
R=$(curl -s -b "$JAR" "$BASE/api/customers/$PROSPECT/detail?include=deals")
grep -q '"stage":"qualified"' <<<"$R" || fail "the Deals tab does not show the person's deal: $R"
grep -q '"value":24000' <<<"$R" || fail "the deal's value is missing: $R"
R=$(curl -s -b "$JAR" "$BASE/api/customers/$PROSPECT/detail?include=subscriptions")
grep -q '"listName":"Solar basics"' <<<"$R" || fail "the Subscriptions tab is empty: $R"
grep -q '"consentBasis"' <<<"$R" || fail "the consent basis is not shown: $R"
R=$(curl -s -b "$JAR" "$BASE/api/customers/$PROSPECT/detail?include=contact")
grep -q 'PAT.WORK@pe.test' <<<"$R" || fail "the second email is not on the record: $R"
pass "Deals, Subscriptions and the extra channels all load on the person record"

# --- 4. the unified timeline -------------------------------------------
q "insert into public.audit_log (action, entity_type, kind, client_id, deal_id)
   values ('Called about the roof survey','clients','call','$PROSPECT','$DEAL')" >/dev/null
R=$(curl -s -b "$JAR" "$BASE/api/customers/$PROSPECT/detail?include=activity")
grep -q 'Called about the roof survey' <<<"$R" || fail "a logged call is not on the timeline: $R"
grep -q '"kind":"call"' <<<"$R" || fail "the timeline does not carry the kind: $R"
grep -q '"dealCode":"DEA' <<<"$R" || fail "the timeline does not name the deal: $R"
pass "one log renders the project trail, the person's activity and the deal timeline"

# --- 5. duplicate prevention, across every channel ---------------------
CODE=$(curl -s -o "$W/dup.json" -w '%{http_code}' -X POST -b "$JAR" -H 'content-type: application/json' \
  -d '{"firstName":"Patricia","lastName":"Prospect","email":"pat.work@PE.test"}' "$BASE/api/customers")
[ "$CODE" = 409 ] || fail "creating a person on an existing *secondary* email was allowed ($CODE)"
grep -q "already on file" "$W/dup.json" || fail "the duplicate warning does not name the problem"
grep -q "\"lifecycle\":\"prospect\"" "$W/dup.json" || fail "the duplicate offer does not say what kind of person they are"
# And the override still works, because sometimes they really are two people.
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR" -H 'content-type: application/json' \
  -d '{"firstName":"Patricia","lastName":"Prospect","email":"pat.work@PE.test","allowDuplicate":true}' \
  "$BASE/api/customers")
[ "$CODE" = 201 ] || fail "the deliberate override was refused ($CODE)"
pass "duplicate detection matches on any channel on file, and can still be overridden"

# --- 6. a person with no dealer and no project -------------------------
CODE=$(curl -s -o "$W/new.json" -w '%{http_code}' -X POST -b "$JAR" -H 'content-type: application/json' \
  -d '{"firstName":"Web","lastName":"Enquiry","email":"web@pe.test"}' "$BASE/api/customers")
[ "$CODE" = 201 ] || fail "creating a person with no dealer was refused ($CODE): $(cat "$W/new.json")"
NEWID=$(python3 -c "import json,sys;print(json.load(open('$W/new.json'))['id'])")
[ "$(q "select dealer_id is null from public.clients where id='$NEWID'")" = t ] \
  || fail "a dealer was invented for a web enquiry"
[ "$(q "select lifecycle from public.people_overview where id='$NEWID'")" = prospect ] \
  || fail "a person with no project is not a prospect"
pass "a web enquiry becomes a person with no dealer, no project and no invented attribution"

# --- 7. deletion: the same rule, wider reach ---------------------------
# A prospect with a subscription can go, and their address is suppressed.
CODE=$(curl -s -o "$W/del.json" -w '%{http_code}' -X DELETE -b "$JAR" -H 'content-type: application/json' \
  -d "{\"mode\":\"delete\",\"confirmName\":\"Pat Prospect\"}" "$BASE/api/customers/$PROSPECT")
if [ "$CODE" = 422 ]; then
  grep -q "deal" "$W/del.json" || fail "a delete was refused without saying why: $(cat "$W/del.json")"
  pass "a person with a deal cannot be deleted — the history goes with them"
else
  fail "deleting a person who has a deal was allowed ($CODE)"
fi
# Now one with only a subscription.
SUBONLY=$(q "insert into public.clients (first_name, last_name, email)
  values ('Sub','Only','sub@pe.test') returning id")
q "insert into public.client_channels (client_id, kind, value, value_normalised, is_primary)
   values ('$SUBONLY','email','sub@pe.test','',true)" >/dev/null
q "insert into public.subscriptions (client_id, list_id, status) values ('$SUBONLY','$LIST','subscribed')" >/dev/null
CODE=$(curl -s -o "$W/del2.json" -w '%{http_code}' -X DELETE -b "$JAR" -H 'content-type: application/json' \
  -d '{"mode":"delete","confirmName":"Sub Only"}' "$BASE/api/customers/$SUBONLY")
[ "$CODE" = 200 ] || fail "a prospect with only a subscription could not be deleted ($CODE): $(cat "$W/del2.json")"
N=$(q "select count(*) from public.suppression where value_normalised = 'sub@pe.test'")
[ "$N" = 1 ] || fail "the deleted subscriber's address was not suppressed ($N)"
pass "a subscription-only prospect can be deleted, and their address is suppressed so an import cannot resurrect them"

# --- 8. the query audit, kept honest -----------------------------------
# Part 10: "every query joining clients to projects needs checking for an inner
# join that will now silently exclude prospects". This is that check, run every
# time rather than once.
python3 - <<'PY'
import pathlib, re, sys
bad = []
for p in list(pathlib.Path('src').rglob('*.ts')) + list(pathlib.Path('src').rglob('*.tsx')):
    text = p.read_text()
    for m in re.finditer(r'`([^`]*from\s+public\.clients\b[^`]*)`', text, re.S | re.I):
        sql = m.group(1)
        # A correlated subquery is fine — it counts per person. A join in the
        # FROM chain is what drops people who have no project.
        head = re.split(r'\bwhere\b', sql, flags=re.I)[0]
        for j in re.finditer(r'(\w+)?\s*join\s+public\.(projects|deals)\b', head, re.I):
            if (j.group(1) or '').lower() not in ('left', 'full'):
                bad.append(f'{p}: clients {j.group(1) or "inner"} join {j.group(2)}')
if bad:
    print('QUERIES THAT WOULD DROP PROSPECTS:')
    print('\n'.join(bad))
    sys.exit(1)
print('QUERY-AUDIT-OK')
PY
pass "no query starts at people and inner-joins projects, so prospects cannot silently vanish"

# --- 9. and the rest of the product is untouched -----------------------
get "$BASE/projects" 200 "$JAR"
has "the projects list" "Maria Martinez"
get "$BASE/pipeline" 200 "$JAR"
has "the board" "Maria Martinez"
R=$(curl -s -b "$JAR" "$BASE/api/health")
grep -q '"ok":true' <<<"$R" || echo "  (health: $R)"
pass "the projects list and the board still show the same people they did before"

echo "PEOPLE CHECKS PASSED"
