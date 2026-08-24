import type { CustomerStage, CustomerTrack } from '@/lib/portal/customer';
import { prettyDate, prettyPhone, timeInStage, typicalLabel, type TypicalRange } from '@/lib/portal/home';
import { StageIcon } from './StageIcon';

/**
 * The one expanded stage (§2, §3).
 *
 * Everything the customer needs about *now* is in this card: what is happening,
 * which pieces of it are done, and how long the stage has been running. The six
 * other stages are the strip above it. That is the whole redesign in one
 * sentence — one card open instead of seven closed.
 *
 * The milestone rows are the part worth being careful about. On the current
 * screen a milestone is a row of unstyled table text, so 'Being scheduled' and
 * 'Not yet due' look identical to the one live thing on the page. Here the state
 * is a shape and a colour before it is a word: a check for done, a filled dot
 * for the thing being worked on now, a hollow dot for what has not started.
 */
export function CurrentStageCard({
  stage,
  explainer,
  daysInStage,
  typical,
  attentionDays,
}: {
  stage: CustomerStage;
  explainer: string;
  daysInStage: number | null;
  typical: TypicalRange | null;
  attentionDays: number | null;
}) {
  const time = timeInStage(daysInStage, attentionDays);
  const typicalText = typicalLabel(typical);

  return (
    <section className="stage-card rise" style={{ '--delay': '120ms' } as React.CSSProperties}>
      <header className="stage-card-head">
        <StageIcon stage={stage.key} />
        <div>
          <h2>{stage.label}</h2>
          {typicalText && <p className="stage-typical">{typicalText}</p>}
        </div>
      </header>

      {/* Two sentences, not four. §3: what is happening and why it matters —
          nothing about internal process. */}
      {explainer && <p className="stage-explainer">{twoSentences(explainer)}</p>}

      {stage.tracks.length > 0 && (
        <ul className="milestones">
          {stage.tracks.map((track, i) => (
            <li
              key={track.label}
              className={`milestone ${track.state}`}
              style={{ '--delay': `${240 + i * 100}ms` } as React.CSSProperties}
            >
              <span className="milestone-dot" aria-hidden>
                {track.state === 'done' ? '✓' : ''}
              </span>
              <span className="milestone-label">{track.label}</span>
              <span className={`pill ${track.state}`}>{track.status}</span>
            </li>
          ))}
        </ul>
      )}

      {time && (
        <div className="time-in-stage">
          <div className="time-bar" aria-hidden>
            {/* The width is the static value; the grow animation in globals.css
                animates to it, so the bar is right with motion switched off. */}
            <span
              className={`time-fill${time.over ? ' over' : ''}`}
              style={{ width: `${time.percent}%`, '--fill': `${time.percent}%` } as React.CSSProperties}
            />
          </div>
          <p className="time-label">
            {time.over
              ? `Day ${time.day} — longer than usual for this stage. Your project manager is chasing it.`
              : `Day ${time.day} of about ${time.of}`}
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * The first two sentences of the stage explainer.
 *
 * The explainers are configurable per company and currently run to four
 * sentences, which is a paragraph nobody reads on a phone. Trimming here rather
 * than shortening the stored text keeps the full version for the stage detail
 * page, where somebody has chosen to read more.
 */
function twoSentences(text: string): string {
  const parts = text.match(/[^.!?]+[.!?]+/g);
  if (!parts || parts.length <= 2) return text;
  return parts.slice(0, 2).join(' ').trim();
}

/**
 * The held state (§5). It replaces the current-stage card completely rather than
 * sitting above it: a paused project has no current stage in any meaningful
 * sense, and showing 'Permits · Day 12 of 30' beside 'paused' invites the
 * question of which of the two is true.
 */
export function HoldCard({
  reason,
  expectedResume,
  pmName,
  pmPhone,
}: {
  reason: string;
  expectedResume: string | null;
  pmName: string | null;
  pmPhone: string | null;
}) {
  return (
    <section className="stage-card hold rise" style={{ '--delay': '120ms' } as React.CSSProperties}>
      <header className="stage-card-head">
        <StageIcon stage="survey" paused />
        <div>
          <h2>Your project is paused</h2>
          <p className="stage-typical">{reason}</p>
        </div>
      </header>
      <p className="stage-explainer">
        {expectedResume
          ? `We expect to restart around ${prettyDate(expectedResume)}. Nothing is needed from you unless your project manager has asked.`
          : 'Your project manager will contact you with an update. Nothing is needed from you in the meantime.'}
      </p>
      {pmName && (
        <p className="stage-explainer">
          {pmPhone
            ? `Any questions, call ${pmName} on ${prettyPhone(pmPhone)}.`
            : `Any questions, message ${pmName} — the Messages tab keeps it with your project.`}
        </p>
      )}
    </section>
  );
}

/**
 * The finished state (§5). Also a replacement, not an addition: once the system
 * is producing, 'what happens next' is not the question any more.
 */
export function CompleteCard({
  liveOn,
  totalDays,
  documentCount,
}: {
  liveOn: string | null;
  totalDays: number | null;
  documentCount: number;
}) {
  return (
    <section className="stage-card done rise" style={{ '--delay': '120ms' } as React.CSSProperties}>
      <header className="stage-card-head">
        <StageIcon stage="complete" />
        <div>
          <h2>Your system is live</h2>
          {liveOn && <p className="stage-typical">{`Switched on ${prettyDate(liveOn)}`}</p>}
        </div>
      </header>
      <p className="stage-explainer">
        {totalDays
          ? `Start to finish in ${totalDays} days. Everything about the project stays here — you can come back to it any time.`
          : 'Everything about the project stays here — you can come back to it any time.'}
      </p>
      <ul className="milestones">
        <li className="milestone done">
          <span className="milestone-dot" aria-hidden>
            ✓
          </span>
          <span className="milestone-label">Installation</span>
          <span className="pill done">Complete</span>
        </li>
        <li className="milestone done">
          <span className="milestone-dot" aria-hidden>
            ✓
          </span>
          <span className="milestone-label">Permission to operate</span>
          <span className="pill done">Granted</span>
        </li>
        <li className="milestone done">
          <span className="milestone-dot" aria-hidden>
            ✓
          </span>
          <span className="milestone-label">Your documents</span>
          <span className="pill done">{`${documentCount} on file`}</span>
        </li>
      </ul>
    </section>
  );
}

export type { CustomerTrack };
