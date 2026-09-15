#!/usr/bin/env bash
# The contact intake: every field a rep fills in, saved and read back.
#
# The list came from the business as fifty-odd field names. This suite is
# written against that list rather than against the schema, so a field that gets
# quietly dropped in a refactor fails here by its business name.
set -euo pipefail

ROOT=/home/user/fable_5_pm_project
W=/tmp/pmdb-intake
PGPORT=54412
APPPORT=3152
DB=pm_intake
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

node scripts/create-admin.mjs admin@in.test "Password1234!" "Ada Admin" >/dev/null
AID=$(q "select id from public.profiles where email='admin@in.test'")
D=$(q "insert into public.dealers (name) values ('Helios') returning id")
SRC=$(q "select id from public.client_sources where name='Web form'")
ROOF=$(q "select id from public.roof_types limit 1")
UTIL=$(q "insert into public.utilities (name, state) values ('Austin Energy','TX') returning id")
MOD=$(q "insert into public.module_types (name, wattage) values ('Q.PEAK 400', 400) returning id")
INV=$(q "insert into public.inverter_types (name) values ('Enphase IQ8') returning id")
BAT=$(q "insert into public.battery_types (name) values ('Powerwall 3') returning id")
FIN=$(q "insert into public.financing_companies (name) values ('GoodLeap') returning id")
C=$(q "insert into public.clients (dealer_id, first_name, last_name, email, phone)
  values ('$D','Dana','Deal','dana@in.test','512-555-0123') returning id")
DEAL=$(q "insert into public.deals (client_id, dealer_id, stage, address)
  values ('$C','$D','qualified','88 Sunny Lane, Austin, TX') returning id")
echo "==> fixture: one contact with one deal"

EMAIL_DEV_LOG=1 NEXT_PUBLIC_SITE_URL="$BASE" PORT=$APPPORT nohup npx next start -p $APPPORT >"$W/next.log" 2>&1 &
NEXT_PID=$!
for i in $(seq 1 60); do
  curl -sf "$BASE/api/health" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && fail "app never came up"; sleep 1
done
JAR="$W/admin.txt"
curl -s -o /dev/null -c "$JAR" -H 'content-type: application/json' \
  -d '{"email":"admin@in.test","password":"Password1234!","door":"staff"}' "$BASE/api/auth/login"

# --- 1. every field on the list is in the registry ---------------------
python3 - <<'PY'
import json, pathlib, re, subprocess, sys

# The business list, verbatim, mapped to the field the product calls it.
WANTED = {
  'Contact Owner': 'owner_id',
  'First Name': 'first_name',
  'Last Name': 'last_name',
  'Email': 'email',
  'Phone': 'phone',
  'Lead Source': 'source_id',
  'Dealer Name': 'dealer_id',
  'System Size (KW)': 'system_size_kw',
  'Module Quantity': 'module_quantity',
  'Updated Solar Proposal': 'solar_proposal',
  'Number of Batteries': 'battery_qty',
  'Battery Size': 'battery_size_kwh',
  'Updated Electricity Bill (Front)': 'electricity_bill_front',
  'Updated Electricity Bill (Back)': 'electricity_bill_back',
  'HOA': 'hoa',
  'Okay to Install Comparable Module & Inverter Brand': 'comparable_brand_ok',
  'Financing Company': 'financing_company_id',
  'Enter System Price': 'gross_price',
  'Created By': 'created_by_name',
  'Wave sales notes': 'wave_sales_notes',
  'Annual kw Usage': 'annual_usage_kwh',
  'Additional Information': 'additional_information',
  'Dealer Code Form': 'dealer_code_form',
  'System Includes Battery?': 'includes_battery',
  'Estimated Annual Production (kwh)': 'production_estimate_kwh',
  'Lead Status': 'stage',
  'Reschedule Reason': 'reschedule_reason',
  'Lost Reason': 'lost_reason_id',
  'Inverter Brand Size': 'inverter_size_kw',
  'Rooftop/ Ground Mount': 'mount_type',
  'Module Brand': 'module_id',
  'Module Wattage': 'module_wattage',
  'Updated Signed Solar Installation Agreement': 'signed_installation_agreement',
  'Updated Electrical Panel': 'electrical_panel',
  'Updated Electrical Meter': 'electrical_meter',
  'Battery Brand': 'battery_id',
  'Average Pre-Solar Monthly Electric Bill': 'avg_monthly_bill',
  'Electric Utility': 'utility_id',
  'Amount': 'contract_value',
  'Down Payment': 'down_payment',
  'Amount Financed': 'amount_financed',
  'Financed or Cash?': 'financing_route',
  "Owner's Phone number": 'owner_phone',
  'Electric bill': 'electric_bill',
  'Mailing Street': 'mailing_street',
  'Mailing City': 'mailing_city',
  'Mailing State': 'mailing_state',
  'Mailing Zip': 'mailing_postal_code',
  'Mailing Country': 'mailing_country',
  'Description': 'description',
  # The fields the Create Contact layout adds to that list.
  'Salutation': 'salutation',
  'Secondary Email': 'secondary_email',
  'Mobile': 'alternate_phone',
  'Consultant': 'consultant',
  'Original Source': 'original_source',
  'UTM Campaign Source': 'utm_source',
  'UTM Campaign Medium': 'utm_medium',
  'UTM Campaign Name': 'utm_campaign',
}

src = pathlib.Path('/home/user/fable_5_pm_project/src/lib/crm/intake.ts').read_text()
present = set(re.findall(r"name:\s*'([a-z_]+)'", src))
missing = {label: field for label, field in WANTED.items() if field not in present}
assert not missing, 'fields on the business list with no entry in the registry:\n  ' + \
    '\n  '.join(f'{k} → {v}' for k, v in missing.items())
print(f'REGISTRY-OK ({len(WANTED)} requested fields, all present)')
PY
pass "every field on the business list exists in the intake registry"

# --- 2. the tab loads, with the reference lists -------------------------
R=$(curl -s -b "$JAR" "$BASE/api/customers/$C/intake")
grep -q '"dealId"' <<<"$R" || fail "the intake did not load: $R"
grep -q '"refs"' <<<"$R" || fail "no reference lists came back"
for key in owners sources dealers modules inverters batteries financingCompanies utilities lossReasons roofTypes; do
  grep -q "\"$key\"" <<<"$R" || fail "the $key list is missing from the intake"
done
pass "the intake loads with every dropdown it needs"

# --- 3. the whole form saves, to two tables, in one call ---------------
CODE=$(curl -s -o "$W/save.json" -w '%{http_code}' -X PATCH -b "$JAR" -H 'content-type: application/json' \
  -d "{\"dealId\":\"$DEAL\",\"values\":{
        \"owner_id\":\"$AID\",\"first_name\":\"Dana\",\"last_name\":\"Deal\",
        \"email\":\"dana@in.test\",\"phone\":\"512-555-0123\",
        \"owner_phone\":\"512-555-0999\",\"source_id\":\"$SRC\",\"dealer_id\":\"$D\",
        \"description\":\"Referred by her neighbour\",
        \"mailing_street\":\"PO Box 12\",\"mailing_city\":\"Austin\",\"mailing_state\":\"TX\",
        \"mailing_postal_code\":\"78701\",\"mailing_country\":\"USA\",
        \"system_size_kw\":8.4,\"module_id\":\"$MOD\",\"module_quantity\":21,
        \"module_wattage\":400,\"inverter_id\":\"$INV\",\"inverter_size_kw\":7.6,
        \"battery_id\":\"$BAT\",\"battery_qty\":2,\"battery_size_kwh\":13.5,
        \"mount_type\":\"rooftop\",\"roof_type_id\":\"$ROOF\",\"hoa\":\"yes\",
        \"comparable_brand_ok\":true,\"utility_id\":\"$UTIL\",\"avg_monthly_bill\":240,
        \"annual_usage_kwh\":14500,\"production_estimate_kwh\":12800,
        \"gross_price\":31000,\"contract_value\":24000,\"down_payment\":2000,
        \"amount_financed\":22000,\"financing_route\":\"loan\",
        \"financing_company_id\":\"$FIN\",\"dealer_code\":\"HEL-9921\",
        \"wave_sales_notes\":\"Wave quoted a 25-year warranty\",
        \"additional_information\":\"Dog in the back garden\",
        \"reschedule_reason\":\"Surveyor van broke down\"}}" \
  "$BASE/api/customers/$C/intake")
[ "$CODE" = 200 ] || fail "saving the intake answered $CODE: $(cat "$W/save.json")"

# The person's half.
ROW=$(q "select owner_phone || '|' || description || '|' || mailing_street || '|' ||
         mailing_city || '|' || mailing_state || '|' || mailing_postal_code || '|' ||
         mailing_country from public.clients where id = '$C'")
[ "$ROW" = "512-555-0999|Referred by her neighbour|PO Box 12|Austin|TX|78701|USA" ] \
  || fail "the person's fields did not save ($ROW)"
# The single-line mailing address follows the parts, so old queries keep working.
LINE=$(q "select mailing_address from public.clients where id = '$C'")
[ "$LINE" = "PO Box 12, Austin, TX, 78701, USA" ] || fail "the legacy mailing line did not follow ($LINE)"

# The deal's half.
ROW=$(q "select system_size_kw || '|' || module_quantity || '|' || module_wattage || '|' ||
         inverter_size_kw || '|' || battery_qty || '|' || battery_size_kwh || '|' ||
         mount_type || '|' || hoa || '|' || comparable_brand_ok || '|' ||
         annual_usage_kwh || '|' || production_estimate_kwh || '|' || gross_price || '|' ||
         contract_value || '|' || down_payment || '|' || amount_financed || '|' ||
         financing_route || '|' || dealer_code || '|' || wave_sales_notes || '|' ||
         additional_information || '|' || reschedule_reason
         from public.deals where id = '$DEAL'")
# (Concatenation casts the boolean to text, so it reads "true" here and "t" when
# the column is selected on its own — same value, two spellings.)
grep -q "8.400|21|400|7.600|2|13.50|rooftop|yes|true|14500|12800|31000.00|24000.00|2000.00|22000.00|loan|HEL-9921|" <<<"$ROW" \
  || fail "the deal's fields did not save ($ROW)"
pass "one save writes the person's fields and the deal's fields to their own tables"

# --- 4. the answers that compute themselves ----------------------------
[ "$(q "select includes_battery from public.deals where id='$DEAL'")" = t ] \
  || fail "'system includes battery' did not follow the battery count"
q "update public.deals set battery_qty = 0 where id = '$DEAL'" >/dev/null
[ "$(q "select includes_battery from public.deals where id='$DEAL'")" = f ] \
  || fail "setting the battery count to zero did not clear the flag"
q "update public.deals set battery_qty = 2 where id = '$DEAL'" >/dev/null
pass "'system includes battery' answers itself from the battery count"

# --- 5. created-by and lead status are recorded, not typed -------------
NEW=$(curl -s -X POST -b "$JAR" -H 'content-type: application/json' \
  -d '{"firstName":"Ned","lastName":"New","email":"ned@in.test"}' "$BASE/api/customers" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
[ "$(q "select created_by from public.clients where id='$NEW'")" = "$AID" ] \
  || fail "created_by was not recorded on a new contact"
R=$(curl -s -b "$JAR" "$BASE/api/customers/$C/intake")
grep -q '"stage":"qualified"' <<<"$R" || fail "lead status does not come from the deal's stage: $R"
pass "created by is recorded automatically, and lead status is the deal's stage"

# --- 6. the documents, filed against the deal --------------------------
printf 'a proposal' > "$W/proposal.pdf"
CODE=$(curl -s -o "$W/up.json" -w '%{http_code}' -X POST -b "$JAR" \
  -F 'category=solar_proposal' -F "file=@$W/proposal.pdf;type=application/pdf" \
  "$BASE/api/deals/$DEAL/documents")
[ "$CODE" = 201 ] || fail "uploading the solar proposal answered $CODE: $(cat "$W/up.json")"
ROW=$(q "select category || '|' || (project_id is null)::text || '|' || customer_visible::text
         from public.documents where deal_id = '$DEAL'")
[ "$ROW" = "solar_proposal|true|false" ] \
  || fail "the document is not filed against the deal, hidden by default ($ROW)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR" \
  -F 'category=not_a_real_category' -F "file=@$W/proposal.pdf;type=application/pdf" \
  "$BASE/api/deals/$DEAL/documents")
[ "$CODE" = 400 ] || fail "an unknown document category was accepted ($CODE)"
R=$(curl -s -b "$JAR" "$BASE/api/customers/$C/intake")
grep -q '"category":"solar_proposal"' <<<"$R" || fail "the upload is not on the contact: $R"
pass "intake documents file against the deal, hidden by default, and show on the contact"

# --- 7. two deals, and the screen says which one it is showing ---------
DEAL2=$(q "insert into public.deals (client_id, dealer_id, stage, address, system_size_kw)
  values ('$C','$D','new','2 Second Street, Austin, TX', 4.2) returning id")
R=$(curl -s -b "$JAR" "$BASE/api/customers/$C/intake?deal=$DEAL2")
grep -q '"system_size_kw":"4.200"\|"system_size_kw":4.2' <<<"$R" \
  || fail "asking for the second deal returned the first one's system size: $R"
python3 - <<'PY'
import pathlib
src = pathlib.Path('/home/user/fable_5_pm_project/src/app/(app)/admin/people/ContactIntake.tsx').read_text()
assert 'Which deal' in src, 'no deal picker for a person with two deals'
assert 'belong to the' in src, 'the screen does not say which deal the fields belong to'
print('PICKER-OK')
PY
pass "a person with two deals gets a picker, and the screen says which one the fields belong to"

# --- 8. a contact with no deal is honest about it ----------------------
R=$(curl -s -b "$JAR" "$BASE/api/customers/$NEW/intake")
grep -q '"dealId":null' <<<"$R" || fail "a contact with no deal claimed to have one: $R"
CODE=$(curl -s -o "$W/nodeal.json" -w '%{http_code}' -X PATCH -b "$JAR" -H 'content-type: application/json' \
  -d '{"values":{"system_size_kw":9.9}}' "$BASE/api/customers/$NEW/intake")
[ "$CODE" = 400 ] || fail "a system size was saved against a contact with no deal ($CODE)"
grep -qi "no deal" "$W/nodeal.json" || fail "the refusal does not explain itself"
# The person's own fields still save.
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -b "$JAR" -H 'content-type: application/json' \
  -d '{"values":{"description":"Rang about a quote"}}' "$BASE/api/customers/$NEW/intake")
[ "$CODE" = 200 ] || fail "the person's own fields would not save without a deal ($CODE)"
pass "without a deal the person's fields still save, and the deal fields say why they cannot"

# --- 9. the screen itself ----------------------------------------------
CODE=$(curl -s -o "$W/page.html" -w '%{http_code}' -b "$JAR" "$BASE/admin/people")
[ "$CODE" = 200 ] || fail "the People screen answered $CODE"
# The record itself is a drawer, so it is not in the server HTML until a row is
# clicked — the honest check is that the tab shipped in the JavaScript the page
# just asked the browser to load, which is what a rep will actually run.
CHUNKS=$(grep -o '/_next/static/chunks/[^"\\]*\.js' "$W/page.html" | sort -u)
[ -n "$CHUNKS" ] || fail "the People screen loaded no JavaScript at all"
FOUND=no
for u in $CHUNKS; do
  curl -s -b "$JAR" "$BASE$u" | grep -q "Solar details" && { FOUND=yes; break; }
done
[ "$FOUND" = yes ] || fail "the Solar details tab is not in the code the People screen loads"
pass "the contact record carries a Solar details tab"

# --- 10. who may read it ------------------------------------------------
DEALERU=$(q "insert into auth.users (email, encrypted_password, email_confirmed_at, raw_app_meta_data)
  values ('dealer@in.test', extensions.crypt('Password1234!', extensions.gen_salt('bf',12)), now(),
          '{\"user_role\":\"dealer\"}'::jsonb) returning id")
q "insert into public.dealer_users (dealer_id, user_id) values ('$D','$DEALERU')" >/dev/null
curl -s -o /dev/null -c "$W/dealer.txt" -H 'content-type: application/json' \
  -d '{"email":"dealer@in.test","password":"Password1234!","door":"dealer"}' "$BASE/api/auth/login"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$W/dealer.txt" "$BASE/api/customers/$C/intake")
[ "$CODE" != 200 ] || fail "a dealer read the whole contact intake"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/customers/$C/intake")
[ "$CODE" != 200 ] || fail "the contact intake is open to anonymous visitors"
pass "the intake is staff-only"

# --- 11. Contacts is everybody, and carries the Create Contact button ---
CODE=$(curl -s -o "$W/list.html" -w '%{http_code}' -b "$JAR" "$BASE/admin/people")
[ "$CODE" = 200 ] || fail "the Contacts screen answered $CODE"
grep -q "Create Contact" "$W/list.html" || fail "no Create Contact button on the list"
grep -q 'href="/admin/people/new"' "$W/list.html" || fail "the button does not open the create page"
python3 - "$W/list.html" <<'PY2'
import re, sys
html = open(sys.argv[1], encoding='utf-8').read()
sel = re.search(r'<select[^>]*aria-label="Lifecycle"(.*?)</select>', html, re.S)
assert sel, 'no lifecycle filter'
# Contacts holds everybody: the filter must open on Everyone, not on Customers.
chosen = re.findall(r'<option[^>]*selected[^>]*value="([^"]+)"|value="([^"]+)"[^>]*selected', sel.group(1))
flat = [a or b for a, b in chosen]
assert flat and flat[0] == 'any', f'the lifecycle filter opens on {flat or "nothing"}, not Everyone'
print('CONTACTS-EVERYBODY-OK')
PY2
pass "Contacts opens on everybody and offers Create Contact"

# --- 12. the create page renders the whole form ------------------------
CODE=$(curl -s -o "$W/new.html" -w '%{http_code}' -b "$JAR" "$BASE/admin/people/new")
[ "$CODE" = 200 ] || fail "the create page answered $CODE"
for label in "Contact owner" "Last name" "Salutation" "Secondary email" "Mobile" "Consultant" \
             "UTM campaign source" "Mailing street" "Lead status" "System size (kW)" \
             "Module quantity" "Down payment" "Dealer code" "Updated solar proposal"; do
  grep -qi "$label" "$W/new.html" || fail "the create page is missing the $label field"
done
grep -q "Save and New" "$W/new.html" || fail "no Save and New on the create page"
grep -qi "Save the contact first" "$W/new.html" \
  || fail "the create page does not say why the uploads wait"
pass "Create Contact renders every field, with the uploads honest about waiting"

# --- 13. a person with nothing to sell is a person, not a deal ---------
CODE=$(curl -s -o "$W/c1.json" -w '%{http_code}' -X POST -b "$JAR" -H 'content-type: application/json' \
  -d '{"values":{"salutation":"Ms.","first_name":"Cora","last_name":"Card",
       "email":"CORA@in.test","phone":"512-555-0300","consultant":"Ray Sunshine",
       "original_source":"Trade show","utm_source":"google","utm_medium":"cpc",
       "utm_campaign":"spring-24","description":"Met at the home show"}}' \
  "$BASE/api/contacts")
[ "$CODE" = 201 ] || fail "creating a plain contact answered $CODE: $(cat "$W/c1.json")"
C1=$(python3 -c "import json;print(json.load(open('$W/c1.json'))['clientId'])")
ROW=$(q "select salutation || '|' || email || '|' || consultant || '|' || original_source || '|' ||
         utm_source || '|' || utm_medium || '|' || utm_campaign
         from public.clients where id = '$C1'")
[ "$ROW" = "Ms.|cora@in.test|Ray Sunshine|Trade show|google|cpc|spring-24" ] \
  || fail "the new contact's fields did not save ($ROW)"
[ "$(q "select count(*) from public.deals where client_id = '$C1'")" = 0 ] \
  || fail "a contact with no system details invented a deal"
[ "$(q "select created_by from public.clients where id='$C1'")" = "$AID" ] \
  || fail "created_by was not recorded by the create route"
[ "$(q "select count(*) from public.client_channels where client_id='$C1'")" = 2 ] \
  || fail "the new contact's email and phone were not recorded as channels"
pass "a contact with no system details is created as a person, with no phantom deal"

# --- 14. the whole form at once creates the person and the deal --------
CODE=$(curl -s -o "$W/c2.json" -w '%{http_code}' -X POST -b "$JAR" -H 'content-type: application/json' \
  -d "{\"values\":{\"first_name\":\"Sol\",\"last_name\":\"Seeker\",
       \"email\":\"sol@in.test\",\"phone\":\"512-555-0400\",
       \"secondary_email\":\"sol.work@in.test\",\"alternate_phone\":\"512-555-0401\",
       \"owner_id\":\"$AID\",\"dealer_id\":\"$D\",\"source_id\":\"$SRC\",
       \"mailing_street\":\"9 Ray Road\",\"mailing_city\":\"Austin\",\"mailing_state\":\"TX\",
       \"stage\":\"qualified\",\"system_size_kw\":9.6,\"module_id\":\"$MOD\",
       \"module_quantity\":24,\"module_wattage\":400,\"battery_qty\":1,
       \"battery_size_kwh\":13.5,\"hoa\":\"unknown\",\"mount_type\":\"ground\",
       \"comparable_brand_ok\":false,\"gross_price\":36000,\"down_payment\":3000,
       \"amount_financed\":33000,\"financing_route\":\"loan\",
       \"financing_company_id\":\"$FIN\",\"utility_id\":\"$UTIL\",
       \"dealer_code\":\"HEL-7\"}}" "$BASE/api/contacts")
[ "$CODE" = 201 ] || fail "creating a full contact answered $CODE: $(cat "$W/c2.json")"
C2=$(python3 -c "import json;print(json.load(open('$W/c2.json'))['clientId'])")
D2=$(python3 -c "import json;print(json.load(open('$W/c2.json'))['dealId'] or '')")
[ -n "$D2" ] || fail "the system details did not make a deal"
ROW=$(q "select stage || '|' || system_size_kw || '|' || module_quantity || '|' ||
         battery_qty || '|' || hoa || '|' || mount_type || '|' || comparable_brand_ok || '|' ||
         includes_battery || '|' || gross_price || '|' || down_payment || '|' ||
         financing_route || '|' || client_id
         from public.deals where id = '$D2'")
[ "$ROW" = "qualified|9.600|24|1|unknown|ground|false|true|36000.00|3000.00|loan|$C2" ] \
  || fail "the deal made alongside the contact is wrong ($ROW)"
[ "$(q "select secondary_email from public.clients where id='$C2'")" = "sol.work@in.test" ] \
  || fail "the secondary email did not save"
# The person's half went to clients, not onto the deal.
[ "$(q "select mailing_city from public.clients where id='$C2'")" = Austin ] \
  || fail "the mailing address did not land on the person"
# And the whole thing reads back through the contact's own screen.
R=$(curl -s -b "$JAR" "$BASE/api/customers/$C2/intake")
grep -q '"stage":"qualified"' <<<"$R" || fail "the new deal is not on the contact: $R"
grep -q '"module_quantity":24' <<<"$R" || fail "the system details are not on the contact: $R"
pass "one Create Contact makes the person and their deal, each field on its own table"

# --- 15. what it insists on ---------------------------------------------
CODE=$(curl -s -o "$W/bad.json" -w '%{http_code}' -X POST -b "$JAR" -H 'content-type: application/json' \
  -d '{"values":{"first_name":"No","email":"nolast@in.test"}}' "$BASE/api/contacts")
[ "$CODE" = 400 ] || fail "a contact with no last name was accepted ($CODE)"
grep -qi "last name" "$W/bad.json" || fail "the refusal does not say what is missing"
CODE=$(curl -s -o "$W/bad2.json" -w '%{http_code}' -X POST -b "$JAR" -H 'content-type: application/json' \
  -d '{"values":{"first_name":"No","last_name":"Contact"}}' "$BASE/api/contacts")
[ "$CODE" = 400 ] || fail "a contact with no way to reach them was accepted ($CODE)"
grep -qi "reach them" "$W/bad2.json" || fail "the refusal does not explain itself"
# A phone and no email is a real contact, and saves.
CODE=$(curl -s -o "$W/ok.json" -w '%{http_code}' -X POST -b "$JAR" -H 'content-type: application/json' \
  -d '{"values":{"first_name":"Dee","last_name":"Driveway","phone":"512-555-0500"}}' \
  "$BASE/api/contacts")
[ "$CODE" = 201 ] || fail "a phone-only contact was refused ($CODE): $(cat "$W/ok.json")"
pass "a last name and one way to reach them, and nothing else, is enough"

# --- 16. the same person twice ------------------------------------------
CODE=$(curl -s -o "$W/dup.json" -w '%{http_code}' -X POST -b "$JAR" -H 'content-type: application/json' \
  -d '{"values":{"first_name":"Cora","last_name":"Card","email":"cora@in.test"}}' \
  "$BASE/api/contacts")
[ "$CODE" = 409 ] || fail "the same email was accepted a second time ($CODE)"
grep -q '"duplicates"' "$W/dup.json" || fail "the clash does not offer the record on file"
grep -q "$C1" "$W/dup.json" || fail "the clash names the wrong person"
# Matched on a second email too, not just the primary column.
q "insert into public.client_channels (client_id, kind, value, value_normalised, is_primary)
   values ('$C1','email','cora.home@in.test','',false)" >/dev/null
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR" -H 'content-type: application/json' \
  -d '{"values":{"first_name":"Cora","last_name":"Card","email":"cora.home@in.test"}}' \
  "$BASE/api/contacts")
[ "$CODE" = 409 ] || fail "a second address on the same person was not matched ($CODE)"
# Overriding is allowed, deliberately.
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR" -H 'content-type: application/json' \
  -d '{"allowDuplicate":true,"values":{"first_name":"Cora","last_name":"Card2","phone":"512-555-0300"}}' \
  "$BASE/api/contacts")
[ "$CODE" = 201 ] || fail "an overridden duplicate was still refused ($CODE)"
pass "Create Contact offers the record on file rather than making a second one, and can be overridden"

# --- 17. who may create --------------------------------------------------
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$W/dealer.txt" -H 'content-type: application/json' \
  -d '{"values":{"first_name":"Dealer","last_name":"Made","email":"dm@in.test"}}' "$BASE/api/contacts")
[ "$CODE" != 201 ] || fail "a dealer created a contact"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -d '{"values":{"first_name":"Anon","last_name":"Made","email":"an@in.test"}}' "$BASE/api/contacts")
[ "$CODE" != 201 ] || fail "an anonymous visitor created a contact"
pass "creating a contact is staff-only"

mkdir -p "$W/shots"
bash "$ROOT/scripts/e2e/shoot.sh" "$BASE" "$JAR" /admin/people/new "$W/shots/create-contact.png" 1440 2200 || true
bash "$ROOT/scripts/e2e/shoot.sh" "$BASE" "$JAR" /admin/people "$W/shots/contacts.png" 1440 1100 || true

echo "CONTACT INTAKE CHECKS PASSED"
