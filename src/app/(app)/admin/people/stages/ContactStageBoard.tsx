'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { SignContractDialog } from '@/app/(app)/_components/SignContractDialog';
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
 *
 * The one exception is Contract signed. Dropping a card there opens the signing
 * form instead of moving it, because that column means a system was sold, and
 * the system is recorded — and the project created — on the way in. Cancel the
 * form and the card stays where it was.
 *
 * And once there is a project, the card stays in Contract signed. It cannot be
 * picked up at all until the project is deleted: a contact with a live
 * installation back in Quoted would have the board and the job disagreeing
 * about whether they are a customer.
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
  /** The contact whose signing form is open, if any. */
  const [signing, setSigning] = useState<ContactStageCard | null>(null);

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
        // The server says this move is a signing. The drop handler already
        // routes Contract signed to the form, so this only happens if something
        // else sent it — and the form is still the right answer.
        if (res.status === 409 && json?.needsSigning) setSigning(card);
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
    if (card.projectId) {
      setToast({
        kind: 'error',
        text: `${card.personName} has a project (${card.projectCode}) — delete the project before moving them.`,
      });
      return;
    }
    if (stage === 'contract_signed') {
      setSigning(card);
      return;
    }
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
                    className={`card${card.stage === 'lost' ? ' cancelled' : ''}${card.projectId ? ' held' : ''}`}
                    draggable={!busy && !card.projectId}
                    title={
                      card.projectId
                        ? `Held by project ${card.projectCode} — delete the project to move them`
                        : undefined
                    }
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
                    {card.awaitingSignature && !card.projectId && (
                      <span className="chip esign-chip">Awaiting e-signature</span>
                    )}
                    {card.projectId ? (
                      <Link className="card-link" href={`/projects/${card.projectId}`} draggable={false}>
                        {`Project ${card.projectCode}`}
                      </Link>
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

      {signing && (
        <SignContractDialog
          clientId={signing.clientId}
          personName={signing.personName}
          onCancel={() => setSigning(null)}
          onSent={(envelope) => {
            const card = signing;
            setSigning(null);
            setToast({
              kind: 'ok',
              text: `Contract sent to ${envelope.signerEmail} — ${card.personName} moves to ${STAGE_COLUMN_LABELS.contract_signed} when they sign`,
            });
            router.refresh();
          }}
          onSigned={(result) => {
            const card = signing;
            setSigning(null);
            setMoved((m) => ({ ...m, [card.clientId]: 'contract_signed' }));
            setToast({
              kind: 'ok',
              text: result.projectCode
                ? `${card.personName} → ${STAGE_COLUMN_LABELS.contract_signed} · project ${result.projectCode} created`
                : `${card.personName} → ${STAGE_COLUMN_LABELS.contract_signed} · system recorded`,
            });
            router.refresh();
          }}
        />
      )}

      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          <strong>{toast.text}</strong>
        </div>
      )}
    </>
  );
}
