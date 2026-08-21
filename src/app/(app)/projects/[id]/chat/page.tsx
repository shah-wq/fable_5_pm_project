import Link from 'next/link';
import { notFound } from 'next/navigation';
import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import {
  CHAT_MIGRATION_FILE,
  chatReady,
  loadCannedReplies,
  loadContext,
  loadSummaries,
  loadThread,
} from '@/lib/chat/service';
import { STAGES, isStageKey } from '@/lib/stages/definitions';
import { Thread } from '@/app/_components/Thread';
import { FlagButton } from './FlagButton';

export const dynamic = 'force-dynamic';

/**
 * The PM's side of the conversation (spec §1, §5, §6).
 *
 * Two tabs, not one toggle. The customer channel and the internal channel are
 * separate URLs rendering separate Thread components — so the internal composer
 * has no code path that reaches the customer, and the customer composer has no
 * code path that hides a message. §6 is emphatic about why: "every product that
 * has shipped a single composer with an internal/external switch has eventually
 * sent an internal comment to a customer".
 *
 * Above the composer sits the context strip §5 asks for — stage, days in stage,
 * what is outstanding from the customer — so the PM answers without switching
 * tabs to find out where the project actually is.
 */
export default async function ProjectChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ channel?: string; about?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const session = await guardPath('/projects');
  const internal = sp.channel === 'internal';
  // A stage carried in from 'Ask a question' on a stage form (§1).
  const about = sp.about && isStageKey(sp.about) ? sp.about : null;

  const data = await withUser(session, async (client) => {
    // Probed first, on its own: the reads below all degrade to empty when 002900
    // has not been pasted yet, and an empty thread with a live composer would
    // offer to send a message the database cannot store.
    const ready = await chatReady(client);
    const context = await loadContext(client, id);
    if (!context) return null;
    const thread = await loadThread(client, id, {
      viewerId: session.userId,
      staff: true,
      channel: internal ? 'internal' : 'customer',
    });
    const canned = internal ? [] : await loadCannedReplies(client);
    const summaries = await loadSummaries(client, [id]);
    return { ready, context, thread, canned, summary: summaries.get(id) ?? null };
  });

  if (!data) notFound();
  const { context, thread, summary } = data;
  const tabHref = (channel: 'customer' | 'internal') =>
    `/projects/${id}/chat${channel === 'internal' ? '?channel=internal' : ''}`;

  return (
    <main className="surface wide chat-page">
      <div className="board-header">
        <div>
          <h1>{context.projectName}</h1>
          <p className="dim">
            {`${context.address ?? '—'} · ${context.projectCode}`}
          </p>
        </div>
        <div className="board-actions">
          <Link className="btn-link" href={`/projects/${id}`}>
            Project
          </Link>
          <Link className="btn-link" href={`/projects/${id}/chat/print`}>
            Transcript
          </Link>
          <Link className="btn-link" href="/messages">
            All messages
          </Link>
        </div>
      </div>

      {/* §5: current stage, days in stage, and any outstanding customer action. */}
      <section className="context-strip">
        <span className="ctx">
          <strong>{context.stageLabel}</strong>
          <span className="dim">{` · ${context.daysInStage} days in stage`}</span>
        </span>
        <span className="ctx">
          <span className="dim">Customer</span> {context.customerName ?? '—'}
          {!context.hasPortalAccess && (
            <span className="ctx-warn" title="They cannot read replies until they can sign in">
              no portal access
            </span>
          )}
        </span>
        <span className="ctx">
          <span className="dim">PM</span> {context.pmName ?? 'Unassigned'}
        </span>
        {context.openAsks.length > 0 && (
          <span className="ctx ctx-warn">
            {`Waiting on: ${context.openAsks.join(', ')}`}
          </span>
        )}
        <span className="spacer" />
        <FlagButton projectId={id} flagged={summary?.flagged ?? false} />
      </section>

      {/* Two tabs. Different labels, different colours, different composers. */}
      <nav className="chat-tabs" aria-label="Conversation channel">
        <Link className={internal ? '' : 'active'} href={tabHref('customer')}>
          Customer
          {summary && summary.unread > 0 && <span className="badge">{summary.unread}</span>}
        </Link>
        <Link className={internal ? 'active internal' : 'internal'} href={tabHref('internal')}>
          Internal
        </Link>
      </nav>

      {!data.ready && (
        <p className="notice">
          {`Messaging is not switched on in this database yet — run ${CHAT_MIGRATION_FILE} in the SQL editor, then reload.`}
        </p>
      )}

      {about && !internal && (
        <p className="notice">
          {`This message will be tagged “about: ${about.replace('_', ' ')}”.`}
        </p>
      )}

      <Thread
        projectId={id}
        role="staff"
        channel={internal ? 'internal' : 'customer'}
        initial={thread.messages}
        hasMore={thread.hasMore}
        recipientName={context.customerName}
        cannedReplies={data.canned}
        stageRef={about}
        emptyState={
          internal
            ? 'No internal notes yet. Anything written here stays with the project and is never shown to the customer.'
            : `No messages yet. ${context.customerName ?? 'The customer'} will see anything you send here in their portal and app.`
        }
        readOnlyReason={
          !data.ready
            ? `Messaging needs its migration run before anything can be sent — ${CHAT_MIGRATION_FILE}.`
            : context.hasPortalAccess
              ? null
              : `${context.customerName ?? 'This customer'} has no portal sign-in yet, so they would not be able to read a reply. Invite them from the project page first — or reach them by phone.`
        }
      />

      {/* Filter the thread by the stage a message was tagged with (§3). */}
      {!internal && (
        <details className="stage-detail">
          <summary>Filter by stage</summary>
          <div className="stage-chips">
            {STAGES.filter((s) => s !== 'complete').map((s) => (
              <Link key={s} className="stage-chip" href={`/projects/${id}/chat?about=${s}`}>
                {s.replace('_', ' ')}
              </Link>
            ))}
          </div>
        </details>
      )}
    </main>
  );
}
