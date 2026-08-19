'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { STAGES, STAGE_LABELS } from '@/lib/stages/definitions';

interface Option {
  id: string;
  name: string;
}

export function SettingsForm({
  settings,
  signers,
  thresholds,
}: {
  settings: Record<string, unknown>;
  signers: Option[];
  /** Per-stage ageing thresholds; empty until the dashboard migration is run. */
  thresholds: Record<string, number>;
}) {
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const f = new FormData(e.currentTarget);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          companyName: f.get('companyName'),
          companyAddress: f.get('companyAddress'),
          companyLicense: f.get('companyLicense'),
          signerUserId: f.get('signer') || null,
          defaultDesignTurnaroundHours: Number(f.get('turnaround')) || 48,
          coPrefix: f.get('coPrefix'),
          coNextNumber: Number(f.get('coNext')) || 1,
          privacyPolicyUrl: f.get('privacyPolicyUrl'),
          termsUrl: f.get('termsUrl'),
          supportEmail: f.get('supportEmail'),
          supportPhone: f.get('supportPhone'),
          appStoreUrl: f.get('appStoreUrl'),
          playStoreUrl: f.get('playStoreUrl'),
          minAppVersion: f.get('minAppVersion'),
          latestAppVersion: f.get('latestAppVersion'),
          onHoldAlertThreshold: Number(f.get('onHoldAlertThreshold')) || 5,
          opsSeeFinancials: f.get('opsSeeFinancials') === 'on',
          stageThresholds: Object.fromEntries(
            Object.keys(thresholds).map((stage) => [stage, Number(f.get(`threshold_${stage}`)) || 0])
          ),
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `Save failed (${res.status}).`);
        return;
      }
      // A partial save is reported, not glossed over: on a database that has not
      // run the newest migration some of these fields have nowhere to go, and
      // "Settings saved" would be a lie the admin only discovers later.
      const skipped: string[] | undefined = json?.skipped;
      setNotice(
        skipped?.length
          ? `Saved, except for ${skipped.join(' and ')}. Those fields need the newest SQL file from db/dist run in the SQL editor.`
          : 'Settings saved.'
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack-form" onSubmit={onSubmit}>
      {notice && <p className="notice ok">{notice}</p>}
      {error && <p className="notice error">{error}</p>}
      <label className="field">
        <span>Company name</span>
        <input name="companyName" defaultValue={String(settings.company_name ?? '')} />
      </label>
      <label className="field">
        <span>Company address</span>
        <input name="companyAddress" defaultValue={String(settings.company_address ?? '')} />
      </label>
      <div className="form-grid">
        <label className="field">
          <span>License no.</span>
          <input name="companyLicense" defaultValue={String(settings.company_license ?? '')} />
        </label>
        <label className="field">
          <span>Authorised company signer</span>
          <select name="signer" defaultValue={String(settings.signer_user_id ?? '')}>
            <option value="">—</option>
            {signers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Default design turnaround (hours)</span>
          <input
            name="turnaround"
            type="number"
            min={1}
            defaultValue={Number(settings.default_design_turnaround_hours ?? 48)}
          />
        </label>
        <label className="field">
          <span>Change-order prefix</span>
          <input name="coPrefix" defaultValue={String(settings.co_prefix ?? 'CO-')} />
        </label>
        <label className="field">
          <span>Next change-order number</span>
          <input
            name="coNext"
            type="number"
            min={1}
            defaultValue={Number(settings.co_next_number ?? 1)}
          />
        </label>
      </div>
      <h2>Customer app</h2>
      <p className="dim">
        The App Store and Play Store both reject an app without a public privacy
        policy URL, and both show these support details on the listing. The minimum
        version is the floor below which the app refuses to run and asks the customer
        to update — leave it blank until you actually need to force one.
      </p>
      <div className="form-grid">
        <label className="field">
          <span>Privacy policy URL</span>
          <input
            name="privacyPolicyUrl"
            type="url"
            placeholder="https://…"
            defaultValue={String(settings.privacy_policy_url ?? '')}
          />
        </label>
        <label className="field">
          <span>Terms of service URL</span>
          <input
            name="termsUrl"
            type="url"
            placeholder="https://…"
            defaultValue={String(settings.terms_url ?? '')}
          />
        </label>
        <label className="field">
          <span>Support email</span>
          <input name="supportEmail" type="email" defaultValue={String(settings.support_email ?? '')} />
        </label>
        <label className="field">
          <span>Support phone</span>
          <input name="supportPhone" defaultValue={String(settings.support_phone ?? '')} />
        </label>
        <label className="field">
          <span>App Store listing URL</span>
          <input name="appStoreUrl" type="url" defaultValue={String(settings.app_store_url ?? '')} />
        </label>
        <label className="field">
          <span>Play Store listing URL</span>
          <input name="playStoreUrl" type="url" defaultValue={String(settings.play_store_url ?? '')} />
        </label>
        <label className="field">
          <span>Minimum app version</span>
          <input
            name="minAppVersion"
            placeholder="e.g. 1.2.0"
            defaultValue={String(settings.min_app_version ?? '')}
          />
        </label>
        <label className="field">
          <span>Latest app version</span>
          <input
            name="latestAppVersion"
            placeholder="e.g. 1.3.0"
            defaultValue={String(settings.latest_app_version ?? '')}
          />
        </label>
      </div>

      {Object.keys(thresholds).length > 0 && (
        <>
          <h2>Dashboard</h2>
          <p className="dim">
            How many days a project may sit in each stage before the dashboard calls it out. These
            drive the Needs attention list and the ageing colours on the funnel, and they are meant to
            be re-tuned — a week in Procurement is fine, a week in Installation is not. Set them from
            what your own projects actually do, not from what you hope they do.
          </p>
          <div className="form-grid">
            {STAGES.filter((s) => s !== 'complete').map((stage) => (
              <label className="field" key={stage}>
                <span>{STAGE_LABELS[stage]} — attention after</span>
                <input
                  name={`threshold_${stage}`}
                  type="number"
                  min={1}
                  max={3650}
                  defaultValue={thresholds[stage] ?? 21}
                />
              </label>
            ))}
            <label className="field">
              <span>On-hold card turns amber above</span>
              <input
                name="onHoldAlertThreshold"
                type="number"
                min={1}
                max={999}
                defaultValue={Number(settings.on_hold_alert_threshold ?? 5)}
              />
            </label>
          </div>
          <label className="check-row">
            <input
              name="opsSeeFinancials"
              type="checkbox"
              defaultChecked={Boolean(settings.ops_see_financials)}
            />
            <span>
              Show the money figures to the PM (ops) role — pipeline value on the dashboard and the
              dealer pipeline column. Admins and the finance role always see them.
            </span>
          </label>
        </>
      )}

      <button className="btn" type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save settings'}
      </button>
    </form>
  );
}
