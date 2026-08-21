'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The inbox list, with the bulk actions §5 asks for: mark read and flag across a
 * selection. Selecting rows needs client state, so the list itself lives here
 * while the query stays on the server.
 *
 * Deliberately not offered in bulk: replying. A canned reply sent to nine people
 * at once is how chat stops being a conversation.
 */
export interface InboxItem {
  projectId: string;
  projectName: string;
  projectCode: string;
  customerName: string | null;
  pmName: string | null;
  stageLabel: string;
  status: string;
  unread: number;
  flagged: boolean;
  preview: string | null;
  previewFrom: 'customer' | 'staff' | 'system' | null;
  lastMessageAt: string | null;
  waitingHours: number | null;
}

export function InboxActions({ rows }: { rows: InboxItem[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allSelected = selected.size > 0 && selected.size === rows.length;

  async function bulk(action: 'read' | 'flag' | 'unflag') {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    try {
      await Promise.all(
        [...selected].map((projectId) =>
          action === 'read'
            ? fetch(`/api/chat/${projectId}/read`, { method: 'POST' })
            : fetch(`/api/chat/${projectId}/flag`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ flagged: action === 'flag' }),
              })
        )
      );
      setSelected(new Set());
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {selected.size > 0 && (
        <div className="bulk-bar">
          <span>
            {`${selected.size} selected`}
          </span>
          <button className="btn" type="button" onClick={() => bulk('read')} disabled={busy}>
            Mark read
          </button>
          <button className="btn secondary" type="button" onClick={() => bulk('flag')} disabled={busy}>
            Flag
          </button>
          <button className="btn secondary" type="button" onClick={() => bulk('unflag')} disabled={busy}>
            Clear flag
          </button>
          <button className="btn secondary" type="button" onClick={() => setSelected(new Set())}>
            Cancel
          </button>
        </div>
      )}

      <ul className="inbox">
        <li className="inbox-head">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.projectId)))}
            aria-label="Select all conversations"
          />
          <span className="dim">
            {`${rows.length} conversation${rows.length === 1 ? '' : 's'}`}
          </span>
        </li>
        {rows.map((r) => (
          <li key={r.projectId} className={`inbox-row${r.unread > 0 ? ' unread' : ''}`}>
            <input
              type="checkbox"
              checked={selected.has(r.projectId)}
              onChange={() => toggle(r.projectId)}
              aria-label={`Select ${r.projectName}`}
            />
            <div className="inbox-main">
              <p className="inbox-title">
                <Link href={`/projects/${r.projectId}/chat`}>
                  {r.customerName ?? r.projectName}
                </Link>
                {r.unread > 0 && <span className="badge">{r.unread}</span>}
                {r.flagged && <span className="flag-chip">needs reply</span>}
                {r.waitingHours !== null && r.waitingHours >= 24 && (
                  <span className="over">{`waiting ${r.waitingHours}h`}</span>
                )}
              </p>
              <p className="inbox-preview">
                {r.previewFrom === 'customer' && <span className="dim">They wrote: </span>}
                {r.previewFrom === 'staff' && <span className="dim">You wrote: </span>}
                {r.preview ?? <span className="dim">No messages yet</span>}
              </p>
              <p className="dim">
                {`${r.projectName} · ${r.projectCode} · ${r.stageLabel}`}
                {r.status !== 'active' ? ` · ${r.status.replace('_', ' ')}` : ''}
                {r.pmName ? ` · ${r.pmName}` : ''}
                {r.lastMessageAt ? ` · ${when(r.lastMessageAt)}` : ''}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** 'today', '3 days ago', or a date — precise enough to triage by. */
function when(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
