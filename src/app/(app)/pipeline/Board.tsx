'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { STAGES, STAGE_LABELS, stageIndex, type StageKey } from '@/lib/stages/definitions';
import type { ProjectCard } from '@/lib/stages/service';

interface ToastState {
  kind: 'error' | 'ok';
  title: string;
  items?: string[];
  link?: { href: string; label: string };
}

/**
 * Kanban board. Drag is limited to one stage forward (backwards one stage for
 * admins, with a mandatory reason). Drops call the same /move endpoint as the
 * advance button; an invalid drop snaps the card back, outlines the target
 * column red, and lists the missing items in a toast with a link to the form.
 */
export function Board({ cards, isAdmin }: { cards: ProjectCard[]; isAdmin: boolean }) {
  const router = useRouter();
  const [dragging, setDragging] = useState<ProjectCard | null>(null);
  const [rejectedColumn, setRejectedColumn] = useState<StageKey | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [busy, setBusy] = useState(false);
  const [backMove, setBackMove] = useState<{ card: ProjectCard; to: StageKey } | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  // "Two PMs see each other's moves live" — poll + refresh on focus.
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

  async function requestMove(card: ProjectCard, direction: 'forward' | 'back', reason?: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${card.id}/move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ direction, via: 'drag', reason }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok) {
        setToast({
          kind: 'ok',
          title:
            json?.stage === 'completed'
              ? `${card.name} completed 🎉`
              : `${card.name} → ${STAGE_LABELS[json?.stage as StageKey] ?? json?.stage}`,
        });
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

  function onDrop(target: StageKey) {
    if (!dragging || busy) return;
    const card = dragging;
    setDragging(null);
    const from = stageIndex(card.stage);
    const to = stageIndex(target);

    if (to === from + 1) {
      // Forward one stage — validation happens server-side; a rejection
      // "snaps back" simply because we never render the card elsewhere.
      requestMove(card, 'forward').then((ok) => {
        if (!ok) {
          setRejectedColumn(target);
          setTimeout(() => setRejectedColumn(null), 1500);
        }
      });
    } else if (to === from - 1 && isAdmin) {
      setBackMove({ card, to: target });
    } else if (to !== from) {
      setRejectedColumn(target);
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

  return (
    <>
      <div className="board" role="list">
        {STAGES.map((stage) => {
          const columnCards = cards.filter((c) => c.stage === stage && c.status !== 'complete');
          return (
            <section
              key={stage}
              className={`board-col${rejectedColumn === stage ? ' rejected' : ''}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDrop(stage)}
            >
              <header>
                <span>{STAGE_LABELS[stage]}</span>
                <span className="col-count">{columnCards.length}</span>
              </header>
              <div className="col-cards">
                {columnCards.map((card) => (
                  <article
                    key={card.id}
                    className={`card${card.status === 'on_hold' ? ' on-hold' : ''}`}
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
                      <span>{card.daysInStage}d in stage</span>
                      {card.status === 'on_hold' && <span className="hold-chip">on hold</span>}
                      {card.missing.length > 0 && (
                        <span
                          className="missing-badge"
                          title={card.missing.join('\n')}
                        >
                          {card.missing.length}
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
                  requestMove(backMove.card, 'back', reason).then(() => setBackMove(null));
                }}
              >
                Move back
              </button>
            </div>
          </div>
        </div>
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
