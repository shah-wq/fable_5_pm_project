import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';

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
  } | null;

  // Only http(s) links reach the app: a javascript: URL in a legal link would
  // be a stored XSS on every customer's device.
  const url = (v: string | undefined) =>
    v && /^https?:\/\/\S+$/i.test(v.trim()) ? v.trim().slice(0, 500) : null;
  const version = (v: string | undefined) =>
    v && /^\d+(\.\d+){0,3}$/.test(v.trim()) ? v.trim() : null;

  await withUser(session, (c) =>
    c.query(
      `update public.app_settings set
         company_name = $1, company_address = $2, company_license = $3,
         signer_user_id = $4, default_design_turnaround_hours = $5,
         co_prefix = $6, co_next_number = $7,
         privacy_policy_url = $8, terms_url = $9,
         support_email = $10, support_phone = $11,
         app_store_url = $12, play_store_url = $13,
         min_app_version = $14, latest_app_version = $15
       where id`,
      [
        p?.companyName || null,
        p?.companyAddress || null,
        p?.companyLicense || null,
        p?.signerUserId || null,
        Math.max(1, Number(p?.defaultDesignTurnaroundHours) || 48),
        p?.coPrefix || 'CO-',
        Math.max(1, Number(p?.coNextNumber) || 1),
        url(p?.privacyPolicyUrl),
        url(p?.termsUrl),
        p?.supportEmail?.trim().slice(0, 200) || null,
        p?.supportPhone?.trim().slice(0, 40) || null,
        url(p?.appStoreUrl),
        url(p?.playStoreUrl),
        version(p?.minAppVersion),
        version(p?.latestAppVersion),
      ]
    )
  );

  return NextResponse.json({ ok: true });
}
