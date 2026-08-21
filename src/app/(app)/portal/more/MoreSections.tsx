'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  appInfo,
  biometricsAvailable,
  biometricsEnabled,
  disableBiometrics,
  disablePush,
  enableBiometrics,
  enablePush,
  pushPermission,
  pushSupported,
  store,
} from '@/lib/native';
import { FAQ } from './faq';

interface RequestRow {
  id: string;
  kind: string;
  created: string;
  message: string | null;
  reply: string | null;
  status: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  stage_advanced: 'When my project moves to a new stage',
  appointment: 'Survey and installation dates, plus reminders',
  action_needed: 'When you need something from me',
  on_hold: 'If my project is paused',
  power_on: 'When my system is switched on',
  chat_message: 'When my project manager sends me a message',
};

/**
 * The More tab's sections, as collapsible rows rather than one long scroll —
 * a customer coming here has one specific errand, and a list of seven headings
 * gets them there in one tap.
 */
export function MoreSections({
  userId,
  name,
  projectId,
  contact,
  pm,
  requests,
  legal,
}: {
  userId: string;
  name: string;
  projectId: string | null;
  contact: { phone: string | null; email: string | null };
  pm: { name: string | null; phone: string | null; email: string | null };
  requests: RequestRow[];
  legal: {
    privacy: string | null;
    terms: string | null;
    supportEmail: string | null;
    supportPhone: string | null;
  };
}) {
  const [open, setOpen] = useState<string | null>(null);
  const info = appInfo();

  return (
    <div className="more-list">
      <Row id="details" label="My details" open={open} setOpen={setOpen}>
        <MyDetails projectId={projectId} contact={contact} />
      </Row>

      <Row id="messages" label="Message my project manager" open={open} setOpen={setOpen}>
        <Messages projectId={projectId} pmName={pm.name} requests={requests} />
      </Row>

      <Row id="notifications" label="Notifications" open={open} setOpen={setOpen}>
        <NotificationSettings />
      </Row>

      <Row id="security" label="Security" open={open} setOpen={setOpen}>
        <Security userId={userId} name={name} />
      </Row>

      <Row id="help" label="Help — common questions" open={open} setOpen={setOpen}>
        <dl className="faq">
          {FAQ.map((entry) => (
            <div key={entry.q}>
              <dt>{entry.q}</dt>
              <dd>{entry.a}</dd>
            </div>
          ))}
        </dl>
        {(pm.phone || legal.supportPhone) && (
          <p>
            Still stuck? Call{' '}
            <a href={`tel:${(pm.phone ?? legal.supportPhone)!.replace(/[^\d+]/g, '')}`}>
              {pm.name ?? 'us'}
            </a>
            .
          </p>
        )}
      </Row>

      <Row id="legal" label="Privacy and legal" open={open} setOpen={setOpen}>
        <ul className="gap-list">
          {legal.privacy && (
            <li>
              <a href={legal.privacy}>Privacy policy</a>
            </li>
          )}
          {legal.terms && (
            <li>
              <a href={legal.terms}>Terms of service</a>
            </li>
          )}
        </ul>
        <DeleteAccount projectId={projectId} name={name} />
      </Row>

      <div className="more-row">
        <form action="/auth/signout" method="post" onSubmit={() => store.clearAll()}>
          <button className="btn secondary" type="submit">
            Sign out
          </button>
        </form>
      </div>

      <p className="version-foot dim">
        Version {info.version} ({info.build})
        {info.isNativeShell ? ` · ${info.platform}` : info.isInstalled ? ' · installed' : ''}
      </p>
    </div>
  );
}

function Row({
  id,
  label,
  open,
  setOpen,
  children,
}: {
  id: string;
  label: string;
  open: string | null;
  setOpen: (v: string | null) => void;
  children: React.ReactNode;
}) {
  // A deep link like /portal/more#messages opens the right section directly.
  useEffect(() => {
    if (window.location.hash.replace('#', '') === id) setOpen(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="more-row" id={id}>
      <button
        className="more-head"
        type="button"
        aria-expanded={open === id}
        onClick={() => setOpen(open === id ? null : id)}
      >
        <span>{label}</span>
        <span className="dim">{open === id ? '▾' : '▸'}</span>
      </button>
      {open === id && <div className="more-body">{children}</div>}
    </section>
  );
}

/* ------------------------------------------------------------------------- */

/** Changes notify the PM rather than silently overwriting (spec §3.5). */
function MyDetails({
  projectId,
  contact,
}: {
  projectId: string | null;
  contact: { phone: string | null; email: string | null };
}) {
  const router = useRouter();
  const [phone, setPhone] = useState(contact.phone ?? '');
  const [email, setEmail] = useState(contact.email ?? '');
  const [preferred, setPreferred] = useState('phone');
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');

  async function save() {
    if (!projectId) return;
    setState('busy');
    const res = await fetch('/api/portal/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        kind: 'contact_update',
        contactPhone: phone,
        contactEmail: email,
        preferredContact: preferred,
      }),
    });
    setState(res.ok ? 'sent' : 'idle');
    if (res.ok) router.refresh();
  }

  return (
    <>
      <label className="field">
        <span>Phone</span>
        <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </label>
      <label className="field">
        <span>Email</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="field">
        <span>How should we contact you?</span>
        <select value={preferred} onChange={(e) => setPreferred(e.target.value)}>
          <option value="phone">Phone call</option>
          <option value="text">Text message</option>
          <option value="email">Email</option>
        </select>
      </label>
      <button className="btn" type="button" onClick={save} disabled={state === 'busy' || !projectId}>
        {state === 'busy' ? 'Sending…' : 'Send to my project manager'}
      </button>
      {state === 'sent' && (
        <p className="notice ok" role="status">
          Thank you — your project manager has your new details.
        </p>
      )}
    </>
  );
}

/** The same simple thread as the portal (spec §3.5). */
function Messages({
  projectId,
  pmName,
  requests,
}: {
  projectId: string | null;
  pmName: string | null;
  requests: RequestRow[];
}) {
  const router = useRouter();
  const [message, setMessage] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');

  async function send() {
    if (!projectId || message.trim().length < 3) return;
    setState('busy');
    const res = await fetch('/api/portal/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, kind: 'question', message: message.trim() }),
    });
    if (res.ok) {
      setMessage('');
      setState('sent');
      router.refresh();
    } else {
      setState('idle');
    }
  }

  const thread = requests.filter((r) => r.kind === 'question' || r.reply);

  return (
    <>
      {thread.length > 0 && (
        <ul className="thread">
          {thread.map((r) => (
            <li key={r.id}>
              <div className="bubble mine">
                <span className="dim">{r.created}</span>
                <p>{r.message}</p>
              </div>
              {r.reply && (
                <div className="bubble theirs">
                  <span className="dim">{pmName ?? 'Your project manager'}</span>
                  <p>{r.reply}</p>
                </div>
              )}
              {!r.reply && r.status === 'open' && <p className="dim">Awaiting a reply</p>}
            </li>
          ))}
        </ul>
      )}
      <label className="field">
        <span>Your message</span>
        <textarea
          rows={3}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={2000}
          placeholder="Ask anything about your project"
        />
      </label>
      <button
        className="btn"
        type="button"
        onClick={send}
        disabled={state === 'busy' || !projectId || message.trim().length < 3}
      >
        {state === 'busy' ? 'Sending…' : 'Send'}
      </button>
      {state === 'sent' && (
        <p className="notice ok" role="status">
          Sent — {pmName ?? 'your project manager'} will reply here.
        </p>
      )}
    </>
  );
}

/** Per-category toggles, matching the portal preferences (spec §3.5). */
function NotificationSettings() {
  const [prefs, setPrefs] = useState<Array<{ category: string; push: boolean; email: boolean }>>([]);
  const [deviceOn, setDeviceOn] = useState<boolean>(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDeviceOn(pushPermission() === 'granted');
    fetch('/api/push/prefs')
      .then((r) => r.json())
      .then((j) => setPrefs(j.prefs ?? []))
      .catch(() => undefined);
  }, []);

  async function toggleDevice(on: boolean) {
    setBusy(true);
    if (on) {
      const result = await enablePush();
      setDeviceOn(result.ok);
    } else {
      await disablePush();
      setDeviceOn(false);
    }
    setBusy(false);
  }

  async function toggle(category: string, field: 'push' | 'email', value: boolean) {
    setPrefs((p) => p.map((row) => (row.category === category ? { ...row, [field]: value } : row)));
    await fetch('/api/push/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category, [field]: value }),
    }).catch(() => undefined);
  }

  return (
    <>
      {pushSupported() ? (
        <label className="check-inline">
          <input
            type="checkbox"
            checked={deviceOn}
            disabled={busy}
            onChange={(e) => toggleDevice(e.target.checked)}
          />
          Notifications on this device
        </label>
      ) : (
        <p className="dim">
          This browser cannot show notifications. Install the app to your home screen, or use the
          email column below.
        </p>
      )}

      <table className="projects-table">
        <thead>
          <tr>
            <th>Tell me…</th>
            <th>Push</th>
            <th>Email</th>
          </tr>
        </thead>
        <tbody>
          {prefs.map((row) => (
            <tr key={row.category}>
              <td>{CATEGORY_LABELS[row.category] ?? row.category}</td>
              <td>
                <input
                  type="checkbox"
                  checked={row.push}
                  onChange={(e) => toggle(row.category, 'push', e.target.checked)}
                  aria-label={`Push: ${CATEGORY_LABELS[row.category]}`}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={row.email}
                  onChange={(e) => toggle(row.category, 'email', e.target.checked)}
                  aria-label={`Email: ${CATEGORY_LABELS[row.category]}`}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="dim">
        We send about six notifications across a whole project. Turning something off here never
        stops us telling you about an installation date by phone.
      </p>
    </>
  );
}

function Security({ userId, name }: { userId: string; name: string }) {
  const [available, setAvailable] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void biometricsAvailable().then(setAvailable);
    setEnabled(biometricsEnabled());
  }, []);

  async function toggle(on: boolean) {
    setBusy(true);
    if (on) {
      setEnabled(await enableBiometrics(userId, name));
    } else {
      disableBiometrics();
      setEnabled(false);
    }
    setBusy(false);
  }

  return (
    <>
      <p>
        <a className="btn secondary" href="/auth/change-password">
          Change my password
        </a>
      </p>
      {available ? (
        <label className="check-inline">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(e) => toggle(e.target.checked)}
          />
          Require Face ID, Touch ID or my fingerprint to open the app
        </label>
      ) : (
        <p className="dim">This device does not offer a biometric unlock.</p>
      )}
      <p className="dim">
        Biometric unlock hides your project until the phone recognises you. Your password is still
        what signs you in.
      </p>
    </>
  );
}

/**
 * Both stores now require an in-app route to request account deletion (spec §7).
 * It is a request, not an instant wipe: an admin carries it out through the
 * anonymise flow, which removes the person and keeps the permit, install and
 * payment record the business is required to retain.
 */
function DeleteAccount({ projectId, name }: { projectId: string | null; name: string }) {
  const [confirm, setConfirm] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function request() {
    setState('busy');
    setError(null);
    const res = await fetch('/api/portal/delete-account', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, confirm }),
    });
    const json = await res.json().catch(() => null);
    if (res.ok) {
      setState('sent');
      return;
    }
    setError(json?.error ?? 'Could not send the request.');
    setState('idle');
  }

  if (state === 'sent') {
    return (
      <p className="notice ok" role="status">
        Your request has been sent. We will remove your personal details and confirm by email
        within 30 days. Records we are legally required to keep — your permit, your installation
        date and your payments — stay on file without your name attached.
      </p>
    );
  }

  return (
    <details className="danger-details">
      <summary>Request account deletion</summary>
      <p>
        This asks us to delete your account and remove your personal details. Records we must keep
        by law — the permit, the installation date, the payment history — are kept with your name
        removed.
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <label className="field">
        <span>Type DELETE to confirm</span>
        <input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </label>
      <button
        className="btn danger"
        type="button"
        disabled={confirm.trim().toUpperCase() !== 'DELETE' || state === 'busy'}
        onClick={request}
      >
        {state === 'busy' ? 'Sending…' : `Request deletion of ${name}'s account`}
      </button>
    </details>
  );
}
