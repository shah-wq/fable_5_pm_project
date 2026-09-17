import type { PoolClient } from 'pg';
import { withUser } from '../db';
import type { Session } from '../auth/session';
import { CRM_FIRST_FILE } from '@/lib/crm/catch-up';
import { optionalRows } from '../db-optional';
import {
  DEAL_COLUMNS,
  PROJECT_START_STAGE,
  STAGE_PROBABILITY,
  isDealColumn,
  type DealColumn,
} from './definitions';
import {
  gapsForConversion,
  gapsForMove,
  missingForNextStep,
  type DealRow,
} from './requirements';

/**
 * Module 17 · the deal data layer and the one move path.
 *
 * Written against lib/stages/service.ts rather than beside it: same card shape,
 * same "button and drag both call one function" rule, same audit on every move.
 * Part 3 is explicit that this is the point — "A separate CRM would ship a
 * second pipeline engine that behaves subtly differently on the same gesture."
 */

export { CRM_FIRST_FILE as CRM_MIGRATION_FILE } from '@/lib/crm/catch-up';

const asIso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value ?? '');

const asDate = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

export interface DealCard {
  id: string;
  code: string | null;
  column: DealColumn;
  personName: string;
  clientId: string | null;
  address: string | null;
  value: number | null;
  probability: number;
  probabilityIsOverride: boolean;
  daysInStage: number;
  nextAction: string | null;
  nextActionAt: string | null;
  /** True when the next action is today or already past (Part 5). */
  nextActionDue: boolean;
  ownerName: string | null;
  ownerId: string | null;
  dealerName: string | null;
  lostReason: string | null;
  projectId: string | null;
  missing: string[];
  updatedAt: string;
}

/** Everything the requirements engine needs, for many deals at once. */
const CARD_SQL = `
  select d.id, d.code, d.stage, d.client_id, d.customer_first, d.customer_last,
         d.customer_email, d.customer_phone, d.property_address_id, d.address,
         d.source_id, d.next_action, d.next_action_at, d.homeowner_confirmed,
         d.roof_type_id, d.avg_monthly_bill, d.utility_id, d.credit_band,
         d.decision_maker_identified, d.system_size_kw, d.module_id, d.net_price,
         d.financing_route, d.expected_close_date, d.contract_value, d.dealer_id,
         d.probability, d.probability_is_override, d.project_id, d.owner_id,
         coalesce(d.contract_value, d.net_price) as card_value,
         greatest(0, extract(day from now() - d.stage_entered_at)::int) as days_in_stage,
         coalesce(c.first_name || ' ' || c.last_name,
                  nullif(btrim(coalesce(d.customer_first, '') || ' ' || coalesce(d.customer_last, '')), ''),
                  'Unnamed') as person_name,
         coalesce(a.lines, d.address) as card_address,
         coalesce(pr.full_name, pr.email) as owner_name,
         dl.name as dealer_name,
         lr.name as lost_reason,
         (d.last_contact_at is not null) as contact_logged,
         exists (select 1 from public.proposals p
                  where p.deal_id = d.id and p.sent_at is not null) as proposal_sent,
         exists (select 1 from public.documents doc
                  where doc.deal_id = d.id
                    and doc.category in ('signed_co', 'signature_docs')) as contract_on_file,
         d.updated_at
    from public.deals d
    left join public.clients c on c.id = d.client_id
    left join public.client_addresses a on a.id = d.property_address_id
    left join public.profiles pr on pr.id = d.owner_id
    left join public.dealers dl on dl.id = d.dealer_id
    left join public.deal_loss_reasons lr on lr.id = d.lost_reason_id
`;

function toCard(r: Record<string, unknown>): DealCard {
  const row: DealRow = {
    id: String(r.id),
    stage: String(r.stage),
    client_id: (r.client_id as string) ?? null,
    customer_first: (r.customer_first as string) ?? null,
    customer_last: (r.customer_last as string) ?? null,
    customer_email: (r.customer_email as string) ?? null,
    customer_phone: (r.customer_phone as string) ?? null,
    property_address_id: (r.property_address_id as string) ?? null,
    address: (r.address as string) ?? null,
    source_id: (r.source_id as string) ?? null,
    contact_logged: r.contact_logged === true,
    next_action: (r.next_action as string) ?? null,
    next_action_at: asDate(r.next_action_at),
    homeowner_confirmed: r.homeowner_confirmed === true,
    roof_type_id: (r.roof_type_id as string) ?? null,
    avg_monthly_bill: r.avg_monthly_bill === null ? null : Number(r.avg_monthly_bill),
    utility_id: (r.utility_id as string) ?? null,
    credit_band: (r.credit_band as string) ?? null,
    decision_maker_identified: r.decision_maker_identified === true,
    system_size_kw: r.system_size_kw === null ? null : Number(r.system_size_kw),
    module_id: (r.module_id as string) ?? null,
    net_price: r.net_price === null ? null : Number(r.net_price),
    financing_route: (r.financing_route as string) ?? null,
    proposal_sent: r.proposal_sent === true,
    expected_close_date: asDate(r.expected_close_date),
    contract_value: r.contract_value === null ? null : Number(r.contract_value),
    contract_on_file: r.contract_on_file === true,
  };
  const column: DealColumn = isDealColumn(row.stage) ? row.stage : 'new';
  const today = new Date().toISOString().slice(0, 10);
  return {
    id: row.id,
    code: (r.code as string) ?? null,
    column,
    personName: String(r.person_name ?? 'Unnamed'),
    clientId: row.client_id,
    address: (r.card_address as string) ?? null,
    value: r.card_value === null || r.card_value === undefined ? null : Number(r.card_value),
    probability:
      r.probability === null || r.probability === undefined
        ? STAGE_PROBABILITY[column]
        : Number(r.probability),
    probabilityIsOverride: r.probability_is_override === true,
    daysInStage: Number(r.days_in_stage ?? 0),
    nextAction: row.next_action,
    nextActionAt: row.next_action_at,
    nextActionDue: row.next_action_at !== null && row.next_action_at <= today,
    ownerName: (r.owner_name as string) ?? null,
    ownerId: (r.owner_id as string) ?? null,
    dealerName: (r.dealer_name as string) ?? null,
    lostReason: (r.lost_reason as string) ?? null,
    projectId: (r.project_id as string) ?? null,
    missing: missingForNextStep(row),
    updatedAt: asIso(r.updated_at),
  };
}

/** True once 003400 is applied; the page explains itself rather than 500ing. */
export async function dealsReady(client: PoolClient): Promise<boolean> {
  const rows = await optionalRows<{ ok: boolean }>(
    client,
    'the deals table (public.deals)',
    `select true as ok where to_regclass('public.deals') is not null`
  );
  return rows.length > 0;
}

export async function loadDealCards(client: PoolClient): Promise<DealCard[]> {
  const rows = await optionalRows(
    client,
    'the deal board (public.deals)',
    `${CARD_SQL} order by d.stage_entered_at desc limit 500`
  );
  return rows.map((r) => toCard(r as Record<string, unknown>));
}

export async function loadDeal(client: PoolClient, id: string): Promise<DealCard | null> {
  const rows = await optionalRows(
    client,
    'a deal (public.deals)',
    `${CARD_SQL} where d.id = $1`,
    [id]
  );
  return rows[0] ? toCard(rows[0] as Record<string, unknown>) : null;
}

export type DealMove = 'forward' | 'back' | 'won' | 'lost' | 'reopen' | 'to';

export type DealMoveResult =
  | { ok: true; stage: DealColumn; projectId?: string | null }
  | { ok: false; code: 'not_found' | 'forbidden' | 'invalid'; message: string; missing?: string[] };

export interface DealMoveOptions {
  via?: 'button' | 'drag';
  /** For 'to': the column dropped on. */
  target?: string;
  /** Lost needs a reason from the list; notes are optional. */
  lostReasonId?: string | null;
  notes?: string | null;
}

/**
 * THE deal move. Button, drag and API all land here.
 *
 * Forward-only for everyone except an admin moving backwards with a typed
 * reason, everything logged with actor and timestamp — the project board's
 * rules, applied to the second board rather than reimplemented for it.
 */
export async function moveDeal(
  session: Session,
  dealId: string,
  move: DealMove,
  options: DealMoveOptions = {}
): Promise<DealMoveResult> {
  const isStaff = ['admin', 'ops', 'sales'].includes(session.role);
  if (!isStaff || !session.isActive) {
    return { ok: false, code: 'forbidden', message: 'Only the sales team moves deals.' };
  }

  return withUser(session, async (client) => {
    const deal = await loadDeal(client, dealId);
    if (!deal) return { ok: false, code: 'not_found', message: 'That deal no longer exists.' };

    const rows = await optionalRows(
      client,
      'the deal being moved',
      `${CARD_SQL} where d.id = $1`,
      [dealId]
    );
    const raw = rows[0] as Record<string, unknown> | undefined;
    if (!raw) return { ok: false, code: 'not_found', message: 'That deal no longer exists.' };

    const current = deal.column;
    const index = DEAL_COLUMNS.indexOf(current);

    let target: DealColumn;
    switch (move) {
      case 'won':
        target = 'won';
        break;
      case 'lost':
        target = 'lost';
        break;
      case 'reopen':
        // "Lost: terminal, reversible." Won is not — Part 9: "A deal cannot be
        // un-won; a project that falls over afterwards is cancelled as a
        // project with its own reason."
        if (current !== 'lost') {
          return { ok: false, code: 'invalid', message: 'Only a lost deal can be reopened.' };
        }
        target = 'new';
        break;
      case 'back': {
        if (session.role !== 'admin') {
          return {
            ok: false,
            code: 'forbidden',
            message: 'Moving a deal backwards is an admin action, and it needs a reason.',
          };
        }
        if (!options.notes?.trim()) {
          return { ok: false, code: 'invalid', message: 'A backwards move needs a typed reason.' };
        }
        target = DEAL_COLUMNS[Math.max(0, index - 1)];
        break;
      }
      case 'to': {
        const wanted = String(options.target ?? '');
        if (!isDealColumn(wanted)) {
          return { ok: false, code: 'invalid', message: 'That is not a column on this board.' };
        }
        target = wanted;
        break;
      }
      default:
        target = index >= DEAL_COLUMNS.indexOf('contract_out') ? 'won' : DEAL_COLUMNS[index + 1];
    }

    if (target === current) return { ok: true, stage: current };

    // Backwards through a drag is the same decision as the button, so it is the
    // same check rather than a second one that drifts.
    const goingBack =
      DEAL_COLUMNS.indexOf(target) < index && target !== 'lost' && move !== 'reopen';
    if (goingBack && session.role !== 'admin') {
      return {
        ok: false,
        code: 'forbidden',
        message: 'This board is forward-only. An admin can move a deal back with a reason.',
      };
    }

    // Lost needs its reason; everything else needs its stage requirements.
    if (target === 'lost') {
      if (!options.lostReasonId) {
        return { ok: false, code: 'invalid', message: 'Pick why this deal was lost.' };
      }
    } else if (!goingBack && move !== 'reopen') {
      const row = toDealRow(raw);
      const missing = gapsForMove(row, target);
      if (missing.length > 0) {
        return {
          ok: false,
          code: 'invalid',
          message: 'Required items are missing for this move.',
          missing,
        };
      }
      if (target === 'won') {
        const convertGaps = gapsForConversion(row);
        if (convertGaps.length > 0) {
          return {
            ok: false,
            code: 'invalid',
            message: 'A won deal becomes a project, and the project needs these.',
            missing: convertGaps,
          };
        }
      }
    }

    let projectId: string | null = null;

    if (target === 'won') {
      // Part 9: "Transactional. If the project insert fails the deal does not
      // move and the user is told why. A half-converted deal is the worst
      // available state and is prevented at the database rather than repaired
      // by a support script." withUser() already wraps this in one transaction,
      // so a throw here rolls the stage change back with it.
      const created = await optionalRows<{ project_id: string }>(
        client,
        'converting a won deal (public.convert_deal_to_project)',
        `select public.convert_deal_to_project($1, $2) as project_id`,
        [dealId, PROJECT_START_STAGE]
      );
      projectId = created[0]?.project_id ?? null;
      if (!projectId) {
        return {
          ok: false,
          code: 'invalid',
          message:
            'The project could not be created, so the deal has not moved. ' +
            `If this database has not caught up yet, run ${CRM_FIRST_FILE} and the files after it.`,
        };
      }
    }

    await client.query(
      `update public.deals
          set stage = $2,
              lost_reason_id = case when $2 = 'lost' then $3::uuid else lost_reason_id end,
              lost_notes = case when $2 = 'lost' then $4 else lost_notes end,
              probability = case when probability_is_override then probability else $5 end,
              project_id = coalesce($6::uuid, project_id)
        where id = $1`,
      [
        dealId,
        target,
        options.lostReasonId ?? null,
        options.notes ?? null,
        STAGE_PROBABILITY[target],
        projectId,
      ]
    );

    // Logged on *this* connection, not through logAuditEvent().
    //
    // logAuditEvent() opens its own pooled connection, and this function is in
    // the middle of a transaction that has already written to deals and, on a
    // conversion, to clients. The audit insert fires the audit_touch_client
    // trigger, which updates clients — so the second connection waits for a row
    // lock this transaction holds, while this transaction waits for the second
    // connection to answer. Postgres cannot break that: the holder is idle in
    // transaction rather than blocked, so there is no deadlock cycle to detect
    // and the request hangs for ever. Every won deal would have done it.
    //
    // The same transaction is the right answer on its own terms as well: a move
    // that rolls back should take its log entry with it.
    await optionalRows(
      client,
      'logging the deal move (public.log_audit_event)',
      `select public.log_audit_event($1, 'deals', $2, $3::uuid, $4::jsonb, 'stage_move', $5::uuid, $6::uuid)`,
      [
        `deal.${target}`,
        dealId,
        projectId,
        JSON.stringify({
          from: current,
          to: target,
          via: options.via ?? 'button',
          reason: options.notes ?? null,
          projectId,
        }),
        dealId,
        deal.clientId,
      ]
    );

    return { ok: true, stage: target, projectId };
  });
}

function toDealRow(r: Record<string, unknown>): DealRow {
  return {
    id: String(r.id),
    stage: String(r.stage),
    client_id: (r.client_id as string) ?? null,
    customer_first: (r.customer_first as string) ?? null,
    customer_last: (r.customer_last as string) ?? null,
    customer_email: (r.customer_email as string) ?? null,
    customer_phone: (r.customer_phone as string) ?? null,
    property_address_id: (r.property_address_id as string) ?? null,
    address: (r.address as string) ?? null,
    source_id: (r.source_id as string) ?? null,
    contact_logged: r.contact_logged === true,
    next_action: (r.next_action as string) ?? null,
    next_action_at: asDate(r.next_action_at),
    homeowner_confirmed: r.homeowner_confirmed === true,
    roof_type_id: (r.roof_type_id as string) ?? null,
    avg_monthly_bill: r.avg_monthly_bill === null ? null : Number(r.avg_monthly_bill),
    utility_id: (r.utility_id as string) ?? null,
    credit_band: (r.credit_band as string) ?? null,
    decision_maker_identified: r.decision_maker_identified === true,
    system_size_kw: r.system_size_kw === null ? null : Number(r.system_size_kw),
    module_id: (r.module_id as string) ?? null,
    net_price: r.net_price === null ? null : Number(r.net_price),
    financing_route: (r.financing_route as string) ?? null,
    proposal_sent: r.proposal_sent === true,
    expected_close_date: asDate(r.expected_close_date),
    contract_value: r.contract_value === null ? null : Number(r.contract_value),
    contract_on_file: r.contract_on_file === true,
  };
}
