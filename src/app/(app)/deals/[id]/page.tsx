import Link from 'next/link';
import { notFound } from 'next/navigation';
import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { optionalRows } from '@/lib/db-optional';
import { loadDeal } from '@/lib/deals/service';
import { DEAL_STAGE_LABELS } from '@/lib/deals/definitions';
import { DealRecord, type DealFields, type RefLists } from './DealRecord';

export const dynamic = 'force-dynamic';

const list = (client: Parameters<typeof optionalRows>[0], sql: string) =>
  optionalRows<{ id: string; name: string }>(client, 'a reference list', sql);

/**
 * One deal. The fields each stage gate reads, its proposals, and its timeline —
 * which is the same audit_log the project record shows, selected by deal_id.
 */
export default async function DealPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await guardPath('/deals');

  const data = await withUser(session, async (c) => {
    const deal = await loadDeal(c, id);
    if (!deal) return null;

    // Sequential, not Promise.all: optionalRows wraps each query in a savepoint
    // on this one client, and overlapping savepoints on a single connection
    // corrupt each other.
    const fields = await optionalRows<Record<string, unknown>>(
      c,
      'the deal being edited',
      `select homeowner_confirmed, roof_type_id, roof_age, avg_monthly_bill, utility_id,
              credit_band, decision_maker_identified, system_size_kw, module_id, inverter_id,
              battery_id, net_price, financing_route, financing_company_id,
              expected_close_date::text as expected_close_date, contract_value, competitor_id,
              owner_id, dealer_id, next_action, next_action_at::text as next_action_at
         from public.deals where id = $1`,
      [id]
    );
    const proposals = await optionalRows<{
      id: string; version: number; net_price: string | null;
      sent_at: string | null; viewed_at: string | null; created_at: string;
    }>(
      c,
      'the deal’s proposals (public.proposals)',
      `select id, version, net_price, sent_at::text, viewed_at::text, created_at::text
         from public.proposals where deal_id = $1 order by version desc`,
      [id]
    );
    const timeline = await optionalRows<{
      occurred_at: string; kind: string; action: string; actor: string | null;
    }>(
      c,
      'the deal timeline (public.audit_log)',
      `select a.occurred_at::text, a.kind, a.action,
              coalesce(pr.full_name, pr.email) as actor
         from public.audit_log a
         left join public.profiles pr on pr.id = a.actor_id
        where a.deal_id = $1
           or (a.entity_type = 'deals' and a.entity_id = $1::text)
        order by a.occurred_at desc limit 100`,
      [id]
    );

    const refs: RefLists = {
      roofTypes: await list(c, `select id, name from public.roof_types where is_active order by sort_order, name`),
      utilities: await list(c, `select id, name from public.utilities order by name`),
      modules: await list(c, `select id, name from public.module_types where is_active order by name`),
      inverters: await list(c, `select id, name from public.inverter_types where is_active order by name`),
      batteries: await list(c, `select id, name from public.battery_types where is_active order by name`),
      financingCompanies: await list(c, `select id, name from public.financing_companies where is_active order by name`),
      competitors: await list(c, `select id, name from public.competitors where is_active order by sort_order, name`),
      lossReasons: await list(c, `select id, name from public.deal_loss_reasons where is_active order by sort_order, name`),
      owners: await list(
        c,
        `select id, coalesce(full_name, email) as name from public.profiles
          where role in ('admin','ops','sales') and is_active and deleted_at is null order by 2`
      ),
      dealers: await list(c, `select id, name from public.dealers where is_active order by name`),
    };

    return { deal, fields: fields[0] ?? {}, proposals, timeline, refs };
  });

  if (!data) notFound();

  const f = data.fields;
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const fields: DealFields = {
    homeowner_confirmed: f.homeowner_confirmed === true,
    roof_type_id: (f.roof_type_id as string) ?? null,
    roof_age: num(f.roof_age),
    avg_monthly_bill: num(f.avg_monthly_bill),
    utility_id: (f.utility_id as string) ?? null,
    credit_band: (f.credit_band as string) ?? null,
    decision_maker_identified: f.decision_maker_identified === true,
    system_size_kw: num(f.system_size_kw),
    module_id: (f.module_id as string) ?? null,
    inverter_id: (f.inverter_id as string) ?? null,
    battery_id: (f.battery_id as string) ?? null,
    net_price: num(f.net_price),
    financing_route: (f.financing_route as string) ?? null,
    financing_company_id: (f.financing_company_id as string) ?? null,
    expected_close_date: (f.expected_close_date as string) ?? null,
    contract_value: num(f.contract_value),
    competitor_id: (f.competitor_id as string) ?? null,
    owner_id: (f.owner_id as string) ?? null,
    dealer_id: (f.dealer_id as string) ?? null,
    next_action: (f.next_action as string) ?? null,
    next_action_at: (f.next_action_at as string) ?? null,
  };

  return (
    <main className="surface wide">
      <div className="board-header">
        <div>
          <h1>
            {data.deal.personName} · {DEAL_STAGE_LABELS[data.deal.column]}
          </h1>
          <p className="dim">
            {data.deal.address ?? data.deal.code}
            {data.deal.dealerName ? ` · ${data.deal.dealerName}` : ''}
          </p>
        </div>
        <div className="board-actions">
          {data.deal.clientId && (
            <Link className="btn-link" href={`/admin/people`}>
              The person
            </Link>
          )}
          <Link className="btn-link" href="/deals">
            All deals
          </Link>
        </div>
      </div>

      <DealRecord
        deal={data.deal}
        fields={fields}
        refs={data.refs}
        proposals={data.proposals.map((p) => ({
          id: p.id,
          version: Number(p.version),
          netPrice: p.net_price === null ? null : Number(p.net_price),
          sentAt: p.sent_at,
          viewedAt: p.viewed_at,
          createdAt: p.created_at,
        }))}
        timeline={data.timeline.map((t) => ({
          at: t.occurred_at,
          kind: t.kind,
          action: t.action,
          actor: t.actor,
        }))}
        isAdmin={session.role === 'admin'}
      />
    </main>
  );
}
