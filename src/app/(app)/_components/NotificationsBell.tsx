'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

interface Item {
  id: string;
  kind: string;
  title: string;
  body: string;
  url: string;
  createdAt: string;
  readAt: string | null;
}

const ago = (iso: string) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
};

/**
 * The bell in the sidebar: the unread count, and the latest notifications in
 * a drop-down. Re-read every minute and when the tab comes back into view, so
 * a PM sees "customer wrote" without reloading. Opening an item marks it read
 * and goes to the screen it is about.
 */
export function NotificationsBell({ allHref = '/notifications' }: { allHref?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<Item[]>([]);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications?limit=12');
      if (!res.ok) return;
      const j = await res.json();
      setUnread(Number(j.unread ?? 0));
      setItems(Array.isArray(j.items) ? j.items : []);
    } catch {
      /* offline: keep what we have */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 60_000);
    const onVis = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  async function markRead(ids: string[] | 'all') {
    await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ids === 'all' ? { all: true } : { ids }),
    }).catch(() => undefined);
    await load();
  }

  return (
    <div className="bell-wrap" ref={box}>
      <button
        className={`bell${open ? ' active' : ''}`}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={unread > 0 ? `${unread} unread notifications` : 'Notifications'}
      >
        <span aria-hidden>🔔</span> Notifications
        {unread > 0 && <span className="bell-count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="bell-panel" role="dialog" aria-label="Notifications">
          <header>
            <strong>Notifications</strong>
            {unread > 0 && (
              <button className="linklike" type="button" onClick={() => void markRead('all')}>
                Mark all read
              </button>
            )}
          </header>
          <ul>
            {items.length === 0 && <li className="dim empty">Nothing yet.</li>}
            {items.map((it) => (
              <li key={it.id} className={it.readAt ? 'read' : 'unread'}>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    void markRead([it.id]).then(() => router.push(it.url));
                  }}
                >
                  <span className="bell-title">{it.title}</span>
                  {it.body && <span className="bell-body">{it.body}</span>}
                  <span className="bell-when">{ago(it.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
          <footer>
            <Link href={allHref} onClick={() => setOpen(false)}>
              All notifications
            </Link>
          </footer>
        </div>
      )}
    </div>
  );
}
