import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { LeadForm } from './LeadForm';

export const dynamic = 'force-dynamic';

/**
 * Submit a lead — the one place a dealer writes. Below the form, every lead
 * they've filed with its status: Submitted → Under review → Converted (with
 * the project) or Declined with the reason.
 */
export default async function DealerLeadsPage() {
  const session = await guardPath('/dealers');

  const data = await withUser(session, async (c) => ({
    cashFinancing: (
      await c.query(`select id, name from public.cash_financing_options where is_active order by name`)
    ).rows,
    leads: (
      await c.query(
        `select l.id, l.customer_first, l.customer_last, l.address, l.status,
                l.declined_reason, l.converted_project_id, l.created_at
         from public.leads l order by l.created_at desc limit 100`
      )
    ).rows,
  }));

  return (
    <main className="surface wide">
      <h1>Submit a lead</h1>
      <p className="dim">
        A lead goes to the PM team for review — you&apos;ll see it move to Under review, then
        Converted (with a link to the new project) or Declined with the reason.
      </p>

      <LeadForm cashFinancing={data.cashFinancing} defaultRep={session.fullName ?? ''} />

      <section className="panel">
        <h2>Your leads</h2>
        <div className="table-wrap">
          <table className="projects-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Site address</th>
                <th>Submitted</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.leads.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.customer_first} {l.customer_last}
                  </td>
                  <td>{l.address}</td>
                  <td>{new Date(l.created_at).toLocaleDateString()}</td>
                  <td>
                    {l.status === 'converted' && l.converted_project_id ? (
                      <a href={`/dealers/projects/${l.converted_project_id}`}>Converted →</a>
                    ) : l.status === 'declined' ? (
                      <span title={l.declined_reason ?? ''}>
                        Declined{l.declined_reason ? ` — ${l.declined_reason}` : ''}
                      </span>
                    ) : (
                      l.status.replaceAll('_', ' ')
                    )}
                  </td>
                </tr>
              ))}
              {data.leads.length === 0 && (
                <tr>
                  <td colSpan={4} className="dim">
                    No leads yet — submit the first one above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
