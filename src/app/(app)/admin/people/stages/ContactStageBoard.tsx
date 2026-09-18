'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  STAGE_COLUMNS,
  STAGE_COLUMN_LABELS,
  STAGE_COLUMN_MEANS,
  type ContactStage,
  type ContactStageCard,
} from '@/lib/contacts/stage-columns';

/**
 * Contact stages.
 *
 * Drag a contact into any column. There is deliberately no ordering enforced:
 * these stages are about the diary rather than the money, and half the real
 * movement in them is sideways or backwards — a no-show goes back to
 * rescheduled, somebody quoted in March rings in September and is scheduled
 * again. A board that refused those moves would be a board people worked around.
 *
 * The move is written to the activity log, so "who moved this, and when" — the
 * question every board eventually raises — has an answer.
 */
export function ContactStageBoard({ cards }: { cards: ContactStageCard[] }) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [mine, setMine] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<ContactStageCard | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  /** Where a card has just been dropped, so the board moves before the server replies. */
  const [moved, setMoved] = useState<Record<string, ContactStage>>({});

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cards
      .map((c) => (moved[c.clientId] ? { ...c, stage: moved[c.clientId] } : c))
      .filter((c) => {
        if (mine && !c.ownerName) return false;
        if (!q) return true;
        return [c.personName, c.email, c.phone, c.subtitle, c.ownerName, c.dealerName].some((v) =>
          v?.toLowerCase().includes(q)
        );
      });
  }, [cards, search, mine, moved]);

  async function move(card: ContactStageCard, stage: ContactStage) {
    // Optimistic: the card lands where it was dropped, and goes back if the
    // server disagrees. Dragging something that snaps back a second later with
    // no explanation is how a board loses somebody's trust.
    setMoved((m) => ({ ...m, [card.clientId]: stage }));
    setBusy(true);
    try {
      const res = await fetch(`/api/contacts/${card.clientId}/stage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setMoved((m) => {
          const next = { ...m };
          delete next[card.clientId];
          return next;
        });
        setToast({ kind: 'error', text: json?.error ?? `That move was refused (${res.status}).` });
        return;
      }
      setToast({
        kind: 'ok',
        text: `${card.personName} → ${STAGE_COLUMN_LABELS[stage]}`,
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function onDrop(stage: ContactStage) {
    const card = dragging;
    setDragging(null);
    setOver(null);
    if (!card || busy || card.stage === stage) return;
    void move(card, stage);
  }

  return (
    <>
      <div className="filters">
        <input
          type="search"
          placeholder="Search name, email, phone or town…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="check-inline">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          Only assigned
        </label>
        <span className="spacer" />
        <span className="dim">{`${visible.length} of ${cards.length}`}</span>
      </div>

      <div className="board contact-board" role="list">
        {STAGE_COLUMNS.map((col) => {
          const columnCards = visible.filter((c) => c.stage === col);
          return (
            <section
              key={col}
              className={`board-col${col === 'lost' ? ' side lost' : ''}${
                col === 'contract_signed' ? ' terminal' : ''
              }${over === col ? ' over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                if (over !== col) setOver(col);
              }}
              onDragLeave={() => setOver((o) => (o === col ? null : o))}
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
                    key={card.clientId}
                    className={`card${card.stage === 'lost' ? ' cancelled' : ''}`}
                    draggable={!busy}
                    onDragStart={() => setDragging(card)}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                  >
                    <Link
                      href={`/admin/people/${card.clientId}`}
                      className="card-title"
                      draggable={false}
                    >
                      {card.personName}
                    </Link>
                    {card.subtitle && <div className="card-sub">{card.subtitle}</div>}
                    {(card.phone || card.email) && (
                      <div className="card-sub dim">
                        {[card.phone, card.email].filter(Boolean).join(' · ')}
                      </div>
                    )}
                    <div className="card-meta">
                      <span>{card.daysInStage}d here</span>
                      {card.lastContact && <span>spoke {card.lastContact}</span>}
                    </div>
                    <div className="card-sub dim">{card.ownerName ?? 'unassigned'}</div>
                    {card.dealId && (
                      <Link className="card-link" href={`/deals/${card.dealId}`} draggable={false}>
                        Open deal
                      </Link>
                    )}
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          <strong>{toast.text}</strong>
        </div>
      )}
    </>
  );
}
