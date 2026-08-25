import Link from 'next/link';
import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { loadOpenTasks } from '@/lib/feedback/service';
import { STAGE_LABELS } from '@/lib/stages/definitions';
import { ResolveTask } from './ResolveTask';

export const dynamic = 'force-dynamic';

/**
 * The follow-up list (Stage feedback §5, §9).
 *
 * "The rating is only half the feature; the follow-up task is the other half,
 * and without somewhere for it to land you are just collecting numbers." This is
 * that somewhere — and the reason the module is worth building at all, because
 * §6 is blunt about the alternative: "a rating you do not act on is worse than
 * no rating."
 *
 * Oldest first, deliberately. A low rating from this morning is feedback; the
 * same rating left for a week is a complaint that has been ignored in writing.
 */
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ mine?: string; done?: string }>;
}) {
  const session = await guardPath('/tasks');
  const sp = await searchParams;
  const mine = sp.mine === '1';
  const includeResolved = sp.done === '1';

  const tasks = await withUser(session, (client) =>
    loadOpenTasks(client, {
      mine: mine ? session.userId : null,
      includeResolved,
    })
  );

  const open = tasks.filter((t) => t.ageDays >= 0);

  return (
    <main className="table-page">
      <div className="board-header">
        <h1>Follow-ups</h1>
        <div className="board-actions">
          <span className="dim">
            {open.length === 0
              ? 'Nothing waiting'
              : `${open.length} open${open.length === 1 ? '' : ''}`}
          </span>
        </div>
      </div>

      <p className="dim">
        Raised automatically when a customer rates a stage 1 or 2 out of 5, or gives a low
        recommendation score at the end. Each one closes with a note saying what you did — the
        project card stays flagged until it does.
      </p>

      <div className="filter-toggles">
        <Link className={`toggle-chip${mine ? ' on' : ''}`} href={mine ? '/tasks' : '/tasks?mine=1'}>
          My projects
        </Link>
        <Link
          className={`toggle-chip${includeResolved ? ' on' : ''}`}
          href={includeResolved ? '/tasks' : '/tasks?done=1'}
        >
          Include closed
        </Link>
      </div>

      {tasks.length === 0 ? (
        <section className="panel">
          <p className="chart-empty">
            No follow-ups. Either nobody has rated a stage badly, or every one has been dealt with —
            the Feedback band on the dashboard says which.
          </p>
        </section>
      ) : (
        <div className="task-list">
          {tasks.map((t) => (
            <article className={`task-card${t.ageDays >= 3 ? ' overdue' : ''}`} key={t.id}>
              <header>
                <span className="task-score" aria-hidden>
                  {t.score ?? '—'}
                </span>
                <div>
                  <h2>
                    <Link href={`/projects/${t.projectId}`}>{t.projectName}</Link>
                    <span className="dim">{` · ${t.projectCode}`}</span>
                  </h2>
                  <p className="dim">
                    {`${t.stage ? STAGE_LABELS[t.stage] : 'Project'} · ${
                      t.ageDays === 0 ? 'today' : t.ageDays === 1 ? 'yesterday' : `${t.ageDays} days ago`
                    }${t.pmName ? ` · ${t.pmName}` : ''}`}
                  </p>
                </div>
              </header>

              {t.detail && <p className="task-detail">{t.detail}</p>}

              {/* §5: the task opens with a suggested first move drawn from the
                  reasons the customer picked. A template, not automation — the
                  PM decides what to actually do. */}
              {t.suggested && (
                <p className="task-suggested">
                  <strong>Suggested:</strong> {t.suggested}
                </p>
              )}

              <div className="task-actions">
                <Link className="btn-link" href={`/projects/${t.projectId}/chat`}>
                  Message them
                </Link>
                <ResolveTask taskId={t.id} />
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
