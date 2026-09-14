'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  DEAL_COLUMNS,
  DEAL_STAGE_LABELS,
  DEAL_STAGE_MEANS,
  dealStageIndex,
  type DealColumn,
} from '@/lib/deals/definitions';
import type { DealCard } from '@/lib/deals/service';

interface ToastState {
  kind: 'error' | 'ok';
  title: string;
  items?: string[];
  link?: { href: string; label: string };
}

/**
 * The deal board (Module 17, Part 5).
 *
 * "Eight columns with Won and Lost visually separated at the end, exactly as
 * Hold and Cancelled are on the Pipeline board. Cards show person, address,
 * value, days in stage, next action and a missing-items badge. Column headers
 * carry count and total value."
 *
 * Deliberately the same shapes and the same class names as the project board:
 * §1 says "Learning the second board should take no time at all", and two
 * boards that look alike but behave differently would be worse than two that
 * look different.
 */
export function DealBoard({
  cards,
  isAdmin,
  lossReasons,
}: {
  cards: DealCard[];
  isAdmin: boolean;
  lossReasons: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [dragging, setDragging] = useState<DealCard | null>(null);
  const [rejectedColumn, setRejectedColumn] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [busy, setBusy] = useState(false);
  const [lost, setLost] = useState<DealCard | null>(null);
  const [back, setBack] = useState<{ card: DealCard; to: DealColumn } | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const [lostReason, setLostReason] = useState('');

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  async function post(card: DealCard, body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    try {
      const res = await fetch(`/api/deals/${card.id}/move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setToast({
          kind: 'error',
          title: json?.error ?? `That move was refused (${res.status}).`,
          items: json?.missing ?? [],
        });
        return false;
      }
      if (json?.projectId) {
        setToast({
          kind: 'ok',
          title: `${card.personName} is a project now.`,
          link: { href: `/projects/${json.projectId}`, label: 'Open the project' },
        });
      }
      router.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function onDrop(column: DealColumn) {
    const card = dragging;
    setDragging(null);
    if (!card || card.column === column) return;

    if (column === 'lost') {
      setLostReason('');
      setLost(card);
      return;
    }
    const backwards = dealStageIndex(column) < dealStageIndex(card.column);
    if (backwards) {
      if (!isAdmin) {
        setRejectedColumn(column);
        setTimeout(() => setRejectedColumn(null), 1200);
        setToast({
          kind: 'error',
          title: 'This board is forward-only. An admin can move a deal back with a reason.',
        });
        return;
      }
      setBack({ card, to: column });
      return;
    }
    // Forward, including a skip: the service checks every stage being jumped.
    const ok = await post(card, { move: 'to', target: column, via: 'drag' });
    if (!ok) {
      setRejectedColumn(column);
      setTimeout(() => setRejectedColumn(null), 1200);
    }
  }

  return (
    <>
      <div className="board" role="list">
        {DEAL_COLUMNS.map((col) => {
          const columnCards = cards.filter((c) => c.column === col);
          const side = col === 'won' || col === 'lost';
          const total = columnCards.reduce((sum, c) => sum + (c.value ?? 0), 0);
          return (
            <section
              key={col}
              className={`board-col${side ? ' side' : ''}${col === 'won' ? ' terminal' : ''}${
                rejectedColumn === col ? ' rejected' : ''
              }`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDrop(col)}
            >
              <header>
                <span>{DEAL_STAGE_LABELS[col]}</span>
                <span className="col-count">{columnCards.length}</span>
              </header>
              <p className="col-sub dim">
                {total > 0 ? `$${Math.round(total).toLocaleString()}` : DEAL_STAGE_MEANS[col]}
              </p>
              <div className="col-cards">
                {columnCards.map((card) => (
                  <article
                    key={card.id}
                    className={`card${card.column === 'lost' ? ' cancelled' : ''}`}
                    draggable={!busy && card.column !== 'won'}
                    onDragStart={() => setDragging(card)}
                    onDragEnd={() => setDragging(null)}
                  >
                    <Link href={`/deals/${card.id}`} className="card-title" draggable={false}>
                      {card.personName}
                    </Link>
                    <div className="card-sub">{card.address ?? card.code}</div>
                    <div className="card-meta">
                      {card.value !== null && <span>${card.value.toLocaleString()}</span>}
                      {side ? (
                        card.column === 'won' ? (
                          <span className="done-badge">✓ Won</span>
                        ) : (
                          <span className="dim">{card.lostReason ?? 'lost'}</span>
                        )
                      ) : (
                        <span>{card.daysInStage}d in stage</span>
                      )}
                      {!side && card.missing.length > 0 && (
                        <span className="missing-badge" title={card.missing.join('\n')}>
                          {card.missing.length}
                        </span>
                      )}
                      {/* Part 5: "Required on every open deal. Deals without one
                          appear in My Day and in the dashboard's attention
                          list." The card says it first. */}
                      {!side && !card.nextAction && (
                        <span className="flag-badge" title="No next action — Part 5 requires one on every open deal">
                          ⚑ no action
                        </span>
                      )}
                      {!side && card.nextActionDue && card.nextAction && (
                        <span className="flag-badge" title={`${card.nextAction} — due ${card.nextActionAt}`}>
                          ⏰ due
                        </span>
                      )}
                    </div>
                    {card.ownerName ? (
                      <div className="card-sub dim">{card.ownerName}</div>
                    ) : (
                      <div className="card-sub dim">unassigned</div>
                    )}
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {lost && (
        <div className="dialog-backdrop">
          <div className="dialog" role="dialog" aria-modal>
            <h2>Mark this deal lost?</h2>
            <p>
              {`${lost.personName} — a reason is required, and a lost deal can be reopened later.`}
            </p>
            <label className="field">
              <span>Reason *</span>
              <select value={lostReason} onChange={(e) => setLostReason(e.target.value)}>
                <option value="">Pick a reason…</option>
                {lossReasons.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <textarea ref={reasonRef} rows={3} placeholder="Anything worth remembering…" />
            <div className="dialog-actions">
              <button className="btn secondary" type="button" onClick={() => setLost(null)}>
                Cancel
              </button>
              <button
                className="btn"
                type="button"
                disabled={busy || !lostReason}
                onClick={async () => {
                  const card = lost;
                  setLost(null);
                  await post(card, {
                    move: 'lost',
                    lostReasonId: lostReason,
                    notes: reasonRef.current?.value ?? null,
                    via: 'drag',
                  });
                }}
              >
                Mark lost
              </button>
            </div>
          </div>
        </div>
      )}

      {back && (
        <div className="dialog-backdrop">
          <div className="dialog" role="dialog" aria-modal>
            <h2>Move backwards?</h2>
            <p>
              {`Move ${back.card.personName} back to ${DEAL_STAGE_LABELS[back.to]}. A reason is required and this is written to the activity log.`}
            </p>
            <textarea ref={reasonRef} rows={3} placeholder="Reason for moving back…" />
            <div className="dialog-actions">
              <button className="btn secondary" type="button" onClick={() => setBack(null)}>
                Cancel
              </button>
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={async () => {
                  const move = back;
                  setBack(null);
                  await post(move.card, {
                    move: 'to',
                    target: move.to,
                    notes: reasonRef.current?.value ?? '',
                    via: 'drag',
                  });
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
          {toast.link && <Link href={toast.link.href}>{toast.link.label}</Link>}
        </div>
      )}
    </>
  );
}
