#!/usr/bin/env bash
# Ask SolarFlow, against a stand-in for the Claude API (anthropic-mock.mjs,
# via ANTHROPIC_BASE_URL). Checked here: the request the app sends (model,
# fallbacks, thinking, caching, tools per role); that every tool reads with the
# asker's permissions — a dealer sees only their own book, a sales rep has no
# dashboard; the PM report, one project's details and a report-builder run; an
# unknown report field is refused rather than guessed; refusals, API errors and
# a runaway loop end in a sentence, not a hang; and each question is logged.
set -euo pipefail

ROOT=/home/user/fable_5_pm_project
W=/tmp/pmdb-assistant
PGPORT=54436
APPPORT=3166
MOCKPORT=3176
DB=pm_assistant
export DATABASE_URL="postgres://postgres@127.0.0.1:$PGPORT/$DB"
BASE="http://127.0.0.1:$APPPORT"
MOCK="http://127.0.0.1:$MOCKPORT"

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

node scripts/create-admin.mjs admin@as.test "Password1234!" "Ada Admin" >/dev/null
node scripts/create-admin.mjs pm@as.test "Password1234!" "Pat Manager" >/dev/null
node scripts/create-admin.mjs rep@as.test "Password1234!" "Ray Rep" >/dev/null
PM=$(q "select id from public.profiles where email='pm@as.test'")
q "update public.profiles set role='ops' where id='$PM'" >/dev/null
q "update public.profiles set role='sales' where email='rep@as.test'" >/dev/null
DA=$(q "insert into public.dealers (name) values ('Apex Solar') returning id")
DB2=$(q "insert into public.dealers (name) values ('Beacon Energy') returning id")
CA=$(q "insert into public.clients (dealer_id, first_name, last_name, email) values ('$DA','Alma','Apex','alma@as.test') returning id")
CB=$(q "insert into public.clients (dealer_id, first_name, last_name, email) values ('$DB2','Bo','Beacon','bo@as.test') returning id")
PA=$(q "insert into public.projects (name, dealer_id, client_id, stage, address, assigned_pm, contract_value)
  values ('Alma Apex', '$DA', '$CA', 'survey', '1 Apex Rd', '$PM', 30000) returning code")
PB=$(q "insert into public.projects (name, dealer_id, client_id, stage, address, assigned_pm)
  values ('Bo Beacon', '$DB2', '$CB', 'design', '2 Beacon Rd', '$PM') returning code")
DEALERU=$(q "insert into auth.users (email, encrypted_password, email_confirmed_at, raw_app_meta_data)
  values ('dealer@as.test', extensions.crypt('Password1234!', extensions.gen_salt('bf',12)), now(),
          '{\"user_role\":\"dealer\"}'::jsonb) returning id")
q "insert into public.dealer_users (dealer_id, user_id) values ('$DA','$DEALERU')" >/dev/null
echo "==> fixture: two dealers, a project each ($PA for Apex, $PB for Beacon), one PM, a dealer login for Apex"

MOCK_PORT=$MOCKPORT nohup node scripts/e2e/anthropic-mock.mjs >"$W/mock.log" 2>&1 &
MOCK_PID=$!
ANTHROPIC_API_KEY=test-anthropic-key ANTHROPIC_BASE_URL=$MOCK \
  PORT=$APPPORT nohup npx next start -p $APPPORT >"$W/next.log" 2>&1 &
NEXT_PID=$!
for i in $(seq 1 60); do
  curl -sf "$BASE/api/health" >/dev/null 2>&1 && curl -sf "$MOCK/__requests" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && fail "app or mock never came up"; sleep 1
done
login() { curl -s -o /dev/null -c "$W/$1.txt" -H 'content-type: application/json' \
  -d "{\"email\":\"$1@as.test\",\"password\":\"Password1234!\",\"door\":\"$2\"}" "$BASE/api/auth/login"; }
login admin staff; login pm staff; login rep staff; login dealer dealer
# ask <who> <question> -> the answer event's text (or the error), in $W/a.txt
ask() {
  local body
  body=$(python3 -c "import json,sys; print(json.dumps({'messages':[{'role':'user','content':sys.argv[1]}]}))" "$2")
  curl -s -b "$W/$1.txt" -H 'content-type: application/json' -d "$body" "$BASE/api/assistant" > "$W/a.ndjson"
  python3 - "$W/a.ndjson" > "$W/a.txt" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    line = line.strip()
    if not line: continue
    e = json.loads(line)
    if e['type'] == 'answer': print(e['text'])
    if e['type'] == 'error': print('ERROR: ' + e['error'])
PY
}
last_request() { curl -s "$MOCK/__requests" > "$W/reqs.json"; }

# --- 1. the request the app makes -----------------------------------------
[ "$(curl -s -o "$W/g.json" -w '%{http_code}' -b "$W/admin.txt" "$BASE/api/assistant")" = 200 ] || fail "GET /api/assistant failed"
python3 -c "import json; d=json.load(open('$W/g.json')); assert d['configured'] is True and len(d['suggestions'])>=3, d"
ask admin "how many projects are there"
grep -q "^RESULT find_projects:" "$W/a.txt" || fail "no answer from the tool loop: $(cat "$W/a.txt"; tail -20 "$W/next.log")"
last_request
python3 - "$W/reqs.json" <<'PY'
import json, sys
reqs = json.load(open(sys.argv[1]))
first, second = reqs[0], reqs[1]
b = first['body']
assert b['model'] == 'claude-opus-5', b['model']
assert b['fallbacks'] == 'default', b.get('fallbacks')
assert 'server-side-fallback-2026-07-01' in (first['headers']['anthropic-beta'] or ''), first['headers']
assert b['thinking'] == {'type': 'adaptive'}, b['thinking']
assert b['output_config']['effort'] == 'medium', b['output_config']
assert b['system'][0]['cache_control'] == {'type': 'ephemeral'}, 'the stable prompt is not cached'
assert 'Today is' not in b['system'][0]['text'] and 'Today is' in b['system'][1]['text'], 'the volatile line is inside the cached block'
assert 'project.code | Project ID' in b['system'][0]['text'], 'the report field catalogue is missing for an admin'
names = {t['name'] for t in b['tools']}
assert names == {'find_projects','project_details','dashboard_summary','pm_report','run_report','find_contacts','find_deals','customer_feedback'}, names
# The second call carries the assistant turn back whole — thinking block included — and one tool_result.
turn = second['body']['messages'][-2]
assert turn['role'] == 'assistant' and [c['type'] for c in turn['content']] == ['thinking', 'tool_use'], turn
res = second['body']['messages'][-1]['content']
assert len(res) == 1 and res[0]['type'] == 'tool_result', res
print('REQUEST-OK')
PY
python3 - "$W/a.txt" "$PA" "$PB" <<'PY'
import json, sys
text = open(sys.argv[1]).read().split(': ', 1)[1]
d = json.loads(text)
codes = {p['code'] for p in d['projects']}
assert codes == {sys.argv[2], sys.argv[3]}, codes
PY
pass "the app asks Claude Opus 5 with adaptive thinking, fallbacks and a cached prompt, and answers from the tool"

# --- 2. a dealer's tools and a dealer's rows -------------------------------
ask dealer "where are my projects"
python3 - "$W/a.txt" "$PA" "$PB" <<'PY'
import json, sys
d = json.loads(open(sys.argv[1]).read().split(': ', 1)[1])
codes = {p['code'] for p in d['projects']}
assert codes == {sys.argv[2]}, f'a dealer saw {codes}'
PY
last_request
python3 -c "
import json
b = json.load(open('$W/reqs.json'))[-2]['body']
names = {t['name'] for t in b['tools']}
assert names == {'find_projects', 'project_details'}, names
assert 'project.code | Project ID' not in b['system'][0]['text'], 'a dealer was given the report fields'
assert '/dealers/projects/' in b['system'][0]['text'], 'a dealer is told to link staff pages'
"
ask dealer "details $PB"
grep -q "No project matching" "$W/a.txt" || fail "a dealer read another dealer's project: $(cat "$W/a.txt")"
ask dealer "show me the dashboard"
grep -q "NO TOOL dashboard_summary" "$W/a.txt" || fail "a dealer was offered the dashboard: $(cat "$W/a.txt")"
pass "a dealer is offered two tools and sees only their own project, even by name"

# --- 3. a sales rep: contacts yes, dashboard no ----------------------------
ask rep "show me the dashboard"
grep -q "NO TOOL dashboard_summary" "$W/a.txt" || fail "a sales rep was offered the dashboard"
ask rep "list contacts"
grep -q '^RESULT find_contacts:' "$W/a.txt" || fail "a sales rep could not look up contacts: $(cat "$W/a.txt")"
grep -q 'Alma Apex' "$W/a.txt" || fail "the contact list is empty: $(cat "$W/a.txt")"
grep -q 'Apex Solar' "$W/a.txt" || fail "a sales rep's contact list has no dealer names: $(cat "$W/a.txt")"
pass "a sales rep gets the sales tools, with dealer names, and not the operations ones"

# --- 4. the PM report, one project, a report run ---------------------------
ask pm "give me the pm report"
python3 - "$W/a.txt" <<'PY'
import json, sys
d = json.loads(open(sys.argv[1]).read().split(': ', 1)[1])
pm = [p for p in d['pms'] if p['pm'] == 'Pat Manager'][0]
assert pm['active'] == 2 and len(pm['projects']) == 2, pm
assert all(p['missing_to_advance'] for p in pm['projects']), 'nothing is missing on two fresh projects?'
PY
ask pm "details $PA"
python3 - "$W/a.txt" "$PA" <<'PY'
import json, sys
d = json.loads(open(sys.argv[1]).read().split(': ', 1)[1])
assert d['code'] == sys.argv[2] and d['stage'] == 'Survey' and d['dealer'] == 'Apex Solar', d
assert d['contract_value'] == 30000, 'ops sees the contract value on the project page too'
assert isinstance(d['missing_to_advance'], list) and d['missing_to_advance'], d['missing_to_advance']
PY
ask admin "count by stage"
python3 - "$W/a.txt" <<'PY'
import json, sys
d = json.loads(open(sys.argv[1]).read().split(': ', 1)[1])
assert d['total_rows'] == 2, d
PY
ask admin "bogus field please"
grep -q "Unknown or not permitted field keys: nope.nothing" "$W/a.txt" || fail "an unknown report field was not refused: $(cat "$W/a.txt")"
pass "PM report, project details and a report-builder run answer from the database; a made-up field is refused"

# --- 5. how it ends when it cannot answer ----------------------------------
ask admin "please refuse this"
grep -q "can’t help with that one" "$W/a.txt" || fail "a refusal was not turned into a sentence: $(cat "$W/a.txt")"
ask admin "badrequest now"
grep -q "^ERROR: The assistant could not process that question" "$W/a.txt" || fail "an API error was not explained: $(cat "$W/a.txt")"
ask admin "loop forever on projects"
grep -q "more lookups than I am allowed" "$W/a.txt" || fail "a runaway tool loop was not stopped: $(cat "$W/a.txt")"
pass "a refusal, an API error and a runaway loop each end in a sentence"

# --- 6. who may ask, and the log -------------------------------------------
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"hi"}]}' "$BASE/api/assistant")
[ "$CODE" = 401 ] || fail "an anonymous question answered $CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$W/admin.txt" -H 'content-type: application/json' -d '{"messages":[]}' "$BASE/api/assistant")
[ "$CODE" = 400 ] || fail "an empty question answered $CODE"
N=$(q "select count(*) from public.audit_log where action = 'assistant.asked'")
[ "$N" -ge 10 ] || fail "questions are not logged ($N)"
[ "$(q "select context->>'question' from public.audit_log where action='assistant.asked' and actor_id='$DEALERU' order by occurred_at limit 1")" = "where are my projects" ] \
  || fail "the log does not say who asked what"
pass "only signed-in staff and dealers may ask, and every question is logged against the person"

# --- 7. the panel, in a browser --------------------------------------------
CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
if [ -n "${PLAYWRIGHT_CORE:-}" ] && [ -x "$CHROME" ]; then
  mkdir -p "$W/shots"; chmod 777 "$W/shots"
  BASE="$BASE" PW="$PLAYWRIGHT_CORE" CHROME="$CHROME" SHOTS="$W/shots" node - <<'JS' || fail "the browser check failed (screenshots in $W/shots)"
const { chromium } = require(process.env.PW);
const { BASE, CHROME, SHOTS } = process.env;
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, baseURL: BASE });
  const r = await context.request.post('/api/auth/login', { data: { email: 'pm@as.test', password: 'Password1234!', door: 'staff' } });
  ok(r.ok(), `login answered ${r.status()}`);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto('/pipeline');
    await page.getByRole('button', { name: 'Ask SolarFlow' }).click();
    const panel = page.getByRole('complementary', { name: 'Ask SolarFlow' });
    await panel.getByRole('button', { name: 'Give me the PM report' }).waitFor();
    await page.screenshot({ path: `${SHOTS}/1-empty.png` });
    await panel.locator('textarea').fill('markdown demo');
    await panel.locator('textarea').press('Enter');
    await panel.locator('.assistant-turn.assistant table').waitFor({ timeout: 20000 });
    ok(await panel.locator('.assistant-turn.assistant a[href="/projects/00000000-0000-0000-0000-000000000000"]').count() === 1, 'the project link is missing');
    ok(await panel.locator('a[href^="https://evil"]').count() === 0, 'an outside link was rendered as a link');
    ok(await panel.getByText('click me').count() === 1, 'the outside link text vanished');
    ok(await panel.locator('.assistant-turn.assistant strong', { hasText: 'waiting on paperwork' }).count() === 1, 'bold did not render');
    ok(await panel.locator('.assistant-turn.assistant td', { hasText: 'PRJ-TWO' }).count() === 1, 'the table did not render');
    await page.screenshot({ path: `${SHOTS}/2-answer.png` });
    // The conversation survives moving to another page.
    await page.goto('/projects');
    await page.getByRole('button', { name: 'Ask SolarFlow' }).click();
    await panel.locator('.assistant-turn.user', { hasText: 'markdown demo' }).waitFor();
    await panel.locator('textarea').fill('give me the pm report');
    await panel.getByRole('button', { name: 'Ask', exact: true }).click();
    await panel.locator('.assistant-turn.assistant', { hasText: 'RESULT pm_report' }).waitFor({ timeout: 20000 });
    await page.screenshot({ path: `${SHOTS}/3-second.png` });
    console.log('PASS: in the browser, the panel answers, renders markdown safely, and keeps the chat across pages');
    ok(errors.length === 0, `page errors: ${errors.join('; ')}`);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
JS
else
  echo "SKIP: browser section (set PLAYWRIGHT_CORE to run it)"
fi

echo "ASSISTANT CHECKS PASSED"
