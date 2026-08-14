'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { UserRole } from '@/lib/auth/roles';

export interface UserRow {
  user_id: string;
  email: string;
  full_name: string | null;
  phone: string | null;
  role: UserRole;
  is_active: boolean;
  deleted_at: string | null;
  has_password: boolean;
  invite_pending: boolean;
  force_password_change: boolean;
  last_sign_in_at: string | null;
}

interface Option {
  id: string;
  name: string;
}

const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Admin',
  ops: 'PM',
  designer: 'Designer',
  finance: 'Finance',
  dealer: 'Dealer',
  customer: 'Customer',
};

function statusOf(u: UserRow): string {
  if (u.deleted_at) return 'deleted';
  if (!u.is_active) return 'disabled';
  if (u.invite_pending) return 'invited';
  return 'active';
}

/** Admin panel §1: users table + add/edit drawer + credential actions. */
export function UsersManager({
  users,
  dealers,
  clients,
  me,
}: {
  users: UserRow[];
  dealers: Option[];
  clients: Option[];
  me: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [drawer, setDrawer] = useState<{ user: UserRow | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'password' | 'invite'>('password');
  const [role, setRole] = useState<UserRole>('ops');
  // Inline company creation from the drawer — the half-filled user form must
  // survive, so the nested dialog only ever adds to this local list.
  const [dealerList, setDealerList] = useState(dealers);
  const [dealerChoice, setDealerChoice] = useState('');
  const [newCompany, setNewCompany] = useState(false);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      if (!showInactive && (u.deleted_at || !u.is_active)) return false;
      if (!q) return true;
      return [u.email, u.full_name, u.role].some((v) => v?.toLowerCase().includes(q));
    });
  }, [users, search, showInactive]);

  async function call(
    url: string,
    init: RequestInit,
    okMessage?: string
  ): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, {
        headers: { 'content-type': 'application/json' },
        ...init,
      });
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) {
        const extra =
          (json?.inviteLink as string) ?? (json?.resetLink as string)
            ? ` Link (share manually): ${json?.inviteLink ?? json?.resetLink}`
            : '';
        setError(`${json?.error ?? `Failed (${res.status})`}${extra}`);
        return null;
      }
      if (okMessage) setNotice(okMessage);
      router.refresh();
      return json;
    } finally {
      setBusy(false);
    }
  }

  function createUser(form: FormData) {
    const payload = {
      mode,
      email: form.get('email'),
      role,
      fullName: form.get('fullName'),
      phone: form.get('phone'),
      password: form.get('password'),
      forceChange: form.get('forceChange') === 'on',
      dealerId: form.get('dealerId') || undefined,
      clientId: form.get('clientId') || undefined,
    };
    if (mode === 'password' && payload.password !== form.get('confirm')) {
      setError('Passwords do not match.');
      return;
    }
    call('/api/admin/users', { method: 'POST', body: JSON.stringify(payload) },
      mode === 'password' ? 'User created — hand them their credentials.' : 'Invitation sent.'
    ).then((ok) => ok && setDrawer(null));
  }

  function saveEdits(u: UserRow, form: FormData) {
    call(
      `/api/admin/users/${u.user_id}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          fullName: form.get('fullName'),
          phone: form.get('phone'),
          role: form.get('role'),
        }),
      },
      'Saved.'
    ).then((ok) => ok && setDrawer(null));
  }

  function action(u: UserRow, body: Record<string, unknown>, message: string) {
    call(`/api/admin/users/${u.user_id}`, { method: 'POST', body: JSON.stringify(body) }, message);
  }

  const u = drawer?.user ?? null;

  return (
    <>
      {notice && (
        <p className="notice ok" role="status">
          {notice}
        </p>
      )}
      <div className="filters">
        <input
          type="search"
          placeholder="Search name, email, role…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="check-inline">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show disabled &amp; deleted
        </label>
        <span className="spacer" />
        <button
          className="btn"
          type="button"
          onClick={() => {
            setMode('password');
            setRole('ops');
            setDealerChoice('');
            setDrawer({ user: null });
          }}
        >
          + Add user
        </button>
      </div>

      <div className="table-wrap">
        <table className="projects-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last sign-in</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr
                key={row.user_id}
                className={row.deleted_at ? 'dim' : 'clickable'}
                onClick={() => !row.deleted_at && setDrawer({ user: row })}
              >
                <td>
                  <span className="row-name">{row.full_name ?? '—'}</span>
                  {row.user_id === me && <span className="dim"> (you)</span>}
                </td>
                <td>{row.email}</td>
                <td>{ROLE_LABELS[row.role]}</td>
                <td>{statusOf(row)}</td>
                <td>
                  {row.last_sign_in_at
                    ? new Date(row.last_sign_in_at).toLocaleDateString()
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {drawer && (
        <div className="drawer-backdrop" onClick={() => !busy && setDrawer(null)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}

            {!u ? (
              <>
                <h2>+ Add user</h2>
                <div className="radio-row">
                  <label>
                    <input
                      type="radio"
                      checked={mode === 'password'}
                      onChange={() => setMode('password')}
                    />
                    Set a password now
                  </label>
                  <label>
                    <input
                      type="radio"
                      checked={mode === 'invite'}
                      onChange={() => setMode('invite')}
                    />
                    Send an invitation email
                  </label>
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    createUser(new FormData(e.currentTarget));
                  }}
                >
                  <label className="field">
                    <span>Full name *</span>
                    <input name="fullName" required />
                  </label>
                  <label className="field">
                    <span>Email *</span>
                    <input name="email" type="email" required />
                  </label>
                  <label className="field">
                    <span>Phone</span>
                    <input name="phone" />
                  </label>
                  <label className="field">
                    <span>Role *</span>
                    <select value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
                      {(Object.keys(ROLE_LABELS) as UserRole[]).map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </label>
                  {role === 'dealer' && (
                    <label className="field">
                      <span>Linked dealer company *</span>
                      <select
                        name="dealerId"
                        required
                        value={dealerChoice}
                        onChange={(e) => {
                          if (e.target.value === '__new__') {
                            setNewCompany(true);
                            return;
                          }
                          setDealerChoice(e.target.value);
                        }}
                      >
                        <option value="" disabled>
                          Select…
                        </option>
                        {dealerList.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                        <option value="__new__">+ Add new company…</option>
                      </select>
                    </label>
                  )}
                  {role === 'customer' && (
                    <label className="field">
                      <span>Linked client *</span>
                      <select name="clientId" required defaultValue="">
                        <option value="" disabled>
                          Select…
                        </option>
                        {clients.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {mode === 'password' && role !== 'customer' && (
                    <>
                      <label className="field">
                        <span>Password * (min 8 characters)</span>
                        <input name="password" type="password" required minLength={8} />
                      </label>
                      <label className="field">
                        <span>Confirm password *</span>
                        <input name="confirm" type="password" required />
                      </label>
                      <label className="check-inline">
                        <input name="forceChange" type="checkbox" defaultChecked />
                        Force password change on first login
                      </label>
                    </>
                  )}
                  {role === 'customer' && (
                    <p className="dim">
                      Customers sign in with an emailed 6-digit code — no password to set.
                    </p>
                  )}
                  <div className="drawer-actions">
                    <span className="spacer" />
                    <button className="btn secondary" type="button" onClick={() => setDrawer(null)}>
                      Cancel
                    </button>
                    <button className="btn" type="submit" disabled={busy}>
                      {busy ? 'Creating…' : mode === 'password' ? 'Create user' : 'Send invitation'}
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <>
                <h2>{u.full_name ?? u.email}</h2>
                <p className="dim">
                  {u.email} · {statusOf(u)}
                  {u.force_password_change && ' · must change password'}
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveEdits(u, new FormData(e.currentTarget));
                  }}
                >
                  <label className="field">
                    <span>Full name</span>
                    <input name="fullName" defaultValue={u.full_name ?? ''} />
                  </label>
                  <label className="field">
                    <span>Phone</span>
                    <input name="phone" defaultValue={u.phone ?? ''} />
                  </label>
                  <label className="field">
                    <span>Role (change is logged)</span>
                    <select name="role" defaultValue={u.role}>
                      {(Object.keys(ROLE_LABELS) as UserRole[]).map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="drawer-actions">
                    <span className="spacer" />
                    <button className="btn" type="submit" disabled={busy}>
                      Save details
                    </button>
                  </div>
                </form>

                <h3 className="drawer-sub">Access</h3>
                <div className="action-grid">
                  <button
                    className="btn secondary"
                    disabled={busy || u.user_id === me}
                    onClick={() =>
                      call(
                        `/api/admin/users/${u.user_id}`,
                        { method: 'PATCH', body: JSON.stringify({ isActive: !u.is_active }) },
                        u.is_active ? 'Disabled — signed out everywhere.' : 'Re-enabled.'
                      )
                    }
                  >
                    {u.is_active ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    className="btn secondary"
                    disabled={busy}
                    onClick={() => action(u, { action: 'force_logout' }, 'Signed out everywhere.')}
                  >
                    Force logout
                  </button>
                  {u.role !== 'customer' && (
                    <>
                      <button
                        className="btn secondary"
                        disabled={busy}
                        onClick={() => {
                          const pw = window.prompt('New password (min 8 characters):');
                          if (pw)
                            action(
                              u,
                              { action: 'set_password', password: pw, forceChange: true },
                              'Password set — they must change it on next login.'
                            );
                        }}
                      >
                        Change password
                      </button>
                      <button
                        className="btn secondary"
                        disabled={busy}
                        onClick={() => action(u, { action: 'reset_link' }, 'Reset email sent.')}
                      >
                        Send reset email
                      </button>
                    </>
                  )}
                  {u.invite_pending && (
                    <>
                      <button
                        className="btn secondary"
                        disabled={busy}
                        onClick={() =>
                          action(u, { action: 'resend_invite', email: u.email }, 'Invitation re-sent.')
                        }
                      >
                        Resend invitation
                      </button>
                      <button
                        className="btn secondary"
                        disabled={busy}
                        onClick={() => action(u, { action: 'cancel_invite' }, 'Invitation cancelled.')}
                      >
                        Cancel invitation
                      </button>
                    </>
                  )}
                </div>

                <h3 className="drawer-sub danger">Delete</h3>
                <p className="dim">
                  Deleting scrubs credentials and personal data but keeps their name on every
                  project, upload and log entry. Prefer Disable.
                </p>
                <button
                  className="btn danger"
                  disabled={busy || u.user_id === me}
                  onClick={() => {
                    const confirmEmail = window.prompt(
                      `Type the user's email (${u.email}) to permanently delete:`
                    );
                    if (confirmEmail)
                      call(
                        `/api/admin/users/${u.user_id}`,
                        { method: 'DELETE', body: JSON.stringify({ confirmEmail }) },
                        'User deleted.'
                      ).then((ok) => ok && setDrawer(null));
                  }}
                >
                  Delete user…
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {newCompany && (
        <NewCompanyDialog
          onClose={() => setNewCompany(false)}
          onCreated={(company) => {
            setDealerList((list) =>
              [...list, company].sort((a, b) => a.name.localeCompare(b.name))
            );
            setDealerChoice(company.id);
            setNewCompany(false);
          }}
        />
      )}
    </>
  );
}

/**
 * Compact nested company form for the Add-user drawer — asks only for the
 * essentials; the rest of the record is filled in later from Admin → Dealers.
 * The half-typed user form stays mounted underneath, untouched on cancel.
 */
function NewCompanyDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (company: Option) => void;
}) {
  const [name, setName] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/dealers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          values: {
            name: name.trim(),
            primary_contact_name: contactName.trim() || null,
            primary_contact_email: contactEmail.trim(),
          },
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.id) {
        setError(json?.error ?? `Could not create the company (${res.status}).`);
        return;
      }
      onCreated({ id: json.id, name: name.trim() });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal>
        <h2>Add dealer company</h2>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <label className="field">
          <span>Company name *</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Primary contact name</span>
          <input value={contactName} onChange={(e) => setContactName(e.target.value)} />
        </label>
        <label className="field">
          <span>Primary contact email *</span>
          <input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
        </label>
        <div className="dialog-actions">
          <button className="btn secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy || !name.trim() || !contactEmail.trim()}
            onClick={create}
          >
            {busy ? 'Creating…' : 'Create & select'}
          </button>
        </div>
      </div>
    </div>
  );
}
