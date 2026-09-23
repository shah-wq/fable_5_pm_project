import Link from 'next/link';
import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { loadFeed } from '@/lib/notify/feed';
import { MarkAllRead } from '../../notifications/MarkAllRead';

export const dynamic = 'force-dynamic';

/**
 * The homeowner's updates: every step of their project as it happened, in
 * plain words, newest first. Opening one marks the list read.
 */
export default async function PortalUpdates() {
  const session = await guardPath('/portal');
  const feed = await withUser(session, (c) => loadFeed(c, { limit: 100 }));
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return (
    <div className="app-page">
      <div className="page-head">
        <h1>Updates</h1>
        {feed.unread > 0 && <MarkAllRead />}
      </div>
      {feed.items.length === 0 ? (
        <p className="dim">
          Nothing yet. Each step of your project — survey booked, permit approved, equipment
          delivered — appears here as it happens.
        </p>
      ) : (
        <ul className="feed portal-feed">
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
    </div>
  );
}
