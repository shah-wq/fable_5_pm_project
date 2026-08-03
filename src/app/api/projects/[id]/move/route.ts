import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { moveProject } from '@/lib/stages/service';

/**
 * THE move endpoint — the stage form's green button and the Kanban drag both
 * POST here, so there is exactly one validation path (lib/stages/service.ts).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session || !session.isActive) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    direction?: 'forward' | 'back';
    via?: 'button' | 'drag';
    reason?: string;
  } | null;
  const direction = body?.direction === 'back' ? 'back' : 'forward';
  const via = body?.via === 'drag' ? 'drag' : 'button';

  const result = await moveProject(session, id, direction, { via, reason: body?.reason });

  if (result.ok) {
    return NextResponse.json({ stage: result.stage });
  }
  const status = result.code === 'not_found' ? 404 : result.code === 'forbidden' ? 403 : 422;
  return NextResponse.json(
    { error: result.message, missing: result.missing ?? [] },
    { status }
  );
}
