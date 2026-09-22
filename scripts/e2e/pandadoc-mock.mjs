// A stand-in for PandaDoc's public API, for scripts/e2e/esign.sh.
//
// Behaves the way the real one does in the respects the app depends on: a new
// document is 'document.uploaded' until it has been looked at once, then a
// draft; only a draft can be sent; only a completed document downloads; every
// call needs the API key. Two extra routes drive it from the test:
//   POST /__complete/<id>   the recipient signs
//   GET  /__docs            everything it was asked to make
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 3175);
const KEY = process.env.MOCK_KEY ?? 'test-key';
const docs = new Map();
let n = 0;

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url, 'http://mock');
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts[0] === '__docs') return send(res, 200, [...docs.values()]);
    if (parts[0] === '__complete') {
      const d = docs.get(parts[1]);
      if (!d) return send(res, 404, { detail: 'no such document' });
      d.status = 'document.completed';
      return send(res, 200, d);
    }
    if (req.headers.authorization !== `API-Key ${KEY}`) {
      return send(res, 401, { detail: 'Authentication credentials were not provided.' });
    }
    if (parts[0] !== 'documents') return send(res, 404, { detail: 'not found' });

    if (req.method === 'POST' && parts.length === 1) {
      if (!body?.template_uuid) return send(res, 400, { detail: 'template_uuid is required' });
      if (body.template_uuid === 'missing-template') {
        return send(res, 404, { detail: 'Template not found' });
      }
      const id = `pd_${++n}`;
      const d = { id, name: body.name, status: 'document.uploaded', looks: 0, request: body, sent: null, sessions: 0, voided: null };
      docs.set(id, d);
      return send(res, 201, { id, name: d.name, status: d.status });
    }
    const d = docs.get(parts[1]);
    if (!d) return send(res, 404, { detail: 'Not found.' });

    if (req.method === 'GET' && parts.length === 2) {
      if (d.status === 'document.uploaded' && d.looks++ >= 1) d.status = 'document.draft';
      return send(res, 200, { id: d.id, name: d.name, status: d.status });
    }
    if (req.method === 'POST' && parts[2] === 'send') {
      if (d.status !== 'document.draft') return send(res, 400, { detail: `Cannot send a ${d.status} document` });
      d.status = 'document.sent';
      d.sent = body;
      return send(res, 200, { id: d.id, status: d.status });
    }
    if (req.method === 'POST' && parts[2] === 'session') {
      if (d.status !== 'document.sent' && d.status !== 'document.viewed') {
        return send(res, 400, { detail: 'Document must be sent' });
      }
      d.sessions++;
      return send(res, 201, { id: `sess_${d.id}_${d.sessions}`, expires_at: '2099-01-01T00:00:00Z' });
    }
    if (req.method === 'GET' && parts[2] === 'download') {
      if (d.status !== 'document.completed') return send(res, 409, { detail: 'Not completed' });
      return send(res, 200, `%PDF-1.4\n% signed ${d.id}\n%%EOF\n`, 'application/pdf');
    }
    if (req.method === 'PATCH' && parts[2] === 'status') {
      if (body?.status === 11) d.status = 'document.voided';
      d.voided = body;
      res.writeHead(204);
      return res.end();
    }
    return send(res, 404, { detail: 'not found' });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`pandadoc mock on ${PORT}`));
