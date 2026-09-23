import type { PoolClient } from 'pg';
import { optionalRows } from '../db-optional';
import { render, type NotifyContext } from './catalogue';

/** One line of somebody's feed, with the words already chosen. */
export interface FeedItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  url: string;
  createdAt: string;
  readAt: string | null;
  projectId: string | null;
}

interface Row {
  id: string;
  kind: string;
  audience: NotifyContext['audience'];
  payload: Record<string, unknown>;
  created_at: Date;
  read_at: Date | null;
  project_id: string | null;
  code: string | null;
  name: string | null;
  address: string | null;
  stage: string | null;
  customer_name: string | null;
  pm_name: string | null;
}

/**
 * The caller's own notifications, newest first. RLS hands back only theirs; the
 * project context comes with each row, so a dealer's or a homeowner's read of
 * a project they may see renders with its name and nothing else leaks.
 */
export async function loadFeed(
  client: PoolClient,
  opts: { limit?: number; unreadOnly?: boolean } = {}
): Promise<{ unread: number; items: FeedItem[] }> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 30));
  const rows = await optionalRows<Row>(
    client,
    'the notification feed',
    `select n.id::text as id, n.kind, r.audience, n.payload, n.created_at, n.read_at, n.project_id,
            p.code, p.name, p.address, p.stage::text as stage,
            nullif(btrim(concat_ws(' ', cl.first_name, cl.last_name)), '') as customer_name,
            coalesce(pm.full_name, pm.email) as pm_name
       from public.notifications n
       join public.notification_rules r on r.kind = n.kind
       left join public.projects p on p.id = n.project_id
       left join public.clients cl on cl.id = p.client_id
       left join public.profiles pm on pm.id = p.assigned_pm
      where n.user_id = (select auth.uid()) and r.in_app
        ${opts.unreadOnly ? 'and n.read_at is null' : ''}
      order by n.created_at desc
      limit ${limit}`
  );
  const unread = await optionalRows<{ n: number }>(
    client,
    'the unread count',
    'select public.unread_notification_count() as n'
  );
  return {
    unread: Number(unread[0]?.n ?? 0),
    items: rows.map((r) => {
      const ctx: NotifyContext = {
        audience: r.audience,
        projectId: r.project_id,
        projectCode: r.code,
        projectName: r.name,
        customerName: r.customer_name,
        address: r.address,
        stage: r.stage,
        pmName: r.pm_name,
        companyName: null,
      };
      const words = render(r.kind, r.payload ?? {}, ctx);
      return {
        id: r.id,
        kind: r.kind,
        ...words,
        createdAt: new Date(r.created_at).toISOString(),
        readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
        projectId: r.project_id,
      };
    }),
  };
}
