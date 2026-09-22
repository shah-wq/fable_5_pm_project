#!/usr/bin/env bash
# E-signature through PandaDoc: contracts and change orders.
#
# PandaDoc is played by scripts/e2e/pandadoc-mock.mjs (PANDADOC_API_BASE points
# the app at it). Checked here: the send is refused until a template is chosen;
# a contract is validated before anybody is emailed; nothing moves until the
# homeowner signs; a forged webhook changes nothing; a signed one creates the
# project as the rep who sent it, files the PDF, and is not applied twice; a
# change order signed on screen and picked up by Check status (no webhook)
# adds its amount to the contract value; manual approval and void; voiding a
# document out for signature; and who may see what.
set -euo pipefail

ROOT=/home/user/fable_5_pm_project
W=/tmp/pmdb-esign
PGPORT=54435
APPPORT=3165
MOCKPORT=3175
DB=pm_esign
export DATABASE_URL="postgres://postgres@127.0.0.1:$PGPORT/$DB"
BASE="http://127.0.0.1:$APPPORT"
MOCK="http://127.0.0.1:$MOCKPORT"
WHK=webhook-shared-key

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

node scripts/create-admin.mjs admin@es.test "Password1234!" "Ada Admin" >/dev/null
node scripts/create-admin.mjs rep@es.test "Password1234!" "Ray Rep" >/dev/null
node scripts/create-admin.mjs pm@es.test "Password1234!" "Pat PM" >/dev/null
REP=$(q "select id from public.profiles where email='rep@es.test'")
PM=$(q "select id from public.profiles where email='pm@es.test'")
q "update public.profiles set role='sales' where id='$REP'" >/dev/null
q "update public.profiles set role='ops' where id='$PM'" >/dev/null
D=$(q "insert into public.dealers (name) values ('Helios Solar') returning id")
# Una is quoted and has no deal; Eve is the one who changes her mind.
C=$(q "insert into public.clients (dealer_id, first_name, last_name, email, contact_stage, mailing_street, mailing_city)
  values ('$D','Una','Signer','una@es.test','quoted','5 Volt Lane','Austin') returning id")
C2=$(q "insert into public.clients (dealer_id, first_name, last_name, email, contact_stage)
  values ('$D','Eve','Undecided','eve@es.test','quoted') returning id")
# A project already under way, for change orders.
PC=$(q "insert into public.clients (dealer_id, first_name, last_name, email) values ('$D','Carl','Change','carl@es.test') returning id")
P=$(q "insert into public.projects (name, dealer_id, client_id, stage, address, contract_value)
  values ('Carl Change', '$D', '$PC', 'design', '9 Sun St', 20000) returning id")
echo "==> fixture: admin, sales rep, PM; two contacts; a project at \$20,000"

MOCK_PORT=$MOCKPORT MOCK_KEY=test-key nohup node scripts/e2e/pandadoc-mock.mjs >"$W/mock.log" 2>&1 &
MOCK_PID=$!
PANDADOC_API_KEY=test-key PANDADOC_WEBHOOK_KEY=$WHK PANDADOC_API_BASE=$MOCK \
  PORT=$APPPORT nohup npx next start -p $APPPORT >"$W/next.log" 2>&1 &
NEXT_PID=$!
for i in $(seq 1 60); do
  curl -sf "$BASE/api/health" >/dev/null 2>&1 && curl -sf "$MOCK/__docs" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && fail "app or mock never came up"; sleep 1
done
login() { curl -s -o /dev/null -c "$W/$1.txt" -H 'content-type: application/json' \
  -d "{\"email\":\"$1@es.test\",\"password\":\"Password1234!\",\"door\":\"staff\"}" "$BASE/api/auth/login"; }
login admin; login rep; login pm
api() { # who method path [body] -> writes $W/r.json, echoes status
  curl -s -o "$W/r.json" -w '%{http_code}' -X "$2" -b "$W/$1.txt" -H 'content-type: application/json' \
    ${4:+-d "$4"} "$BASE$3"; }
j() { python3 -c "import json,sys; d=json.load(open('$W/r.json')); print($1)"; }
docs() { curl -s "$MOCK/__docs" > "$W/docs.json"; }
hook() { # body -> status, signed with the shared key unless $2 = forged
  local sig
  sig=$(python3 -c "import hmac,hashlib,sys; print(hmac.new(b'$WHK', sys.argv[1].encode(), hashlib.sha256).hexdigest())" "$1")
  [ "${2:-}" = forged ] && sig=0000$sig
  curl -s -o "$W/hook.json" -w '%{http_code}' -X POST -H 'content-type: application/json' \
    --data-binary "$1" "$BASE/api/integrations/pandadoc/webhook?signature=$sig"; }
SIGN="{\"system_size_kw\":7.2,\"dealer_id\":\"$D\",\"address\":\"5 Volt Lane, Austin\",\"contract_value\":24500,\"module_quantity\":18}"

# --- 1. no template, no send ----------------------------------------------
[ "$(api rep GET /api/contacts/$C/esign)" = 200 ] || fail "the e-sign status answered $(cat "$W/r.json")"
[ "$(j "d['ready']")" = False ] || fail "e-signature offered with no template chosen"
j "d['reason']" | grep -q "template" || fail "the reason does not mention the template: $(cat "$W/r.json")"
[ "$(j "d['signer']['email']")" = una@es.test ] || fail "the signer is not pre-filled from the contact"
CODE=$(api rep POST /api/contacts/$C/esign "{\"values\":$SIGN,\"signerEmail\":\"una@es.test\"}")
[ "$CODE" = 409 ] || fail "a send with no template answered $CODE"
pass "without a template the button is not offered, and a send is refused with the reason"

CODE=$(api admin PUT /api/admin/settings '{"companyName":"SunCo","coPrefix":"CO-","coNextNumber":41,"pandadocContractTemplate":"tmpl-contract-1","pandadocChangeOrderTemplate":"tmpl-co-1","pandadocSignerRole":"Client"}')
[ "$CODE" = 200 ] || fail "saving the templates answered $CODE: $(cat "$W/r.json")"
grep -q skipped "$W/r.json" && fail "the e-signature settings were skipped: $(cat "$W/r.json")"
api rep GET /api/contacts/$C/esign >/dev/null
[ "$(j "d['ready']")" = True ] || fail "e-signature still off after choosing templates: $(cat "$W/r.json")"
pass "an admin chooses the templates in Settings, and a sales rep can then send"

# --- 2. checked before anybody is emailed ---------------------------------
CODE=$(api rep POST /api/contacts/$C/esign "{\"values\":{\"dealer_id\":\"$D\",\"address\":\"5 Volt Lane\"},\"signerEmail\":\"una@es.test\"}")
[ "$CODE" = 400 ] || fail "a contract with no system size answered $CODE"
[ "$(j "d['missing']")" = "['system_size_kw']" ] || fail "the refusal does not name the field: $(cat "$W/r.json")"
docs; [ "$(python3 -c "import json; print(len(json.load(open('$W/docs.json'))))")" = 0 ] || fail "PandaDoc was called for an invalid contract"
pass "a contract the project could not be made from is refused before PandaDoc is called"

# --- 3. send by email: nothing moves yet ----------------------------------
CODE=$(api rep POST /api/contacts/$C/esign "{\"values\":$SIGN,\"signerName\":\"Una Signer\",\"signerEmail\":\"una@es.test\",\"delivery\":\"email\"}")
[ "$CODE" = 201 ] || fail "sending the contract answered $CODE: $(cat "$W/r.json")"
ENV=$(j "d['envelope']['id']")
[ "$(j "d['envelope']['status']")" = sent ] || fail "the envelope is not sent: $(cat "$W/r.json")"
[ "$(j "d['sessionUrl']")" = None ] || fail "an emailed contract came back with a signing link"
docs
python3 - "$W/docs.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))[0]
r = d['request']
assert r['template_uuid'] == 'tmpl-contract-1', r
assert r['recipients'] == [{'email': 'una@es.test', 'first_name': 'Una', 'last_name': 'Signer', 'role': 'Client'}], r['recipients']
t = {x['name']: x['value'] for x in r['tokens']}
assert t['System.SizeKw'] == '7.2' and t['Project.Address'] == '5 Volt Lane, Austin', t
assert t['Contract.Value'] == '$24,500.00' and t['Dealer.Name'] == 'Helios Solar' and t['Company.Name'] == 'SunCo', t
assert r['metadata']['solarflow_purpose'] == 'contract', r['metadata']
assert d['status'] == 'document.sent' and d['sent']['silent'] is False, d
print('PANDADOC-REQUEST-OK')
PY
[ "$(q "select contact_stage from public.clients where id='$C'")" = quoted ] || fail "sending moved the contact"
[ "$(q "select count(*) from public.projects where client_id='$C'")" = 0 ] || fail "sending made a project"
curl -s -b "$W/rep.txt" "$BASE/admin/people/stages" | grep -q "Awaiting e-signature" || fail "the board does not show the contract is out"
CODE=$(api rep POST /api/contacts/$C/esign "{\"values\":$SIGN,\"signerEmail\":\"una@es.test\"}")
[ "$CODE" = 409 ] || fail "a second contract for the same contact answered $CODE"
pass "the contract goes out with the form's figures; the contact stays put and shows as awaiting signature"

# --- 4. a forged webhook changes nothing ----------------------------------
PD=$(q "select provider_document_id from public.esign_envelopes where id='$ENV'")
curl -s -X POST "$MOCK/__complete/$PD" >/dev/null
BODY="[{\"event\":\"document_state_changed\",\"data\":{\"id\":\"$PD\",\"status\":\"document.completed\"}}]"
[ "$(hook "$BODY" forged)" = 401 ] || fail "a forged webhook was accepted"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data-binary "$BODY" \
  "$BASE/api/integrations/pandadoc/webhook")
[ "$CODE" = 401 ] || fail "an unsigned webhook answered $CODE"
[ "$(q "select contact_stage from public.clients where id='$C'")" = quoted ] || fail "a forged webhook signed the contact"
pass "an unsigned or wrongly signed webhook is refused and changes nothing"

# --- 5. signed: the project, as the rep, once -----------------------------
[ "$(hook "$BODY")" = 200 ] || fail "the signed webhook answered $(cat "$W/hook.json")"
grep -q '"completed"' "$W/hook.json" || fail "the webhook did not complete: $(cat "$W/hook.json")"
ROW=$(q "select c.contact_stage || '|' || p.system_size_kw || '|' || p.contract_value || '|' || p.stage
           from public.clients c join public.projects p on p.client_id = c.id where c.id = '$C'")
[ "$ROW" = "contract_signed|7.200|24500.00|survey" ] || fail "the signed contract did not make the project it described ($ROW)"
[ "$(q "select count(*) from public.documents d join public.projects p on p.id = d.project_id
        where p.client_id = '$C' and d.category = 'signed_installation_agreement' and d.deal_id is not null")" = 1 ] \
  || fail "the signed PDF is not filed on the project and the deal"
[ "$(q "select encode(od.data, 'escape') like '%PDF-1.4%signed $PD%' from public.documents d
        join storage.objects o on o.bucket_id = d.bucket and o.name = d.object_path
        join storage.object_data od on od.object_id = o.id
        where d.category = 'signed_installation_agreement'")" = t ] || fail "the filed PDF is not the one PandaDoc signed"
[ "$(q "select actor_id from public.audit_log where action = 'contact.contract_signed' order by occurred_at desc limit 1")" = "$REP" ] \
  || fail "the signing is not in the log under the rep who sent it"
[ "$(q "select applied_at is not null from public.esign_envelopes where id='$ENV'")" = t ] || fail "the envelope is not marked applied"
[ "$(hook "$BODY")" = 200 ] || fail "a repeated webhook failed"
grep -q "already applied" "$W/hook.json" || fail "a repeated webhook was not recognised: $(cat "$W/hook.json")"
[ "$(q "select count(*) from public.projects where client_id='$C'")" = 1 ] || fail "a repeated webhook made a second project"
[ "$(q "select count(*) from public.documents where category='signed_installation_agreement'")" = 1 ] || fail "a repeated webhook filed a second PDF"
api rep GET /api/contacts/$C/esign >/dev/null
[ "$(j "d['envelopes'][0]['projectCode'] is not None and d['envelopes'][0]['documentId'] is not None")" = True ] \
  || fail "the record does not show the project and the PDF: $(cat "$W/r.json")"
pass "the signature creates the project as the rep who sent it, files the signed PDF, and a retry changes nothing"

# --- 6. voiding a contract out for signature ------------------------------
api rep POST /api/contacts/$C2/esign "{\"values\":{\"system_size_kw\":5,\"dealer_id\":\"$D\",\"address\":\"1 Maybe Rd\"},\"signerEmail\":\"eve@es.test\"}" >/dev/null
E2=$(j "d['envelope']['id']")
[ "$(api rep POST /api/esign/$E2 '{"action":"void"}')" = 200 ] || fail "voiding answered $(cat "$W/r.json")"
[ "$(j "d['envelope']['status']")" = voided ] || fail "the envelope is not voided"
docs; python3 -c "import json; d=[x for x in json.load(open('$W/docs.json')) if x['request']['recipients'][0]['email']=='eve@es.test'][0]; assert d['status']=='document.voided' and d['voided']['status']==11, d"
CODE=$(api rep POST /api/contacts/$C2/esign "{\"values\":{\"system_size_kw\":5,\"dealer_id\":\"$D\",\"address\":\"1 Maybe Rd\"},\"signerEmail\":\"eve@es.test\"}")
[ "$CODE" = 201 ] || fail "a new contract after voiding answered $CODE"
pass "a contract out for signature can be withdrawn in PandaDoc too, and a new one sent"

# --- 7. a change order, signed on screen, picked up without a webhook -----
CODE=$(api pm POST /api/projects/$P/change-orders '{"reason":"Main panel upgrade","description":"200A panel","amountDelta":1500}')
[ "$CODE" = 201 ] || fail "raising a change order answered $CODE: $(cat "$W/r.json")"
CO=$(j "d['id']")
[ "$(q "select number || '|' || status from public.change_orders where id='$CO'")" = "41|draft" ] \
  || fail "the change order did not take the company's next number"
CODE=$(api pm POST /api/projects/$P/change-orders/$CO '{"action":"send","signerName":"Carl Change","signerEmail":"carl@es.test","delivery":"embedded"}')
[ "$CODE" = 201 ] || fail "sending the change order answered $CODE: $(cat "$W/r.json")"
CE=$(j "d['envelope']['id']")
j "d['sessionUrl']" | grep -q '^https://app.pandadoc.com/s/sess_' || fail "no signing link for on-screen signing: $(cat "$W/r.json")"
[ "$(q "select status from public.change_orders where id='$CO'")" = pending_approval ] || fail "the change order is not pending"
docs
python3 - "$W/docs.json" <<'PY'
import json, sys
d = [x for x in json.load(open(sys.argv[1])) if x['request']['template_uuid'] == 'tmpl-co-1'][0]
t = {x['name']: x['value'] for x in d['request']['tokens']}
assert t['ChangeOrder.Number'] == 'CO-41' and t['ChangeOrder.Amount'] == '$1,500.00', t
assert t['Contract.CurrentValue'] == '$20,000.00' and t['Contract.NewValue'] == '$21,500.00', t
assert d['sent']['silent'] is True, 'an on-screen signing must not also email'
print('CO-REQUEST-OK')
PY
[ "$(api rep POST /api/esign/$CE '{"action":"refresh"}')" = 404 ] || fail "a sales rep could reach a change order's envelope"
[ "$(api rep GET /api/projects/$P/change-orders)" = 403 ] || fail "a sales rep could list change orders"
[ "$(api pm POST /api/esign/$CE '{"action":"refresh"}')" = 200 ] || fail "check status answered $(cat "$W/r.json")"
[ "$(j "d['envelope']['status']")" = sent ] || fail "an unsigned change order was reported $(j "d['envelope']['status']")"
[ "$(q "select contract_value from public.projects where id='$P'")" = 20000.00 ] || fail "the value moved before signing"
CPD=$(q "select provider_document_id from public.esign_envelopes where id='$CE'")
curl -s -X POST "$MOCK/__complete/$CPD" >/dev/null
[ "$(api pm POST /api/esign/$CE '{"action":"refresh"}')" = 200 ] || fail "check status after signing answered $(cat "$W/r.json")"
[ "$(j "d['envelope']['appliedAt'] is not None")" = True ] || fail "the signed change order was not applied: $(cat "$W/r.json")"
[ "$(q "select contract_value from public.projects where id='$P'")" = 21500.00 ] || fail "the contract value did not take the change order"
[ "$(q "select status || '|' || (document_id is not null) from public.change_orders where id='$CO'")" = "approved|true" ] \
  || fail "the change order is not approved with its signed PDF"
[ "$(api pm POST /api/esign/$CE '{"action":"refresh"}')" = 200 ] || fail "a second check failed"
[ "$(q "select contract_value from public.projects where id='$P'")" = 21500.00 ] || fail "checking again applied it twice"
pass "a change order signed on screen is picked up by Check status, adds its amount once, and files its PDF"

# --- 8. by hand: approve, void --------------------------------------------
api pm POST /api/projects/$P/change-orders '{"reason":"Fewer panels","amountDelta":-500,"requiresSignature":false}' >/dev/null
CO2=$(j "d['id']")
[ "$(api pm POST /api/projects/$P/change-orders/$CO2 '{"action":"approve"}')" = 200 ] || fail "approving answered $(cat "$W/r.json")"
[ "$(j "float(d['contractValue'])")" = 21000.0 ] || fail "a credit did not reduce the contract value: $(cat "$W/r.json")"
[ "$(api pm POST /api/projects/$P/change-orders/$CO2 '{"action":"void"}')" = 400 ] || fail "an approved change order was voided"
api pm POST /api/projects/$P/change-orders '{"reason":"Critter guard","amountDelta":300}' >/dev/null
CO3=$(j "d['id']")
[ "$(api pm POST /api/projects/$P/change-orders/$CO3 '{"action":"void"}')" = 200 ] || fail "voiding a draft answered $(cat "$W/r.json")"
[ "$(api pm POST /api/projects/$P/change-orders/$CO3 '{"action":"approve"}')" = 400 ] || fail "a void change order was approved"
[ "$(q "select contract_value from public.projects where id='$P'")" = 21000.00 ] || fail "the contract value is not 21000"
api pm GET /api/projects/$P/change-orders >/dev/null
[ "$(j "[o['status'] for o in d['orders']]")" = "['void', 'approved', 'approved']" ] || fail "the list is wrong: $(cat "$W/r.json")"
pass "a change order can be approved by hand (credits too), and a draft voided; neither can be undone into the other"

# --- 9. PandaDoc says no ---------------------------------------------------
api admin PUT /api/admin/settings '{"companyName":"SunCo","coPrefix":"CO-","coNextNumber":50,"pandadocContractTemplate":"missing-template","pandadocChangeOrderTemplate":"tmpl-co-1"}' >/dev/null
C3=$(q "insert into public.clients (dealer_id, first_name, last_name, email) values ('$D','Tom','Template','tom@es.test') returning id")
CODE=$(api rep POST /api/contacts/$C3/esign "{\"values\":{\"system_size_kw\":6,\"dealer_id\":\"$D\",\"address\":\"3 Ray Ct\"},\"signerEmail\":\"tom@es.test\"}")
[ "$CODE" = 502 ] || fail "a template PandaDoc does not know answered $CODE"
grep -q "Template not found" "$W/r.json" || fail "PandaDoc's reason is not passed on: $(cat "$W/r.json")"
[ "$(q "select status from public.esign_envelopes where client_id='$C3'")" = failed ] || fail "the failed send is not recorded as failed"
pass "PandaDoc's own refusal reaches the person in PandaDoc's words, and the envelope is marked failed"

# --- 10. in the browser, as a sales rep ------------------------------------
# Optional, like contract-signed-ui.sh: needs PLAYWRIGHT_CORE pointing at a
# playwright-core install and the pre-installed Chromium.
CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
if [ -n "${PLAYWRIGHT_CORE:-}" ] && [ -x "$CHROME" ]; then
  api admin PUT /api/admin/settings '{"companyName":"SunCo","coPrefix":"CO-","coNextNumber":60,"pandadocContractTemplate":"tmpl-contract-1","pandadocChangeOrderTemplate":"tmpl-co-1"}' >/dev/null
  q "insert into public.clients (dealer_id, first_name, last_name, email, contact_stage, mailing_street, mailing_city)
     values ('$D','Bea','Browser','bea@es.test','quoted','8 Glass St','Austin')" >/dev/null
  mkdir -p "$W/shots"; chmod 777 "$W/shots"
  BASE="$BASE" PW="$PLAYWRIGHT_CORE" CHROME="$CHROME" SHOTS="$W/shots" P="$P" node - <<'JS' || fail "the browser check failed (screenshots in $W/shots)"
const { chromium } = require(process.env.PW);
const { BASE, CHROME, SHOTS, P } = process.env;
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const errors = [];
  const as = async (email) => {
    const context = await browser.newContext({ viewport: { width: 1700, height: 1000 }, baseURL: BASE });
    const r = await context.request.post('/api/auth/login', { data: { email, password: 'Password1234!', door: 'staff' } });
    ok(r.ok(), `login ${email} answered ${r.status()}`);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    return page;
  };
  try {
    const page = await as('rep@es.test');
    const dialog = page.getByRole('dialog');
    await page.goto('/admin/people/stages');
    const card = page.locator('article.card', { hasText: 'Bea Browser' });
    await card.waitFor();
    const target = page.locator('section.board-col', { has: page.locator('header span', { hasText: 'Contract signed' }) });
    await card.dragTo(target);
    await dialog.waitFor({ timeout: 5000 });
    // The dealer list a sales rep sees (004500): it used to be empty for them.
    const dealer = dialog.locator('label.field', { has: page.locator(':scope > span', { hasText: /^Dealer( \*)?$/ }) }).locator('select');
    await dealer.waitFor();
    const options = await dealer.locator('option').allTextContents();
    ok(options.includes('Helios Solar'), `a sales rep's dealer list is ${JSON.stringify(options)}`);
    await dialog.locator('label.field', { has: page.locator(':scope > span', { hasText: /^System size \(kW\)( \*)?$/ }) }).locator('input').fill('6.6');
    await dialog.getByRole('button', { name: 'Send for e-signature…' }).click();
    await dialog.getByText('Send for e-signature', { exact: true }).waitFor();
    ok((await dialog.locator('input[type=email]').inputValue()) === 'bea@es.test', 'the signer email is not pre-filled');
    await page.screenshot({ path: `${SHOTS}/1-send-pane.png` });
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await dialog.getByText('Sent to bea@es.test').waitFor({ timeout: 20000 });
    await page.screenshot({ path: `${SHOTS}/2-sent.png` });
    await dialog.getByRole('button', { name: 'Done' }).click();
    await page.locator('.toast', { hasText: 'Contract sent to bea@es.test' }).waitFor();
    await page.locator('article.card', { hasText: 'Bea Browser' }).locator('.esign-chip').waitFor();
    ok(await page.locator('section.board-col', { hasText: 'Quoted' }).locator('article.card', { hasText: 'Bea Browser' }).count() === 1,
       'Bea moved before signing');
    await page.screenshot({ path: `${SHOTS}/3-board-awaiting.png` });
    console.log('PASS: in the browser, a sales rep picks the dealer, sends the contract, and the card waits in Quoted');

    const pm = await as('pm@es.test');
    await pm.goto(`/projects/${P}`);
    const panel = pm.locator('section.change-orders');
    await panel.getByText('CO-41').waitFor();
    ok(await panel.getByText('+$1,500.00').count() === 1, 'the signed change order is not listed with its amount');
    ok(await panel.getByRole('link', { name: 'Signed change order' }).count() === 1, 'no link to the signed change order');
    await panel.getByRole('button', { name: '+ New change order' }).click();
    await panel.locator('label.field', { hasText: 'Reason' }).locator('input').fill('Extra conduit run');
    await panel.locator('label.field', { hasText: 'Change to contract value' }).locator('input').fill('250');
    await panel.getByRole('button', { name: 'Raise change order' }).click();
    await panel.getByText('CO-60').waitFor();
    ok(await panel.getByRole('button', { name: 'Send for e-signature' }).count() >= 1, 'a draft cannot be sent');
    await pm.screenshot({ path: `${SHOTS}/4-change-orders.png`, fullPage: true });
    console.log('PASS: in the browser, the PM sees signed change orders with their PDF and raises a new one');
    ok(errors.length === 0, `page errors: ${errors.join('; ')}`);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
JS
else
  echo "SKIP: browser section (set PLAYWRIGHT_CORE to run it)"
fi

echo "ESIGN CHECKS PASSED"
