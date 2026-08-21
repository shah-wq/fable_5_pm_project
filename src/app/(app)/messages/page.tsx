import Link from 'next/link';
import { guardPath } from '@/lib/auth/session';
import { CHAT_MIGRATION_FILE, chatReady, loadInbox, type InboxFilter } from '@/lib/chat/service';
import { withUser } from '@/lib/db';
import { STAGE_LABELS } from '@/lib/stages/definitions';
import { InboxActions } from './InboxActions';

export const dynamic = 'force-dynamic';

const FILTERS: Array<{ key: InboxFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'flagged', label: 'Needs reply' },
  { key: 'waiting', label: 'Unanswered over 24h' },
];

/**
 * The global inbox (spec §1): every conversation across the PM's projects,
 * unread first then newest. "This is how a PM starts their morning; the
 * per-project panel is how they answer in context."
 *
 * Ordering is the whole feature. A list sorted by recency alone buries the
 * message from three days ago that nobody answered — which is precisely the
 * failure §1 opens with.
 */
export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; q?: string; mine?: string }>;
}) {
  const session = await guardPath('/messages');
  const sp = await searchParams;
  const filter = (FILTERS.find((f) => f.key === sp.filter)?.key ?? 'all') as InboxFilter;
  const search = sp.q?.trim() || null;
  const mine = sp.mine === '1';

  // The deployment and the database move separately: code ships on push, the SQL
  // is pasted into a console by a person some time later. In that window this
  // page says what to run rather than claiming there are no conversations.
  const { ready, rows } = await withUser(session, async (client) => {
    const present = await chatReady(client);
    if (!present) return { ready: false, rows: [] as Awaited<ReturnType<typeof loadInbox>> };
    return {
      ready: true,
      rows: await loadInbox(client, { filter, search, mine: mine ? session.userId : null }),
    };
  });

  if (!ready) {
    return (
      <main className="table-page">
        <h1>Messages</h1>
        <section className="panel">
          <h2>The database has not caught up yet</h2>
          <p>
            Messages live in a table called <code>public.project_messages</code>, which arrives with
            the project chat module’s migration. It is not in this database yet.
          </p>
          <p>
            Run <code>{CHAT_MIGRATION_FILE}</code> in the SQL editor — the whole file, once. It is
            safe to run twice. Then reload this page.
          </p>
          <p className="dim">
            Everything else in the app keeps working in the meantime.{' '}
            <Link href="/api/health">/api/health</Link> lists every migration this deployment
            expects.
          </p>
        </section>
      </main>
    );
  }

  const link = (over: Record<string, string | null>) => {
    const params = new URLSearchParams();
    if (filter !== 'all') params.set('filter', filter);
    if (search) params.set('q', search);
    if (mine) params.set('mine', '1');
    for (const [k, v] of Object.entries(over)) {
      if (v === null) params.delete(k);
      else params.set(k, v);
    }
    const qs = params.toString();
    return qs ? `/messages?${qs}` : '/messages';
  };

  const totalUnread = rows.reduce((n, r) => n + r.unread, 0);

  return (
    <main className="table-page">
      <div className="board-header">
        <h1>Messages</h1>
        <div className="board-actions">
          <span className="dim">
            {totalUnread > 0
              ? `${totalUnread} unread across ${rows.filter((r) => r.unread > 0).length} conversations`
              : 'Nothing unread'}
          </span>
        </div>
      </div>

      <form className="filters" method="get">
        <input
          type="search"
          name="q"
          placeholder="Search messages, customers, projects…"
          defaultValue={search ?? ''}
        />
        {filter !== 'all' && <input type="hidden" name="filter" value={filter} />}
        {mine && <input type="hidden" name="mine" value="1" />}
        <button className="btn" type="submit">
          Search
        </button>
      </form>

      <div className="filter-toggles">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            className={`toggle-chip${filter === f.key ? ' on' : ''}`}
            href={link({ filter: f.key === 'all' ? null : f.key })}
          >
            {f.label}
          </Link>
        ))}
        <Link className={`toggle-chip${mine ? ' on' : ''}`} href={link({ mine: mine ? null : '1' })}>
          My projects
        </Link>
        {(search || filter !== 'all' || mine) && (
          <Link className="toggle-chip clear" href="/messages">
            Clear
          </Link>
        )}
      </div>

      {rows.length === 0 ? (
        <section className="panel">
          <p className="chart-empty">
            {search || filter !== 'all'
              ? 'No conversations match that.'
              : 'No conversations yet. A thread appears here the first time you or a customer writes on a project.'}
          </p>
        </section>
      ) : (
        <InboxActions
          rows={rows.map((r) => ({
            projectId: r.projectId,
            projectName: r.projectName,
            projectCode: r.projectCode,
            customerName: r.customerName,
            pmName: r.pmName,
            stageLabel: STAGE_LABELS[r.stage] ?? r.stage,
            status: r.status,
            unread: r.unread,
            flagged: r.flagged,
            preview: r.preview,
            previewFrom: r.previewFrom,
            lastMessageAt: r.lastMessageAt,
            waitingHours: r.waitingHours,
          }))}
        />
      )}
    </main>
  );
}
