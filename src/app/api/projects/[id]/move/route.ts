import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { moveProject, type MoveDirection } from '@/lib/stages/service';

const DIRECTIONS: MoveDirection[] = ['forward', 'back', 'hold', 'resume', 'cancel', 'reinstate'];

/**
 * THE move endpoint — the advance button, the Kanban drag, and the header
 * Hold/Cancel/Resume/Reinstate buttons all POST here, so there is exactly
 * one validation path (lib/stages/service.ts). hold/cancel skip field
 * validation by design and carry their own reason payload.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session || !session.isActive) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    direction?: string;
    via?: 'button' | 'drag';
    reason?: string;
    notes?: string;
    expectedResumeDate?: string | null;
    refundRequired?: boolean;
    equipmentReturnRequired?: boolean;
  } | null;

  const direction = (DIRECTIONS as string[]).includes(body?.direction ?? '')
    ? (body!.direction as MoveDirection)
    : 'forward';
  const via = body?.via === 'drag' ? 'drag' : 'button';

  const result = await moveProject(session, id, direction, {
    via,
    reason: body?.reason,
    notes: body?.notes,
    expectedResumeDate: body?.expectedResumeDate,
    refundRequired: body?.refundRequired,
    equipmentReturnRequired: body?.equipmentReturnRequired,
  });

  if (result.ok) {
    return NextResponse.json({ stage: result.stage, column: result.column ?? result.stage });
  }
  const status = result.code === 'not_found' ? 404 : result.code === 'forbidden' ? 403 : 422;
  return NextResponse.json({ error: result.message, missing: result.missing ?? [] }, { status });
}
