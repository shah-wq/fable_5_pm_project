import Link from 'next/link';
import { loadPortalPage, NO_PROJECT_MESSAGE } from '@/lib/portal/page';
import { AppRuntime } from './_components/AppRuntime';
import { CallMyPm } from './_components/CallMyPm';
import { NotificationOptIn } from './_components/NotificationOptIn';
import { PropertyPicker } from './_components/PropertyPicker';
import { StageTracker } from './StageTracker';

export const dynamic = 'force-dynamic';

/**
 * Home (spec §3.1). Everything above the fold answers 'where are we?' — one
 * sentence, the stage, the estimate — and the most-used control on the screen,
 * calling the project manager, stays reachable without scrolling.
 *
 * The order is deliberate: status, then anything blocking, then the tracker,
 * then history. A customer opens this roughly once a week for four months, so
 * it has to be readable in ten seconds and never require a tap to learn the
 * one fact they came for.
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

  return (
    <div className="app-page">
      <AppRuntime
        snapshot={{
          headline: p.statusHeadline,
          stageLabel: p.stageLabel,
          address: p.address,
          estimate: p.estimate,
        }}
      />

      {projects.length > 1 && <PropertyPicker projects={projects} current={p.id} />}

      {/* --- Status card: the whole reason the app exists ------------------- */}
      <section className="status-card">
        <p className="eyebrow">{p.stageLabel}</p>
        <h1>{p.statusHeadline}</h1>
        {p.estimate && (
          <p className="status-estimate">
            Estimated completion <strong>{p.estimate}</strong>
          </p>
        )}
        {!p.isComplete && p.whatHappensNext && <p className="status-next">{p.whatHappensNext}</p>}
        <p className="dim">
          {p.address} · {p.systemSummary}
        </p>
      </section>

      {p.cancelled && (
        <p className="notice error">
          This project was cancelled{p.cancelled.date ? ` on ${p.cancelled.date}` : ''}. Please
          contact your project manager with any questions.
        </p>
      )}

      {p.onHold && (
        <p className="notice hold">
          <strong>Your project is temporarily paused.</strong> Reason: {p.onHold.reason}.
          {p.onHold.expectedResume
            ? ` We expect to restart around ${p.onHold.expectedResume}.`
            : ' Your project manager will contact you with an update.'}
        </p>
      )}

      {/* Hidden entirely when empty, rather than an empty card (spec §3.1). */}
      {p.needed.length > 0 && (
        <section className="panel attention">
          <h2>Needs your attention</h2>
          <ul className="gap-list">
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

      <StageTracker stages={p.stages} />

      <section className="panel">
        <h2>Recent updates</h2>
        <ul className="activity">
          {p.updates.slice(0, 5).map((u, i) => (
            <li key={i}>
              <span className="dim">{u.date}</span> {u.text}
            </li>
          ))}
          {p.updates.length === 0 && <li className="dim">Your project has just started.</li>}
        </ul>
        <Link className="dim" href="/portal/project">
          See every stage in detail →
        </Link>
      </section>

      {/* Project Chat §1: a contextual way into the thread. Written before
          'Call my project manager' on purpose — a message is answered in the
          PM's own time, and a phone call is the thing this feature exists to
          reduce. */}
      <section className="panel">
        <h2>Ask a question</h2>
        <p className="dim">
          {p.team.pmName
            ? `Send ${p.team.pmName} a message about your project and it stays with the job, so anyone covering can pick it up.`
            : 'Send your project manager a message about your project.'}
        </p>
        <Link className="btn" href="/portal/messages">
          Open messages
        </Link>
      </section>

      <NotificationOptIn />

      <CallMyPm
        name={p.team.pmName}
        phone={p.team.pmPhone}
        email={p.team.pmEmail}
      />
    </div>
  );
}
