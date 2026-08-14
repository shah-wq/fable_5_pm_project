import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guarded dealer-company deletion ("Deactivate is almost always the right
 * answer"): allowed only when the company has no projects, no leads and no
 * commission records; the admin types the exact company name to confirm; and
 * linked user accounts must be explicitly reassigned to another company or
 * deactivated — a Dealer login is never left pointing at nothing. The
 * deletion is logged with the company name so the trail survives the record.
 * The database's plain foreign keys enforce the same rule below any UI bug.
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.role !== 'admin' || !session.isActive) {
    return NextResponse.json({ error: 'only an admin can delete a dealer company' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    confirmName?: string;
    userAction?: 'deactivate' | 'reassign';
    targetDealerId?: string;
  } | null;

  const result = await withUser(session, async (client) => {
    const { rows } = await client.query(`select id, name from public.dealers where id = $1`, [id]);
    const dealer = rows[0];
    if (!dealer) return { error: 'dealer not found', status: 404 };

    if ((body?.confirmName ?? '').trim() !== String(dealer.name).trim()) {
      return { error: 'Type the company name exactly to confirm deletion.', status: 400 };
    }

    const counts = (
      await client.query(
        `select
           (select count(*) from public.projects p where p.dealer_id = $1) as projects,
           (select count(*) from public.leads l where l.dealer_id = $1) as leads,
           (select count(*) from public.commissions cm
             join public.projects p on p.id = cm.project_id where p.dealer_id = $1) as commissions,
           (select count(*) from public.dealer_users du where du.dealer_id = $1) as users`,
        [id]
      )
    ).rows[0];
    const blockers: string[] = [];
    if (Number(counts.projects) > 0) blockers.push(`${counts.projects} project(s)`);
    if (Number(counts.leads) > 0) blockers.push(`${counts.leads} lead(s)`);
    if (Number(counts.commissions) > 0) blockers.push(`${counts.commissions} commission record(s)`);
    if (blockers.length > 0) {
      return {
        error: `${dealer.name} has ${blockers.join(', ')} and cannot be deleted — deactivate it instead.`,
        status: 422,
      };
    }

    if (Number(counts.users) > 0) {
      if (body?.userAction === 'reassign') {
        const target = body.targetDealerId;
        if (!target || !UUID_RE.test(target) || target === id) {
          return { error: 'Pick the company to reassign the user accounts to.', status: 400 };
        }
        const t = await client.query(`select id from public.dealers where id = $1`, [target]);
        if (!t.rows[0]) return { error: 'target company not found', status: 404 };
        await client.query(
          `insert into public.dealer_users (dealer_id, user_id)
           select $2, du.user_id from public.dealer_users du
           where du.dealer_id = $1
           on conflict do nothing`,
          [id, target]
        );
      } else if (body?.userAction === 'deactivate') {
        await client.query(
          `update public.profiles set is_active = false
           where id in (select user_id from public.dealer_users where dealer_id = $1)`,
          [id]
        );
      } else {
        return {
          error: `${dealer.name} has ${counts.users} linked user account(s) — choose whether to deactivate them or reassign them to another company.`,
          status: 422,
        };
      }
    }

    // dealer_users memberships cascade with the company row.
    await client.query(`delete from public.dealers where id = $1`, [id]);
    return { ok: true as const, name: String(dealer.name), users: Number(counts.users) };
  });

  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status });

  await tryLogAuditEvent(session, {
    action: 'dealer.deleted',
    entityType: 'dealers',
    entityId: id,
    context: { name: result.name, users: result.users, userAction: body?.userAction ?? null },
  });
  return NextResponse.json({ ok: true });
}

/** Reassign one dealer user to a different company (confirmed in the UI, logged). */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.role !== 'admin' || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    userId?: string;
    targetDealerId?: string;
  } | null;
  if (!body?.userId || !UUID_RE.test(body.userId) || !body.targetDealerId ||
      !UUID_RE.test(body.targetDealerId)) {
    return NextResponse.json({ error: 'userId and targetDealerId are required' }, { status: 400 });
  }
  if (body.targetDealerId === id) {
    return NextResponse.json({ error: 'already linked to this company' }, { status: 400 });
  }

  const moved = await withUser(session, async (client) => {
    const { rowCount } = await client.query(
      `update public.dealer_users set dealer_id = $3
       where dealer_id = $1 and user_id = $2`,
      [id, body.userId, body.targetDealerId]
    );
    return (rowCount ?? 0) > 0;
  }).catch(() => false);

  if (!moved) {
    return NextResponse.json(
      { error: 'Could not reassign — check the user belongs to this company.' },
      { status: 422 }
    );
  }
  await tryLogAuditEvent(session, {
    action: 'dealer.user_reassigned',
    entityType: 'dealer_users',
    entityId: body.userId,
    context: { from: id, to: body.targetDealerId },
  });
  return NextResponse.json({ ok: true });
}
