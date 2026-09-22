import { NextResponse } from 'next/server';
import { parseWebhook, verifyWebhook } from '@/lib/esign/pandadoc';
import { handleWebhookEvent } from '@/lib/esign/service';

export const dynamic = 'force-dynamic';

/**
 * PandaDoc's webhook: Settings → Integrations → Webhooks in PandaDoc, pointed
 * at https://<your domain>/api/integrations/pandadoc/webhook with the
 * "document state changed" event, and its shared key set as
 * PANDADOC_WEBHOOK_KEY here.
 *
 * No session: the request is PandaDoc's only if its signature checks out, and
 * each event is then acted on as the person who sent the document (see
 * handleWebhookEvent). An unsigned or wrongly signed request changes nothing.
 *
 * Answers 200 once the events are handled — including events about documents
 * this app never sent, which are simply not ours. A failure answers 500, so
 * PandaDoc retries; completing is idempotent, so a retry cannot double-apply.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  const signature = new URL(request.url).searchParams.get('signature');
  if (!verifyWebhook(raw, signature)) {
    return NextResponse.json({ error: 'bad signature' }, { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'not JSON' }, { status: 400 });
  }
  const results: string[] = [];
  let failed = false;
  for (const ev of parseWebhook(body)) {
    try {
      results.push(await handleWebhookEvent(ev));
    } catch (e) {
      failed = true;
      const message = e instanceof Error ? e.message : String(e);
      console.error('[esign] webhook event failed:', ev.documentId, ev.status, message);
      results.push(`error: ${message}`);
    }
  }
  return NextResponse.json({ results }, { status: failed ? 500 : 200 });
}
