// A stand-in for the Claude Messages API, for scripts/e2e/assistant.sh and
// scripts/e2e/ai-automation.sh.
//
// It does not think. For Ask SolarFlow it picks a tool from keywords in the
// question, and once the tool result comes back it answers "RESULT <tool>: <the
// result>", so the suite can see exactly what the tool returned under the
// asker's permissions. For the automation jobs it recognises the system prompt
// and answers with the JSON the job expects, built from what the job sent —
// so the suite can check that the app passed the right facts and did the right
// thing with the answer. Every request is kept, for the suite to inspect:
// GET /__requests.
//
//   "refuse"      → stop_reason: refusal
//   "badrequest"  → HTTP 400
//   "loop"        → asks for a tool every round, forever
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 3176);
const requests = [];
let n = 0;

const ROUTES = [
  [/briefing/i, 'pm_report', {}],
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
const json = (obj) => message([{ type: 'text', text: '```json\n' + JSON.stringify(obj) + '\n```' }], 'end_turn');

// --- the document reader ---------------------------------------------------
// The job sends the file as a document/image block and a text block naming the
// category ('as "Building permit approval"') and the stage's fields. The answer
// depends on the category, and on a marker hidden in the file's bytes.
function readDocument(blocks) {
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const file = blocks.find((b) => b.type === 'document' || b.type === 'image');
  const bytes = file ? Buffer.from(file.source.data, 'base64').toString('latin1') : '';
  const category = (/as "([^"]+)"/.exec(text) ?? [])[1] ?? '';
  if (bytes.includes('NOTAPERMIT')) {
    return json({
      document_type: 'a photo of a dog',
      matches_category: false,
      summary: 'This is not an approval letter.',
      fields: [],
      issues: ['The file does not appear to be an HOA approval.'],
    });
  }
  if (/Building permit approval/i.test(category)) {
    return json({
      document_type: 'building permit approval letter',
      matches_category: true,
      summary: 'Permit BP-2026-0042 approved 15 Sep 2026; expires 15 Mar 2027; conditional on final inspection.',
      fields: [
        { field: 'permit_status', value: 'approved', confidence: 0.95, evidence: 'PERMIT APPROVED' },
        { field: 'permit_number', value: 'BP-2026-0042', confidence: 0.97, evidence: 'Permit No. BP-2026-0042' },
        { field: 'permit_received_date', value: '2026-09-15', confidence: 0.9, evidence: 'Approved: September 15, 2026' },
        { field: 'permit_expiry_date', value: '2027-03-15', confidence: 0.92, evidence: 'Expires 180 days from approval' },
        { field: 'permit_fee', value: 350, confidence: 0.55, evidence: 'Fee: $350 (partially legible)' },
        // Not a value the form accepts: the app must drop it and say so.
        { field: 'permit_submission_method', value: 'fax', confidence: 0.8, evidence: 'Submitted by fax' },
        // Not a field at all: the app must ignore it.
        { field: 'permit_number_x', value: 'nope', confidence: 0.99, evidence: '' },
      ],
      issues: ['Approval is conditional on a final inspection within 180 days.'],
    });
  }
  if (/Delivery confirmation/i.test(category)) {
    return json({
      document_type: 'packing slip',
      matches_category: true,
      summary: 'Delivered 20 Sep 2026 against PO-7781.',
      fields: [
        { field: 'material_status', value: 'delivered', confidence: 0.9, evidence: 'DELIVERED' },
        { field: 'po_number', value: 'PO-7781', confidence: 0.96, evidence: 'PO-7781' },
        { field: 'material_delivered_date', value: '2026-09-20', confidence: 0.93, evidence: 'Delivered 09/20/2026' },
      ],
      issues: [],
    });
  }
  return json({ document_type: 'photo', matches_category: true, summary: 'Nothing to extract.', fields: [], issues: [] });
}

// --- reply drafts ------------------------------------------------------------
// The job sends the homeowner's first name, the project facts as JSON and the
// message. The answer quotes a fact back, so the suite can see the facts arrived.
function draftReply(text) {
  const first = (/first name: (\w+)/.exec(text) ?? [])[1] ?? 'there';
  const factsLine = text.split('\n').find((l) => l.startsWith('{'));
  let facts = {};
  try { facts = JSON.parse(factsLine); } catch { /* keep {} */ }
  const msg = (/last one: "([^]*)"$/m.exec(text) ?? [])[1] ?? '';
  if (/refund|cancel/i.test(msg)) {
    return json({
      reply: `Thanks, ${first} — I’ve passed this to ${facts.project_manager ?? 'your project manager'}, who will come back to you shortly.`,
      confidence: 0.4,
      needs_human: true,
      reason: 'money or cancellation',
    });
  }
  return json({
    reply: `Hi ${first}! Your project is in the ${facts.stage} stage. Building permit: ${facts.permits?.building_permit ?? 'not applied yet'}. Equipment: ${facts.equipment?.status ?? 'not ordered yet'}.`,
    confidence: 0.93,
    needs_human: false,
    reason: '',
  });
}

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
    // Kept without file bytes, which would make the log unreadable.
    requests.push({
      headers: { 'anthropic-beta': req.headers['anthropic-beta'] ?? null },
      query: url.search,
      body: {
        ...body,
        messages: body.messages.map((m) => ({
          ...m,
          content: Array.isArray(m.content)
            ? m.content.map((b) => (b.type === 'document' || b.type === 'image' ? { type: b.type, bytes: Buffer.from(b.source.data, 'base64').length } : b))
            : m.content,
        })),
      },
    });

    const system = Array.isArray(body.system) ? body.system.map((s) => s.text).join('\n') : String(body.system ?? '');
    const msgs = body.messages;
    const last = msgs[msgs.length - 1];

    // The automation jobs: one turn, no tools, JSON back.
    if (/^You read documents/.test(system)) {
      return reply(res, 200, readDocument(Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }]));
    }
    if (/^You draft replies/.test(system)) {
      return reply(res, 200, draftReply(typeof last.content === 'string' ? last.content : last.content.map((b) => b.text ?? '').join('\n')));
    }

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
