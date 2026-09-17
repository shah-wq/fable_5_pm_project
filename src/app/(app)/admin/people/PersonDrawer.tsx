'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { PasswordInput } from '@/app/_components/PasswordInput';
import type { CustomerRow } from '@/lib/customers/service';
import type {
  AddressRow,
  ChannelRow,
  PersonDealRow,
  PersonSubscriptionRow,
  TimelineEntry,
} from '@/lib/people/service';
import { STAGE_LABELS, type StageKey } from '@/lib/stages/definitions';
import { ContactIntake } from './ContactIntake';

// Part 4: "Existing: Details, Projects, Portal access, Activity. Added: Deals
// (every deal this person appears on with their role, including lost ones) and
// Subscriptions (list membership and consent)."
type Tab = 'details' | 'intake' | 'projects' | 'deals' | 'subscriptions' | 'portal' | 'activity';

const DEAL_STAGE_LABELS: Record<string, string> = {
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  proposal: 'Proposal',
  negotiation: 'Negotiation',
  contract_out: 'Contract out',
  won: 'Won',
  lost: 'Lost',
};

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
 * The person record: Details, Projects, Deals, Subscriptions, Portal access and
 * Activity. The whole point of the section is that it answers 'what is our
 * entire history with this person?' in one place — which now covers the half of
 * that history that happens before anybody signs anything.
 *
 * The same component renders two ways. As a drawer it slides over the list,
 * which suits a glance and a one-field correction. As a page it is the record
 * at its own address, laid out like Create Contact — because a contact's fields
 * are the same fields whether they are being typed for the first time or
 * corrected a year later, and a form that changes shape between those two
 * moments teaches people two screens instead of one.
 */
export function PersonDrawer({
  customer,
  dealers,
  isAdmin,
  variant = 'drawer',
  onClose,
  onSaved,
}: {
  customer: CustomerRow | null;
  dealers: Array<{ id: string; name: string }>;
  isAdmin: boolean;
  variant?: 'drawer' | 'page';
  onClose: () => void;
  onSaved: () => void;
}) {
  const asPage = variant === 'page';
  // On its own page the contact's own fields are what somebody came for, so
  // they open on them rather than on the account panel behind them.
  const [tab, setTab] = useState<Tab>(asPage ? 'intake' : 'details');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<Array<{ id: string; name: string; projects: number }>>([]);
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [activity, setActivity] = useState<TimelineEntry[] | null>(null);
  const [deals, setDeals] = useState<PersonDealRow[] | null>(null);
  const [subscriptions, setSubscriptions] = useState<PersonSubscriptionRow[] | null>(null);
  const [channels, setChannels] = useState<ChannelRow[] | null>(null);
  const [addresses, setAddresses] = useState<AddressRow[] | null>(null);
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
    if (tab === 'deals' && deals === null) {
      fetch(`/api/customers/${customer.id}/detail?include=deals`)
        .then((r) => r.json())
        .then((j) => setDeals(j.deals ?? []))
        .catch(() => setDeals([]));
    }
    if (tab === 'subscriptions' && subscriptions === null) {
      fetch(`/api/customers/${customer.id}/detail?include=subscriptions`)
        .then((r) => r.json())
        .then((j) => setSubscriptions(j.subscriptions ?? []))
        .catch(() => setSubscriptions([]));
    }
    if (tab === 'details' && channels === null) {
      fetch(`/api/customers/${customer.id}/detail?include=contact`)
        .then((r) => r.json())
        .then((j) => { setChannels(j.channels ?? []); setAddresses(j.addresses ?? []); })
        .catch(() => { setChannels([]); setAddresses([]); });
    }
  }, [tab, customer, projects, activity, deals, subscriptions, channels]);

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
    <div
      className={asPage ? 'record-page' : 'drawer-backdrop'}
      onClick={asPage ? undefined : () => !busy && onClose()}
    >
      <div
        className={asPage ? 'record-body' : 'drawer wide-drawer'}
        onClick={asPage ? undefined : (e) => e.stopPropagation()}
      >
        {asPage ? (
          <div className="record-bar">
            <h1>{customer ? `${customer.firstName} ${customer.lastName}` : 'Contact'}</h1>
            <span className="spacer" />
            <button className="btn secondary" type="button" onClick={onClose}>
              Back to contacts
            </button>
          </div>
        ) : (
          <h2>
            {customer ? `${customer.firstName} ${customer.lastName}` : '+ Add person'}
          </h2>
        )}

        {customer && (
          <div className="admin-tabs">
            {(['details', 'intake', 'projects', 'deals', 'subscriptions', 'portal', 'activity'] as Tab[]).map((t) => (
              <button
                key={t}
                className={`linklike${tab === t ? ' active' : ''}`}
                type="button"
                onClick={() => setTab(t)}
              >
                {t === 'details' ? 'Details'
                  : t === 'intake' ? 'Contact details'
                  : t === 'projects' ? `Projects (${customer.projectCount})`
                  : t === 'deals' ? 'Deals'
                  : t === 'subscriptions' ? 'Subscriptions'
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
            <strong>Somebody with this email or phone is already on file:</strong>
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
                  {/* Optional now. A person can exist with no project and no
                      dealer — a web-form prospect belongs to nobody yet, and
                      inventing a dealer for them corrupts attribution later. */}
                  <select name="dealerId" defaultValue="">
                    <option value="">None yet</option>
                    {dealers.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            {customer && (channels?.length ?? 0) > 1 && (
              <>
                <h3>Other ways to reach them</h3>
                <ul className="gap-list">
                  {channels!.filter((ch) => !ch.isPrimary).map((ch) => (
                    <li key={ch.id}>
                      {ch.value}
                      <span className="dim">
                        {` · ${ch.kind}${ch.type ? ` (${ch.type})` : ''}`}
                        {ch.verifiedAt ? ' · verified' : ''}
                        {ch.bounceState ? ` · ${ch.bounceState} bounce` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="dim">
                  The primary email and phone are the fields above; everything else they have
                  given you lives here. A hard bounce is shown because writing to it again is
                  how a sending domain gets itself blocked.
                </p>
              </>
            )}

            {customer && (addresses?.length ?? 0) > 0 && (
              <>
                <h3>Addresses</h3>
                <ul className="gap-list">
                  {addresses!.map((a) => (
                    <li key={a.id}>
                      {a.lines}
                      {a.city ? `, ${a.city}` : ''}
                      {a.state ? `, ${a.state}` : ''}
                      <span className="dim">
                        {` · ${a.kind}${a.isPrimary ? ' · primary' : ''}`}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="dim">
                  A deal attaches to a property address, which is how a person with two houses
                  gets two deals rather than two records.
                </p>
              </>
            )}

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

        {customer && tab === 'intake' && <ContactIntake clientId={customer.id} />}

        {customer && tab === 'deals' && (
          <>
            {deals === null ? (
              <p className="dim">Loading…</p>
            ) : deals.length === 0 ? (
              <p className="dim">
                No deals yet. A deal is an opportunity before it is a job — this person has
                either never been one, or came in through a route that skipped the pipeline.
              </p>
            ) : (
              <table className="projects-table">
                <thead>
                  <tr>
                    <th>Deal</th>
                    <th>Stage</th>
                    <th>Their role</th>
                    <th>Value</th>
                    <th>Owner</th>
                    <th>Outcome</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {deals.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <Link href={`/deals/${d.id}`}>{d.code ?? d.id.slice(0, 8)}</Link>
                      </td>
                      <td>{DEAL_STAGE_LABELS[d.stage] ?? d.stage}</td>
                      {/* Part 5: most residential deals involve two people, and
                          which one you are looking at decides who to call. */}
                      <td>{(d.role ?? 'primary').replaceAll('_', ' ')}</td>
                      <td>{d.value === null ? '—' : `$${d.value.toLocaleString()}`}</td>
                      <td>{d.ownerName ?? 'unassigned'}</td>
                      <td>
                        {d.projectId ? (
                          <Link href={`/projects/${d.projectId}`}>became a project</Link>
                        ) : d.lostReason ? (
                          `lost — ${d.lostReason}`
                        ) : (
                          'open'
                        )}
                      </td>
                      <td>{d.updatedAt ? d.updatedAt.slice(0, 10) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        {customer && tab === 'subscriptions' && (
          <>
            {subscriptions === null ? (
              <p className="dim">Loading…</p>
            ) : subscriptions.length === 0 ? (
              <p className="dim">Not on any marketing list.</p>
            ) : (
              <table className="projects-table">
                <thead>
                  <tr>
                    <th>List</th>
                    <th>Status</th>
                    {/* Part 7: the consent basis column is always visible,
                        because it is the record produced if someone complains. */}
                    <th>Consent basis</th>
                    <th>Consented</th>
                    <th>Source</th>
                    <th>Confirmed</th>
                  </tr>
                </thead>
                <tbody>
                  {subscriptions.map((sub) => (
                    <tr key={sub.id}>
                      <td>{sub.listName}</td>
                      <td>
                        {sub.status}
                        {sub.unsubscribedAt && (
                          <span className="dim">{` · ${sub.unsubscribedAt.slice(0, 10)}`}</span>
                        )}
                      </td>
                      <td>{sub.consentBasis.replaceAll('_', ' ')}</td>
                      <td>{sub.consentAt ? sub.consentAt.slice(0, 10) : '—'}</td>
                      <td>{sub.consentSource ?? '—'}</td>
                      <td>{sub.confirmedAt ? sub.confirmedAt.slice(0, 10) : 'pending'}</td>
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

            {isAdmin && (
              <>
                <h3>Set a password directly</h3>
                <p className="dim">
                  For the customer on the phone who wants a password now, or who never received
                  the invitation. You set it, read it to them, and they are asked to choose their
                  own the first time they sign in.
                  {customer.portal === 'none' && ' This also creates their login.'}
                </p>
                {!customer.email && (
                  <p className="notice hold">
                    Add an email address on the Details tab first — it is the login name.
                  </p>
                )}
                <div className="ref-row">
                  <PasswordInput
                    label="New password"
                    placeholder="At least 10 characters"
                    autoComplete="new-password"
                    minLength={10}
                    value={password}
                    onChange={setPassword}
                  />
                  <button
                    className="btn secondary"
                    type="button"
                    disabled={busy || password.length < 10 || !customer.email}
                    onClick={() =>
                      portalAction('set_password', 'Password set — hand it to the customer.',
                        { password, forceChange: true }).then(() => setPassword(''))
                    }
                  >
                    Set password
                  </button>
                </div>
                <p className="dim">
                  Setting a password signs them out of any device they were already using, and
                  cancels an unused invitation.
                </p>
              </>
            )}
          </>
        )}

        {customer && tab === 'activity' && (
          <>
            {/* Part 3: one log renders the project audit trail, the customer
                Activity tab and the deal timeline. This is that one log. */}
            {activity === null ? (
              <p className="dim">Loading…</p>
            ) : activity.length === 0 ? (
              <p className="dim">Nothing logged against this person yet.</p>
            ) : (
              <ul className="activity">
                {activity.map((a, i) => (
                  <li key={i}>
                    <span className="dim">{new Date(a.at).toLocaleString()}</span>
                    {a.kind && a.kind !== 'field_change' && (
                      <span className="stage-chip-sm">{a.kind.replaceAll('_', ' ')}</span>
                    )}{' '}
                    {a.action}
                    {a.dealCode ? <span className="dim">{` · ${a.dealCode}`}</span> : null}
                    {a.actor ? <span className="dim">{` · ${a.actor}`}</span> : null}
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
