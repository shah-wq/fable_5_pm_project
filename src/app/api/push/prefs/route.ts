import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';

/**
 * Per-category notification preferences, matching the portal (spec §3.5).
 * A missing row means 'not chosen yet', and the default is on — so a customer
 * who never opens this screen still gets told their permit was approved.
 */
// 'chat_message' joins the five from the mobile-app spec: a customer must be
// able to silence chat pushes like any other kind (Project Chat §4).
const CATEGORIES = ['stage_advanced', 'appointment', 'action_needed', 'on_hold',
                    'power_on', 'chat_message'];

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  try {
    const prefs = await withUser(session, async (client) => {
      const { rows } = await client.query<{ category: string; push: boolean; email: boolean }>(
        `select category, push, email from public.notification_preferences where user_id = $1`,
        [session.userId]
      );
      const chosen = new Map(rows.map((r) => [r.category, r]));
      return CATEGORIES.map((category) => ({
        category,
        push: chosen.get(category)?.push ?? true,
        email: chosen.get(category)?.email ?? true,
      }));
    });
    return NextResponse.json({ prefs });
  } catch (e) {
    return dbErrorResponse(e, 'Loading your notification settings');
  }
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session || !session.isActive) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    category?: string;
    push?: boolean;
    email?: boolean;
  } | null;
  if (!CATEGORIES.includes(String(body?.category))) {
    return NextResponse.json({ error: 'unknown category' }, { status: 400 });
  }

  try {
    await withUser(session, (client) =>
      client.query(
        `insert into public.notification_preferences (user_id, category, push, email)
         values ($1, $2, coalesce($3, true), coalesce($4, true))
         on conflict (user_id, category) do update set
           push = coalesce($3, public.notification_preferences.push),
           email = coalesce($4, public.notification_preferences.email)`,
        [
          session.userId,
          body!.category,
          typeof body?.push === 'boolean' ? body.push : null,
          typeof body?.email === 'boolean' ? body.email : null,
        ]
      )
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return dbErrorResponse(e, 'Saving your notification settings');
  }
}
