import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { dbErrorResponse } from '@/lib/db-error';
import { optionalQuery, optionalRows } from '@/lib/db-optional';

/**
 * The notification catalogue as the admin sees it: every kind, who it is for,
 * and which channels it uses. PUT flips one rule's switches, or changes the
 * timing settings the scheduled rules read.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.role !== 'admin' || !session.isActive) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  try {
    const out = await withUser(session, async (c) => {
      const rules = await optionalRows(
        c,
        'the notification rules',
        `select r.kind, r.audience, r.label, r.description, r.enabled, r.in_app, r.email, r.push,
                (select count(*) from public.notifications n where n.kind = r.kind and n.created_at > now() - interval '30 days')::int as last_30_days
           from public.notification_rules r
          order by array_position(array['customer','pm','admin','sales','dealer','user'], r.audience), r.label`
      );
      const settings = await optionalRows<Record<string, number>>(
        c,
        'the reminder settings',
        'select contact_stale_days, deal_stale_days, permit_expiry_warning_days, briefing_hour from public.app_settings where id'
      );
      return { rules, settings: settings[0] ?? null, ready: rules.length > 0 };
    });
    return NextResponse.json(out);
  } catch (e) {
    return dbErrorResponse(e, 'Loading notification rules');
  }
}

export async function PUT(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.role !== 'admin' || !session.isActive) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const body = (await request.json().catch(() => null)) as {
    kind?: unknown;
    enabled?: unknown;
    in_app?: unknown;
    email?: unknown;
    push?: unknown;
    settings?: Record<string, unknown>;
  } | null;
  try {
    await withUser(session, async (c) => {
      if (typeof body?.kind === 'string') {
        const sets: string[] = [];
        const params: unknown[] = [body.kind];
        for (const col of ['enabled', 'in_app', 'email', 'push'] as const) {
          if (typeof body[col] === 'boolean') {
            params.push(body[col]);
            sets.push(`${col} = $${params.length}`);
          }
        }
        if (sets.length) {
          const r = await c.query(`update public.notification_rules set ${sets.join(', ')} where kind = $1`, params);
          if (r.rowCount === 0) throw Object.assign(new Error('unknown notification kind'), { code: 'P0002' });
        }
      }
      if (body?.settings && typeof body.settings === 'object') {
        const n = (v: unknown, min: number, max: number, dflt: number) => {
          const x = Math.round(Number(v));
          return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : dflt;
        };
        const s = body.settings;
        const res = await optionalQuery(
          c,
          'the reminder settings',
          `update public.app_settings set contact_stale_days = $1, deal_stale_days = $2,
              permit_expiry_warning_days = $3, briefing_hour = $4 where id`,
          [
            n(s.contact_stale_days, 1, 365, 7),
            n(s.deal_stale_days, 1, 365, 14),
            n(s.permit_expiry_warning_days, 1, 365, 14),
            n(s.briefing_hour, 0, 23, 7),
          ]
        );
        if (!res.available) throw Object.assign(new Error('the notification settings need migration 004700'), { code: '42703' });
      }
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'P0002') return NextResponse.json({ error: 'Unknown notification kind.' }, { status: 404 });
    return dbErrorResponse(e, 'Saving notification rules');
  }
}
