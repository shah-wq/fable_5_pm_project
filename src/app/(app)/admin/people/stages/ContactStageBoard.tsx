'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { dealStageIndex, type DealColumn } from '@/lib/deals/definitions';
import {
  NO_DEAL,
  STAGE_COLUMNS,
  STAGE_COLUMN_LABELS,
  STAGE_COLUMN_MEANS,
  type ContactStageCard,
} from '@/lib/contacts/stage-columns';

interface ToastState {
  kind: 'error' | 'ok';
  title: string;
  items?: string[];
}

/**
 * Contact stages.
 *
 * The same gesture, the same rules and the same class names as the Deals board:
 * dragging a contact forward moves the deal behind them, so the gates that
 * board enforces are enforced here too and the two can never tell a rep
 * different things about the same person.
 *
 * The first column is the one the Deals board cannot show: people on file whom
 * nobody has opened a deal for. They are not dragged out of it — a deal is
 * started, deliberately, with a button — because dropping somebody into
 * Negotiation would have to invent an opportunity that no conversation has
 * happened on.
 */
export function ContactStageBoard({
  cards,
  isAdmin,
  lossReasons,
}: {
  cards: ContactStageCard[];
  isAdmin: boolean;
  lossReasons: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<ContactStageCard | null>(null);
  const [rejectedColumn, setRejectedColumn] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [lost, setLost] = useState<ContactStageCard | null>(null);
  const [lostReason, setLostReason] = useState('');
  const [back, setBack] = useState<{ card: ContactStageCard; to: DealColumn } | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return cards;
    return cards.filter((c) =>
      [c.personName, c.email, c.phone, c.subtitle, c.ownerName, c.dealerName]
        .some((v) => v?.toLowerCase().includes(q))
    );
  }, [cards, search]);

  async function move(card: ContactStageCard, body: Record<string, unknown>): Promise<boolean> {
    if (!card.dealId) return false;
    setBusy(true);
    try {
      const res = await fetch(`/api/deals/${card.dealId}/move`, {
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
      setToast({ kind: 'ok', title: `${card.personName} moved.` });
      router.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  }

  /** Open the first deal for somebody who is only on file. */
  async function startDeal(card: ContactStageCard) {
    setBusy(true);
    try {
      const res = await fetch('/api/deals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: card.clientId }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setToast({ kind: 'error', title: json?.error ?? `Could not start a deal (${res.status}).` });
        return;
      }
      setToast({ kind: 'ok', title: `${card.personName} is on the board at New.` });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function refuse(column: string, title: string) {
    setRejectedColumn(column);
    setTimeout(() => setRejectedColumn(null), 1200);
    setToast({ kind: 'error', title });
  }

  async function onDrop(column: string) {
    const card = dragging;
    setDragging(null);
    if (!card || busy || card.column === column) return;

    if (column === NO_DEAL) {
      refuse(column, 'A deal that has started cannot be un-started. Mark it lost instead.');
      return;
    }
    if (!card.dealId) {
      refuse(column, `${card.personName} has no deal yet — use Start a deal first.`);
      return;
    }
    if (card.column === 'won') {
      refuse(column, 'A won deal is a project now. Cancel the project instead.');
      return;
    }
    if (column === 'lost') {
      setLostReason('');
      setLost(card);
      return;
    }

    const target = column as DealColumn;
    const backwards =
      card.column !== NO_DEAL && dealStageIndex(target) < dealStageIndex(card.column as DealColumn);
    if (backwards) {
      if (!isAdmin) {
        refuse(column, 'This board is forward-only. An admin can move somebody back with a reason.');
        return;
      }
      setBack({ card, to: target });
      return;
    }
    const ok = await move(card, { move: 'to', target, via: 'drag' });
    if (!ok) {
      setRejectedColumn(column);
      setTimeout(() => setRejectedColumn(null), 1200);
    }
  }

  return (
    <>
      <div className="filters">
        <input
          type="search"
          placeholder="Search name, email, phone or address…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="board" role="list">
        {STAGE_COLUMNS.map((col) => {
          const columnCards = visible.filter((c) => c.column === col);
          const side = col === 'won' || col === 'lost' || col === NO_DEAL;
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
                <span>{STAGE_COLUMN_LABELS[col]}</span>
                <span className="col-count">{columnCards.length}</span>
              </header>
              <p className="col-sub dim">{STAGE_COLUMN_MEANS[col]}</p>
              <div className="col-cards">
                {columnCards.map((card) => (
                  <article
                    key={card.dealId ?? card.clientId ?? card.personName}
                    className={`card${card.column === 'lost' ? ' cancelled' : ''}`}
                    draggable={!busy && card.column !== NO_DEAL && card.column !== 'won'}
                    onDragStart={() => setDragging(card)}
                    onDragEnd={() => setDragging(null)}
                  >
                    {card.clientId ? (
                      <Link
                        href={`/admin/people?person=${card.clientId}`}
                        className="card-title"
                        draggable={false}
                      >
                        {card.personName}
                      </Link>
                    ) : (
                      <span className="card-title">{card.personName}</span>
                    )}
                    {card.subtitle && <div className="card-sub">{card.subtitle}</div>}
                    {(card.email || card.phone) && (
                      <div className="card-sub dim">
                        {[card.phone, card.email].filter(Boolean).join(' · ')}
                      </div>
                    )}
                    <div className="card-meta">
                      {card.daysInStage !== null && <span>{card.daysInStage}d in stage</span>}
                      {card.lastContact && <span>last spoke {card.lastContact}</span>}
                      {card.column === 'won' && <span className="done-badge">✓ Won</span>}
                      {card.column === 'lost' && (
                        <span className="dim">{card.lostReason ?? 'lost'}</span>
                      )}
                      {card.missing.length > 0 && (
                        <span className="missing-badge" title={card.missing.join('\n')}>
                          {card.missing.length}
                        </span>
                      )}
                      {card.dealId && !card.nextAction && card.column !== 'won' && card.column !== 'lost' && (
                        <span className="flag-badge" title="No next action on the deal behind this contact">
                          ⚑ no action
                        </span>
                      )}
                      {card.nextActionDue && (
                        <span className="flag-badge" title={card.nextAction ?? 'due'}>
                          ⏰ due
                        </span>
                      )}
                    </div>
                    <div className="card-sub dim">{card.ownerName ?? 'unassigned'}</div>
                    {card.column === NO_DEAL ? (
                      <button
                        className="btn secondary small"
                        type="button"
                        disabled={busy || !card.clientId}
                        onClick={() => void startDeal(card)}
                      >
                        Start a deal
                      </button>
                    ) : (
                      card.dealId && (
                        <Link className="card-link" href={`/deals/${card.dealId}`} draggable={false}>
                          Open deal
                        </Link>
                      )
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
            <h2>Mark this one lost?</h2>
            <p>{`${lost.personName} — a reason is required, and a lost deal can be reopened later.`}</p>
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
                  await move(card, {
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
              {`Move ${back.card.personName} back to ${STAGE_COLUMN_LABELS[back.to]}. A reason is required and this is written to the activity log.`}
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
                  const it = back;
                  setBack(null);
                  await move(it.card, {
                    move: 'to',
                    target: it.to,
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
        </div>
      )}
    </>
  );
}
