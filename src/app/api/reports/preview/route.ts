import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { PREVIEW_ROWS, recordRun, runReport } from '@/lib/reports/run';

/**
 * Live preview: the first 50 rows plus the full matching count, so every drop
 * on the canvas shows its effect immediately and 'Showing 50 of 348' is
 * honest about the rest.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops', 'finance'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    definition?: unknown;
    reportId?: string;
    name?: string;
  } | null;

  try {
    const { result, durationMs } = await runReport(session, body?.definition, { limit: PREVIEW_ROWS });
    await recordRun(session, {
      reportId: body?.reportId ?? null,
      reportName: body?.name?.slice(0, 200) || 'Untitled report',
      format: 'preview',
      rowCount: result.rows.length,
      durationMs,
    });
    return NextResponse.json({
      columns: result.columns,
      rows: result.rows,
      totalRows: result.totalRows,
      truncated: result.truncated,
      groupColumns: result.groupColumns,
      groups: result.groups,
      totals: result.totals,
      durationMs,
    });
  } catch (e) {
    return dbErrorResponse(e, 'Running the report');
  }
}
