import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { optionalRows } from '@/lib/db-optional';
import { AdminTabs } from '../_components/AdminTabs';

export const dynamic = 'force-dynamic';

/**
 * Module 19 · Subscribers (Part 7).
 *
 * "Subscribers list with the consent basis column always visible" — always,
 * because the consent basis is the record produced if somebody complains, and a
 * column you have to go looking for is a column nobody checks.
 *
 * This is the reading half of module 19. The sender, the double-opt-in
 * confirmation and the preference page come with the rest of it; what is here
 * already tells you what you are holding and whether you may write to it.
 */
export default async function SubscribersPage({
  searchParams,
}: {
  searchParams: Promise<{ list?: string; status?: string }>;
}) {
  const session = await guardPath('/admin/subscribers');
  const sp = await searchParams;

  const data = await withUser(session, async (c) => {
    const lists = await optionalRows<{
      id: string; name: string; double_optin: boolean; sunset_months: number;
      subscribed: string; pending: string; unsubscribed: string; suppressed: string;
    }>(
      c,
      'the marketing lists (public.lists)',
      `select l.id, l.name, l.double_optin, l.sunset_months,
              count(*) filter (where s.status = 'subscribed') as subscribed,
              count(*) filter (where s.status = 'pending') as pending,
              count(*) filter (where s.status = 'unsubscribed') as unsubscribed,
              count(*) filter (where s.status in ('bounced','complained','suppressed')) as suppressed
         from public.lists l
         left join public.subscriptions s on s.list_id = l.id
        group by l.id, l.name, l.double_optin, l.sunset_months
        order by l.name`
    );

    const where: string[] = [];
    const params: unknown[] = [];
    if (sp.list) {
      params.push(sp.list);
      where.push(`s.list_id = $${params.length}`);
    }
    if (sp.status) {
      params.push(sp.status);
      where.push(`s.status = $${params.length}`);
    }

    const subscribers = await optionalRows<{
      id: string; client_id: string; person: string; email: string | null;
      list_name: string; status: string; consent_basis: string; consent_at: string | null;
      consent_source: string | null; confirmed_at: string | null; sends: number;
      opens: number; last_engaged_at: string | null; magnet: string | null;
    }>(
      c,
      'the subscribers (public.subscriptions)',
      `select s.id, s.client_id,
              c.first_name || ' ' || c.last_name as person,
              c.email, l.name as list_name, s.status, s.consent_basis,
              s.consent_at::text, s.consent_source,
              s.double_optin_confirmed_at::text as confirmed_at,
              s.sends, s.opens, s.last_engaged_at::text, m.name as magnet
         from public.subscriptions s
         join public.clients c on c.id = s.client_id
         join public.lists l on l.id = s.list_id
         left join public.lead_magnets m on m.id = s.lead_magnet_id
        ${where.length ? `where ${where.join(' and ')}` : ''}
        order by s.consent_at desc nulls last
        limit 500`,
      params
    );

    const magnets = await optionalRows<{
      id: string; name: string; version: string | null; download_count: number; list_name: string | null;
    }>(
      c,
      'the lead magnets (public.lead_magnets)',
      `select m.id, m.name, m.version, m.download_count, l.name as list_name
         from public.lead_magnets m
         left join public.lists l on l.id = m.list_id
        order by m.name`
    );

    const suppressed = await optionalRows<{ n: string }>(
      c,
      'the suppression list (public.suppression)',
      `select count(*) as n from public.suppression`
    );

    return { lists, subscribers, magnets, suppressed: Number(suppressed[0]?.n ?? 0) };
  });

  return (
    <main className="table-page">
      <h1>Admin</h1>
      <AdminTabs />
      <h2 className="section-title">E-book subscribers</h2>
      <p className="dim">
        A subscription is a person’s relationship to one list, with the consent that permits it
        recorded as data rather than implied by the row existing. Unsubscribing is global by
        default, and project messages are never affected by it.
      </p>

      <section className="panel">
        <h3>Lists</h3>
        {data.lists.length === 0 ? (
          <p className="chart-empty">
            No lists yet. A list is what somebody subscribes to — create one before the first
            e-book goes out, because the consent record points at it.
          </p>
        ) : (
          <table className="projects-table">
            <thead>
              <tr>
                <th>List</th>
                <th>Subscribed</th>
                <th>Pending</th>
                <th>Unsubscribed</th>
                <th>Suppressed</th>
                <th>Double opt-in</th>
                <th>Sunset</th>
              </tr>
            </thead>
            <tbody>
              {data.lists.map((l) => (
                <tr key={l.id}>
                  <td>{l.name}</td>
                  <td>{l.subscribed}</td>
                  {/* Pending is not a failure: the download was delivered and
                      the subscription waits for the confirmation click. */}
                  <td>{l.pending}</td>
                  <td>{l.unsubscribed}</td>
                  <td>{l.suppressed}</td>
                  <td>{l.double_optin ? 'on' : 'off'}</td>
                  <td>{`${l.sunset_months} months`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h3>Subscribers</h3>
        {data.subscribers.length === 0 ? (
          <p className="chart-empty">Nobody has subscribed yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="projects-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Email</th>
                  <th>List</th>
                  <th>Status</th>
                  {/* Always visible, per Part 7. */}
                  <th>Consent basis</th>
                  <th>Consented</th>
                  <th>Source</th>
                  <th>Confirmed</th>
                  <th>Engagement</th>
                </tr>
              </thead>
              <tbody>
                {data.subscribers.map((s) => (
                  <tr key={s.id}>
                    <td>{s.person}</td>
                    <td>{s.email ?? '—'}</td>
                    <td>
                      {s.list_name}
                      {s.magnet && <span className="dim">{` · ${s.magnet}`}</span>}
                    </td>
                    <td>{s.status}</td>
                    <td>{s.consent_basis.replaceAll('_', ' ')}</td>
                    <td>{s.consent_at ? s.consent_at.slice(0, 10) : '—'}</td>
                    <td>{s.consent_source ?? '—'}</td>
                    <td>{s.confirmed_at ? s.confirmed_at.slice(0, 10) : 'pending'}</td>
                    <td>
                      {`${s.opens ?? 0}/${s.sends ?? 0}`}
                      {s.last_engaged_at && (
                        <span className="dim">{` · ${s.last_engaged_at.slice(0, 10)}`}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h3>Lead magnets</h3>
        {data.magnets.length === 0 ? (
          <p className="chart-empty">No lead magnets yet.</p>
        ) : (
          <table className="projects-table">
            <thead>
              <tr>
                <th>Magnet</th>
                <th>Version</th>
                <th>List</th>
                <th>Downloads</th>
              </tr>
            </thead>
            <tbody>
              {data.magnets.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td>{m.version ?? '—'}</td>
                  <td>{m.list_name ?? '—'}</td>
                  <td>{m.download_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="dim">
        {`${data.suppressed} address(es) are suppressed. `}
        One suppression set is checked by marketing and transactional sends alike, because a
        dead address should stop being written to from everywhere at once.
      </p>
    </main>
  );
}
