import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { withOwner } from '@/lib/db';
import { applyPending, bundledMigrations } from '@/lib/db-apply';
import { migrationState } from '@/lib/db-migrations';

export const dynamic = 'force-dynamic';
/** A few DDL-heavy files over a network hop; the default ten seconds is tight. */
export const maxDuration = 60;

/**
 * Admin § Database: which migrations this database has, and applying the rest.
 *
 * Admin only, and it runs nothing it is sent — only the files bundled with this
 * deployment, in order, through the connection every page already uses. The
 * console-and-clipboard step that this replaces is described in db-apply.ts.
 */
function guard(session: Awaited<ReturnType<typeof getSession>>) {
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.role !== 'admin' || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return null;
}

export async function GET() {
  const session = await getSession();
  const denied = guard(session);
  if (denied) return denied;
  try {
    const state = await withOwner((c) => migrationState(c));
    return NextResponse.json({ ...state, bundled: bundledMigrations() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST() {
  const session = await getSession();
  const denied = guard(session);
  if (denied || !session) return denied ?? NextResponse.json({ error: 'forbidden' }, { status: 403 });
  try {
    const result = await withOwner((c) => applyPending(c));
    await tryLogAuditEvent(session, {
      action: 'database.migrations_applied',
      entityType: 'system',
      entityId: 'migrations',
      kind: 'system',
      context: {
        applied: result.applied.filter((a) => a.ok).map((a) => a.file),
        failed: result.applied.filter((a) => !a.ok).map((a) => `${a.file}: ${a.error}`),
      },
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
