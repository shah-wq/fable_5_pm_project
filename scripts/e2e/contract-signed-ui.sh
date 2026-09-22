#!/usr/bin/env bash
# Contract signed, in a real browser: the popup is the feature, and curl cannot
# see a popup.
#
# Drags a card into Contract signed and checks the signing form opens instead of
# the card moving; that Cancel leaves the card where it was; that it will not
# sign without a dealer, a site and a size; that signing moves the card and
# creates the project; that the project then holds the card in place and the
# record's Lead status stops being offered; that the record's own Lead status
# box signs the same way; and that deleting the project from its page releases
# the contact to be moved again.
#
# Needs playwright-core. It is not a project dependency, so point at an install
# with PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core, or the check skips.
set -euo pipefail

ROOT=/home/user/fable_5_pm_project
W=/tmp/pmdb-signui
PGPORT=54432
APPPORT=3162
DB=pm_signui
export DATABASE_URL="postgres://postgres@127.0.0.1:$PGPORT/$DB"
BASE="http://127.0.0.1:$APPPORT"
CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

PW=${PLAYWRIGHT_CORE:-}
if [ -z "$PW" ]; then PW=$(cd "$ROOT" && node -p "require.resolve('playwright-core')" 2>/dev/null || true); fi
[ -n "$PW" ] && [ -x "$CHROME" ] || { echo "SKIP: no playwright-core or chromium; set PLAYWRIGHT_CORE"; exit 0; }

rm -rf "$W"; mkdir -p "$W/shots"; chmod -R 777 "$W"
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

node scripts/create-admin.mjs admin@su.test "Password1234!" "Ada Admin" >/dev/null
D=$(q "insert into public.dealers (name) values ('Helios') returning id")
# Dana has no deal, no dealer and no address. Rita belongs to Helios and was
# quoted a 5.4 kW system at 4 Beam Road on an open deal.
DANA=$(q "insert into public.clients (first_name, last_name, email, phone, contact_stage)
  values ('Dana','Drag','dana@su.test','512-555-0700','appointment_scheduled') returning id")
RITA=$(q "insert into public.clients (dealer_id, first_name, last_name, email, phone, contact_stage)
  values ('$D','Rita','Record','rita@su.test','512-555-0701','quoted') returning id")
q "insert into public.deals (client_id, dealer_id, stage, address, system_size_kw, gross_price)
   values ('$RITA','$D','proposal','4 Beam Road',5.4,19000)" >/dev/null
echo "==> fixture: Dana with nothing, Rita at Helios quoted 5.4 kW"

PORT=$APPPORT nohup npx next start -p $APPPORT >"$W/next.log" 2>&1 &
NEXT_PID=$!
for i in $(seq 1 60); do
  curl -sf "$BASE/api/health" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && fail "app never came up"; sleep 1
done

BASE="$BASE" PW="$PW" CHROME="$CHROME" SHOTS="$W/shots" DANA="$DANA" RITA="$RITA" D="$D" \
node - <<'JS' || fail "the browser check failed (screenshots in $W/shots)"
const { chromium } = require(process.env.PW);
const { BASE, CHROME, SHOTS, DANA, RITA, D } = process.env;
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const context = await browser.newContext({ viewport: { width: 1800, height: 1000 }, baseURL: BASE });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    const login = await context.request.post('/api/auth/login', {
      data: { email: 'admin@su.test', password: 'Password1234!', door: 'staff' },
    });
    ok(login.ok(), `login answered ${login.status()}`);

    const column = (label) => page.locator('section.board-col', { has: page.locator('header span', { hasText: label }) });
    const card = (name) => page.locator('article.card', { hasText: name });
    const dialog = page.getByRole('dialog');
    // A field by the words on its label. Not getByLabel: a <select> inside a
    // <label> takes its options into the label's name, and a note under a box
    // does the same, so an exact name never matches. The span holds the words
    // alone, plus " *" when the field is required.
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const inField = (scope, label) =>
      scope
        .locator('label.field', {
          has: page.locator(':scope > span', { hasText: new RegExp(`^${esc(label)}( \\*)?$`) }),
        })
        .locator('input, select, textarea')
        .first();
    const field = (label) => inField(dialog, label);
    const signBtn = () => dialog.getByRole('button', { name: 'Sign and create project' });

    // --- the board: a drop into Contract signed opens the form ------------
    await page.goto('/admin/people/stages');
    await card('Rita Record').waitFor();
    await card('Rita Record').dragTo(column('Contract signed'));
    await dialog.waitFor({ timeout: 5000 });
    ok(await dialog.getByText('Contract signed — Rita Record').isVisible(), 'the form does not name Rita');
    // It opens with what she already has: her dealer, her deal's site and size.
    ok((await field('Dealer').inputValue()) === D, 'Rita\'s dealer was not carried in');
    ok((await field('Site address').inputValue()) === '4 Beam Road', `Rita's site was not carried in (got "${await field('Site address').inputValue()}")`);
    // Numerically: the column is numeric(…,3), so it arrives as "5.400".
    ok(Number(await field('System size (kW)').inputValue()) === 5.4, 'Rita\'s quoted 5.4 kW was not carried in');
    for (const label of ['Module brand', 'Inverter brand', 'Number of batteries', 'Electric utility', 'System price', 'Financed or cash?']) {
      ok(await field(label).count() > 0, `the form has no ${label}`);
    }
    ok(await dialog.getByText('Updated solar proposal').count() === 0, 'the form asks for uploads it has nowhere to put');
    await page.screenshot({ path: `${SHOTS}/1-board-dialog.png` });

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'detached' });
    ok(await column('Quoted').locator('article.card', { hasText: 'Rita Record' }).count() === 1, 'Cancel moved Rita anyway');
    console.log('PASS: a drop into Contract signed opens the form, pre-filled with dealer, site and size; Cancel leaves the card');

    // --- nothing without a dealer, a site and a size ----------------------
    await card('Dana Drag').dragTo(column('Contract signed'));
    await dialog.waitFor();
    await signBtn().click();
    await dialog.getByText('needs the dealer, the site address and the system size in kW').waitFor();
    ok(await dialog.isVisible(), 'the form closed with nothing filled in');
    await page.screenshot({ path: `${SHOTS}/2-needs-fields.png` });

    // --- sign, and the project is made ------------------------------------
    await field('Dealer').selectOption({ label: 'Helios' });
    await field('Site address').fill('12 Ray Road, Austin, TX');
    await field('System size (kW)').fill('8.1');
    await field('Module quantity').fill('20');
    await field('Amount').fill('29500');
    await signBtn().click();
    await dialog.waitFor({ state: 'detached', timeout: 10000 });
    await page.getByText(/Dana Drag → Contract signed · project PRJ-\w+ created/).waitFor();
    await column('Contract signed').locator('article.card', { hasText: 'Dana Drag' }).waitFor();
    await page.screenshot({ path: `${SHOTS}/3-signed.png` });
    console.log('PASS: it will not sign without dealer, site and size; signing moves the card and creates the project');

    // --- the project holds the card --------------------------------------
    await page.reload();
    const dana = card('Dana Drag');
    await dana.locator('a', { hasText: /^Project PRJ-/ }).waitFor();
    ok((await dana.getAttribute('draggable')) === 'false', 'Dana\'s card can still be picked up');
    ok((await dana.getAttribute('class')).includes('held'), 'Dana\'s card is not marked held');
    await dana.dragTo(column('Quoted'));
    await page.waitForTimeout(500);
    ok(await column('Contract signed').locator('article.card', { hasText: 'Dana Drag' }).count() === 1, 'a held card was dragged out');
    const projectHref = await dana.locator('a', { hasText: /^Project PRJ-/ }).getAttribute('href');
    const projectCode = (await dana.locator('a', { hasText: /^Project PRJ-/ }).innerText()).replace('Project ', '');
    await page.screenshot({ path: `${SHOTS}/4-held-card.png` });
    console.log('PASS: the project holds the card in Contract signed');

    // --- the record: System tab, and Lead status no longer offered --------
    await page.goto(`/admin/people/${DANA}`);
    await page.getByText('held there by project').waitFor();
    ok(await inField(page, 'Lead status').count() === 0, 'Lead status is still offered while a project holds Dana');
    await page.screenshot({ path: `${SHOTS}/5-record-held.png` });
    const systemTab = page.locator('.admin-tabs button', { hasText: /^System$/ });
    await systemTab.click();
    await page.getByText(`Installed as project ${projectCode}`).waitFor();
    ok(Number(await inField(page, 'System size (kW)').inputValue()) === 8.1, 'Dana\'s record does not show 8.1 kW');
    await page.screenshot({ path: `${SHOTS}/6-record-system-tab.png`, fullPage: true });

    await page.goto(`/admin/people/${RITA}`);
    await page.locator('.admin-tabs').waitFor();
    ok(await page.locator('.admin-tabs button', { hasText: /^System$/ }).count() === 0, 'Rita has not signed but shows a System tab');
    console.log('PASS: the record shows the system and the hold once signed, and nothing about systems before');

    // --- the record's own Lead status box signs the same way --------------
    await inField(page, 'Lead status').waitFor();
    await inField(page, 'Lead status').selectOption('contract_signed');
    await page.locator('.save-bar').getByRole('button', { name: 'Save' }).click();
    await dialog.waitFor({ timeout: 5000 });
    ok((await field('Site address').inputValue()) === '4 Beam Road', 'the record\'s form did not carry Rita\'s site');
    await field('System size (kW)').fill('6');
    await signBtn().click();
    await dialog.waitFor({ state: 'detached', timeout: 10000 });
    await page.locator('.admin-tabs button', { hasText: /^System$/ }).waitFor({ timeout: 10000 });
    console.log('PASS: Lead status → Contract signed opens the same form and makes the project');

    // --- deleting the project releases the contact ------------------------
    await page.goto(projectHref);
    await page.getByRole('button', { name: 'Delete project' }).click();
    const del = page.getByRole('dialog');
    await del.getByText(`Delete project ${projectCode}`).waitFor();
    const confirmBtn = del.getByRole('button', { name: 'Delete project' });
    ok(await confirmBtn.isDisabled(), 'the delete is offered before the code is typed');
    await del.getByLabel(`Type ${projectCode} to confirm`).fill(projectCode);
    await page.screenshot({ path: `${SHOTS}/7-delete-dialog.png` });
    await confirmBtn.click();
    await page.waitForURL(`**/admin/people/${DANA}`, { timeout: 10000 });
    await inField(page, 'Lead status').waitFor();
    ok(await page.getByText('held there by project').count() === 0, 'the hold notice outlived the project');

    await page.goto('/admin/people/stages');
    await card('Dana Drag').waitFor();
    ok((await card('Dana Drag').getAttribute('draggable')) === 'true', 'Dana is still held after the project was deleted');
    await card('Dana Drag').dragTo(column('Quoted'));
    await page.getByText('Dana Drag → Quoted').waitFor();
    await column('Quoted').locator('article.card', { hasText: 'Dana Drag' }).waitFor();
    await page.screenshot({ path: `${SHOTS}/8-released.png` });
    console.log('PASS: deleting the project from its page releases the contact, who can then be moved');

    ok(errors.length === 0, `the page threw: ${errors.join(' | ')}`);
  } catch (e) {
    await page.screenshot({ path: `${SHOTS}/failure.png`, fullPage: true }).catch(() => {});
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
JS

# The database agrees with what the browser showed.
[ "$(q "select contact_stage from public.clients where id='$DANA'")" = quoted ] || fail "Dana is not back in Quoted in the database"
[ "$(q "select system_size_kw || '|' || module_quantity || '|' || contract_value || '|' || stage || '|' || address || '|' || (project_id is null) from public.deals where client_id='$DANA'")" \
  = "8.100|20|29500.00|contract_out|12 Ray Road, Austin, TX|true" ] || fail "Dana's deal does not hold what was typed, reopened"
[ "$(q "select count(*) from public.projects where client_id='$DANA'")" = 0 ] || fail "Dana's project was not deleted"
[ "$(q "select c.contact_stage || '|' || d.stage || '|' || p.system_size_kw || '|' || p.address from public.clients c join public.deals d on d.client_id=c.id join public.projects p on p.id=d.project_id where c.id='$RITA'")" \
  = "contract_signed|won|6.000|4 Beam Road" ] || fail "Rita's signing from the record did not make her project"
pass "the database holds exactly what was typed into the forms"
echo "CONTRACT-SIGNED UI CHECKS PASSED"
