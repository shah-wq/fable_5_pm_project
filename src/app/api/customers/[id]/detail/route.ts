import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';
import { loadCustomerActivity, loadCustomerProjects } from '@/lib/customers/service';

/** Lazily-loaded tabs of the customer record: their projects, or their trail. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const include = new URL(request.url).searchParams.get('include') ?? 'projects';

  try {
    const data = await withUser(session, async (client) => {
      if (include === 'activity') {
        const { rows } = await client.query<{ user_id: string | null }>(
          `select user_id from public.clients where id = $1`,
          [id]
        );
        return { activity: await loadCustomerActivity(client, id, rows[0]?.user_id ?? null) };
      }
      return { projects: await loadCustomerProjects(client, id) };
    });
    return NextResponse.json(data);
  } catch (e) {
    return dbErrorResponse(e, 'Loading the customer record');
  }
}
