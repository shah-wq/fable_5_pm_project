'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { linkify } from '@/lib/chat/linkify';

/**
 * The conversation. One component for all three surfaces (spec §8): the PM's
 * project panel, the customer portal, and the mobile app — differing only by a
 * role prop and which channel it is showing.
 *
 * The rules from the spec that live in here:
 *
 *  - §6 two channels, never one toggle. This component shows ONE channel and is
 *    told which. The internal channel gets a different background, a persistent
 *    'not visible to the customer' banner, and a differently worded button. It
 *    is structurally impossible to type into the internal box and have it go to
 *    the customer, because the box does not know how to do that.
 *  - §6 the customer tab's button names the recipient — 'Send to Maria
 *    Martinez'. A cheap, effective last check.
 *  - §3 plain text with line breaks and link detection. No rich formatting.
 *  - §3 day headers, and consecutive messages from one sender grouped.
 *  - §3 read receipts for staff only. The customer's copy is never given the
 *    data, so there is nothing here to leak.
 *  - §8 optimistic send with a pending state and a retry, because a message that
 *    silently vanishes is the worst outcome of the whole feature.
 *  - §8 reverse pagination: the most recent fifty, then back on demand.
 *
 * Near-real-time is polling, not a socket. The stack has no websocket layer and
 * adding one for this would be a second server to operate; a 15-second poll of a
 * small endpoint gives the same experience for a conversation where the two
 * parties are rarely online together (§3 says as much when it recommends
 * skipping typing indicators).
 */

export interface ThreadAttachment {
  id: string;
  title: string;
  mime: string | null;
  bytes: number | null;
}

export interface ThreadMessage {
  id: string;
  senderRole: 'customer' | 'staff' | 'system';
  senderName: string | null;
  body: string;
  stageLabel: string | null;
  isInternal: boolean;
  readAt: string | null;
  editedAt: string | null;
  createdAt: string;
  attachments: ThreadAttachment[];
  mine: boolean;
  /** Client-side only: an optimistic message not yet confirmed. */
  pending?: boolean;
  failed?: boolean;
}

export interface CannedReply {
  id: string;
  title: string;
  body: string;
}

const MAX_ATTACHMENT = 10 * 1024 * 1024;
const POLL_MS = 15_000;
/** §3: consecutive messages from the same sender within a few minutes group. */
const GROUP_WINDOW_MS = 5 * 60_000;
/** §3: a PM may edit their own message within five minutes. */
const EDIT_WINDOW_MS = 5 * 60_000;

export function Thread({
  projectId,
  role,
  channel,
  initial,
  hasMore: initialHasMore,
  recipientName,
  cannedReplies = [],
  stageRef,
  emptyState,
  readOnlyReason,
}: {
  projectId: string;
  role: 'staff' | 'customer';
  channel: 'customer' | 'internal';
  initial: ThreadMessage[];
  hasMore: boolean;
  /** Named on the send button, per §6. */
  recipientName?: string | null;
  cannedReplies?: CannedReply[];
  /** Pre-attached stage, when the thread was opened from a stage (§1). */
  stageRef?: string | null;
  emptyState: string;
  /** Set when nobody can post — e.g. a cancelled project. */
  readOnlyReason?: string | null;
}) {
  const [messages, setMessages] = useState<ThreadMessage[]>(initial);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const internal = channel === 'internal';

  // The newest confirmed message, which is what polling asks for messages after.
  const since = useCallback(
    () => messages.filter((m) => !m.pending).at(-1)?.createdAt ?? null,
    [messages]
  );

  const merge = useCallback((incoming: ThreadMessage[]) => {
    if (incoming.length === 0) return;
    setMessages((current) => {
      const seen = new Set(current.map((m) => m.id));
      const added = incoming.filter((m) => !seen.has(m.id));
      if (added.length === 0) return current;
      return [...current, ...added];
    });
  }, []);

  // Poll for the other side's replies. Paused while the tab is hidden: a
  // background tab polling every fifteen seconds for hours is somebody's battery.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stop || document.hidden) return;
      try {
        const params = new URLSearchParams({ channel });
        const from = since();
        if (from) params.set('since', from);
        const res = await fetch(`/api/chat/${projectId}?${params}`, { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as { messages?: ThreadMessage[] };
        if (!stop && json.messages) merge(json.messages);
      } catch {
        // A failed poll is not worth telling anyone about; the next one may work.
      }
    };
    const timer = setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [projectId, channel, since, merge]);

  // Mark the other party's messages read on open. Fire and forget: a failed
  // receipt must not interrupt reading.
  useEffect(() => {
    fetch(`/api/chat/${projectId}/read`, { method: 'POST' }).catch(() => undefined);
  }, [projectId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  async function send(retryOf?: ThreadMessage) {
    const body = retryOf ? retryOf.body : draft.trim();
    if (!body || busy) return;
    setError(null);
    setBusy(true);

    const tempId = retryOf?.id ?? `pending-${Date.now()}`;
    const attaching = retryOf ? [] : files;

    if (!retryOf) {
      setMessages((current) => [
        ...current,
        {
          id: tempId,
          senderRole: role === 'staff' ? 'staff' : 'customer',
          senderName: null,
          body,
          stageLabel: null,
          isInternal: internal,
          readAt: null,
          editedAt: null,
          createdAt: new Date().toISOString(),
          attachments: [],
          mine: true,
          pending: true,
        },
      ]);
      setDraft('');
      setFiles([]);
      if (fileInput.current) fileInput.current.value = '';
    } else {
      setMessages((current) =>
        current.map((m) => (m.id === tempId ? { ...m, pending: true, failed: false } : m))
      );
    }

    try {
      const form = new FormData();
      form.set('body', body);
      form.set('internal', internal ? '1' : '0');
      if (stageRef) form.set('stageRef', stageRef);
      for (const file of attaching) form.append('files', file);

      const res = await fetch(`/api/chat/${projectId}`, { method: 'POST', body: form });
      const json = (await res.json().catch(() => null)) as
        | { message?: ThreadMessage; error?: string }
        | null;
      if (!res.ok || !json?.message) {
        throw new Error(json?.error ?? `Could not send (${res.status})`);
      }
      // Replace the optimistic copy with the confirmed one.
      const confirmed = json.message;
      setMessages((current) => current.map((m) => (m.id === tempId ? confirmed : m)));
    } catch (e) {
      setMessages((current) =>
        current.map((m) => (m.id === tempId ? { ...m, pending: false, failed: true } : m))
      );
      setError(e instanceof Error ? e.message : 'Could not send that message.');
    } finally {
      setBusy(false);
    }
  }

  async function loadOlder() {
    const oldest = messages.find((m) => !m.pending)?.createdAt;
    if (!oldest) return;
    setBusy(true);
    try {
      const params = new URLSearchParams({ channel, before: oldest });
      const res = await fetch(`/api/chat/${projectId}?${params}`, { cache: 'no-store' });
      const json = (await res.json().catch(() => null)) as
        | { messages?: ThreadMessage[]; hasMore?: boolean }
        | null;
      if (json?.messages) {
        setMessages((current) => {
          const seen = new Set(current.map((m) => m.id));
          return [...json.messages!.filter((m) => !seen.has(m.id)), ...current];
        });
      }
      setHasMore(json?.hasMore === true);
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/chat/${projectId}/messages/${editing.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: editing.body }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(json?.error ?? 'Could not save the edit.');
      setMessages((current) =>
        current.map((m) =>
          m.id === editing.id
            ? { ...m, body: editing.body, editedAt: new Date().toISOString() }
            : m
        )
      );
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the edit.');
    } finally {
      setBusy(false);
    }
  }

  function chooseFiles(list: FileList | null) {
    if (!list) return;
    const chosen = Array.from(list);
    const tooBig = chosen.find((f) => f.size > MAX_ATTACHMENT);
    if (tooBig) {
      setError(`${tooBig.name} is larger than 10 MB.`);
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    setError(null);
    setFiles(chosen);
  }

  const sendLabel = internal
    ? 'Save internal note'
    : recipientName
      ? `Send to ${recipientName}`
      : 'Send';

  return (
    <div className={`thread${internal ? ' thread-internal' : ''}`}>
      {internal && (
        // §6: persistent, above the composer, impossible to miss at a glance.
        <p className="internal-banner">Internal — not visible to the customer</p>
      )}

      <div className="thread-scroll">
        {hasMore && (
          <button className="thread-older" type="button" onClick={loadOlder} disabled={busy}>
            Load earlier messages
          </button>
        )}
        {messages.length === 0 ? (
          <p className="thread-empty">{emptyState}</p>
        ) : (
          renderDays(messages, role, (m) => setEditing({ id: m.id, body: m.body }), send)
        )}
        <div ref={bottom} />
      </div>

      {error && <p className="notice error">{error}</p>}

      {editing ? (
        <div className="composer">
          <textarea
            value={editing.body}
            onChange={(e) => setEditing({ ...editing, body: e.target.value })}
            rows={3}
            aria-label="Edit message"
          />
          <div className="composer-actions">
            <button className="btn" type="button" onClick={saveEdit} disabled={busy}>
              Save edit
            </button>
            <button className="btn secondary" type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : readOnlyReason ? (
        <p className="thread-empty">{readOnlyReason}</p>
      ) : (
        <div className="composer">
          {cannedReplies.length > 0 && !internal && (
            <div className="canned-row">
              <span className="dim">Insert:</span>
              {cannedReplies.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className="toggle-chip"
                  // §5: inserted with one click and editable before sending — so
                  // it fills the box rather than sending.
                  onClick={() => setDraft((d) => (d ? `${d}\n\n${r.body}` : r.body))}
                  title={r.body.slice(0, 120)}
                >
                  {r.title}
                </button>
              ))}
            </div>
          )}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder={
              internal
                ? 'A note for the office — the customer never sees this'
                : 'Write a message…'
            }
            aria-label={internal ? 'Internal note' : 'Message'}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter is a line break. Cmd/Ctrl+Enter too, for
              // people whose habits come from email.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-actions">
            <label className="attach-btn">
              <input
                ref={fileInput}
                type="file"
                accept="image/*,application/pdf"
                multiple
                onChange={(e) => chooseFiles(e.target.files)}
              />
              {files.length > 0 ? `${files.length} file${files.length > 1 ? 's' : ''}` : 'Attach'}
            </label>
            <span className="spacer" />
            <button
              className={`btn${internal ? ' secondary' : ''}`}
              type="button"
              onClick={() => void send()}
              disabled={busy || draft.trim().length === 0}
            >
              {busy ? 'Sending…' : sendLabel}
            </button>
          </div>
          {files.length > 0 && (
            <small className="dim">
              {files.map((f) => f.name).join(', ')} — photos and PDFs up to 10 MB
            </small>
          )}
        </div>
      )}
    </div>
  );
}

// --- rendering -------------------------------------------------------------

function renderDays(
  messages: ThreadMessage[],
  role: 'staff' | 'customer',
  onEdit: (m: ThreadMessage) => void,
  onRetry: (m: ThreadMessage) => void
) {
  const out: React.ReactNode[] = [];
  let lastDay = '';
  let previous: ThreadMessage | null = null;

  for (const m of messages) {
    const day = dayKey(m.createdAt);
    if (day !== lastDay) {
      out.push(
        <p className="thread-day" key={`day-${day}-${m.id}`}>
          {dayLabel(m.createdAt)}
        </p>
      );
      lastDay = day;
      previous = null;
    }
    const grouped =
      previous !== null &&
      previous.senderRole === m.senderRole &&
      previous.senderName === m.senderName &&
      m.senderRole !== 'system' &&
      Date.parse(m.createdAt) - Date.parse(previous.createdAt) < GROUP_WINDOW_MS;

    out.push(<Bubble key={m.id} m={m} role={role} grouped={grouped} onEdit={onEdit} onRetry={onRetry} />);
    previous = m;
  }
  return out;
}

function Bubble({
  m,
  role,
  grouped,
  onEdit,
  onRetry,
}: {
  m: ThreadMessage;
  role: 'staff' | 'customer';
  grouped: boolean;
  onEdit: (m: ThreadMessage) => void;
  onRetry: (m: ThreadMessage) => void;
}) {
  // A system line is neutral and never looks like somebody talking (§3).
  if (m.senderRole === 'system') {
    return (
      <p className="msg-system">
        {m.body} <span className="dim">· {timeLabel(m.createdAt)}</span>
      </p>
    );
  }

  const fromMe = role === 'staff' ? m.senderRole === 'staff' : m.senderRole === 'customer';
  const canEdit =
    role === 'staff' &&
    m.mine &&
    !m.pending &&
    Date.now() - Date.parse(m.createdAt) < EDIT_WINDOW_MS;

  return (
    <div className={`msg${fromMe ? ' mine' : ''}${m.isInternal ? ' internal' : ''}${grouped ? ' grouped' : ''}`}>
      {!grouped && (
        <p className="msg-who">
          {m.senderName ?? (m.senderRole === 'staff' ? 'SolarFlow' : 'Customer')}
          {m.stageLabel && <span className="stage-chip-sm">about: {m.stageLabel}</span>}
        </p>
      )}
      <div className="msg-body">{linkify(m.body)}</div>
      {m.attachments.length > 0 && (
        <ul className="msg-files">
          {m.attachments.map((a) => (
            <li key={a.id}>
              <a href={`/api/files/${a.id}`} target="_blank" rel="noreferrer">
                {a.title}
              </a>
              {a.bytes !== null && <span className="dim"> {Math.round(a.bytes / 1024)} KB</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="msg-meta">
        {timeLabel(m.createdAt)}
        {m.editedAt && <span className="dim"> · edited</span>}
        {/* §3: staff see the customer's receipt; the customer is never sent the
            data, so this cannot render on their side. */}
        {role === 'staff' && m.senderRole === 'staff' && !m.isInternal && (
          <span className="dim"> · {m.readAt ? 'read' : 'sent'}</span>
        )}
        {m.pending && <span className="dim"> · sending…</span>}
        {m.failed && (
          <button className="msg-retry" type="button" onClick={() => onRetry(m)}>
            not sent — retry
          </button>
        )}
        {canEdit && (
          <button className="msg-retry" type="button" onClick={() => onEdit(m)}>
            edit
          </button>
        )}
      </p>
    </div>
  );
}

const dayKey = (iso: string) => iso.slice(0, 10);

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (dayKey(iso) === today.toISOString().slice(0, 10)) return 'Today';
  if (dayKey(iso) === yesterday.toISOString().slice(0, 10)) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
