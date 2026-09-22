import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { dbErrorResponse } from '@/lib/db-error';
import { optionalRows } from '@/lib/db-optional';
import { coerceIntakeValue } from '@/lib/crm/coerce';
import { intakeColumns, type IntakeField } from '@/lib/crm/intake';
import { loadIntakeRefs } from '@/lib/crm/refs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The contact intake: every field on one person, and on the deal being worked.
 *
 * GET returns the values, the reference lists and the deal's documents; PATCH
 * writes them back to whichever table each field belongs to. The registry in
 * lib/crm/intake.ts decides which that is, so adding a field is one entry there
 * rather than an edit in four places.
 */


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
            // address too: not an intake field, but the signing form's site
            // address starts from it.
            `select id, stage, address, ${dealCols.join(', ')} from public.deals where id = $1`,
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

      const refs = await loadIntakeRefs(client);

      // The project holding them in Contract signed, if there is one. The
      // record says so and stops offering the stage as something to change.
      const held = await optionalRows<{ project_id: string; project_code: string }>(
        client,
        'the project holding the contact (public.contact_project)',
        `select project_id, project_code from public.contact_project($1)`,
        [id]
      );

      return {
        values: { ...person[0], ...(deal[0] ?? {}) },
        dealId,
        deals,
        documents,
        refs,
        project: held[0] ? { id: held[0].project_id, code: held[0].project_code } : null,
      };
    });

    if (!data) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(data);
  } catch (e) {
    return dbErrorResponse(e, 'Loading the contact');
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
      params.push(coerceIntakeValue(field, incoming[field.name]));
      sets.push(`${field.name} = $${offset + params.length}`);
    }
    return { sets, params };
  };

  try {
    const result = await withUser(session, async (client) => {
      // Choosing Contract signed in the Lead status box is the same move as
      // dropping the card in that column, and goes the same way: through the
      // signing form, which records the system. Saving it straight onto the
      // person would make a signed contact with no system behind them. The
      // record's own screen opens the form instead of sending this; this is for
      // anything else that tries.
      if (incoming.contact_stage === 'contract_signed') {
        const now = await optionalRows<{ contact_stage: string }>(
          client,
          'the contact’s stage',
          `select contact_stage from public.clients where id = $1`,
          [id]
        );
        if (now[0]?.contact_stage !== 'contract_signed') {
          return {
            error: 'Contract signed records the system first — fill in the signing form.',
            needsSigning: true as const,
          };
        }
      }

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

    if ('needsSigning' in result) {
      return NextResponse.json({ error: result.error, needsSigning: true }, { status: 409 });
    }
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
    // The project holds them in Contract signed (55000, from the hold trigger).
    // That is an answer to give the person at the board, not a server fault.
    const held = e as { code?: string; message?: string };
    if (held.code === '55000') {
      const text = held.message ?? 'This contact has a project.';
      return NextResponse.json(
        { error: text.charAt(0).toUpperCase() + text.slice(1) + '.', projectHeld: true },
        { status: 409 }
      );
    }
    return dbErrorResponse(e, 'Saving the contact');
  }
}
