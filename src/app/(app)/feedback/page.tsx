import Link from 'next/link';
import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { optionalRows } from '@/lib/db-optional';
import { STAGES, STAGE_LABELS, isStageKey, type StageKey } from '@/lib/stages/definitions';

export const dynamic = 'force-dynamic';

/**
 * The verbatim log (Stage feedback §7).
 *
 * "Every comment with its score, stage, date and chips, filterable and
 * searchable. The most useful part of the whole module — read it, do not just
 * average it."
 *
 * Its own page rather than a panel on the dashboard, because reading is a
 * different activity from scanning: somebody comes here to find the three
 * comments about permits, or everything one PM's customers said, and that wants
 * a search box rather than a chart.
 */
export default async function FeedbackLogPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; stage?: string; score?: string }>;
}) {
  const session = await guardPath('/feedback');
  const sp = await searchParams;
  const q = sp.q?.trim() || null;
  const stage = sp.stage && isStageKey(sp.stage) ? (sp.stage as StageKey) : null;
  const low = sp.score === 'low';

  const rows = await withUser(session, (client) => {
    const params: unknown[] = [];
    const where: string[] = ['comment is not null'];
    if (q) {
      params.push(`%${q}%`);
      where.push(`(comment ilike $${params.length} or project_name ilike $${params.length})`);
    }
    if (stage) {
      params.push(stage);
      where.push(`stage = $${params.length}`);
    }
    if (low) where.push('score <= 2');

    return optionalRows<{
      id: string;
      project_id: string;
      project_name: string;
      project_code: string;
      stage: string;
      score: number | null;
      nps: number | null;
      comment: string;
      tags: string[];
      channel: string | null;
      responded_at: string;
      pm_name: string | null;
      dealer_name: string | null;
      task_resolved_at: string | null;
    }>(
      client,
      'the verbatim log (public.feedback_verbatims)',
      `select id, project_id, project_name, project_code, stage, score, nps, comment,
              tags, channel, responded_at::text, pm_name, dealer_name,
              task_resolved_at::text
         from public.feedback_verbatims
        where ${where.join(' and ')}
        order by responded_at desc
        limit 300`,
      params
    );
  });

  const link = (over: Record<string, string | null>) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (stage) params.set('stage', stage);
    if (low) params.set('score', 'low');
    for (const [k, v] of Object.entries(over)) {
      if (v === null) params.delete(k);
      else params.set(k, v);
    }
    const qs = params.toString();
    return qs ? `/feedback?${qs}` : '/feedback';
  };

  return (
    <main className="table-page">
      <div className="board-header">
        <h1>What customers said</h1>
        <div className="board-actions">
          <span className="dim">{`${rows.length} comment${rows.length === 1 ? '' : 's'}`}</span>
        </div>
      </div>

      <p className="dim">
        Every comment left with a rating, newest first. Scores without a comment are counted on the{' '}
        <Link href="/dashboard#sentiment">dashboard</Link>; this page is the words.
      </p>

      <form className="filters" method="get">
        <input type="search" name="q" placeholder="Search comments and projects…" defaultValue={q ?? ''} />
        {stage && <input type="hidden" name="stage" value={stage} />}
        {low && <input type="hidden" name="score" value="low" />}
        <button className="btn" type="submit">
          Search
        </button>
      </form>

      <div className="filter-toggles">
        <Link className={`toggle-chip${low ? ' on' : ''}`} href={link({ score: low ? null : 'low' })}>
          Low scores only
        </Link>
        {STAGES.map((s) => (
          <Link
            key={s}
            className={`toggle-chip${stage === s ? ' on' : ''}`}
            href={link({ stage: stage === s ? null : s })}
          >
            {STAGE_LABELS[s]}
          </Link>
        ))}
        {(q || stage || low) && (
          <Link className="toggle-chip clear" href="/feedback">
            Clear
          </Link>
        )}
      </div>

      {rows.length === 0 ? (
        <section className="panel">
          <p className="chart-empty">
            {q || stage || low
              ? 'No comments match that.'
              : 'No comments yet. They arrive as customers answer — the first ones usually come by email.'}
          </p>
        </section>
      ) : (
        <ul className="verbatim-list full">
          {rows.map((r) => (
            <li key={r.id}>
              <span className={`verbatim-score s${r.score ?? 0}`}>{r.score ?? '—'}</span>
              <div>
                <p className="verbatim-text">{`“${r.comment}”`}</p>
                <p className="dim">
                  {`${STAGE_LABELS[isStageKey(r.stage) ? r.stage : 'survey']} · `}
                  <Link href={`/projects/${r.project_id}`}>{r.project_name}</Link>
                  {` · ${r.responded_at.slice(0, 10)}`}
                  {r.pm_name ? ` · ${r.pm_name}` : ''}
                  {r.dealer_name ? ` · ${r.dealer_name}` : ''}
                  {r.channel ? ` · by ${r.channel}` : ''}
                  {r.nps !== null ? ` · would recommend ${r.nps}/10` : ''}
                </p>
                {r.tags.length > 0 && (
                  <p className="verbatim-tags">
                    {r.tags.map((t) => (
                      <span className="stage-chip-sm" key={t}>
                        {t.replace(/_/g, ' ')}
                      </span>
                    ))}
                  </p>
                )}
                {r.score !== null && r.score <= 2 && (
                  <p className="dim">
                    {r.task_resolved_at
                      ? `Followed up ${r.task_resolved_at.slice(0, 10)}`
                      : 'Follow-up still open — '}
                    {!r.task_resolved_at && <Link href="/tasks">open it</Link>}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
