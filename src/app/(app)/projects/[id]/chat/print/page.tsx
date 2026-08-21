import { notFound } from 'next/navigation';
import { guardPath } from '@/lib/auth/session';
import { loadContext, loadThread } from '@/lib/chat/service';
import { withUser } from '@/lib/db';
import { linkify } from '@/lib/chat/linkify';

export const dynamic = 'force-dynamic';

/**
 * The full thread as a printable transcript (spec §7) — "for disputes, handovers
 * and record requests".
 *
 * Internal notes are excluded, and not by filtering a list that had them in it:
 * this asks the customer channel for its messages, which is the only thing it
 * can produce. §6's "never mixed in exports" is then true because the export has
 * no path to them at all.
 *
 * PDF is the browser's print-to-PDF, as with the report exports. That needs no
 * headless renderer on the deployment and no second layout to keep in step with
 * the one on screen — and every desktop browser can save a print as a PDF.
 */
export default async function ChatTranscriptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await guardPath('/projects');

  const data = await withUser(session, async (client) => {
    const context = await loadContext(client, id);
    if (!context) return null;
    // The whole thread, not a page of it: a transcript with 'load earlier' in it
    // is not a transcript.
    const thread = await loadThread(client, id, {
      viewerId: session.userId,
      staff: true,
      channel: 'customer',
      limit: 200,
    });
    return { context, thread };
  });

  if (!data) notFound();
  const { context, thread } = data;

  return (
    <main className="transcript">
      <header>
        <h1>Conversation transcript</h1>
        <dl className="facts">
          <dt>Project</dt>
          <dd>{`${context.projectName} · ${context.projectCode}`}</dd>
          <dt>Address</dt>
          <dd>{context.address ?? '—'}</dd>
          <dt>Customer</dt>
          <dd>{context.customerName ?? '—'}</dd>
          <dt>Project manager</dt>
          <dd>{context.pmName ?? '—'}</dd>
          <dt>Messages</dt>
          <dd>{thread.messages.length}</dd>
          <dt>Printed</dt>
          <dd>{new Date().toLocaleString()}</dd>
        </dl>
        <p className="dim">
          Customer-visible messages only. Internal staff notes are not part of this transcript.
        </p>
        {thread.hasMore && (
          <p className="notice">
            This conversation is longer than 200 messages; only the most recent 200 are shown.
          </p>
        )}
      </header>

      {thread.messages.length === 0 ? (
        <p className="dim">No messages were exchanged on this project.</p>
      ) : (
        <ol className="transcript-list">
          {thread.messages.map((m) => (
            <li key={m.id}>
              <p className="transcript-head">
                <strong>
                  {m.senderRole === 'system'
                    ? 'System'
                    : (m.senderName ??
                      (m.senderRole === 'staff' ? 'SolarFlow' : 'Customer'))}
                </strong>
                <span className="dim">
                  {` · ${new Date(m.createdAt).toLocaleString()}`}
                  {m.stageLabel ? ` · about: ${m.stageLabel}` : ''}
                  {m.editedAt ? ' · edited' : ''}
                </span>
              </p>
              <div className="transcript-body">{linkify(m.body)}</div>
              {m.attachments.length > 0 && (
                <p className="dim">
                  {`Attached: ${m.attachments.map((a) => a.title).join(', ')}`}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
