import type { PoolClient } from 'pg';
import { optionalRows } from '@/lib/db-optional';
import { isContactStage, type ContactStageCard } from '@/lib/contacts/stage-columns';

/**
 * Contact stages: the contact list, as a board.
 *
 * One row per person, read straight from clients — the stage is theirs, not a
 * reading of some deal behind them. That is what makes the board simple: every
 * contact has exactly one card from the moment they are created, so there is no
 * question of which of somebody's two deals a card is talking about, and nobody
 * sits outside the board waiting for an opportunity to be invented for them.
 *
 * The deal is still on the card, when there is one, so a rep can jump to the
 * money from the person. It just no longer decides where they stand.
 */

export * from '@/lib/contacts/stage-columns';

interface StageRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  city_state: string | null;
  dealer_name: string | null;
  owner_name: string | null;
  contact_stage: string;
  days_in_stage: string | number;
  last_contacted_at: string | null;
  deal_id: string | null;
}

export async function loadContactStageBoard(client: PoolClient): Promise<ContactStageCard[]> {
  const rows = await optionalRows<StageRow>(
    client,
    'the contact board (public.clients.contact_stage)',
    `select c.id, c.first_name, c.last_name, c.email, c.phone,
            -- clients has no city column: the mailing parts added with the
            -- intake fields are the only structured place a town is written.
            nullif(concat_ws(', ', nullif(btrim(coalesce(c.mailing_city, '')), ''),
                                   nullif(btrim(coalesce(c.mailing_state, '')), '')), '')
              as city_state,
            dl.name as dealer_name,
            coalesce(p.full_name, p.email) as owner_name,
            c.contact_stage,
            floor(extract(epoch from (now() - c.contact_stage_at)) / 86400) as days_in_stage,
            c.last_contacted_at::text,
            (select d.id from public.deals d
              where d.client_id = c.id
              order by (d.stage not in ('won', 'lost')) desc, d.updated_at desc
              limit 1) as deal_id
       from public.clients c
       left join public.dealers dl on dl.id = c.dealer_id
       left join public.profiles p on p.id = c.owner_id
      where not coalesce(c.is_archived, false)
      order by c.contact_stage_at desc
      limit 1000`
  );

  // Who is held in Contract signed by a project, asked separately so that a
  // database without the signing columns still gets its board — just with
  // nobody held. The same rule as public.contact_project(): the project made
  // by their newest signing, while it exists.
  const holds = await optionalRows<{ client_id: string; id: string; code: string }>(
    client,
    'the projects holding contacts in place',
    `select distinct on (d.client_id) d.client_id, p.id, p.code
       from public.deals d
       join public.projects p on p.id = d.project_id
      where d.system_recorded_at is not null
      order by d.client_id, d.system_recorded_at desc`
  );
  const held = new Map(holds.map((h) => [h.client_id, { id: h.id, code: h.code }]));

  return rows.map((r) => ({
    clientId: r.id,
    stage: isContactStage(r.contact_stage) ? r.contact_stage : 'created',
    personName: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Unnamed contact',
    email: r.email,
    phone: r.phone,
    subtitle: r.city_state ?? r.dealer_name,
    ownerName: r.owner_name,
    dealerName: r.dealer_name,
    daysInStage: Number(r.days_in_stage ?? 0),
    lastContact: r.last_contacted_at ? r.last_contacted_at.slice(0, 10) : null,
    dealId: r.deal_id,
    projectId: held.get(r.id)?.id ?? null,
    projectCode: held.get(r.id)?.code ?? null,
  }));
}

/** Whether this database knows about contact stages yet. */
export async function contactStagesReady(client: PoolClient): Promise<boolean> {
  const rows = await optionalRows<{ ok: boolean }>(
    client,
    'the contact stage column (public.clients.contact_stage)',
    `select true as ok
       from information_schema.columns
      where table_schema = 'public' and table_name = 'clients'
        and column_name = 'contact_stage'`
  );
  return rows.length > 0;
}
