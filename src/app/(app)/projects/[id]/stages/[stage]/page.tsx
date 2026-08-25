import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { guardPath } from '@/lib/auth/session';
import { isoDate } from '@/lib/dates';
import { withUser } from '@/lib/db';
import {
  ADVANCE_LABELS,
  STAGE_LABELS,
  isStageKey,
  stageIndex,
} from '@/lib/stages/definitions';
import { STAGE_FORMS, STAGE_TABLES } from '@/lib/stages/fields';
import { evaluateStage } from '@/lib/stages/requirements';
import { loadBundles } from '@/lib/stages/service';
import { Stepper } from '../../Stepper';
import { AdvanceButton } from './AdvanceButton';
import { StageForm } from './StageForm';

export const dynamic = 'force-dynamic';

/**
 * A stage's data-entry form (Stage Field Specification) plus the validated
 * advance button — the same requirements engine gates both this button and
 * the board drag.
 */
export default async function StagePage({
  params,
}: {
  params: Promise<{ id: string; stage: string }>;
}) {
  const { id, stage } = await params;
  if (!isStageKey(stage)) notFound();
  const session = await guardPath('/projects');

  const cards = STAGE_FORMS[stage];
  const uploadCategories = cards
    .flatMap((c) => c.fields)
    .filter((f) => f.type === 'upload')
    .map((f) => f.name);

  const data = await withUser(session, async (c) => {
    const project = await c.query(
      `select id, name, address, stage, status, created_at, finance_partner_id
       from public.projects where id = $1`,
      [id]
    );
    if (!project.rows[0]) return null;

    const [stageRow, financeRow, docs, designers, staff, financePartners, bundles] =
      await Promise.all([
        c.query(`select * from public."${STAGE_TABLES[stage]}" where project_id = $1`, [id]),
        c.query(`select * from public.finance_milestones where project_id = $1`, [id]),
        uploadCategories.length
          ? c.query(
              `select id, title, category from public.documents
               where project_id = $1 and category = any($2) order by created_at`,
              [id, uploadCategories]
            )
          : Promise.resolve({ rows: [] as { id: string; title: string | null; category: string }[] }),
        c.query(`select id, display_name as name from public.designers where is_active order by 2`),
        c.query(
          `select id, coalesce(full_name, email) as name from public.profiles
           where role in ('admin', 'ops') and is_active and deleted_at is null order by 2`
        ),
        c.query(`select id, name from public.finance_partners where is_active order by name`),
        loadBundles(c, [id]),
      ]);

    return {
      project: project.rows[0],
      stageRow: stageRow.rows[0] ?? {},
      financeRow: financeRow.rows[0] ?? {},
      docs: docs.rows,
      refs: {
        designers: designers.rows,
        staff: staff.rows,
        financePartners: financePartners.rows,
      },
      bundle: bundles.get(id) ?? null,
    };
  });
  if (!data) notFound();

  const project = data.project;
  const currentStage = isStageKey(String(project.stage)) ? (String(project.stage) as typeof stage) : 'survey';
  const viewIndex = stageIndex(stage);
  const currentIndex = stageIndex(currentStage);

  // Future stages stay locked until reached.
  if (project.status !== 'complete' && viewIndex > currentIndex) {
    redirect(`/projects/${id}/stages/${currentStage}`);
  }

  const isCurrent = project.status !== 'complete' && stage === currentStage;
  const missing = data.bundle ? evaluateStage(stage, data.bundle) : [];

  // Merge the three persistence sources into one flat value map for the form.
  const drop = new Set(['project_id', 'created_at', 'updated_at']);
  const initialValues: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data.stageRow)) if (!drop.has(k)) initialValues[k] = v;
  for (const [k, v] of Object.entries(data.financeRow)) if (!drop.has(k)) initialValues[k] = v;
  initialValues.finance_partner_id = project.finance_partner_id;

  const docsByCategory: Record<string, { id: string; title: string | null }[]> = {};
  for (const d of data.docs) {
    (docsByCategory[d.category] ??= []).push({ id: d.id, title: d.title });
  }

  const editable = ['admin', 'ops'].includes(session.role);

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
          <Link className="btn-link" href="/pipeline">
            Board
          </Link>
        </div>
      </div>

      <Stepper projectId={id} current={currentStage} completed={project.status === 'complete'} />

      {!isCurrent && (
        <p className="notice ok">
          {project.status === 'complete' || viewIndex < currentIndex
            ? 'This stage is complete. Edits are allowed for corrections and every change is written to the activity log.'
            : null}
        </p>
      )}

      {/* projectCreatedAt is a timestamp and the card that counts days wants a
          calendar date. String(...).slice(0, 10) on a Date gives 'Tue Aug 25',
          which then parses as a date in 2001. */}
      <StageForm
        projectId={id}
        stage={stage}
        cards={cards}
        initialValues={initialValues}
        docs={docsByCategory}
        refs={data.refs}
        projectCreatedAt={isoDate(project.created_at)}
        editable={editable}
      />

      {isCurrent && (
        <section className="panel advance-panel">
          <AdvanceButton
            projectId={id}
            label={ADVANCE_LABELS[stage]}
            missing={missing}
            canMove={editable}
          />
        </section>
      )}
    </main>
  );
}
