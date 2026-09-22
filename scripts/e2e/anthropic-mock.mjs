// A stand-in for the Claude Messages API, for scripts/e2e/assistant.sh.
//
// It does not think. It picks a tool from keywords in the question, and once
// the tool result comes back it answers "RESULT <tool>: <the result>", so the
// suite can see exactly what the tool returned under the asker's permissions.
// Every request is kept, for the suite to inspect: GET /__requests.
//
//   "refuse"      → stop_reason: refusal
//   "badrequest"  → HTTP 400
//   "loop"        → asks for a tool every round, forever
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 3176);
const requests = [];
let n = 0;

const ROUTES = [
  [/pm report/i, 'pm_report', {}],
  [/details (PRJ-[A-Z0-9]+)/i, 'project_details', (m) => ({ project: m[1] })],
  [/dashboard/i, 'dashboard_summary', { period: 'all' }],
  [/count by stage/i, 'run_report', {
    columns: [{ field: 'project.code' }],
    group_by: [{ field: 'project.stage' }],
    summarise: [{ field: 'project.code', agg: 'count' }],
  }],
  [/bogus field/i, 'run_report', { columns: [{ field: 'nope.nothing' }] }],
  [/contacts/i, 'find_contacts', {}],
  [/deals/i, 'find_deals', {}],
  [/stuck|blocked/i, 'find_projects', { only_blocked: true }],
  [/projects/i, 'find_projects', {}],
];

function reply(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const message = (content, stop_reason) => ({
  id: `msg_${++n}`,
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = new URL(req.url, 'http://mock');
    if (url.pathname === '/__requests') return reply(res, 200, requests);
    if (req.method !== 'POST' || url.pathname !== '/v1/messages') return reply(res, 404, { error: 'not found' });
    if (req.headers['x-api-key'] !== 'test-anthropic-key') {
      return reply(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ headers: { 'anthropic-beta': req.headers['anthropic-beta'] ?? null }, query: url.search, body });

    const msgs = body.messages;
    const last = msgs[msgs.length - 1];
    const firstUserText = (() => {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user' && typeof msgs[i].content === 'string') return msgs[i].content;
      }
      return '';
    })();

    if (/badrequest/i.test(firstUserText)) {
      return reply(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } });
    }
    if (/markdown demo/i.test(firstUserText)) {
      const text = [
        '## Two projects',
        'Both are **waiting on paperwork**:',
        '- [PRJ-DEMO](/projects/00000000-0000-0000-0000-000000000000) needs `Site survey photos`',
        '- a link that must not be one: [click me](https://evil.example/steal)',
        '',
        '| Code | Stage |',
        '| --- | --- |',
        '| PRJ-DEMO | Survey |',
        '| PRJ-TWO | Design |',
      ].join('\n');
      return reply(res, 200, message([{ type: 'text', text }], 'end_turn'));
    }
    if (/refuse/i.test(firstUserText)) {
      return reply(res, 200, message([], 'refusal'));
    }

    // A tool result came back: answer with it, verbatim.
    if (Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result')) {
      if (/loop/i.test(firstUserText)) {
        return reply(res, 200, message([{ type: 'tool_use', id: `toolu_${++n}`, name: 'find_projects', input: {} }], 'tool_use'));
      }
      const prev = msgs[msgs.length - 2].content.find((b) => b.type === 'tool_use');
      const results = last.content.map((b) => `${b.is_error ? 'ERROR ' : ''}${b.content}`).join('\n');
      return reply(res, 200, message([{ type: 'text', text: `RESULT ${prev?.name}: ${results}` }], 'end_turn'));
    }

    const tools = new Set((body.tools ?? []).map((t) => t.name));
    for (const [re, name, input] of ROUTES) {
      const m = re.exec(firstUserText);
      if (!m) continue;
      if (!tools.has(name)) {
        return reply(res, 200, message([{ type: 'text', text: `NO TOOL ${name} for this user` }], 'end_turn'));
      }
      return reply(res, 200, message([
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'tool_use', id: `toolu_${++n}`, name, input: typeof input === 'function' ? input(m) : input },
      ], 'tool_use'));
    }
    return reply(res, 200, message([{ type: 'text', text: 'Hello — ask me about **projects**.' }], 'end_turn'));
  })
  .listen(PORT, '127.0.0.1', () => console.log(`anthropic mock on ${PORT}`));
