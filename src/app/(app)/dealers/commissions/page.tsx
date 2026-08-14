import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { dealerScope } from '@/lib/dealer/portal';
import { CommissionsTable } from './CommissionsTable';

export const dynamic = 'force-dynamic';

/**
 * The dealer's commission statement: one row per project with base,
 * adjustment, total and status (pending → payable → paid — an admin sets it,
 * nothing is automatic), plus period totals and a CSV export to reconcile
 * against their own records.
 */
export default async function DealerCommissionsPage() {
  const session = await guardPath('/dealers');

  const rows = await withUser(session, async (c) => {
    const scope = await dealerScope(c, session);
    const { rows } = await c.query(
      `select p.id, p.name, p.contract_value, cm.base_amount, cm.adjustment,
              cm.status, cm.payable_date, cm.paid_date, cm.updated_at
       from public.commissions cm
       join public.projects p on p.id = cm.project_id
       where true ${scope.clause.replace('$SCOPE$', '$1')}
       order by cm.updated_at desc
       limit 500`,
      scope.params
    );
    return rows;
  });

  return (
    <main className="surface wide">
      <h1>Commissions</h1>
      <p className="dim">
        Set by the PM team per project — pending while the project is active, payable
        (normally at PTO), then paid with the payment date.
      </p>
      <CommissionsTable
        rows={rows.map((r) => ({
          id: r.id,
          name: r.name,
          projectTotal: r.contract_value === null ? null : Number(r.contract_value),
          base: Number(r.base_amount),
          adjustment: Number(r.adjustment),
          status: r.status,
          payableDate: r.payable_date ? String(r.payable_date) : null,
          paidDate: r.paid_date ? String(r.paid_date) : null,
        }))}
      />
    </main>
  );
}
