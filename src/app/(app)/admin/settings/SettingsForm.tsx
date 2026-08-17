'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Option {
  id: string;
  name: string;
}

export function SettingsForm({
  settings,
  signers,
}: {
  settings: Record<string, unknown>;
  signers: Option[];
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
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `Save failed (${res.status}).`);
        return;
      }
      setNotice('Settings saved.');
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

      <button className="btn" type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save settings'}
      </button>
    </form>
  );
}
