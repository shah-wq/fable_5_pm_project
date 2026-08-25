import Link from 'next/link';
import {
  completionPercent,
  nextStage,
  shortRange,
  stagePosition,
  prettyDate,
  startedAgo,
  systemLine,
} from '@/lib/portal/home';
import { loadPortalPage, NO_PROJECT_MESSAGE } from '@/lib/portal/page';
import { loadPendingRequest, loadReasonChips } from '@/lib/feedback/service';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { STAGE_LABELS } from '@/lib/stages/definitions';
import { ActionTiles } from './_components/ActionTiles';
import { FeedbackSheet } from './_components/FeedbackSheet';
import { AppRuntime } from './_components/AppRuntime';
import { CallMyPm } from './_components/CallMyPm';
import { CompleteCard, CurrentStageCard, HoldCard } from './_components/CurrentStageCard';
import { NotificationOptIn } from './_components/NotificationOptIn';
import { ProgressRing } from './_components/ProgressRing';
import { PropertyPicker } from './_components/PropertyPicker';
import { StageStrip } from './_components/StageStrip';

export const dynamic = 'force-dynamic';

/**
 * The homeowner's home screen (Customer portal redesign).
 *
 * One idea runs through it: show the stage they are in, not the seven they could
 * be in. The old screen was seven collapsed rows, six of them describing things
 * that had not happened yet — they filled the phone, pushed everything useful
 * below the fold, and communicated no sense of progress at all. A numbered list
 * is not a progress indicator; a customer cannot see how far along they are
 * without counting.
 *
 * So the order answers a homeowner's three questions, in the order they ask
 * them, and all three fit above the fold on a 360px phone:
 *
 *   where am I         the ring, the stage name, the strip
 *   what happens next  the current-stage card, then one 'up next' row
 *   anything from me   the needs-attention block, when there is anything in it
 *
 * Everything else is one tap away rather than scrolled past. This is the same
 * data the previous screen loaded — the redesign is presentation only.
 */
export default async function PortalHome({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { projects, project: p } = await loadPortalPage(searchParams);

  if (!p) {
    return (
      <div className="app-page">
        <h1>Your project</h1>
        <p className="notice hold">{NO_PROJECT_MESSAGE}</p>
        <p className="dim">
          If you were expecting to see something here, your project manager can link your account
          in a moment.
        </p>
      </div>
    );
  }

  const paused = Boolean(p.onHold) || Boolean(p.cancelled);
  const percent = completionPercent(p.stageKey, p.isComplete);
  const position = stagePosition(p.stageKey);
  const current = p.stages.find((s) => s.state === 'current') ?? p.stages[0];
  const upcoming = p.isComplete ? null : nextStage(p.stageKey);
  const pace = (key: string) => p.pace[key] ?? { typical: null, attention: null };
  // Stage feedback §2: the sheet slides up over Home on the customer's next
  // visit. Loaded here rather than inside the component so the page arrives with
  // the answer already known — a rating sheet that appears a second late is a
  // rating sheet that gets tapped past.
  const session = await getSession();
  const rating =
    session && p
      ? await withUser(session, async (client) => {
          const pending = await loadPendingRequest(client, p.id);
          if (!pending) return null;
          return { pending, chips: await loadReasonChips(client, pending.stage) };
        }).catch(() => null)
      : null;

  const line = systemLine({
    address: p.address,
    sizeKw: p.system.sizeKw,
    modules: p.system.modules,
    batteries: p.system.batteries,
  });

  return (
    <div className="app-page home">
      <AppRuntime
        snapshot={{
          headline: p.statusHeadline,
          stageLabel: p.stageLabel,
          address: p.address,
          estimate: p.estimate,
        }}
      />

      {projects.length > 1 && <PropertyPicker projects={projects} current={p.id} />}

      {/* Above the fold and above everything else, but never in the way: the
          scrim dismisses it and Home is fully usable behind it (§4). */}
      {rating && (
        <FeedbackSheet
          projectId={p.id}
          stage={rating.pending.stage}
          stageLabel={rating.pending.stageLabel}
          chips={rating.chips}
          pmName={p.team.pmName}
          askNps={rating.pending.askNps}
          startCollapsed={rating.pending.dismissed}
        />
      )}

      {/* --- Where am I ---------------------------------------------------- */}
      <section className="hero rise" style={{ '--delay': '0ms' } as React.CSSProperties}>
        <ProgressRing
          percent={percent}
          index={position.index}
          total={position.total}
          paused={paused}
        />
        <div className="hero-text">
          {/* The live indicator: the only continuous motion on the screen, which
              is what makes it read as 'live' rather than as noise. On a paused
              project it stops — motion stopping is itself the signal (§5). */}
          <p className={`live${paused ? ' stopped' : ''}`}>
            <span className="live-dot" aria-hidden />
            {p.cancelled ? 'Project cancelled' : p.onHold ? 'Paused' : p.isComplete ? 'Complete' : 'Happening now'}
          </p>
          <h1>{p.isComplete ? 'Your system is live' : (current?.label ?? p.stageLabel)}</h1>
          <p className="hero-meta">
            {`${position.index} of ${position.total}${line ? ` · ${line}` : ''}`}
          </p>
          {/* The estimate is not in the redesign's wireframe, and it stays
              anyway when a PM has set one: that is a deliberate promise made to
              this customer by a person, and dropping it silently would lose
              information the business chose to give. One line, not a card. */}
          {!p.isComplete && !paused && p.estimate && (
            <p className="hero-estimate">{`Estimated completion ${p.estimate}`}</p>
          )}
        </div>
      </section>

      <StageStrip stages={p.stages} />

      {/* --- Anything needed from me -------------------------------------- */}
      {/* Only when there is something. An empty card here would teach the
          customer that this part of the screen is not worth reading. */}
      {p.needed.length > 0 && (
        <section className="needs rise" style={{ '--delay': '60ms' } as React.CSSProperties}>
          <h2>Needs you</h2>
          <ul>
            {p.needed.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          {p.asks.length > 0 && (
            <Link className="btn" href="/portal/photos">
              Send a photo
            </Link>
          )}
        </section>
      )}

      {/* --- What is happening -------------------------------------------- */}
      {p.cancelled ? (
        <section className="stage-card hold rise" style={{ '--delay': '120ms' } as React.CSSProperties}>
          <h2>This project was cancelled</h2>
          <p className="stage-explainer">
            {p.cancelled.date
              ? `Cancelled on ${prettyDate(p.cancelled.date)}. Please contact your project manager with any questions.`
              : 'Please contact your project manager with any questions.'}
          </p>
        </section>
      ) : p.onHold ? (
        <HoldCard
          reason={p.onHold.reason}
          expectedResume={p.onHold.expectedResume}
          pmName={p.team.pmName}
          pmPhone={p.team.pmPhone}
        />
      ) : p.isComplete ? (
        <CompleteCard
          liveOn={p.stages.find((s) => s.key === 'complete')?.reachedOn ?? null}
          totalDays={p.daysSinceStart}
          documentCount={p.documentCount}
        />
      ) : (
        current && (
          <CurrentStageCard
            stage={current}
            explainer={current.explainer || p.whatHappensNext}
            daysInStage={p.daysInStage}
            typical={pace(current.key).typical}
            attentionDays={pace(current.key).attention}
          />
        )
      )}

      {/* --- What happens next: one row, not six -------------------------- */}
      {upcoming && !paused && (
        <Link
          className="up-next rise"
          href={`/portal/project#${upcoming}`}
          style={{ '--delay': '360ms' } as React.CSSProperties}
        >
          <span className="up-next-label">
            {`Up next: ${STAGE_LABELS[upcoming]}${
              shortRange(pace(upcoming).typical) ? ` · ${shortRange(pace(upcoming).typical)}` : ''
            }`}
          </span>
          <span className="up-next-caret" aria-hidden>
            ›
          </span>
        </Link>
      )}

      <ActionTiles
        pmName={p.team.pmName}
        replyPromise={p.replyPromise}
        documentCount={p.documentCount}
      />

      <div className="home-foot rise" style={{ '--delay': '480ms' } as React.CSSProperties}>
        <Link href="/portal/project">Full timeline</Link>
        {/* The old screen gave 'Your project has just started' a whole card,
            which teaches a reader that this section is not worth checking. One
            quiet line, at the bottom, where a date belongs (§6). */}
        {startedAgo(p.daysSinceStart) && <span className="dim">{startedAgo(p.daysSinceStart)}</span>}
      </div>

      <NotificationOptIn />

      <CallMyPm name={p.team.pmName} phone={p.team.pmPhone} email={p.team.pmEmail} />
    </div>
  );
}
