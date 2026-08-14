import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { loadCustomerProject, loadCustomerProjects } from '@/lib/portal/customer';
import { CustomerActions } from './CustomerActions';
import { StageTracker } from './StageTracker';

export const dynamic = 'force-dynamic';

/**
 * The homeowner's page. It answers the three questions every customer calls to
 * ask — where is my project, what happens next, and when — from the same data
 * the PM enters on the stage forms. Read-only apart from four clearly-marked
 * actions, mobile-first, and deliberately plain-spoken: an honest empty state
 * ('being scheduled') beats a guessed date.
 */
export default async function CustomerPortalPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const session = await guardPath('/portal');
  const sp = await searchParams;

  const data = await withUser(session, async (c) => {
    const projects = await loadCustomerProjects(c, session);
    const chosen = sp.project && projects.some((p) => p.id === sp.project)
      ? sp.project
      : (projects[0]?.id ?? null);
    const project = chosen ? await loadCustomerProject(c, chosen) : null;
    return { projects, project };
  });

  if (!data.project) {
    return (
      <main className="surface portal">
        <h1>Your project</h1>
        <p className="dim">
          Your project isn&apos;t linked to this account yet. Please contact your project manager
          and they will connect it.
        </p>
      </main>
    );
  }

  const p = data.project;
  const money = (n: number | null) =>
    n === null ? '—' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

  return (
    <main className="surface portal">
      {data.projects.length > 1 && (
        <form className="filters" method="get">
          <label className="field">
            <span>Property</span>
            <select name="project" defaultValue={p.id}>
              {data.projects.map((op) => (
                <option key={op.id} value={op.id}>
                  {op.label}
                </option>
              ))}
            </select>
          </label>
          <button className="btn secondary" type="submit">
            Switch
          </button>
        </form>
      )}

      <header className="portal-head">
        <h1>Hello {p.customerName.split(' ')[0]}</h1>
        <p className="dim">
          {p.address ?? ''} · {p.systemSummary}
        </p>
      </header>

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

      <section className="portal-status">
        <h2>{p.statusHeadline}</h2>
        {p.estimate && (
          <p>
            <strong>Estimated completion:</strong> {p.estimate}
          </p>
        )}
        {!p.isComplete && p.whatHappensNext && (
          <p>
            <strong>What happens next:</strong> {p.whatHappensNext}
          </p>
        )}
      </section>

      <StageTracker stages={p.stages} />

      <div className="portal-grid">
        <section className="panel">
          <h2>Anything needed from you</h2>
          {p.needed.length === 0 ? (
            <p className="dim">Nothing needed right now — we&apos;ll be in touch if that changes.</p>
          ) : (
            <ul className="gap-list">
              {p.needed.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>Your project team</h2>
          <dl className="facts">
            <dt>Project manager</dt>
            <dd>
              {p.team.pmName ?? 'Being assigned'}
              {p.team.pmPhone && (
                <>
                  {' · '}
                  <a href={`tel:${p.team.pmPhone.replace(/[^\d+]/g, '')}`}>{p.team.pmPhone}</a>
                </>
              )}
              {p.team.pmEmail && (
                <>
                  {' · '}
                  <a href={`mailto:${p.team.pmEmail}`}>{p.team.pmEmail}</a>
                </>
              )}
            </dd>
            {p.team.repName && (
              <>
                <dt>Your sales rep</dt>
                <dd>
                  {p.team.repName}
                  {p.team.repEmail && (
                    <>
                      {' · '}
                      <a href={`mailto:${p.team.repEmail}`}>{p.team.repEmail}</a>
                    </>
                  )}
                </dd>
              </>
            )}
          </dl>
        </section>

        <section className="panel">
          <h2>Recent updates</h2>
          <ul className="activity">
            {p.updates.map((u, i) => (
              <li key={i}>
                <span className="dim">{u.date}</span> {u.text}
              </li>
            ))}
            {p.updates.length === 0 && <li className="dim">Your project has just started.</li>}
          </ul>
        </section>

        <section className="panel">
          <h2>Your project total</h2>
          <dl className="facts">
            <dt>Contract total</dt>
            <dd>{money(p.contractTotal)}</dd>
            {p.adders.map((a) => (
              <span key={a.name} style={{ display: 'contents' }}>
                <dt>{a.name}</dt>
                <dd>{money(a.amount)}</dd>
              </span>
            ))}
            {p.adders.length > 0 && (
              <>
                <dt>Current total</dt>
                <dd>
                  <strong>{money(p.revisedTotal)}</strong>
                </dd>
              </>
            )}
          </dl>

          <h2>Payments</h2>
          <table className="projects-table">
            <thead>
              <tr>
                <th>Payment</th>
                <th>Status</th>
                <th>Received</th>
              </tr>
            </thead>
            <tbody>
              {p.payments.map((m) => (
                <tr key={m.label}>
                  <td>{m.label}</td>
                  <td>{m.status}</td>
                  <td>{m.receivedOn ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {p.finance.company && (
            <>
              <h2>Your finance company</h2>
              <p>{p.finance.company}</p>
              <table className="projects-table">
                <tbody>
                  {p.finance.milestones.map((m) => (
                    <tr key={m.label}>
                      <td>{m.label}</td>
                      <td>{m.status}</td>
                      <td>{m.receivedOn ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>

        <section className="panel">
          <h2>Your documents</h2>
          {p.documents.filter((d) => !d.isPhoto).length === 0 ? (
            <p className="dim">Documents will appear here as your project progresses.</p>
          ) : (
            <ul className="activity">
              {p.documents.filter((d) => !d.isPhoto).map((d) => (
                <li key={d.id}>
                  <a href={`/api/files/${d.id}`}>{d.title}</a>
                  <span className="dim"> · {d.date}</span>
                </li>
              ))}
            </ul>
          )}

          {p.documents.some((d) => d.isPhoto) && (
            <>
              <h2>Photos of your system</h2>
              <div className="photo-grid">
                {p.documents.filter((d) => d.isPhoto).map((d) => (
                  <a key={d.id} href={`/api/files/${d.id}`} title={d.title}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/files/${d.id}`} alt={d.title} loading="lazy" />
                  </a>
                ))}
              </div>
            </>
          )}
        </section>
      </div>

      <CustomerActions
        projectId={p.id}
        requests={p.openRequests}
        pmName={p.team.pmName}
      />
    </main>
  );
}
