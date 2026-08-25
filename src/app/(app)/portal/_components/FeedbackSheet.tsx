'use client';

import { useEffect, useState } from 'react';

/**
 * The rating sheet (Stage feedback §2, §3).
 *
 * One component for the portal and the app, because §9 asks for one and because
 * two would drift: this is the screen the whole module's response rate depends
 * on.
 *
 * The single most important line in here is the one in `pick`: the score is sent
 * the moment a face is tapped, before Send, before the comment, before the
 * second step exists. §4 — "record the score the instant they tap a face. If
 * they abandon the sheet after tapping, you still have the number, which is the
 * part you can actually act on."
 *
 * Step two appears only for 1 and 2 (§3), and is framed as an apology rather
 * than an interrogation: someone who has just told you it went badly is not in
 * the mood for a form.
 */

export interface FeedbackChip {
  key: string;
  label: string;
}

const FACES = [
  // All five deliberately from the emoji-presentation range. The obvious
  // choices for 1 and 5 (☹ and ☺) are *text*-presentation glyphs, so they
  // rendered flat and grey between three colour faces — a row that looked
  // half-broken rather than like a scale.
  { score: 1, face: '😞', label: 'Not good' },
  { score: 2, face: '🙁', label: 'Poor' },
  { score: 3, face: '😐', label: 'Fine' },
  { score: 4, face: '🙂', label: 'Good' },
  { score: 5, face: '😄', label: 'Great' },
];

type Step = 'score' | 'reasons' | 'nps' | 'done';

export function FeedbackSheet({
  projectId,
  stage,
  stageLabel,
  chips,
  pmName,
  askNps,
  startCollapsed,
}: {
  projectId: string;
  stage: string;
  stageLabel: string;
  chips: FeedbackChip[];
  pmName: string | null;
  askNps: boolean;
  /** True when 'Not now' was tapped before: a card, not a sheet (§2). */
  startCollapsed: boolean;
}) {
  const [open, setOpen] = useState(!startCollapsed);
  const [step, setStep] = useState<Step>('score');
  const [score, setScore] = useState<number | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);

  // Escape closes it, like any other dismissible layer. It is never modal in
  // the trapping sense — §4: "the sheet is always dismissible and never gates
  // any other action".
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void notNow();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  async function post(path: string, body: Record<string, unknown>) {
    return fetch(`/api/feedback/${projectId}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage, ...body }),
    });
  }

  async function pick(value: number) {
    setScore(value);
    setBusy(true);
    // Fire and continue: the next step renders immediately rather than waiting
    // for a round trip, because the customer has already given us the answer.
    void post('/score', { score: value }).finally(() => setBusy(false));
    if (value <= 2) {
      setStep('reasons');
    } else if (askNps) {
      setStep('nps');
    } else {
      setStep('done');
    }
  }

  async function sendDetail() {
    setBusy(true);
    try {
      await post('/detail', { tags, comment: comment.trim() || null });
      setStep(askNps ? 'nps' : 'done');
    } finally {
      setBusy(false);
    }
  }

  async function sendNps(value: number) {
    setBusy(true);
    try {
      await post('/nps', { nps: value });
      setStep('done');
    } finally {
      setBusy(false);
    }
  }

  async function notNow() {
    setOpen(false);
    await post('/dismiss', {}).catch(() => undefined);
  }

  if (gone) return null;

  // Dismissed: a compact card at the top of Home, one quiet reminder rather
  // than a repeated interruption (§2).
  if (!open) {
    return (
      <section className="rate-card">
        <p>
          <strong>{`How was your ${stageLabel.toLowerCase()}?`}</strong>
        </p>
        <button className="btn small" type="button" onClick={() => setOpen(true)}>
          Rate it
        </button>
      </section>
    );
  }

  return (
    <>
      {/* Tapping outside dismisses — §2. Not a focus trap: this must never stand
          between a customer and their documents. */}
      <button className="sheet-scrim" type="button" aria-label="Close" onClick={notNow} />
      <section
        className="rate-sheet"
        role="dialog"
        aria-modal="false"
        aria-label={`Rate ${stageLabel}`}
      >
        {step === 'score' && (
          <>
            <p className="rate-eyebrow">{stageLabel} complete</p>
            <h2>{`How was your ${stageLabel.toLowerCase()}?`}</h2>
            <div className="rate-faces">
              {FACES.map((f) => (
                <button
                  key={f.score}
                  type="button"
                  className={`rate-face${score === f.score ? ' on' : ''}`}
                  onClick={() => void pick(f.score)}
                  aria-label={`${f.score} — ${f.label}`}
                >
                  <span aria-hidden>{f.face}</span>
                  <span className="rate-num">{f.score}</span>
                </button>
              ))}
            </div>
            <p className="rate-anchors">
              <span>Not good</span>
              <span>Great</span>
            </p>
            <button className="btn secondary small" type="button" onClick={notNow}>
              Not now
            </button>
          </>
        )}

        {step === 'reasons' && (
          <>
            {/* §3: framed as an apology, not an interrogation. */}
            <h2>Sorry to hear that</h2>
            <p className="dim">What let you down? Tap anything that applies.</p>
            <div className="rate-chips">
              {chips.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className={`toggle-chip${tags.includes(c.key) ? ' on' : ''}`}
                  aria-pressed={tags.includes(c.key)}
                  onClick={() =>
                    setTags((t) => (t.includes(c.key) ? t.filter((x) => x !== c.key) : [...t, c.key]))
                  }
                >
                  {c.label}
                </button>
              ))}
            </div>
            <label className="field">
              <span>Anything else?</span>
              <textarea
                rows={3}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={
                  pmName ? `Anything you'd like ${pmName} to know?` : 'Anything you would like us to know?'
                }
              />
            </label>
            <button className="btn" type="button" disabled={busy} onClick={() => void sendDetail()}>
              {busy ? 'Sending…' : 'Send'}
            </button>
            {/* The score is already saved, so leaving here costs nothing. */}
            <p className="rate-foot">
              {pmName ? `${pmName} will see this today.` : 'Your project manager will see this today.'}
            </p>
          </>
        )}

        {step === 'nps' && (
          <>
            <h2>One last question</h2>
            <p className="dim">
              How likely are you to recommend us to a friend or neighbour?
            </p>
            <div className="rate-nps">
              {Array.from({ length: 11 }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  className="rate-nps-btn"
                  disabled={busy}
                  onClick={() => void sendNps(i)}
                  aria-label={`${i} out of 10`}
                >
                  {i}
                </button>
              ))}
            </div>
            <p className="rate-anchors">
              <span>Not at all</span>
              <span>Definitely</span>
            </p>
            <button className="btn secondary small" type="button" onClick={() => setStep('done')}>
              Skip
            </button>
          </>
        )}

        {step === 'done' && (
          <>
            {/* §9: make the thank-you specific. A generic 'thanks for your
                feedback' is what every dead survey says. */}
            <h2>{score !== null && score <= 2 ? 'Thanks for telling us' : 'Thanks — that helps us'}</h2>
            <p className="dim">
              {score !== null && score <= 2
                ? pmName
                  ? `${pmName} will be in touch.`
                  : 'Your project manager will be in touch.'
                : 'It goes straight to the team working on your project.'}
            </p>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setOpen(false);
                setGone(true);
              }}
            >
              Close
            </button>
          </>
        )}
      </section>
    </>
  );
}
