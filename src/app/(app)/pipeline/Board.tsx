'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { STAGES, STAGE_LABELS, stageIndex, type StageKey } from '@/lib/stages/definitions';
import { HOLD_REASONS, CANCELLATION_REASONS } from '@/lib/stages/fields';
import type { ProjectCard } from '@/lib/stages/service';

interface ToastState {
  kind: 'error' | 'ok';
  title: string;
  items?: string[];
  link?: { href: string; label: string };
}

type SideKind = 'hold' | 'cancel';
type BackState = { card: ProjectCard; to: StageKey };
type SideState = { card: ProjectCard; kind: SideKind };

/**
 * Kanban board: the seven stage columns (Complete is terminal) plus the Hold
 * and Cancelled side columns at the right. Forward drag is one stage and runs
 * the shared validation (snap-back + red outline + missing-items toast on
 * rejection); a drop on Hold/Cancelled opens a reason dialog and bypasses
 * validation; admins can drag one stage back with a logged reason — including
 * back out of Complete, which reopens the project.
 */
export function Board({ cards, isAdmin }: { cards: ProjectCard[]; isAdmin: boolean }) {
  const router = useRouter();
  const [dragging, setDragging] = useState<ProjectCard | null>(null);
  const [rejectedColumn, setRejectedColumn] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [busy, setBusy] = useState(false);
  const [backMove, setBackMove] = useState<BackState | null>(null);
  const [sideMove, setSideMove] = useState<SideState | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const interval = setInterval(() => router.refresh(), 30_000);
    const onFocus = () => router.refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [router]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  async function post(card: ProjectCard, body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${card.id}/move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ via: 'drag', ...body }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok) {
        setToast({ kind: 'ok', title: `${card.name} moved` });
        router.refresh();
        return true;
      }
      setToast({
        kind: 'error',
        title: `${card.name}: ${json?.error ?? 'move rejected'}`,
        items: json?.missing?.slice(0, 8),
        link: { href: `/projects/${card.id}/stages/${card.stage}`, label: 'Open stage form' },
      });
      return false;
    } finally {
      setBusy(false);
    }
  }

  function onDrop(column: string) {
    if (!dragging || busy) return;
    const card = dragging;
    setDragging(null);

    if (column === 'hold' || column === 'cancelled') {
      if (card.column === column) return;
      if (card.column === 'complete') {
        setToast({ kind: 'error', title: 'Move the project back out of Complete first.' });
        return;
      }
      setSideMove({ card, kind: column === 'hold' ? 'hold' : 'cancel' });
      return;
    }
    // Held/cancelled cards must be resumed/reinstated first (via the header).
    if (card.column === 'hold' || card.column === 'cancelled') {
      setToast({ kind: 'error', title: `Resume or reinstate ${card.name} from its page first.` });
      return;
    }

    const from = stageIndex(card.stage);
    const to = stageIndex(column as StageKey);
    if (to === from + 1) {
      post(card, { direction: 'forward' }).then((ok) => {
        if (!ok) {
          setRejectedColumn(column);
          setTimeout(() => setRejectedColumn(null), 1500);
        }
      });
    } else if (to === from - 1 && isAdmin) {
      setBackMove({ card, to: column as StageKey });
    } else if (to !== from) {
      setRejectedColumn(column);
      setTimeout(() => setRejectedColumn(null), 1500);
      setToast({
        kind: 'error',
        title:
          to > from
            ? 'One stage at a time — no skipping stages.'
            : isAdmin
              ? 'Backwards moves are limited to one stage.'
              : 'Only an admin can move a project backwards.',
      });
    }
  }

  const columns: Array<{ key: string; label: string; side?: boolean }> = [
    ...STAGES.map((s) => ({ key: s as string, label: STAGE_LABELS[s] })),
    { key: 'hold', label: 'Hold', side: true },
    { key: 'cancelled', label: 'Cancelled', side: true },
  ];

  return (
    <>
      <div className="board" role="list">
        {columns.map((col) => {
          const columnCards = cards.filter((c) => c.column === col.key);
          return (
            <section
              key={col.key}
              className={`board-col${col.side ? ' side' : ''}${col.key === 'complete' ? ' terminal' : ''}${rejectedColumn === col.key ? ' rejected' : ''}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDrop(col.key)}
            >
              <header>
                <span>{col.label}</span>
                <span className="col-count">{columnCards.length}</span>
              </header>
              <div className="col-cards">
                {columnCards.map((card) => (
                  <article
                    key={card.id}
                    className={`card${card.column === 'hold' ? ' on-hold' : ''}${card.column === 'cancelled' ? ' cancelled' : ''}`}
                    draggable={!busy}
                    onDragStart={() => setDragging(card)}
                    onDragEnd={() => setDragging(null)}
                  >
                    <Link href={`/projects/${card.id}`} className="card-title" draggable={false}>
                      {card.name}
                    </Link>
                    <div className="card-sub">{card.address ?? card.code}</div>
                    <div className="card-meta">
                      {card.systemSizeKw !== null && <span>{card.systemSizeKw} kW</span>}
                      {col.side ? (
                        <span className="dim">was {STAGE_LABELS[card.stage]}</span>
                      ) : col.key === 'complete' ? (
                        <span className="done-badge">✓ Completed</span>
                      ) : (
                        <span>{card.daysInStage}d in stage</span>
                      )}
                      {!col.side && card.missing.length > 0 && (
                        <span className="missing-badge" title={card.missing.join('\n')}>
                          {card.missing.length}
                        </span>
                      )}
                      {/* Project Chat §1: the unread count belongs on the card,
                          so a message from three days ago is visible without
                          opening anything. */}
                      {card.unreadMessages > 0 && (
                        <span className="chat-badge" title="Unread customer messages">
                          {`✉ ${card.unreadMessages}`}
                        </span>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {backMove && (
        <div className="dialog-backdrop">
          <div className="dialog" role="dialog" aria-modal>
            <h2>Move backwards?</h2>
            <p>
              Move <strong>{backMove.card.name}</strong> back to{' '}
              <strong>{STAGE_LABELS[backMove.to]}</strong>. A reason is required and this is
              written to the activity log.
            </p>
            <textarea ref={reasonRef} rows={3} placeholder="Reason for moving back…" />
            <div className="dialog-actions">
              <button className="btn secondary" type="button" onClick={() => setBackMove(null)}>
                Cancel
              </button>
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() => {
                  const reason = reasonRef.current?.value?.trim() ?? '';
                  if (reason.length < 5) return;
                  post(backMove.card, { direction: 'back', reason }).then(() => setBackMove(null));
                }}
              >
                Move back
              </button>
            </div>
          </div>
        </div>
      )}

      {sideMove && (
        <SideDialog
          state={sideMove}
          busy={busy}
          onClose={() => setSideMove(null)}
          onSubmit={(body) => post(sideMove.card, body).then((ok) => ok && setSideMove(null))}
        />
      )}

      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          <strong>{toast.title}</strong>
          {toast.items && toast.items.length > 0 && (
            <ul>
              {toast.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          {toast.link && <Link href={toast.link.href}>{toast.link.label} →</Link>}
        </div>
      )}
    </>
  );
}

function SideDialog({
  state,
  busy,
  onClose,
  onSubmit,
}: {
  state: SideState;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const hold = state.kind === 'hold';
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [expected, setExpected] = useState('');
  const [refund, setRefund] = useState(false);
  const [equipment, setEquipment] = useState(false);
  const reasons = hold ? HOLD_REASONS : CANCELLATION_REASONS;

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal>
        <h2>{hold ? 'Put on hold' : 'Cancel project'}</h2>
        <p>
          {hold ? 'Pause' : 'Cancel'} <strong>{state.card.name}</strong>. No stage fields are
          required — just the reason below. Logged to the activity trail.
        </p>
        <label className="field">
          <span>Reason *</span>
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">Select…</option>
            {reasons.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Notes *</span>
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {hold ? (
          <label className="field">
            <span>Expected resume date</span>
            <input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
          </label>
        ) : (
          <>
            <label className="check-inline">
              <input type="checkbox" checked={refund} onChange={(e) => setRefund(e.target.checked)} />
              Refund / clawback required
            </label>
            <label className="check-inline">
              <input
                type="checkbox"
                checked={equipment}
                onChange={(e) => setEquipment(e.target.checked)}
              />
              Equipment return required
            </label>
          </>
        )}
        <div className="dialog-actions">
          <button className="btn secondary" type="button" onClick={onClose}>
            Back
          </button>
          <button
            className={`btn${hold ? '' : ' danger'}`}
            type="button"
            disabled={busy || !reason || notes.trim().length < 3}
            onClick={() =>
              onSubmit(
                hold
                  ? { direction: 'hold', reason, notes, expectedResumeDate: expected || null }
                  : {
                      direction: 'cancel',
                      reason,
                      notes,
                      refundRequired: refund,
                      equipmentReturnRequired: equipment,
                    }
              )
            }
          >
            {hold ? 'Put on hold' : 'Cancel project'}
          </button>
        </div>
      </div>
    </div>
  );
}
