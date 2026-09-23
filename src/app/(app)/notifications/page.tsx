import Link from 'next/link';
import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { loadFeed } from '@/lib/notify/feed';
import { MarkAllRead } from './MarkAllRead';

export const dynamic = 'force-dynamic';

/**
 * Everything the system has told this person, newest first. The same rows the
 * bell shows, without the limit. Customers have their own version under
 * /portal/updates.
 */
export default async function NotificationsPage() {
  const session = await guardPath('/notifications');
  const feed = await withUser(session, (c) => loadFeed(c, { limit: 200 }));
  const day = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <main className="table-page notifications-page">
      <div className="board-header">
        <div>
          <h1>Notifications</h1>
          <p className="dim">
            {feed.unread > 0 ? `${feed.unread} unread.` : 'All caught up.'} Which of these are sent,
            and how, is set by an admin under Admin → Notifications.
          </p>
        </div>
        <div className="board-actions">{feed.unread > 0 && <MarkAllRead />}</div>
      </div>
      {feed.items.length === 0 ? (
        <section className="panel">
          <p className="dim">Nothing yet. When a project moves, a customer writes or something needs you, it lands here.</p>
        </section>
      ) : (
        <ul className="feed">
          {feed.items.map((it) => (
            <li key={it.id} className={it.readAt ? 'read' : 'unread'}>
              <Link href={it.url}>
                <span className="feed-title">{it.title}</span>
                {it.body && <span className="feed-body">{it.body}</span>}
                <span className="feed-when">{day(it.createdAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
