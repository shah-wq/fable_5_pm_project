import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { isUuid } from '@/lib/crm/coerce';
import { esignErrorResponse } from '@/lib/esign/errors';
import { loadEnvelope, signingSession, syncEnvelope, toView, voidEnvelope } from '@/lib/esign/service';

const ROLES = ['admin', 'ops', 'sales'];

async function gate(ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: 'unauthenticated' }, { status: 401 }) };
  if (!ROLES.includes(session.role) || !session.isActive) {
    return { error: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
  }
  if (!isUuid(id)) return { error: NextResponse.json({ error: 'not found' }, { status: 404 }) };
  return { id, session };
}

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate(ctx);
  if ('error' in g) return g.error;
  const env = await withUser(g.session, (c) => loadEnvelope(c, g.id));
  if (!env) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ envelope: toView(env) });
}

/**
 * One envelope's actions:
 *   refresh  ask PandaDoc where it is and act on it (and finish one whose
 *            outcome could not be applied the first time)
 *   session  a link to sign it on this screen, with the homeowner present
 *   void     withdraw it
 * Permission is the database's: RLS decides whether the envelope is visible,
 * and esign_mark/esign_complete whether it may be changed.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate(ctx);
  if ('error' in g) return g.error;
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  try {
    const visible = await withUser(g.session, (c) => loadEnvelope(c, g.id));
    if (!visible) return NextResponse.json({ error: 'not found' }, { status: 404 });
    switch (body?.action) {
      case 'refresh':
        return NextResponse.json(await syncEnvelope(g.session, g.id));
      case 'session':
        return NextResponse.json({ sessionUrl: await signingSession(g.session, g.id) });
      case 'void':
        return NextResponse.json({ envelope: await voidEnvelope(g.session, g.id) });
      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 });
    }
  } catch (e) {
    return esignErrorResponse(e, 'Updating the e-signature');
  }
}
