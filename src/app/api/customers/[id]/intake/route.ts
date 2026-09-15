import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { dbErrorResponse } from '@/lib/db-error';
import { optionalRows } from '@/lib/db-optional';
import { intakeColumns, type IntakeField } from '@/lib/crm/intake';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The contact intake: every field on one person, and on the deal being worked.
 *
 * GET returns the values, the reference lists and the deal's documents; PATCH
 * writes them back to whichever table each field belongs to. The registry in
 * lib/crm/intake.ts decides which that is, so adding a field is one entry there
 * rather than an edit in four places.
 */

const REF_SQL: Record<string, string> = {
  owners: `select id, coalesce(full_name, email) as name from public.profiles
            where role in ('admin','ops','sales') and is_active and deleted_at is null order by 2`,
  sources: `select id, name from public.client_sources where is_active order by sort_order, name`,
  dealers: `select id, name from public.dealers where is_active order by name`,
  modules: `select id, name from public.module_types where is_active order by name`,
  inverters: `select id, name from public.inverter_types where is_active order by name`,
  batteries: `select id, name from public.battery_types where is_active order by name`,
  financingCompanies: `select id, name from public.financing_companies where is_active order by name`,
  utilities: `select id, name from public.utilities order by name`,
  lossReasons: `select id, name from public.deal_loss_reasons where is_active order by sort_order, name`,
  roofTypes: `select id, name from public.roof_types where is_active order by sort_order, name`,
};

function guard(session: Awaited<ReturnType<typeof getSession>>) {
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops', 'sales'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return null;
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  const denied = guard(session);
  if (denied || !session) return denied ?? NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const dealParam = new URL(request.url).searchParams.get('deal');

  try {
    const data = await withUser(session, async (client) => {
      const clientCols = intakeColumns('client').map((f) => f.name);
      const person = await optionalRows<Record<string, unknown>>(
        client,
        'the contact being opened',
        `select id, ${clientCols.join(', ')},
                (select coalesce(pr.full_name, pr.email) from public.profiles pr
                  where pr.id = c.created_by) as created_by_name
           from public.clients c where id = $1`,
        [id]
      );
      if (person.length === 0) return null;

      // Which deal the fields belong to: the one asked for, else the newest
      // open one, else the newest of any kind. A contact with two live deals is
      // ambiguous by nature, so the screen offers the list and says which it is
      // showing rather than picking silently and hoping.
      const deals = await optionalRows<{ id: string; code: string | null; stage: string; updated_at: string }>(
        client,
        'the contact’s deals',
        `select id, code, stage, updated_at::text
           from public.deals where client_id = $1
          order by (stage not in ('won','lost')) desc, updated_at desc`,
        [id]
      );
      const dealId =
        dealParam && UUID_RE.test(dealParam) && deals.some((d) => d.id === dealParam)
          ? dealParam
          : (deals[0]?.id ?? null);

      const dealCols = intakeColumns('deal').map((f) => f.name);
      const deal = dealId
        ? await optionalRows<Record<string, unknown>>(
            client,
            'the deal behind the contact',
            `select id, stage, ${dealCols.join(', ')} from public.deals where id = $1`,
            [dealId]
          )
        : [];

      const documents = dealId
        ? await optionalRows<{ id: string; category: string; title: string | null }>(
            client,
            'the intake documents',
            `select id, category, title from public.documents
              where deal_id = $1 order by created_at`,
            [dealId]
          )
        : [];

      const refs: Record<string, Array<{ id: string; name: string }>> = {};
      for (const [key, sql] of Object.entries(REF_SQL)) {
        refs[key] = await optionalRows<{ id: string; name: string }>(client, `the ${key} list`, sql);
      }

      return {
        values: { ...person[0], ...(deal[0] ?? {}) },
        dealId,
        deals,
        documents,
        refs,
      };
    });

    if (!data) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(data);
  } catch (e) {
    return dbErrorResponse(e, 'Loading the contact');
  }
}

/** Coerce one value to the shape its column expects, or refuse it. */
function coerce(field: IntakeField, raw: unknown): unknown {
  if (raw === '' || raw === null || raw === undefined) return null;
  switch (field.type) {
    case 'number':
    case 'currency': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case 'toggle':
      return raw === true;
    case 'ref':
      return UUID_RE.test(String(raw)) ? String(raw) : null;
    case 'select':
      return field.options?.some((o) => o.value === String(raw)) ? String(raw) : null;
    default:
      return String(raw).slice(0, 4000);
  }
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  const denied = guard(session);
  if (denied || !session) return denied ?? NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const body = (await request.json().catch(() => null)) as {
    dealId?: string;
    values?: Record<string, unknown>;
  } | null;
  const incoming = body?.values ?? {};
  const dealId = body?.dealId && UUID_RE.test(body.dealId) ? body.dealId : null;

  // `offset` is how many placeholders the WHERE clause has already used, so the
  // SET list numbers itself from there. Getting this wrong writes the right
  // values into the wrong columns, which is the kind of bug that looks like a
  // haunted database three weeks later.
  const build = (fields: IntakeField[], offset: number) => {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const field of fields) {
      if (!(field.name in incoming)) continue;
      params.push(coerce(field, incoming[field.name]));
      sets.push(`${field.name} = $${offset + params.length}`);
    }
    return { sets, params };
  };

  try {
    const result = await withUser(session, async (client) => {
      const person = build(intakeColumns('client'), 1);
      if (person.sets.length > 0) {
        await optionalRows(
          client,
          'saving the contact',
          `update public.clients set ${person.sets.join(', ')} where id = $1`,
          [id, ...person.params]
        );
      }

      const deal = build(intakeColumns('deal'), 2);
      if (deal.sets.length > 0) {
        if (!dealId) return { error: 'There is no deal on this contact to save those fields to.' };
        // client_id in the WHERE as well as the id: a deal belonging to somebody
        // else cannot be edited through this person's screen even if its id is
        // guessed or stale.
        await optionalRows(
          client,
          'saving the deal behind the contact',
          `update public.deals set ${deal.sets.join(', ')} where id = $1 and client_id = $2`,
          [dealId, id, ...deal.params]
        );
      }
      return { ok: true as const };
    });

    if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 });

    await tryLogAuditEvent(session, {
      action: 'contact.intake_saved',
      entityType: 'clients',
      entityId: id,
      clientId: id,
      dealId: dealId ?? undefined,
      kind: 'field_change',
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return dbErrorResponse(e, 'Saving the contact');
  }
}
