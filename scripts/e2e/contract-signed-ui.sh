#!/usr/bin/env bash
# Contract signed, in a real browser: the popup is the feature, and curl cannot
# see a popup.
#
# Drags a card into Contract signed and checks the signing form opens instead of
# the card moving; that Cancel leaves the card where it was; that it will not
# sign without a size; that signing moves the card; and that the contact record
# grows a System tab only once there is a system — including when the move is
# made from the record's own Lead status box.
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
# Dana has no deal at all. Rita was quoted a 5.4 kW system on an open deal.
DANA=$(q "insert into public.clients (first_name, last_name, email, phone, contact_stage)
  values ('Dana','Drag','dana@su.test','512-555-0700','appointment_scheduled') returning id")
RITA=$(q "insert into public.clients (first_name, last_name, email, phone, contact_stage)
  values ('Rita','Record','rita@su.test','512-555-0701','quoted') returning id")
q "insert into public.deals (client_id, stage, address, system_size_kw, gross_price)
   values ('$RITA','proposal','4 Beam Road',5.4,19000)" >/dev/null
echo "==> fixture: Dana with no deal, Rita quoted 5.4 kW"

PORT=$APPPORT nohup npx next start -p $APPPORT >"$W/next.log" 2>&1 &
NEXT_PID=$!
for i in $(seq 1 60); do
  curl -sf "$BASE/api/health" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && fail "app never came up"; sleep 1
done

BASE="$BASE" PW="$PW" CHROME="$CHROME" SHOTS="$W/shots" DANA="$DANA" RITA="$RITA" \
node - <<'JS' || fail "the browser check failed (screenshots in $W/shots)"
const { chromium } = require(process.env.PW);
const { BASE, CHROME, SHOTS, DANA, RITA } = process.env;
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

    // --- the board: a drop into Contract signed opens the form ------------
    await page.goto('/admin/people/stages');
    await card('Rita Record').waitFor();
    await card('Rita Record').dragTo(column('Contract signed'));
    await dialog.waitFor({ timeout: 5000 });
    ok(await dialog.getByText('Contract signed — Rita Record').isVisible(), 'the form does not name Rita');
    // It opens with what her open deal already says.
    const size = dialog.getByLabel('System size (kW)');
    // Numerically: the column is numeric(…,3), so it arrives as "5.400".
    ok(Number(await size.inputValue()) === 5.4, `Rita's quoted 5.4 kW was not carried in (got "${await size.inputValue()}")`);
    for (const label of ['Module brand', 'Inverter brand', 'Number of batteries', 'Electric utility', 'System price', 'Financed or cash?']) {
      ok(await dialog.getByLabel(label).count() > 0, `the form has no ${label}`);
    }
    ok(await dialog.getByText('Updated solar proposal').count() === 0, 'the form asks for uploads it has nowhere to put');
    await page.screenshot({ path: `${SHOTS}/1-board-dialog.png` });

    // Cancel: nothing moved.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'detached' });
    ok(await column('Quoted').locator('article.card', { hasText: 'Rita Record' }).count() === 1, 'Cancel moved Rita anyway');
    console.log('PASS: a drop into Contract signed opens the form, pre-filled; Cancel leaves the card');

    // --- no size, no signing ---------------------------------------------
    await card('Dana Drag').dragTo(column('Contract signed'));
    await dialog.waitFor();
    ok((await dialog.getByLabel('System size (kW)').inputValue()) === '', 'Dana has no deal but the size is filled in');
    await dialog.getByRole('button', { name: 'Sign contract' }).click();
    await dialog.getByText('needs a system size').waitFor();
    ok(await dialog.isVisible(), 'the form closed without a size');
    await page.screenshot({ path: `${SHOTS}/2-needs-size.png` });

    // --- sign ------------------------------------------------------------
    await dialog.getByLabel('System size (kW)').fill('8.1');
    await dialog.getByLabel('Module quantity').fill('20');
    await dialog.getByLabel('Amount').first().fill('29500');
    await dialog.getByRole('button', { name: 'Sign contract' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 10000 });
    await page.getByText('Dana Drag → Contract signed · system recorded on a new deal').waitFor();
    await column('Contract signed').locator('article.card', { hasText: 'Dana Drag' }).waitFor();
    await page.screenshot({ path: `${SHOTS}/3-signed.png` });
    console.log('PASS: it will not sign without a size; signing moves the card and says a deal was made');

    // --- the record: a System tab now, and not before --------------------
    await page.goto(`/admin/people/${DANA}`);
    const systemTab = page.locator('.admin-tabs button', { hasText: /^System$/ });
    await systemTab.waitFor();
    await systemTab.click();
    await page.getByLabel('System size (kW)').waitFor();
    ok(Number(await page.getByLabel('System size (kW)').inputValue()) === 8.1, 'Dana\'s record does not show 8.1 kW');
    ok(Number(await page.getByLabel('Module quantity').inputValue()) === 20, 'Dana\'s record lost the module quantity');
    await page.screenshot({ path: `${SHOTS}/4-record-system-tab.png`, fullPage: true });

    await page.goto(`/admin/people/${RITA}`);
    await page.locator('.admin-tabs').waitFor();
    ok(await page.locator('.admin-tabs button', { hasText: /^System$/ }).count() === 0, 'Rita has not signed but shows a System tab');
    console.log('PASS: the record shows the system once signed, and nothing about systems before');

    // --- the record's own Lead status box goes the same way --------------
    await page.getByLabel('Lead status').waitFor();
    await page.getByLabel('Lead status').selectOption('contract_signed');
    await page.locator('.save-bar').getByRole('button', { name: 'Save' }).click();
    await dialog.waitFor({ timeout: 5000 });
    ok(Number(await dialog.getByLabel('System size (kW)').inputValue()) === 5.4, 'the record\'s form did not carry Rita\'s 5.4 kW');
    await page.screenshot({ path: `${SHOTS}/5-record-dialog.png` });
    await dialog.getByLabel('System size (kW)').fill('6');
    await dialog.getByRole('button', { name: 'Sign contract' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 10000 });
    await page.locator('.admin-tabs button', { hasText: /^System$/ }).waitFor({ timeout: 10000 });
    console.log('PASS: Lead status → Contract signed opens the same form, and the System tab appears');

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
[ "$(q "select contact_stage from public.clients where id='$DANA'")" = contract_signed ] || fail "Dana is not signed in the database"
[ "$(q "select system_size_kw || '|' || module_quantity || '|' || contract_value || '|' || stage from public.deals where client_id='$DANA'")" = "8.100|20|29500.00|contract_out" ] \
  || fail "Dana's deal does not hold what was typed"
[ "$(q "select c.contact_stage || '|' || d.system_size_kw || '|' || d.gross_price from public.clients c join public.deals d on d.client_id=c.id where c.id='$RITA'")" = "contract_signed|6.000|19000.00" ] \
  || fail "Rita's signing from the record did not land on her deal"
pass "the database holds exactly what was typed into the forms"
echo "CONTRACT-SIGNED UI CHECKS PASSED"
