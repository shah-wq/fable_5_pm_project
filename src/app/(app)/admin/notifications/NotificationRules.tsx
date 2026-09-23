'use client';

import { useEffect, useState } from 'react';

interface Rule {
  kind: string;
  audience: string;
  label: string;
  description: string | null;
  enabled: boolean;
  in_app: boolean;
  email: boolean;
  push: boolean;
  last_30_days: number;
}

interface Settings {
  contact_stale_days: number;
  deal_stale_days: number;
  permit_expiry_warning_days: number;
  briefing_hour: number;
}

const AUDIENCE: Record<string, string> = {
  customer: 'Homeowner',
  pm: 'Project manager',
  admin: 'Admin',
  sales: 'Sales rep',
  dealer: 'Dealer',
  user: 'Person',
};

/**
 * Admin → Notifications: every kind of notification the system can send, who
 * it goes to, and three switches — in the app, by email, by push. Off means
 * nothing is raised at all. The timing settings feed the scheduled rules.
 */
export function NotificationRules() {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [ready, setReady] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function load() {
    const res = await fetch('/api/admin/notification-rules');
    const j = await res.json().catch(() => null);
    if (!res.ok) {
      setError(j?.error ?? `Could not load (${res.status}).`);
      return;
    }
    setRules(j.rules);
    setSettings(j.settings);
    setReady(j.ready);
  }
  useEffect(() => {
    void load();
  }, []);

  async function put(body: unknown) {
    setError(null);
    const res = await fetch('/api/admin/notification-rules', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) setError(j?.error ?? `Save failed (${res.status}).`);
    else {
      setSaved('Saved.');
      setTimeout(() => setSaved(null), 1500);
    }
    await load();
  }

  if (!rules) return <p className="dim">{error ?? 'Loading…'}</p>;
  if (!ready) return <p className="notice">Notifications need migration 004700 — Admin → Database → Apply.</p>;

  const audiences = [...new Set(rules.map((r) => r.audience))];
  return (
    <div className="rules">
      {error && <p className="notice error">{error}</p>}
      {saved && <p className="notice ok">{saved}</p>}
      {settings && (
        <form
          className="rules-settings"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void put({
              settings: {
                contact_stale_days: f.get('contact_stale_days'),
                deal_stale_days: f.get('deal_stale_days'),
                permit_expiry_warning_days: f.get('permit_expiry_warning_days'),
                briefing_hour: f.get('briefing_hour'),
              },
            });
          }}
        >
          <label className="field">
            <span>Contact “going quiet” after (days)</span>
            <input name="contact_stale_days" type="number" min={1} defaultValue={settings.contact_stale_days} />
          </label>
          <label className="field">
            <span>Deal “going quiet” after (days)</span>
            <input name="deal_stale_days" type="number" min={1} defaultValue={settings.deal_stale_days} />
          </label>
          <label className="field">
            <span>Warn of permit expiry (days before)</span>
            <input name="permit_expiry_warning_days" type="number" min={1} defaultValue={settings.permit_expiry_warning_days} />
          </label>
          <label className="field">
            <span>Morning briefing hour (company time)</span>
            <input name="briefing_hour" type="number" min={0} max={23} defaultValue={settings.briefing_hour} />
          </label>
          <button className="btn" type="submit">
            Save timing
          </button>
        </form>
      )}
      {audiences.map((a) => (
        <section key={a} className="panel">
          <h2>{AUDIENCE[a] ?? a}</h2>
          <table className="rules-table">
            <thead>
              <tr>
                <th>Notification</th>
                <th>On</th>
                <th>In app</th>
                <th>Email</th>
                <th>Push</th>
                <th className="num">Last 30 days</th>
              </tr>
            </thead>
            <tbody>
              {rules
                .filter((r) => r.audience === a)
                .map((r) => (
                  <tr key={r.kind} className={r.enabled ? '' : 'off'}>
                    <td>
                      <strong>{r.label}</strong>
                      {r.description && <div className="dim small">{r.description}</div>}
                    </td>
                    {(['enabled', 'in_app', 'email', 'push'] as const).map((col) => (
                      <td key={col}>
                        <input
                          type="checkbox"
                          aria-label={`${r.label}: ${col}`}
                          checked={r[col]}
                          disabled={col !== 'enabled' && !r.enabled}
                          onChange={(e) => void put({ kind: r.kind, [col]: e.target.checked })}
                        />
                      </td>
                    ))}
                    <td className="num dim">{r.last_30_days}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
