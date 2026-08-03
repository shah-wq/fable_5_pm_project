import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import {
  ADVANCE_LABELS,
  STAGE_LABELS,
  isStageKey,
  stageIndex,
} from '@/lib/stages/definitions';
import { evaluateStage } from '@/lib/stages/requirements';
import { loadBundles } from '@/lib/stages/service';
import { Stepper } from '../../Stepper';
import { AdvanceButton } from './AdvanceButton';

export const dynamic = 'force-dynamic';

/**
 * A stage's page: its live requirements checklist and the validated advance
 * button. Module 2 replaces the checklist body with the full data-entry form
 * (same requirements engine keeps gating the button).
 */
export default async function StagePage({
  params,
}: {
  params: Promise<{ id: string; stage: string }>;
}) {
  const { id, stage } = await params;
  if (!isStageKey(stage)) notFound();
  const session = await guardPath('/projects');

  const data = await withUser(session, async (c) => {
    const { rows } = await c.query(
      `select id, name, address, stage, status from public.projects where id = $1`,
      [id]
    );
    if (!rows[0]) return null;
    const bundles = await loadBundles(c, [id]);
    return { project: rows[0], bundle: bundles.get(id) ?? null };
  });
  if (!data) notFound();

  const project = data.project;
  const currentStage = isStageKey(project.stage) ? project.stage : 'survey';
  const viewIndex = stageIndex(stage);
  const currentIndex = stageIndex(currentStage);

  // Future stages are locked: bounce to the current one.
  if (project.status !== 'complete' && viewIndex > currentIndex) {
    redirect(`/projects/${id}/stages/${currentStage}`);
  }

  const isCurrent = project.status !== 'complete' && stage === currentStage;
  const missing = data.bundle ? evaluateStage(stage, data.bundle) : [];

  return (
    <main className="surface wide">
      <div className="board-header">
        <div>
          <h1>
            {STAGE_LABELS[stage]} · {project.name}
          </h1>
          <p className="dim">{project.address ?? ''}</p>
        </div>
        <div className="board-actions">
          <Link className="btn-link" href={`/projects/${id}`}>
            Project overview
          </Link>
        </div>
      </div>

      <Stepper projectId={id} current={currentStage} completed={project.status === 'complete'} />

      <div className="detail-grid two">
        <section className="panel">
          <h2>{isCurrent ? 'Required to advance' : 'Stage record'}</h2>
          {!isCurrent && (
            <p className="dim">
              {project.status === 'complete' || viewIndex < currentIndex
                ? 'This stage is complete — shown read-only. Corrections come with the stage forms (next module) and are logged.'
                : null}
            </p>
          )}
          {missing.length === 0 ? (
            <p className="ok-line">✓ Every required item for this stage is complete.</p>
          ) : (
            <ul className="gap-list">
              {missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
          <p className="dim form-note">
            The {STAGE_LABELS[stage]} data-entry form (fields &amp; uploads) arrives with the
            stage-forms module; this checklist and the button below already run the exact
            validation it will use.
          </p>
        </section>

        {isCurrent && (
          <section className="panel">
            <h2>Advance</h2>
            <AdvanceButton
              projectId={id}
              label={ADVANCE_LABELS[stage]}
              missing={missing}
              canMove={['admin', 'ops'].includes(session.role)}
            />
          </section>
        )}
      </div>
    </main>
  );
}
