import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * PandaDoc's public API, the parts this product uses.
 *
 * The key is PANDADOC_API_KEY, sent as `Authorization: API-Key …`. PANDADOC_API_BASE
 * exists for the test suite, which points it at a local stand-in; in
 * production it is left unset.
 *
 * The flow for one document:
 *   create from template   → status document.uploaded
 *   wait until draft        (PandaDoc builds it asynchronously, a few seconds)
 *   send                    → document.sent (silent when signing in person)
 *   [session]               a link for the embedded signing screen
 *   … the recipient signs   → document.completed, announced by webhook
 *   download                the signed PDF
 */

export const PANDADOC_APP = 'https://app.pandadoc.com';

export function pandadocBase(): string {
  return (process.env.PANDADOC_API_BASE ?? 'https://api.pandadoc.com/public/v1').replace(
    /\/+$/,
    ''
  );
}

export function pandadocConfigured(): boolean {
  return Boolean(process.env.PANDADOC_API_KEY);
}

export class PandaDocError extends Error {
  readonly status: number;
  /** PandaDoc itself refused, as opposed to this app declining to ask it. */
  readonly upstream: boolean;
  constructor(message: string, status: number, upstream = false) {
    super(message);
    this.status = status;
    this.upstream = upstream;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const key = process.env.PANDADOC_API_KEY;
  if (!key)
    throw new PandaDocError('PandaDoc is not connected — PANDADOC_API_KEY is not set.', 503);
  const res = await fetch(`${pandadocBase()}${path}`, {
    method,
    headers: {
      authorization: `API-Key ${key}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { detail?: unknown; message?: unknown };
      detail = String(j.detail ?? j.message ?? detail);
    } catch {
      /* not JSON */
    }
    throw new PandaDocError(
      `PandaDoc refused ${method} ${path.split('?')[0]} (${res.status})${detail ? `: ${detail}` : ''}`,
      res.status,
      true
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface PdRecipient {
  email: string;
  first_name?: string;
  last_name?: string;
  role?: string;
}

export interface PdDocument {
  id: string;
  name?: string;
  status: string;
}

export function createFromTemplate(input: {
  name: string;
  templateId: string;
  recipients: PdRecipient[];
  tokens: Record<string, string | number | null | undefined>;
  metadata: Record<string, string>;
}): Promise<PdDocument> {
  return call<PdDocument>('POST', '/documents', {
    name: input.name,
    template_uuid: input.templateId,
    recipients: input.recipients,
    tokens: Object.entries(input.tokens)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([name, value]) => ({ name, value: String(value) })),
    metadata: input.metadata,
    tags: ['solarflow'],
  });
}

export function getDocument(id: string): Promise<PdDocument> {
  return call<PdDocument>('GET', `/documents/${encodeURIComponent(id)}`);
}

/**
 * Wait for a new document to leave document.uploaded. PandaDoc says a few
 * seconds; this waits up to `ms` and returns whatever the status is then, so a
 * slow build is recorded as 'preparing' and finished by Check status rather
 * than failing the request.
 */
export async function waitForDraft(id: string, ms = 12000): Promise<string> {
  const until = Date.now() + ms;
  let delay = 400;
  for (;;) {
    const doc = await getDocument(id);
    if (doc.status !== 'document.uploaded') return doc.status;
    if (Date.now() + delay > until) return doc.status;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.6, 2000);
  }
}

export function sendDocument(
  id: string,
  opts: { subject: string; message: string; silent: boolean }
): Promise<PdDocument> {
  return call<PdDocument>('POST', `/documents/${encodeURIComponent(id)}/send`, opts);
}

/** A signing link for the embedded screen, valid for `lifetime` seconds. */
export async function createSession(
  id: string,
  recipient: string,
  lifetime = 3600
): Promise<{ id: string; url: string; expiresAt: string | null }> {
  const s = await call<{ id: string; expires_at?: string }>(
    'POST',
    `/documents/${encodeURIComponent(id)}/session`,
    { recipient, lifetime }
  );
  return {
    id: s.id,
    url: `${PANDADOC_APP}/s/${encodeURIComponent(s.id)}`,
    expiresAt: s.expires_at ?? null,
  };
}

export async function downloadDocument(id: string): Promise<Buffer> {
  const key = process.env.PANDADOC_API_KEY;
  if (!key)
    throw new PandaDocError('PandaDoc is not connected — PANDADOC_API_KEY is not set.', 503);
  const res = await fetch(`${pandadocBase()}/documents/${encodeURIComponent(id)}/download`, {
    headers: { authorization: `API-Key ${key}` },
    cache: 'no-store',
  });
  if (!res.ok)
    throw new PandaDocError(`PandaDoc refused the download (${res.status})`, res.status, true);
  return Buffer.from(await res.arrayBuffer());
}

/** Void a sent document (PandaDoc's status code 11, document.voided). */
export function voidDocument(id: string, note: string): Promise<void> {
  return call<void>('PATCH', `/documents/${encodeURIComponent(id)}/status`, {
    status: 11,
    note,
    notify_recipients: true,
  });
}

/**
 * PandaDoc's status string, in our words. Anything unrecognised is null and
 * changes nothing.
 */
export function mapStatus(pd: string | null | undefined): string | null {
  switch (pd) {
    case 'document.uploaded':
    case 'document.draft':
      return 'preparing';
    case 'document.sent':
    case 'document.waiting_approval':
    case 'document.approved':
      return 'sent';
    case 'document.viewed':
      return 'viewed';
    case 'document.completed':
    case 'document.paid':
      return 'completed';
    case 'document.declined':
    case 'document.rejected':
      return 'declined';
    case 'document.voided':
      return 'voided';
    case 'document.error':
      return 'failed';
    default:
      return null;
  }
}

/**
 * A webhook is PandaDoc's only if `signature` — a query parameter PandaDoc adds
 * to the URL — is the HMAC-SHA256 of the raw body under the shared key.
 * Compared in constant time; a missing key refuses everything.
 */
export function verifyWebhook(rawBody: string, signature: string | null): boolean {
  const key = process.env.PANDADOC_WEBHOOK_KEY;
  if (!key || !signature) return false;
  const expected = createHmac('sha256', key).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature.trim().toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface WebhookEvent {
  event: string;
  documentId: string;
  status: string | null;
}

/**
 * The events in a webhook body. PandaDoc sends an array of
 * `{ event, data: { id, status, … } }`; a single object is accepted as well.
 */
export function parseWebhook(body: unknown): WebhookEvent[] {
  const list = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : [];
  const out: WebhookEvent[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const e = item as { event?: unknown; data?: { id?: unknown; status?: unknown } };
    const id = e.data?.id;
    if (typeof id !== 'string' || !id) continue;
    out.push({
      event: typeof e.event === 'string' ? e.event : '',
      documentId: id,
      status: typeof e.data?.status === 'string' ? e.data.status : null,
    });
  }
  return out;
}
