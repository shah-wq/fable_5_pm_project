'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { CustomerRow } from '@/lib/customers/service';
import { STAGE_LABELS, type StageKey } from '@/lib/stages/definitions';

type Tab = 'details' | 'projects' | 'portal' | 'activity';

interface ProjectRow {
  id: string;
  code: string;
  address: string | null;
  systemSizeKw: number | null;
  stage: string;
  status: string;
  contractValue: number | null;
  createdAt: string;
  completionDate: string | null;
}

/**
 * The customer record: Details, Projects, Portal access and Activity. The
 * Projects tab is the reason this section is worth building — it answers 'what
 * is our whole history with this person?' in one place, which no
 * project-by-project view can.
 */
export function CustomerDrawer({
  customer,
  dealers,
  isAdmin,
  onClose,
  onSaved,
}: {
  customer: CustomerRow | null;
  dealers: Array<{ id: string; name: string }>;
  isAdmin: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tab, setTab] = useState<Tab>('details');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<Array<{ id: string; name: string; projects: number }>>([]);
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [activity, setActivity] = useState<Array<{ at: string; action: string; actor: string | null }> | null>(null);
  const [destructive, setDestructive] = useState<'delete' | 'anonymise' | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [password, setPassword] = useState('');

  // The Projects and Activity tabs are fetched when first opened.
  useEffect(() => {
    if (!customer) return;
    if (tab === 'projects' && projects === null) {
      fetch(`/api/customers/${customer.id}/detail?include=projects`)
        .then((r) => r.json())
        .then((j) => setProjects(j.projects ?? []))
        .catch(() => setProjects([]));
    }
    if (tab === 'activity' && activity === null) {
      fetch(`/api/customers/${customer.id}/detail?include=activity`)
        .then((r) => r.json())
        .then((j) => setActivity(j.activity ?? []))
        .catch(() => setActivity([]));
    }
  }, [tab, customer, projects, activity]);

  async function call(url: string, init: RequestInit, okMessage?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, { headers: { 'content-type': 'application/json' }, ...init });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        if (json?.duplicates) setDuplicates(json.duplicates);
        setError(json?.error ?? `Failed (${res.status}).`);
        return null;
      }
      if (json?.inviteLink || json?.resetLink) {
        setNotice(`${okMessage ?? 'Done.'} Email did not send — share this link: ${json.inviteLink ?? json.resetLink}`);
      } else if (okMessage) {
        setNotice(okMessage);
      }
      return json ?? {};
    } finally {
      setBusy(false);
    }
  }

  function save(form: FormData, allowDuplicate = false) {
    call('/api/customers', {
      method: 'POST',
      body: JSON.stringify({
        id: customer?.id,
        dealerId: form.get('dealerId') || undefined,
        firstName: form.get('firstName'),
        lastName: form.get('lastName'),
        email: form.get('email'),
        phone: form.get('phone'),
        alternatePhone: form.get('alternatePhone'),
        mailingAddress: form.get('mailingAddress'),
        preferredContact: form.get('preferredContact') || null,
        preferredLanguage: form.get('preferredLanguage'),
        internalNotes: form.get('internalNotes'),
        allowDuplicate,
      }),
    }, 'Saved.').then((ok) => ok && onSaved());
  }

  const portalAction = (action: string, okMessage: string, extra: Record<string, unknown> = {}) =>
    call(`/api/customers/${customer!.id}/portal`,
      { method: 'POST', body: JSON.stringify({ action, ...extra }) }, okMessage)
      .then((ok) => ok && onSaved());

  return (
    <div className="drawer-backdrop" onClick={() => !busy && onClose()}>
      <div className="drawer wide-drawer" onClick={(e) => e.stopPropagation()}>
        <h2>
          {customer ? `${customer.firstName} ${customer.lastName}` : '+ Add customer'}
        </h2>

        {customer && (
          <div className="admin-tabs">
            {(['details', 'projects', 'portal', 'activity'] as Tab[]).map((t) => (
              <button
                key={t}
                className={`linklike${tab === t ? ' active' : ''}`}
                type="button"
                onClick={() => setTab(t)}
              >
                {t === 'details' ? 'Details'
                  : t === 'projects' ? `Projects (${customer.projectCount})`
                  : t === 'portal' ? 'Portal access' : 'Activity'}
              </button>
            ))}
          </div>
        )}

        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {notice && <p className="notice ok">{notice}</p>}

        {duplicates.length > 0 && (
          <div className="notice hold">
            <strong>A customer with this email or phone already exists:</strong>
            <ul className="gap-list">
              {duplicates.map((d) => (
                <li key={d.id}>
                  {d.name} — {d.projects} project(s)
                </li>
              ))}
            </ul>
            <p className="dim">
              Add the new project to that customer instead, or create a separate record if these
              really are different people.
            </p>
            <button
              className="btn secondary small"
              type="button"
              onClick={() => {
                const form = document.getElementById('customer-form') as HTMLFormElement | null;
                if (form) save(new FormData(form), true);
              }}
            >
              Create a separate record anyway
            </button>
          </div>
        )}

        {(!customer || tab === 'details') && (
          <form
            id="customer-form"
            onSubmit={(e) => {
              e.preventDefault();
              save(new FormData(e.currentTarget));
            }}
          >
            <h3>Identity</h3>
            <div className="form-grid">
              <label className="field">
                <span>First name *</span>
                <input name="firstName" required defaultValue={customer?.firstName ?? ''} />
              </label>
              <label className="field">
                <span>Last name *</span>
                <input name="lastName" required defaultValue={customer?.lastName ?? ''} />
              </label>
              <label className="field">
                <span>Email</span>
                <input name="email" type="email" defaultValue={customer?.email ?? ''} />
                <small className="dim">
                  This is the portal login identity — changing it changes how they log in, and the
                  change is logged.
                </small>
              </label>
              <label className="field">
                <span>Phone</span>
                <input name="phone" defaultValue={customer?.phone ?? ''} />
              </label>
              <label className="field">
                <span>Alternate phone</span>
                <input name="alternatePhone" defaultValue={customer?.alternatePhone ?? ''} />
              </label>
              <label className="field">
                <span>Preferred contact method</span>
                <select name="preferredContact" defaultValue={customer?.preferredContact ?? ''}>
                  <option value="">—</option>
                  <option value="phone">Phone</option>
                  <option value="email">Email</option>
                  <option value="text">Text</option>
                </select>
              </label>
              <label className="field">
                <span>Preferred language</span>
                <input name="preferredLanguage" defaultValue={customer?.preferredLanguage ?? ''} />
              </label>
              {!customer && (
                <label className="field">
                  <span>Dealer</span>
                  <select name="dealerId" defaultValue={dealers[0]?.id ?? ''}>
                    {dealers.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            <h3>Address</h3>
            <label className="field">
              <span>Mailing address</span>
              <input
                name="mailingAddress"
                defaultValue={customer?.mailingAddress ?? ''}
                placeholder="Where different from the site address"
              />
            </label>
            {customer && customer.cityState && (
              <p className="dim">Site: {customer.cityState}</p>
            )}

            <h3>Relationships</h3>
            <dl className="facts">
              <dt>Dealer</dt>
              <dd>{customer?.dealerName ?? (dealers[0]?.name ?? '—')} <span className="dim">(from their projects)</span></dd>
              <dt>Sales rep</dt>
              <dd>{customer?.repName ?? '—'}</dd>
            </dl>

            <h3>Housekeeping</h3>
            <label className="field">
              <span>Internal notes — never visible in the customer portal</span>
              <textarea
                name="internalNotes"
                rows={3}
                defaultValue={customer?.internalNotes ?? ''}
                placeholder="e.g. prefers calls after 6pm; spouse handles all decisions"
              />
            </label>

            <div className="drawer-actions">
              {customer && isAdmin && (
                <>
                  <button
                    className="btn secondary"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      call('/api/customers', {
                        method: 'POST',
                        body: JSON.stringify({ id: customer.id, isArchived: !customer.isArchived }),
                      }, customer.isArchived ? 'Restored.' : 'Archived.').then((ok) => ok && onSaved())
                    }
                  >
                    {customer.isArchived ? 'Restore' : 'Archive'}
                  </button>
                  <button
                    className="btn secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setConfirmName('');
                      setDestructive('anonymise');
                    }}
                  >
                    Anonymise…
                  </button>
                  <button
                    className="btn secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setConfirmName('');
                      setDestructive('delete');
                    }}
                  >
                    Delete…
                  </button>
                </>
              )}
              <span className="spacer" />
              <button className="btn secondary" type="button" onClick={onClose}>
                Cancel
              </button>
              <button className="btn" type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        )}

        {customer && tab === 'projects' && (
          <>
            {projects === null ? (
              <p className="dim">Loading…</p>
            ) : projects.length === 0 ? (
              <p className="dim">No projects yet — this record was added ahead of the first job.</p>
            ) : (
              <table className="projects-table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Site</th>
                    <th>kW</th>
                    <th>Stage</th>
                    <th>Status</th>
                    <th>Total</th>
                    <th>Started</th>
                    <th>Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <Link href={`/projects/${p.id}`}>{p.code}</Link>
                      </td>
                      <td>{p.address ?? '—'}</td>
                      <td>{p.systemSizeKw ?? '—'}</td>
                      <td>{STAGE_LABELS[p.stage as StageKey] ?? p.stage}</td>
                      <td>{p.status.replaceAll('_', ' ')}</td>
                      <td>{p.contractValue === null ? '—' : `$${p.contractValue.toLocaleString()}`}</td>
                      <td>{p.createdAt.slice(0, 10)}</td>
                      <td>{p.completionDate ? p.completionDate.slice(0, 10) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        {customer && tab === 'portal' && (
          <>
            <dl className="facts">
              <dt>Access status</dt>
              <dd>
                {customer.portal === 'none' ? 'No access'
                  : customer.portal === 'invited' ? 'Invited — not yet accepted'
                  : customer.portal === 'disabled' ? 'Disabled'
                  : `Active${customer.lastSignInAt ? ` · last login ${customer.lastSignInAt.slice(0, 10)}` : ''}`}
              </dd>
              <dt>Login email</dt>
              <dd>{customer.email ?? <span className="dim">none on file</span>}</dd>
              <dt>Notification preferences</dt>
              <dd>
                {customer.preferredContact
                  ? `Prefers ${customer.preferredContact}`
                  : 'Not set'}
              </dd>
            </dl>

            <div className="action-row">
              {customer.portal === 'none' && (
                <button
                  className="btn"
                  type="button"
                  disabled={busy || !customer.email}
                  onClick={() => portalAction('invite', 'Invitation sent.')}
                >
                  Invite to portal
                </button>
              )}
              {customer.portal !== 'none' && (
                <button
                  className="btn secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => portalAction('resend_invite', 'Invitation re-sent.')}
                >
                  Resend invitation
                </button>
              )}
              {isAdmin && customer.portal !== 'none' && (
                <>
                  <button
                    className="btn secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => portalAction('reset_link', 'Reset email sent.')}
                  >
                    Send reset email
                  </button>
                  <button
                    className="btn secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => portalAction('force_logout', 'Signed out of all devices.')}
                  >
                    Force logout
                  </button>
                  <button
                    className="btn secondary"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      portalAction(customer.portal === 'disabled' ? 'enable' : 'disable',
                        customer.portal === 'disabled' ? 'Access restored.' : 'Access disabled.')
                    }
                  >
                    {customer.portal === 'disabled' ? 'Re-enable access' : 'Disable access'}
                  </button>
                </>
              )}
            </div>

            {isAdmin && customer.portal !== 'none' && (
              <>
                <h3>Set a password directly</h3>
                <p className="dim">
                  For customers who cannot manage an email link — you set it and pass it on.
                </p>
                <div className="ref-row">
                  <input
                    type="password"
                    placeholder="At least 8 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    className="btn secondary"
                    type="button"
                    disabled={busy || password.length < 8}
                    onClick={() =>
                      portalAction('set_password', 'Password set — hand it to the customer.',
                        { password, forceChange: true }).then(() => setPassword(''))
                    }
                  >
                    Set password
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {customer && tab === 'activity' && (
          <>
            {activity === null ? (
              <p className="dim">Loading…</p>
            ) : activity.length === 0 ? (
              <p className="dim">Nothing logged against this customer yet.</p>
            ) : (
              <ul className="activity">
                {activity.map((a, i) => (
                  <li key={i}>
                    <span className="dim">{new Date(a.at).toLocaleString()}</span> {a.action}
                    {a.actor ? <span className="dim"> · {a.actor}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {destructive && customer && (
          <div className="dialog-backdrop">
            <div className="dialog" role="dialog" aria-modal>
              <h2>
                {destructive === 'anonymise' ? 'Anonymise' : 'Delete'} {customer.firstName}{' '}
                {customer.lastName}?
              </h2>
              {destructive === 'anonymise' ? (
                <p>
                  Their name, email, phone and address are replaced with a redaction marker and
                  their portal login is removed. The projects, permit records, dates and payment
                  history the business must retain stay intact. This is the right answer to a
                  data-removal request once a project exists.
                </p>
              ) : (
                <p>
                  Only possible for a record with no projects and no leads — otherwise archive it,
                  or anonymise it for a data-removal request.
                </p>
              )}
              <label className="field">
                <span>
                  Type <strong>{customer.firstName} {customer.lastName}</strong> to confirm
                </span>
                <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
              </label>
              <div className="dialog-actions">
                <button className="btn secondary" type="button" onClick={() => setDestructive(null)}>
                  Cancel
                </button>
                <button
                  className="btn danger"
                  type="button"
                  disabled={
                    busy ||
                    confirmName.trim().toLowerCase() !==
                      `${customer.firstName} ${customer.lastName}`.toLowerCase()
                  }
                  onClick={() =>
                    call(`/api/customers/${customer.id}`, {
                      method: 'DELETE',
                      body: JSON.stringify({ confirmName, mode: destructive }),
                    }, destructive === 'anonymise' ? 'Customer anonymised.' : 'Customer deleted.')
                      .then((ok) => {
                        setDestructive(null);
                        if (ok) onSaved();
                      })
                  }
                >
                  {destructive === 'anonymise' ? 'Anonymise' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
