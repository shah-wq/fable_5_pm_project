import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { isUuid } from '@/lib/crm/coerce';
import { esignErrorResponse } from '@/lib/esign/errors';
import { loadSettings, readiness, sendEnvelope } from '@/lib/esign/service';

/**
 * A change order's actions:
 *   send     to the homeowner through PandaDoc (by email, or signed here)
 *   approve  by hand — for one that needs no signature, or was signed on paper
 *   void     withdraw a draft or pending one
 * Signing or approving adds its amount to the project's contract value, in
 * the database, in the same statement.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string; co: string }> }) {
  const { id, co } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (!isUuid(id) || !isUuid(co)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const body = (await request.json().catch(() => null)) as {
    action?: unknown;
    signerName?: unknown;
    signerEmail?: unknown;
    delivery?: unknown;
    note?: unknown;
  } | null;

  try {
    const belongs = await withUser(session, (c) =>
      c.query('select 1 from public.change_orders where id = $1 and project_id = $2', [co, id])
    );
    if (belongs.rowCount === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });

    if (body?.action === 'send') {
      const settings = await withUser(session, (c) => loadSettings(c));
      const r = readiness(settings, 'change_order');
      if (!r.ready) return NextResponse.json({ error: r.reason }, { status: 409 });
      const { rows } = await withUser(session, (c) =>
        c.query<{ id: string }>(
          `select public.esign_open('change_order', null, null, $1, $2, $3, $4, null, null) as id`,
          [
            co,
            typeof body.signerName === 'string' ? body.signerName.slice(0, 200) : null,
            typeof body.signerEmail === 'string' ? body.signerEmail.trim() : '',
            body.delivery === 'embedded' ? 'embedded' : 'email',
          ]
        )
      );
      return NextResponse.json(await sendEnvelope(session, rows[0].id), { status: 201 });
    }
    if (body?.action === 'approve') {
      const { rows } = await withUser(session, (c) =>
        c.query<{ value: string | null }>('select public.approve_change_order($1, $2) as value', [
          co,
          typeof body.note === 'string' ? body.note.slice(0, 500) : null,
        ])
      );
      return NextResponse.json({ contractValue: rows[0].value === null ? null : Number(rows[0].value) });
    }
    if (body?.action === 'void') {
      await withUser(session, (c) => c.query('select public.void_change_order($1)', [co]));
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (e) {
    return esignErrorResponse(e, 'Updating the change order');
  }
}
