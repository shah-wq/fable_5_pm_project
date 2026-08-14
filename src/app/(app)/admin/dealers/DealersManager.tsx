'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

export interface DealerUser {
  userId: string;
  name: string | null;
  email: string | null;
  isActive: boolean;
  repLinked: boolean;
}

export interface DealerRow {
  id: string;
  name: string;
  code: string | null;
  email: string | null;
  phone: string | null;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
  companyAddress: string | null;
  taxId: string | null;
  defaultCommissionBasis: string | null;
  defaultCommissionRate: number | null;
  paymentTerms: string | null;
  notificationRecipients: string | null;
  notes: string | null;
  repsSeeOwnOnly: boolean;
  isActive: boolean;
  activeProjects: number;
  completedProjects: number;
  totalProjects: number;
  leadCount: number;
  commissionPending: number;
  users: DealerUser[];
}

const BASIS_LABELS: Record<string, string> = {
  percentage_of_contract: 'Percentage of contract',
  fixed_per_project: 'Fixed per project',
  per_watt: 'Per watt',
  manual: 'Manual per project',
};

/**
 * Admin → Dealers: list with the numbers that matter, one drawer for the
 * full record (Record / Users tabs), Deactivate as the primary destructive
 * action and Delete deliberately narrow — blocked whenever projects, leads
 * or commissions reference the company, typed-name confirmation, and an
 * explicit choice for linked user accounts.
 */
export function DealersManager({ rows }: { rows: DealerRow[] }) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [drawer, setDrawer] = useState<{ dealer: DealerRow | null; tab: 'record' | 'users' } | null>(null);
  const [deleting, setDeleting] = useState<DealerRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((d) => {
      if (!showInactive && !d.isActive) return false;
      if (!q) return true;
      return [d.name, d.primaryContactName, d.primaryContactEmail, d.email].some((v) =>
        v?.toLowerCase().includes(q)
      );
    });
  }, [rows, search, showInactive]);

  async function api(url: string, init: RequestInit): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { headers: { 'content-type': 'application/json' }, ...init });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `Failed (${res.status}).`);
        return false;
      }
      router.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  }

  function save(dealer: DealerRow | null, form: FormData, nextActive?: boolean) {
    const values: Record<string, unknown> = {
      name: form.get('name'),
      code: form.get('code'),
      primary_contact_name: form.get('primary_contact_name'),
      primary_contact_email: form.get('primary_contact_email'),
      phone: form.get('phone'),
      company_address: form.get('company_address'),
      tax_id: form.get('tax_id'),
      default_commission_basis: form.get('default_commission_basis'),
      default_commission_rate: form.get('default_commission_rate'),
      payment_terms: form.get('payment_terms'),
      notification_recipients: form.get('notification_recipients'),
      notes: form.get('notes'),
      reps_see_own_only: form.get('reps_see_own_only') === 'on',
    };
    api('/api/admin/dealers', {
      method: 'POST',
      body: JSON.stringify({
        id: dealer?.id,
        values,
        ...(nextActive === undefined ? {} : { isActive: nextActive }),
      }),
    }).then((ok) => ok && setDrawer(null));
  }

  return (
    <>
      {error && !drawer && !deleting && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      <div className="filters">
        <input
          type="search"
          placeholder="Search company, contact, email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="check-inline">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show inactive
        </label>
        <span className="spacer" />
        <button className="btn" type="button" onClick={() => setDrawer({ dealer: null, tab: 'record' })}>
          + Add dealer company
        </button>
      </div>

      <div className="table-wrap">
        <table className="projects-table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Primary contact</th>
              <th>Email</th>
              <th>Active projects</th>
              <th>Completed</th>
              <th>Commission pending</th>
              <th>Users</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((d) => (
              <tr key={d.id}>
                <td>
                  <button
                    className="linklike"
                    type="button"
                    onClick={() => setDrawer({ dealer: d, tab: 'record' })}
                  >
                    {d.name}
                  </button>
                </td>
                <td>{d.primaryContactName ?? '—'}</td>
                <td>{d.primaryContactEmail ?? d.email ?? '—'}</td>
                <td>
                  {d.activeProjects > 0 ? (
                    <Link href={`/projects?dealer=${d.id}`}>{d.activeProjects} active</Link>
                  ) : (
                    '0'
                  )}
                </td>
                <td>{d.completedProjects}</td>
                <td>${d.commissionPending.toLocaleString()}</td>
                <td>
                  <button
                    className="linklike"
                    type="button"
                    onClick={() => setDrawer({ dealer: d, tab: 'users' })}
                  >
                    {d.users.length}
                  </button>
                </td>
                <td>{d.isActive ? 'active' : <span className="dim">inactive</span>}</td>
                <td>
                  <span className="ref-row">
                    <button
                      className="btn secondary small"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        api('/api/admin/dealers', {
                          method: 'POST',
                          body: JSON.stringify({ id: d.id, values: {}, isActive: !d.isActive }),
                        })
                      }
                    >
                      {d.isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                    <button
                      className="btn secondary small"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setError(null);
                        setDeleting(d);
                      }}
                    >
                      Delete
                    </button>
                  </span>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={9} className="dim">
                  No dealer companies{search ? ' match' : ' yet — add the first one'}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {drawer && (
        <div className="drawer-backdrop" onClick={() => !busy && setDrawer(null)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <h2>{drawer.dealer ? drawer.dealer.name : '+ Add dealer company'}</h2>
            {drawer.dealer && (
              <div className="admin-tabs">
                <button
                  className={`linklike${drawer.tab === 'record' ? ' active' : ''}`}
                  type="button"
                  onClick={() => setDrawer({ ...drawer, tab: 'record' })}
                >
                  Record
                </button>
                <button
                  className={`linklike${drawer.tab === 'users' ? ' active' : ''}`}
                  type="button"
                  onClick={() => setDrawer({ ...drawer, tab: 'users' })}
                >
                  Users ({drawer.dealer.users.length})
                </button>
              </div>
            )}
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}

            {drawer.tab === 'record' ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  save(drawer.dealer, new FormData(e.currentTarget));
                }}
              >
                <h3>Identity</h3>
                <label className="field">
                  <span>Company name *</span>
                  <input name="name" required defaultValue={drawer.dealer?.name ?? ''} />
                </label>
                <label className="field">
                  <span>Primary contact name</span>
                  <input
                    name="primary_contact_name"
                    defaultValue={drawer.dealer?.primaryContactName ?? ''}
                  />
                </label>
                <label className="field">
                  <span>Primary contact email *</span>
                  <input
                    name="primary_contact_email"
                    type="email"
                    required
                    defaultValue={drawer.dealer?.primaryContactEmail ?? ''}
                  />
                </label>
                <label className="field">
                  <span>Phone</span>
                  <input name="phone" defaultValue={drawer.dealer?.phone ?? ''} />
                </label>
                <label className="field">
                  <span>Company address</span>
                  <input
                    name="company_address"
                    defaultValue={drawer.dealer?.companyAddress ?? ''}
                    placeholder="Appears on commission statements"
                  />
                </label>
                <label className="field">
                  <span>Tax / business ID</span>
                  <input name="tax_id" defaultValue={drawer.dealer?.taxId ?? ''} />
                </label>
                <label className="field">
                  <span>Code</span>
                  <input name="code" defaultValue={drawer.dealer?.code ?? ''} />
                </label>

                <h3>Commercial</h3>
                <label className="field">
                  <span>Default commission basis</span>
                  <select
                    name="default_commission_basis"
                    defaultValue={drawer.dealer?.defaultCommissionBasis ?? ''}
                  >
                    <option value="">—</option>
                    {Object.entries(BASIS_LABELS).map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Default commission rate</span>
                  <input
                    name="default_commission_rate"
                    type="number"
                    step="any"
                    min={0}
                    defaultValue={drawer.dealer?.defaultCommissionRate ?? ''}
                  />
                  <small className="dim">
                    Pre-fills new projects for this dealer; always overridable. Existing projects
                    keep the commission they were created with.
                  </small>
                </label>
                <label className="field">
                  <span>Payment terms</span>
                  <input
                    name="payment_terms"
                    defaultValue={drawer.dealer?.paymentTerms ?? ''}
                    placeholder="e.g. Net 30 after PTO"
                  />
                </label>

                <h3>Portal behaviour</h3>
                <label className="check-inline">
                  <input
                    name="reps_see_own_only"
                    type="checkbox"
                    defaultChecked={drawer.dealer?.repsSeeOwnOnly ?? false}
                  />
                  Reps see only their own sales
                </label>
                <label className="field">
                  <span>Notification recipients</span>
                  <input
                    name="notification_recipients"
                    defaultValue={drawer.dealer?.notificationRecipients ?? ''}
                    placeholder="extra@example.com, boss@example.com"
                  />
                </label>

                <h3>Housekeeping</h3>
                <label className="field">
                  <span>Notes (internal — never visible in the dealer portal)</span>
                  <textarea name="notes" rows={3} defaultValue={drawer.dealer?.notes ?? ''} />
                </label>

                <div className="drawer-actions">
                  <button className="btn secondary" type="button" onClick={() => setDrawer(null)}>
                    Cancel
                  </button>
                  <button className="btn" type="submit" disabled={busy}>
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </form>
            ) : (
              <UsersTab
                dealer={drawer.dealer!}
                others={rows.filter((r) => r.id !== drawer.dealer!.id && r.isActive)}
                busy={busy}
                onReassign={(userId, targetDealerId) =>
                  api(`/api/admin/dealers/${drawer.dealer!.id}`, {
                    method: 'POST',
                    body: JSON.stringify({ userId, targetDealerId }),
                  })
                }
              />
            )}
          </div>
        </div>
      )}

      {deleting && (
        <DeleteDialog
          dealer={deleting}
          others={rows.filter((r) => r.id !== deleting.id && r.isActive)}
          busy={busy}
          error={error}
          onClose={() => setDeleting(null)}
          onDelete={(confirmName, userAction, targetDealerId) =>
            api(`/api/admin/dealers/${deleting.id}`, {
              method: 'DELETE',
              body: JSON.stringify({ confirmName, userAction, targetDealerId }),
            }).then((ok) => ok && setDeleting(null))
          }
        />
      )}
    </>
  );
}

function UsersTab({
  dealer,
  others,
  busy,
  onReassign,
}: {
  dealer: DealerRow;
  others: DealerRow[];
  busy: boolean;
  onReassign: (userId: string, targetDealerId: string) => void;
}) {
  const [target, setTarget] = useState('');

  if (dealer.users.length === 0) {
    return (
      <p className="dim">
        No portal access yet — <Link href="/admin">add a user</Link> with role Dealer linked to
        this company. Perfectly valid: you can track a dealer&apos;s projects and commissions
        long before they get a login.
      </p>
    );
  }
  return (
    <>
      <table className="projects-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Status</th>
            <th>Sales-rep linked</th>
            <th>Reassign to</th>
          </tr>
        </thead>
        <tbody>
          {dealer.users.map((u) => (
            <tr key={u.userId}>
              <td>{u.name ?? '—'}</td>
              <td>{u.email ?? '—'}</td>
              <td>{u.isActive ? 'active' : <span className="dim">disabled</span>}</td>
              <td>{u.repLinked ? 'yes' : '—'}</td>
              <td>
                <span className="ref-row">
                  <select value={target} onChange={(e) => setTarget(e.target.value)}>
                    <option value="">Choose company…</option>
                    {others.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn secondary small"
                    type="button"
                    disabled={busy || !target}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Move ${u.name ?? u.email} to another company? This changes what they can see immediately.`
                        )
                      ) {
                        onReassign(u.userId, target);
                      }
                    }}
                  >
                    Move
                  </button>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="dim">
        Disable or delete an account from <Link href="/admin">Users &amp; roles</Link> — the same
        rules apply as for any user.
      </p>
    </>
  );
}

function DeleteDialog({
  dealer,
  others,
  busy,
  error,
  onClose,
  onDelete,
}: {
  dealer: DealerRow;
  others: DealerRow[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onDelete: (confirmName: string, userAction?: 'deactivate' | 'reassign', targetDealerId?: string) => void;
}) {
  const [confirmName, setConfirmName] = useState('');
  const [userAction, setUserAction] = useState<'deactivate' | 'reassign'>('deactivate');
  const [target, setTarget] = useState('');
  const blocked =
    dealer.totalProjects > 0 || dealer.leadCount > 0;

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal>
        <h2>Delete {dealer.name}?</h2>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {blocked ? (
          <>
            <p>
              <strong>{dealer.name}</strong> has{' '}
              {[
                dealer.totalProjects > 0 ? `${dealer.totalProjects} project(s)` : null,
                dealer.leadCount > 0 ? `${dealer.leadCount} lead(s)` : null,
              ]
                .filter(Boolean)
                .join(', ')}{' '}
              and cannot be deleted — deleting would orphan that history.
            </p>
            <p className="dim">
              Deactivate instead: the company disappears from the New-project dropdown while
              projects, portal access and commissions stay untouched.
            </p>
            <div className="dialog-actions">
              <button className="btn secondary" type="button" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              Nothing references this company
              {dealer.users.length > 0
                ? `, but ${dealer.users.length} user account(s) are linked to it`
                : ''}
              . Deletion is permanent; the activity log keeps the record.
            </p>
            {dealer.users.length > 0 && (
              <>
                <label className="check-inline">
                  <input
                    type="radio"
                    name="userAction"
                    checked={userAction === 'deactivate'}
                    onChange={() => setUserAction('deactivate')}
                  />
                  Deactivate the linked accounts
                </label>
                <label className="check-inline">
                  <input
                    type="radio"
                    name="userAction"
                    checked={userAction === 'reassign'}
                    onChange={() => setUserAction('reassign')}
                  />
                  Reassign them to another company
                </label>
                {userAction === 'reassign' && (
                  <label className="field">
                    <span>Target company *</span>
                    <select value={target} onChange={(e) => setTarget(e.target.value)}>
                      <option value="">Choose…</option>
                      {others.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            )}
            <label className="field">
              <span>
                Type <strong>{dealer.name}</strong> to confirm
              </span>
              <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
            </label>
            <div className="dialog-actions">
              <button className="btn secondary" type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn danger"
                type="button"
                disabled={
                  busy ||
                  confirmName.trim() !== dealer.name.trim() ||
                  (dealer.users.length > 0 && userAction === 'reassign' && !target)
                }
                onClick={() =>
                  onDelete(
                    confirmName,
                    dealer.users.length > 0 ? userAction : undefined,
                    userAction === 'reassign' ? target : undefined
                  )
                }
              >
                Delete company
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
