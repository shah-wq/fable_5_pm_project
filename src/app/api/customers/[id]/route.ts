import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';
import { optionalRows } from '@/lib/db-optional';

/**
 * Guarded customer deletion and anonymisation. Deleting a customer who has
 * projects would take the project's context with them, and the business still
 * needs the permit record, install date and payment history — so deletion is
 * only possible for a record nothing references, and anonymise is offered as a
 * distinct action for a data-removal request (spec §5).
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.role !== 'admin' || !session.isActive) {
    return NextResponse.json(
      { error: 'Only an admin can delete or anonymise a customer.' },
      { status: 403 }
    );
  }

  const body = (await request.json().catch(() => null)) as {
    confirmName?: string;
    mode?: 'delete' | 'anonymise';
  } | null;
  const mode = body?.mode === 'anonymise' ? 'anonymise' : 'delete';

  try {
    const result = await withUser(session, async (client) => {
      const { rows } = await client.query<{
        name: string; projects: number; leads: number; user_id: string | null;
      }>(
        `select c.first_name || ' ' || c.last_name as name,
                (select count(*)::int from public.projects p where p.client_id = c.id) as projects,
                (select count(*)::int from public.deals d
                  where d.client_id = c.id
                     or d.converted_project_id in
                        (select id from public.projects where client_id = c.id)) as leads,
                c.user_id
         from public.clients c where c.id = $1`,
        [id]
      );
      const customer = rows[0];
      if (!customer) return { error: 'customer not found', status: 404 };

      if ((body?.confirmName ?? '').trim().toLowerCase() !== customer.name.trim().toLowerCase()) {
        return { error: "Type the customer's name exactly to confirm.", status: 400 };
      }

      if (mode === 'anonymise') {
        await client.query(`select public.anonymise_customer($1)`, [id]);
        return { ok: true as const, name: customer.name, mode };
      }

      // Part 4, same rule with a wider reach: "delete only with zero projects,
      // deals and subscriptions; once a project exists, anonymise."
      if (customer.projects > 0 || customer.leads > 0) {
        return {
          error:
            `${customer.name} has ${customer.projects} project(s)` +
            (customer.leads > 0 ? ` and ${customer.leads} deal(s)` : '') +
            ' — deleting would take that history with them. Archive the record, or anonymise it if this is a data-removal request.',
          status: 422,
        };
      }

      // "A prospect with only a subscription can be deleted, with their address
      // added to suppression so a later import does not resurrect them." The
      // suppression row outlives the person on purpose: it is the only way to
      // honour the request against a list that arrives next quarter.
      const subs = await optionalRows<{ n: string }>(
        client,
        'the subscriptions blocking a delete',
        `select count(*) as n from public.subscriptions where client_id = $1`,
        [id]
      );
      if (Number(subs[0]?.n ?? 0) > 0) {
        await optionalRows(
          client,
          'suppressing a deleted subscriber (public.suppression)',
          `insert into public.suppression (kind, value_normalised, reason, notes)
           select ch.kind, ch.value_normalised, 'deleted',
                  'person record deleted with an active subscription'
             from public.client_channels ch
            where ch.client_id = $1 and ch.value_normalised <> ''
           on conflict (kind, value_normalised) do nothing`,
          [id]
        );
      }

      await client.query(`delete from public.clients where id = $1`, [id]);
      return { ok: true as const, name: customer.name, mode };
    });

    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status });

    await tryLogAuditEvent(session, {
      action: mode === 'anonymise' ? 'customer.anonymised' : 'customer.deleted',
      entityType: 'clients',
      entityId: id,
      context: { name: result.name },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return dbErrorResponse(e, mode === 'anonymise' ? 'Anonymising the customer' : 'Deleting the customer');
  }
}
