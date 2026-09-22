import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { dbErrorResponse } from '@/lib/db-error';
import { optionalRows } from '@/lib/db-optional';
import { isContactStage } from '@/lib/contacts/stage-columns';

/**
 * Move one contact to one stage.
 *
 * Any stage to any stage: these are diary states, not pipeline steps, and the
 * common moves are sideways — rescheduled to no-show and back again. The
 * database function does the work, checks the stage is real, and writes the move
 * to the activity log.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops', 'sales'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as { stage?: unknown; note?: unknown } | null;
  if (!isContactStage(body?.stage)) {
    return NextResponse.json({ error: 'that is not a contact stage' }, { status: 400 });
  }
  // Contract signed is a step, not a drop: the system is recorded on the way in,
  // through /sign, which moves the contact itself once it has. A move straight
  // there from here would put a signed contact on the board with no system —
  // the one thing that column is for.
  if (body.stage === 'contract_signed') {
    return NextResponse.json(
      {
        error: 'Contract signed records the system first — fill in the signing form.',
        needsSigning: true,
      },
      { status: 409 }
    );
  }
  const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : null;

  try {
    const rows = await withUser(session, (client) =>
      optionalRows<{ before: string }>(
        client,
        'moving a contact (public.set_contact_stage)',
        `select public.set_contact_stage($1, $2, $3) as before`,
        [id, body.stage, note]
      )
    );
    if (rows.length === 0) {
      return NextResponse.json(
        { error: 'Could not move that contact — the database may not have caught up yet.' },
        { status: 400 }
      );
    }
    return NextResponse.json({ from: rows[0].before, to: body.stage });
  } catch (e) {
    return dbErrorResponse(e, 'Moving the contact');
  }
}
