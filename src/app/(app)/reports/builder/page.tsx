import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { EMPTY_DEFINITION, sanitizeDefinition, type ReportDefinition } from '@/lib/reports/definition';
import { visibleFields } from '@/lib/reports/fields';
import { allowedKeysFor } from '@/lib/reports/run';
import { TEMPLATE_BY_KEY } from '@/lib/reports/templates';
import { Builder } from './Builder';
import type { LibraryField } from './FieldLibrary';

export const dynamic = 'force-dynamic';

/**
 * The builder screen. It opens blank, from a template, or from a saved report;
 * the field library is already filtered to what this role may see, so a field
 * a user cannot report on is never offered in the first place.
 */
export default async function ReportBuilderPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string; report?: string; copy?: string }>;
}) {
  const session = await guardPath('/reports');
  const sp = await searchParams;

  const template = sp.template ? TEMPLATE_BY_KEY.get(sp.template) : undefined;

  const data = await withUser(session, async (c) => {
    const saved = sp.report
      ? (
          await c.query(
            `select id, name, description, definition from public.report_definitions where id = $1`,
            [sp.report]
          )
        ).rows[0] ?? null
      : null;
    const dealers = (await c.query('select id, name from public.dealers where is_active order by name')).rows;
    const reps = (await c.query('select id, name from public.sales_reps where is_active order by name')).rows;
    const pms = (
      await c.query(
        `select id, coalesce(full_name, email) as name from public.profiles
         where role in ('admin', 'ops') and is_active and deleted_at is null order by 2`
      )
    ).rows;
    return { saved, dealers, reps, pms };
  });

  // The notes flag has to be known before the key set is computed, so read it
  // from whichever definition we are opening.
  const source: unknown = data.saved?.definition ?? template?.definition ?? EMPTY_DEFINITION;
  const wantsNotes = (source as { includeInternalNotes?: boolean })?.includeInternalNotes === true;
  const allowed = allowedKeysFor(session, wantsNotes);
  const definition: ReportDefinition = sanitizeDefinition(source, allowed);

  const fields: LibraryField[] = visibleFields(session.role, wantsNotes).map((f) => ({
    key: f.key,
    label: f.label,
    category: f.category,
    type: f.type,
    groupable: f.groupable === true,
    summarisable: f.summarisable === true,
    filterable: f.filterable === true,
  }));

  const copying = sp.copy === '1';
  const name = copying
    ? `${data.saved?.name ?? template?.name ?? 'Untitled report'} (copy)`
    : (data.saved?.name ?? template?.name ?? 'Untitled report');

  return (
    <main className="board-page">
      <Builder
        fields={fields}
        refs={{ dealers: data.dealers, reps: data.reps, pms: data.pms }}
        initial={definition}
        savedReportId={copying ? undefined : (data.saved?.id ?? undefined)}
        initialName={name}
        initialDescription={data.saved?.description ?? template?.description ?? null}
        canShare={['admin', 'ops', 'finance'].includes(session.role)}
      />
    </main>
  );
}
