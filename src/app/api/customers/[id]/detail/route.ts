import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';
import { loadCustomerProjects } from '@/lib/customers/service';
import {
  loadAddresses,
  loadChannels,
  loadPersonDeals,
  loadPersonSubscriptions,
  loadTimeline,
} from '@/lib/people/service';

/**
 * Lazily-loaded tabs of the person record: projects, deals, subscriptions, or
 * the timeline.
 *
 * Six tabs now (Part 4), and each one is a fetch when it is first opened rather
 * than six queries on every list render. The Activity tab reads the unified
 * timeline — the same audit_log rows the project side writes, now also selected
 * by client_id and deal_id, which is the whole point of extending that table
 * instead of adding an activities table beside it.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops', 'sales'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const include = new URL(request.url).searchParams.get('include') ?? 'projects';

  try {
    const data = await withUser(session, async (client) => {
      switch (include) {
        case 'activity': {
          const { rows } = await client.query<{ user_id: string | null }>(
            `select user_id from public.clients where id = $1`,
            [id]
          );
          return { activity: await loadTimeline(client, id, rows[0]?.user_id ?? null) };
        }
        case 'deals':
          return { deals: await loadPersonDeals(client, id) };
        case 'subscriptions':
          return { subscriptions: await loadPersonSubscriptions(client, id) };
        case 'contact':
          // Channels and addresses are one tab's worth of the Details pane, so
          // they travel together — sequentially, because optionalQuery wraps
          // each in a savepoint on the same client.
          return {
            channels: await loadChannels(client, id),
            addresses: await loadAddresses(client, id),
          };
        default:
          return { projects: await loadCustomerProjects(client, id) };
      }
    });
    return NextResponse.json(data);
  } catch (e) {
    return dbErrorResponse(e, 'Loading the person record');
  }
}
