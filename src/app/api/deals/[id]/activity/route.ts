import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { dbErrorResponse } from '@/lib/db-error';
import { optionalRows } from '@/lib/db-optional';

const KINDS = ['call', 'email', 'sms', 'meeting', 'note'];

/**
 * Log an interaction against a deal (Part 5, stage 2).
 *
 * "A logged interaction with an outcome, plus a next action with a date. A
 * voicemail is an attempt, logged as an activity; the deal stays in New." So
 * this endpoint records both kinds — the difference is the `reached` flag, and
 * only a two-way contact satisfies the gate out of New.
 *
 * It writes to audit_log through the definer function, which means the deal
 * timeline, the person's Activity tab and the project audit trail are one list
 * rather than three.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops', 'sales'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    kind?: string;
    note?: string;
    reached?: boolean;
    nextAction?: string | null;
    nextActionAt?: string | null;
  } | null;

  const kind = KINDS.includes(String(body?.kind)) ? String(body!.kind) : 'note';
  const note = (body?.note ?? '').trim().slice(0, 4000);
  if (!note) {
    return NextResponse.json({ error: 'Say what happened — a line is enough.' }, { status: 400 });
  }
  // An attempt is logged as a note, so it is in the history without pretending
  // the customer answered.
  const reached = body?.reached === true && kind !== 'note';

  try {
    const ok = await withUser(session, async (client) => {
      const deal = await optionalRows<{ client_id: string | null }>(
        client,
        'the deal being logged against',
        `select client_id from public.deals where id = $1`,
        [id]
      );
      if (deal.length === 0) return false;

      // One function, so the log row and the deal's contact stamp can never
      // disagree — the stamp is what the move out of New is gated on.
      await optionalRows(
        client,
        'logging deal activity (public.log_deal_contact)',
        `select public.log_deal_contact($1, $2, $3, $4)`,
        [id, kind, note, reached]
      );

      if (body?.nextAction || body?.nextActionAt) {
        await optionalRows(
          client,
          'setting the next action',
          `update public.deals
              set next_action = coalesce($2, next_action),
                  next_action_at = coalesce($3::date, next_action_at)
            where id = $1`,
          [
            id,
            typeof body?.nextAction === 'string' ? body.nextAction.slice(0, 200) : null,
            typeof body?.nextActionAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.nextActionAt)
              ? body.nextActionAt
              : null,
          ]
        );
      }
      return true;
    });

    if (!ok) return NextResponse.json({ error: 'that deal no longer exists' }, { status: 404 });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e) {
    return dbErrorResponse(e, 'Logging the activity');
  }
}
