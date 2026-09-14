import type { PoolClient } from 'pg';
import { optionalRows } from '../db-optional';

/**
 * Module 16 · People — the CRM half of the person record.
 *
 * Deliberately an extension of lib/customers/service.ts rather than a second
 * loader: Part 4 says the Customers screen *becomes* People, keeping its four
 * tabs, its merge tool and its portal controls. So the list query there stays
 * exactly as it was, and everything this file adds arrives beside it, keyed by
 * client id.
 *
 * Every query here is optional (savepoint-wrapped, degrading to nothing) for
 * one reason: migrations are applied by hand in a SQL editor, and a People
 * screen that 500s because 003400 has not been pasted yet is a worse failure
 * than a screen that is briefly missing its lifecycle chips.
 */

export const CRM_MIGRATION_FILE = 'db/dist/20260803003400-crm-foundation.sql';

export type Lifecycle = 'prospect' | 'customer' | 'past_customer';

export const LIFECYCLE_LABELS: Record<Lifecycle, string> = {
  prospect: 'Prospect',
  customer: 'Customer',
  past_customer: 'Past customer',
};

export interface PersonCrmRow {
  id: string;
  lifecycle: Lifecycle;
  dealCount: number;
  openDealCount: number;
  subscriptionCount: number;
  sourceName: string | null;
  ownerName: string | null;
  doNotEmail: boolean;
  doNotCall: boolean;
  doNotSms: boolean;
  lastContactedAt: string | null;
}

const asDate = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const asLifecycle = (v: unknown): Lifecycle =>
  v === 'customer' || v === 'past_customer' ? v : 'prospect';

/** True once 003400 is applied — the screen uses this to explain itself. */
export async function crmReady(client: PoolClient): Promise<boolean> {
  const rows = await optionalRows(
    client,
    'the CRM foundation (public.people_overview)',
    `select 1 as ok from public.people_overview limit 1`
  );
  // An empty table is still a ready database, so ask the catalogue, not the row.
  const probe = await optionalRows<{ ok: boolean }>(
    client,
    'the CRM foundation (public.people_overview)',
    `select true as ok where to_regclass('public.people_overview') is not null`
  );
  return probe.length > 0 || rows.length > 0;
}

/** The CRM columns for the list, in one query beside the existing loader. */
export async function loadPersonCrm(client: PoolClient): Promise<Map<string, PersonCrmRow>> {
  const rows = await optionalRows<{
    id: string;
    lifecycle: string;
    deal_count: string;
    open_deal_count: string;
    subscription_count: string;
    source_name: string | null;
    owner_name: string | null;
    do_not_email: boolean;
    do_not_call: boolean;
    do_not_sms: boolean;
    last_contacted_at: unknown;
  }>(
    client,
    'the people roll-ups (public.people_overview)',
    `select o.id, o.lifecycle, o.deal_count, o.open_deal_count, o.subscription_count,
            s.name as source_name, coalesce(pr.full_name, pr.email) as owner_name,
            o.do_not_email, o.do_not_call, o.do_not_sms, o.last_contacted_at
       from public.people_overview o
       left join public.client_sources s on s.id = o.source_id
       left join public.profiles pr on pr.id = o.owner_id`
  );
  const map = new Map<string, PersonCrmRow>();
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      lifecycle: asLifecycle(r.lifecycle),
      dealCount: Number(r.deal_count),
      openDealCount: Number(r.open_deal_count),
      subscriptionCount: Number(r.subscription_count),
      sourceName: r.source_name,
      ownerName: r.owner_name,
      doNotEmail: r.do_not_email === true,
      doNotCall: r.do_not_call === true,
      doNotSms: r.do_not_sms === true,
      lastContactedAt: asDate(r.last_contacted_at),
    });
  }
  return map;
}

export interface ChannelRow {
  id: string;
  kind: 'email' | 'phone';
  value: string;
  type: string | null;
  isPrimary: boolean;
  verifiedAt: string | null;
  bounceState: string | null;
}

export interface AddressRow {
  id: string;
  kind: 'mailing' | 'property';
  lines: string;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  isPrimary: boolean;
}

/**
 * The channels and addresses on one person (Part 4).
 *
 * "Several emails and phones with a type and a primary flag" — and the reason
 * the property addresses are a list rather than a field: "a person with two
 * houses gets two deals rather than two records".
 */
export async function loadChannels(
  client: PoolClient,
  clientId: string
): Promise<ChannelRow[]> {
  const rows = await optionalRows<{
    id: string; kind: string; value: string; type: string | null;
    is_primary: boolean; verified_at: unknown; bounce_state: string | null;
  }>(
    client,
    'a person’s channels (public.client_channels)',
    `select id, kind, value, type, is_primary, verified_at, bounce_state
       from public.client_channels where client_id = $1
      order by kind, is_primary desc, created_at`,
    [clientId]
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind === 'phone' ? 'phone' : 'email',
    value: r.value,
    type: r.type,
    isPrimary: r.is_primary === true,
    verifiedAt: asDate(r.verified_at),
    bounceState: r.bounce_state,
  }));
}

export async function loadAddresses(
  client: PoolClient,
  clientId: string
): Promise<AddressRow[]> {
  const rows = await optionalRows<{
    id: string; kind: string; lines: string; city: string | null;
    state: string | null; postal_code: string | null; is_primary: boolean;
  }>(
    client,
    'a person’s addresses (public.client_addresses)',
    `select id, kind, lines, city, state, postal_code, is_primary
       from public.client_addresses where client_id = $1
      order by kind, is_primary desc, created_at`,
    [clientId]
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind === 'mailing' ? 'mailing' : 'property',
    lines: r.lines,
    city: r.city,
    state: r.state,
    postalCode: r.postal_code,
    isPrimary: r.is_primary === true,
  }));
}

export interface PersonDealRow {
  id: string;
  code: string | null;
  stage: string;
  role: string | null;
  value: number | null;
  ownerName: string | null;
  lostReason: string | null;
  projectId: string | null;
  updatedAt: string | null;
}

/**
 * The Deals tab (Part 4): "every deal this person appears on with their role,
 * including lost ones".
 *
 * Through deal_contacts as well as deals.client_id, because a co-owner is on
 * the deal without being its primary person — and a spouse who only appears as
 * a decision maker is exactly the person somebody goes looking for.
 */
export async function loadPersonDeals(
  client: PoolClient,
  clientId: string
): Promise<PersonDealRow[]> {
  const rows = await optionalRows<{
    id: string; code: string | null; stage: string; role: string | null;
    contract_value: string | null; owner_name: string | null;
    lost_reason: string | null; project_id: string | null; updated_at: unknown;
  }>(
    client,
    'a person’s deals (public.deals)',
    `select d.id, d.code, d.stage,
            (select dc.role from public.deal_contacts dc
              where dc.deal_id = d.id and dc.client_id = $1 limit 1) as role,
            coalesce(d.contract_value, d.net_price) as contract_value,
            coalesce(pr.full_name, pr.email) as owner_name,
            lr.name as lost_reason, d.project_id, d.updated_at
       from public.deals d
       left join public.profiles pr on pr.id = d.owner_id
       left join public.deal_loss_reasons lr on lr.id = d.lost_reason_id
      where d.client_id = $1
         or exists (select 1 from public.deal_contacts dc
                     where dc.deal_id = d.id and dc.client_id = $1)
      order by d.updated_at desc nulls last
      limit 100`,
    [clientId]
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    stage: r.stage,
    role: r.role,
    value: r.contract_value === null ? null : Number(r.contract_value),
    ownerName: r.owner_name,
    lostReason: r.lost_reason,
    projectId: r.project_id,
    updatedAt: asDate(r.updated_at),
  }));
}

export interface PersonSubscriptionRow {
  id: string;
  listName: string;
  status: string;
  consentBasis: string;
  consentAt: string | null;
  consentSource: string | null;
  confirmedAt: string | null;
  unsubscribedAt: string | null;
}

/** The Subscriptions tab: list membership and the consent that permits it. */
export async function loadPersonSubscriptions(
  client: PoolClient,
  clientId: string
): Promise<PersonSubscriptionRow[]> {
  const rows = await optionalRows<{
    id: string; list_name: string; status: string; consent_basis: string;
    consent_at: unknown; consent_source: string | null;
    double_optin_confirmed_at: unknown; unsubscribed_at: unknown;
  }>(
    client,
    'a person’s subscriptions (public.subscriptions)',
    `select s.id, l.name as list_name, s.status, s.consent_basis, s.consent_at,
            s.consent_source, s.double_optin_confirmed_at, s.unsubscribed_at
       from public.subscriptions s
       join public.lists l on l.id = s.list_id
      where s.client_id = $1
      order by s.consent_at desc`,
    [clientId]
  );
  return rows.map((r) => ({
    id: r.id,
    listName: r.list_name,
    status: r.status,
    consentBasis: r.consent_basis,
    consentAt: asDate(r.consent_at),
    consentSource: r.consent_source,
    confirmedAt: asDate(r.double_optin_confirmed_at),
    unsubscribedAt: asDate(r.unsubscribed_at),
  }));
}

export interface TimelineEntry {
  at: string;
  kind: string;
  action: string;
  actor: string | null;
  dealCode: string | null;
}

/**
 * The unified timeline (Part 3): "One log renders the project audit trail, the
 * customer Activity tab and the deal timeline."
 *
 * Which is why this reads audit_log rather than anything new — the same rows
 * the project side already writes, now also selected by client_id and deal_id.
 */
export async function loadTimeline(
  client: PoolClient,
  clientId: string,
  userId: string | null
): Promise<TimelineEntry[]> {
  return (
    await optionalRows<{
      occurred_at: unknown; kind: string; action: string;
      actor: string | null; deal_code: string | null;
    }>(
      client,
      'the unified timeline (public.audit_log)',
      `select a.occurred_at, a.kind, a.action,
              coalesce(pr.full_name, pr.email) as actor, d.code as deal_code
         from public.audit_log a
         left join public.profiles pr on pr.id = a.actor_id
         left join public.deals d on d.id = a.deal_id
        where a.client_id = $1::uuid
           or (a.entity_type = 'clients' and a.entity_id = $1::uuid::text)
           or a.deal_id in (select id from public.deals where client_id = $1::uuid)
           or (a.project_id in (select id from public.projects where client_id = $1::uuid)
               and a.action like 'customer%')
           or ($2::text is not null and a.entity_id = $2::text)
        order by a.occurred_at desc
        limit 150`,
      [clientId, userId]
    )
  ).map((r) => ({
    at: asDate(r.occurred_at)!,
    kind: r.kind ?? 'field_change',
    action: r.action,
    actor: r.actor,
    dealCode: r.deal_code,
  }));
}

export interface DuplicateMatch {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  lifecycle: Lifecycle;
  projects: number;
}

/**
 * Duplicate prevention on every creation path (Part 4).
 *
 * "It now runs on every creation path including web forms, e-book downloads and
 * imports, offering to attach to the existing person rather than inserting."
 *
 * Matches on the normalised channel values rather than the legacy columns, so a
 * second email on an existing person still counts as that person — which is the
 * case the old check missed.
 */
export async function findPeopleByContact(
  client: PoolClient,
  email: string | null,
  phone: string | null
): Promise<DuplicateMatch[]> {
  if (!email && !phone) return [];
  const rows = await optionalRows<{
    id: string; name: string; email: string | null; phone: string | null;
    lifecycle: string; projects: string;
  }>(
    client,
    'duplicate detection across channels (public.client_channels)',
    `select distinct c.id,
            c.first_name || ' ' || c.last_name as name,
            c.email, c.phone,
            public.client_lifecycle(c.id) as lifecycle,
            (select count(*) from public.projects p where p.client_id = c.id) as projects
       from public.clients c
       left join public.client_channels ch on ch.client_id = c.id
      where not c.is_archived
        and (
          ($1::text is not null and (
             lower(btrim(c.email)) = lower(btrim($1))
             or (ch.kind = 'email' and ch.value_normalised = app.normalise_channel('email', $1))))
          or ($2::text is not null and (
             c.phone = $2
             or (ch.kind = 'phone' and ch.value_normalised = app.normalise_channel('phone', $2))))
        )
      limit 5`,
    [email, phone]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    lifecycle: asLifecycle(r.lifecycle),
    projects: Number(r.projects),
  }));
}

/**
 * What blocks a delete (Part 4): "delete only with zero projects, deals and
 * subscriptions; once a project exists, anonymise."
 *
 * Returns the counts so the screen can say which of the three it is rather than
 * refusing without a reason.
 */
export async function deletionBlockers(
  client: PoolClient,
  clientId: string
): Promise<{ projects: number; deals: number; subscriptions: number }> {
  const rows = await optionalRows<{ projects: string; deals: string; subscriptions: string }>(
    client,
    'what blocks deleting a person',
    `select (select count(*) from public.projects where client_id = $1) as projects,
            (select count(*) from public.deals where client_id = $1) as deals,
            (select count(*) from public.subscriptions where client_id = $1) as subscriptions`,
    [clientId]
  );
  return {
    projects: Number(rows[0]?.projects ?? 0),
    deals: Number(rows[0]?.deals ?? 0),
    subscriptions: Number(rows[0]?.subscriptions ?? 0),
  };
}
