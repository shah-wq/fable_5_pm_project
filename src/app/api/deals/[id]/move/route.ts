import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { moveDeal, type DealMove } from '@/lib/deals/service';

const MOVES: DealMove[] = ['forward', 'back', 'won', 'lost', 'reopen', 'to'];

/**
 * THE deal move endpoint — the stage button, the board drag and Won/Lost all
 * POST here, so there is exactly one validation path (lib/deals/service.ts).
 *
 * The mirror of /api/projects/[id]/move, on purpose: Part 3's whole argument is
 * that a second pipeline should reuse the first one's service rather than grow
 * its own, and that argument only holds if the route is this thin.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session || !session.isActive) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    move?: string;
    target?: string;
    via?: 'button' | 'drag';
    lostReasonId?: string | null;
    notes?: string | null;
  } | null;

  const move = (MOVES as string[]).includes(body?.move ?? '')
    ? (body!.move as DealMove)
    : 'forward';

  const result = await moveDeal(session, id, move, {
    via: body?.via === 'drag' ? 'drag' : 'button',
    target: body?.target,
    lostReasonId: body?.lostReasonId ?? null,
    notes: body?.notes ?? null,
  });

  if (result.ok) {
    return NextResponse.json({ stage: result.stage, projectId: result.projectId ?? null });
  }
  const status =
    result.code === 'not_found' ? 404 : result.code === 'forbidden' ? 403 : 422;
  return NextResponse.json(
    { error: result.message, missing: result.missing ?? [] },
    { status }
  );
}
