import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { optionalRows } from '@/lib/db-optional';
import { AdminTabs } from '../_components/AdminTabs';
import { SettingsForm } from './SettingsForm';

export const dynamic = 'force-dynamic';

/** Admin panel §6 — company-wide defaults. */
export default async function AdminSettingsPage() {
  const session = await guardPath('/admin');

  const data = await withUser(session, async (c) => {
    const settings = await c.query('select * from public.app_settings where id');
    const signers = await c.query(
      `select id, coalesce(full_name, email) as name from public.profiles
       where role in ('admin', 'ops') and is_active and deleted_at is null order by 2`
    );
    // Arrives with the dashboard migration; an empty list simply leaves that
    // section out rather than taking the settings page down (see db-optional.ts).
    const thresholds = await optionalRows<{ stage: string; attention_days: number }>(
      c,
      'the per-stage ageing thresholds (public.stage_thresholds)',
      `select stage::text as stage, attention_days from public.stage_thresholds`
    );
    // The typical ranges arrive one migration later than the thresholds beside
    // them, so they are asked for separately — on a database at 002800 the
    // ageing column still renders and only this pair is missing.
    const typical = await optionalRows<{
      stage: string;
      typical_min_days: number | null;
      typical_max_days: number | null;
    }>(
      c,
      'the typical stage durations (public.stage_thresholds)',
      `select stage::text as stage, typical_min_days, typical_max_days
         from public.stage_thresholds`
    );
    return { settings: settings.rows[0], signers: signers.rows, thresholds, typical };
  });

  const thresholds = Object.fromEntries(
    data.thresholds.map((t) => [t.stage, Number(t.attention_days)])
  );
  const typical = Object.fromEntries(
    data.typical.map((t) => [
      t.stage,
      {
        min: t.typical_min_days === null ? null : Number(t.typical_min_days),
        max: t.typical_max_days === null ? null : Number(t.typical_max_days),
      },
    ])
  );

  return (
    <main className="table-page">
      <h1>Admin</h1>
      <AdminTabs />
      <h2 className="section-title">Settings</h2>
      <p className="dim">
        Company details print on work orders and change orders; the turnaround default pre-fills
        Stage 2 due dates; the CO numbering feeds change orders.
      </p>
      <SettingsForm
        settings={data.settings}
        signers={data.signers}
        thresholds={thresholds}
        typical={typical}
      />
    </main>
  );
}
