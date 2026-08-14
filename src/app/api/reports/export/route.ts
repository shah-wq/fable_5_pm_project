import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';
import { FIELD_BY_KEY } from '@/lib/reports/fields';
import { STAGE_LABELS, type StageKey } from '@/lib/stages/definitions';
import { toCsv, toXlsx } from '@/lib/reports/export';
import { EXPORT_ROW_CAP, recordRun, runReport } from '@/lib/reports/run';
import type { ReportDefinition } from '@/lib/reports/definition';

/**
 * Export the current definition as a typed .xlsx or a flat .csv. Rows are
 * capped (EXPORT_ROW_CAP) and the cover sheet says so when the cap bites, so a
 * partial file can never be mistaken for the whole set.
 */

function describeFilters(definition: ReportDefinition): string[] {
  return definition.filters.map((f) => {
    const label = FIELD_BY_KEY.get(f.field)?.label ?? f.field;
    const op = f.op.replaceAll('_', ' ');
    const value = f.values?.length
      ? f.values.join(' / ')
      : f.value2 !== null && f.value2 !== undefined && f.value2 !== ''
        ? `${f.value} – ${f.value2}`
        : f.relative
          ? f.relative.replaceAll('_', ' ')
          : (f.value ?? '');
    return `${label} ${op}${value === '' ? '' : ` ${value}`}`.trim();
  });
}

function describeStages(definition: ReportDefinition): string {
  const stages = definition.stages.length
    ? definition.stages.map((s) => STAGE_LABELS[s as StageKey] ?? s).join(', ')
    : 'all stages';
  const mode = definition.stageMode === 'passed_through' ? 'passed through' : 'currently in';
  const extra = [
    definition.includeHold ? 'incl. hold' : 'excl. hold',
    definition.includeCancelled ? 'incl. cancelled' : 'excl. cancelled',
  ].join(', ');
  return `${mode}: ${stages} (${extra})`;
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops', 'finance'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    definition?: unknown;
    format?: string;
    name?: string;
    description?: string | null;
    reportId?: string;
  } | null;
  const format = body?.format === 'csv' ? 'csv' : 'xlsx';
  const name = body?.name?.trim().slice(0, 120) || 'SolarFlow report';

  try {
    const { result, definition, durationMs } = await runReport(session, body?.definition, {
      limit: EXPORT_ROW_CAP,
    });

    await recordRun(session, {
      reportId: body?.reportId ?? null,
      reportName: name,
      format,
      rowCount: result.rows.length,
      durationMs,
    });

    const filename = `${name.replace(/[^\w\- ]+/g, '').trim().replaceAll(' ', '-').toLowerCase()
      || 'report'}-${new Date().toISOString().slice(0, 10)}.${format}`;

    if (format === 'csv') {
      return new NextResponse(toCsv(result), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}"`,
        },
      });
    }

    const who = await withUser(session, async (c) => {
      const { rows } = await c.query<{ name: string }>(
        `select coalesce(full_name, email) as name from public.profiles where id = $1`,
        [session.userId]
      );
      return rows[0]?.name ?? session.email ?? 'unknown';
    }).catch(() => session.email ?? 'unknown');

    const buffer = await toXlsx(result, definition, {
      reportName: name,
      description: body?.description ?? null,
      ranBy: who,
      ranAt: new Date(),
      filterSummary: describeFilters(definition),
      stageSummary: describeStages(definition),
    });

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (e) {
    return dbErrorResponse(e, 'Exporting the report');
  }
}
