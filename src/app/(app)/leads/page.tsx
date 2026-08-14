import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { LeadQueue } from './LeadQueue';

export const dynamic = 'force-dynamic';

/**
 * The PM's lead review queue: everything dealers have submitted, with
 * Review / Convert / Decline actions. Converting creates the client + project
 * prefilled from the lead and links it back for the dealer.
 */
export default async function LeadsQueuePage() {
  const session = await guardPath('/leads');

  const leads = await withUser(session, async (c) => {
    const { rows } = await c.query(
      `select l.*, d.name as dealer_name, cf.name as cash_or_financing_name
       from public.leads l
       join public.dealers d on d.id = l.dealer_id
       left join public.cash_financing_options cf on cf.id = l.cash_or_financing_id
       order by case l.status when 'submitted' then 0 when 'under_review' then 1 else 2 end,
                l.created_at desc
       limit 200`
    );
    return rows;
  });

  return (
    <main className="surface wide">
      <h1>Leads</h1>
      <p className="dim">
        Dealer submissions land here — nothing becomes a project until you convert it.
      </p>
      <LeadQueue leads={leads} />
    </main>
  );
}
