import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { optionalQuery } from '@/lib/db-optional';
import { isStageKey } from '@/lib/stages/definitions';

export async function PUT(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.role !== 'admin' || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const p = (await request.json().catch(() => null)) as {
    companyName?: string;
    companyAddress?: string;
    companyLicense?: string;
    signerUserId?: string | null;
    defaultDesignTurnaroundHours?: number;
    coPrefix?: string;
    coNextNumber?: number;
    /* Mobile app (spec §7, §8): the public legal URLs both stores require, the
       store listings to send customers to, and the version floor below which
       the shell shows a blocking update prompt. */
    privacyPolicyUrl?: string;
    termsUrl?: string;
    supportEmail?: string;
    supportPhone?: string;
    appStoreUrl?: string;
    playStoreUrl?: string;
    minAppVersion?: string;
    latestAppVersion?: string;
    /* Dashboard (spec §7, §8): the amber threshold on the on-hold card, whether
       the ops role sees the money cards, and the per-stage ageing thresholds
       that decide what lands in Needs attention. */
    onHoldAlertThreshold?: number;
    opsSeeFinancials?: boolean;
    stageThresholds?: Record<string, number>;
    /** 003100 — 'Typical 15–30 days' on the customer's current-stage card. */
    typicalDurations?: Record<string, { min?: number; max?: number }>;
  } | null;

  // Only http(s) links reach the app: a javascript: URL in a legal link would
  // be a stored XSS on every customer's device.
  const url = (v: string | undefined) =>
    v && /^https?:\/\/\S+$/i.test(v.trim()) ? v.trim().slice(0, 500) : null;
  const version = (v: string | undefined) =>
    v && /^\d+(\.\d+){0,3}$/.test(v.trim()) ? v.trim() : null;

  /**
   * The save is split by the migration each group of columns came from, and every
   * group after the first is savepoint-guarded.
   *
   * The reason is a real failure this arrangement prevents: the mobile-app fields
   * arrived in 002500 and the dashboard fields in 002800, but they were being
   * written in the same statement as the company name — so on a database that had
   * not run the newest SQL yet, saving the company address returned a 500 and the
   * settings form appeared broken. The columns an installation does have must
   * always save; the ones it does not are reported back rather than pretended.
   */
  const skipped: string[] = [];

  await withUser(session, async (c) => {
    // 001300 — present in every installation.
    await c.query(
      `update public.app_settings set
         company_name = $1, company_address = $2, company_license = $3,
         signer_user_id = $4, default_design_turnaround_hours = $5,
         co_prefix = $6, co_next_number = $7
       where id`,
      [
        p?.companyName || null,
        p?.companyAddress || null,
        p?.companyLicense || null,
        p?.signerUserId || null,
        Math.max(1, Number(p?.defaultDesignTurnaroundHours) || 48),
        p?.coPrefix || 'CO-',
        Math.max(1, Number(p?.coNextNumber) || 1),
      ]
    );

    // 002500 — the customer app's legal URLs, store links and version floor.
    const app = await optionalQuery(
      c,
      'the customer-app settings (app_settings.privacy_policy_url)',
      `update public.app_settings set
         privacy_policy_url = $1, terms_url = $2,
         support_email = $3, support_phone = $4,
         app_store_url = $5, play_store_url = $6,
         min_app_version = $7, latest_app_version = $8
       where id`,
      [
        url(p?.privacyPolicyUrl),
        url(p?.termsUrl),
        p?.supportEmail?.trim().slice(0, 200) || null,
        p?.supportPhone?.trim().slice(0, 40) || null,
        url(p?.appStoreUrl),
        url(p?.playStoreUrl),
        version(p?.minAppVersion),
        version(p?.latestAppVersion),
      ]
    );
    if (!app.available) skipped.push('the customer-app settings (run migration 002500)');

    // 002800 — the dashboard's two numbers.
    const dash = await optionalQuery(
      c,
      'the dashboard settings (app_settings.on_hold_alert_threshold)',
      `update public.app_settings
         set on_hold_alert_threshold = $1, ops_see_financials = $2
       where id`,
      [
        Math.min(999, Math.max(1, Number(p?.onHoldAlertThreshold) || 5)),
        Boolean(p?.opsSeeFinancials),
      ]
    );
    if (!dash.available) skipped.push('the dashboard settings (run migration 002800)');

    // 002800 — per-stage ageing thresholds, one row each. The stage name is
    // checked against STAGES before it reaches the query: casting an unknown
    // string to the enum raises 22P02, which is not a "schema behind" code and
    // would abort the whole transaction rather than being skipped.
    let thresholdsMissing = false;
    for (const [stage, value] of Object.entries(p?.stageThresholds ?? {})) {
      if (!isStageKey(stage)) continue;
      const days = Math.round(Number(value));
      if (!Number.isFinite(days)) continue;
      const result = await optionalQuery(
        c,
        'the per-stage ageing thresholds (public.stage_thresholds)',
        `update public.stage_thresholds set attention_days = $2
         where stage = $1::public.project_stage`,
        [stage, Math.min(3650, Math.max(1, days))]
      );
      if (!result.available) thresholdsMissing = true;
    }
    if (thresholdsMissing) skipped.push('the per-stage ageing thresholds (run migration 002800)');

    // 003100 — the typical duration shown to customers on the stage they are in.
    // Saved as a pair: a min without a max would render as half a range. Both
    // blank clears the row back to showing no estimate at all, which is the right
    // answer for a stage nobody has a figure for yet.
    let typicalMissing = false;
    for (const [stage, range] of Object.entries(p?.typicalDurations ?? {})) {
      if (!isStageKey(stage)) continue;
      const min = Math.round(Number(range?.min));
      const max = Math.round(Number(range?.max));
      const pair =
        Number.isFinite(min) && Number.isFinite(max) && min > 0 && max > 0
          ? [Math.min(3650, min), Math.min(3650, Math.max(min, max))]
          : [null, null];
      const result = await optionalQuery(
        c,
        'the typical stage durations (public.stage_thresholds)',
        `update public.stage_thresholds
            set typical_min_days = $2, typical_max_days = $3
          where stage = $1::public.project_stage`,
        [stage, pair[0], pair[1]]
      );
      if (!result.available) typicalMissing = true;
    }
    if (typicalMissing) skipped.push('the typical stage durations (run migration 003100)');
  });

  return NextResponse.json({ ok: true, ...(skipped.length ? { skipped } : {}) });
}
