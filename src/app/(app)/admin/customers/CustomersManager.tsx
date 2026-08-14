'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { CustomerRow } from '@/lib/customers/service';
import { STAGE_LABELS, type StageKey } from '@/lib/stages/definitions';
import { CustomerDrawer } from './CustomerDrawer';
import { MergeDialog } from './MergeDialog';

const PORTAL_LABELS: Record<CustomerRow['portal'], string> = {
  none: 'no access',
  invited: 'invited',
  active: 'active',
  disabled: 'disabled',
};

type PortalFilter = 'any' | 'none' | 'invited' | 'active' | 'disabled';
type ProjectFilter = 'any' | 'has_active' | 'completed_only' | 'none';

/**
 * The Customers list: search by name, email, phone or site address — staff
 * often remember the house before the name — filters for the states that
 * matter, a row menu, bulk invite for switching portal access on across an
 * existing book, and CSV export of what is on screen.
 */
export function CustomersManager({
  customers,
  duplicates,
  dealers,
  isAdmin,
}: {
  customers: CustomerRow[];
  duplicates: Array<{ a: string; b: string; reason: string }>;
  dealers: Array<{ id: string; name: string }>;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [portalFilter, setPortalFilter] = useState<PortalFilter>('any');
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>('any');
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState<{ customer: CustomerRow | null } | null>(null);
  const [merging, setMerging] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const byId = useMemo(() => new Map(customers.map((c) => [c.id, c])), [customers]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return customers.filter((c) => {
      if (!showArchived && c.isArchived) return false;
      if (portalFilter !== 'any' && c.portal !== portalFilter) return false;
      if (projectFilter === 'has_active'
          && !(c.projectCount > c.completedCount)) return false;
      if (projectFilter === 'completed_only'
          && !(c.projectCount > 0 && c.projectCount === c.completedCount)) return false;
      if (projectFilter === 'none' && c.projectCount > 0) return false;
      if (!q) return true;
      return [c.firstName, c.lastName, `${c.firstName} ${c.lastName}`, c.email, c.phone,
              c.alternatePhone, c.cityState, c.mailingAddress]
        .some((v) => v?.toLowerCase().includes(q));
    });
  }, [customers, search, portalFilter, projectFilter, showArchived]);

  const dupPairs = duplicates
    .map((d) => ({ ...d, aRow: byId.get(d.a), bRow: byId.get(d.b) }))
    .filter((d) => d.aRow && d.bRow);

  async function call(url: string, init: RequestInit, okMessage?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, { headers: { 'content-type': 'application/json' }, ...init });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `Failed (${res.status}).`);
        return null;
      }
      if (okMessage) setNotice(json?.inviteLink ? `${okMessage} Link: ${json.inviteLink}` : okMessage);
      router.refresh();
      return json ?? {};
    } finally {
      setBusy(false);
    }
  }

  async function bulkInvite() {
    const ids = [...selected].filter((id) => {
      const c = byId.get(id);
      return c && c.email && c.portal === 'none';
    });
    if (ids.length === 0) {
      setError('None of the selected customers have an email address and no login yet.');
      return;
    }
    setBusy(true);
    setError(null);
    let sent = 0;
    for (const id of ids) {
      const res = await fetch(`/api/customers/${id}/portal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'invite' }),
      });
      if (res.ok) sent += 1;
    }
    setBusy(false);
    setNotice(`Invited ${sent} of ${ids.length} selected customer${ids.length === 1 ? '' : 's'}.`);
    setSelected(new Set());
    router.refresh();
  }

  function exportCsv() {
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    };
    const lines = [
      ['Name', 'Email', 'Phone', 'City/State', 'Projects', 'Current stage', 'Portal access',
       'Last activity', 'Status'].join(','),
      ...visible.map((c) =>
        [`${c.firstName} ${c.lastName}`, c.email ?? '', c.phone ?? '', c.cityState ?? '',
         c.projectCount, c.currentStage ? (STAGE_LABELS[c.currentStage as StageKey] ?? c.currentStage) : '',
         PORTAL_LABELS[c.portal], c.lastActivity?.slice(0, 10) ?? '',
         c.isArchived ? 'archived' : 'active'].map(esc).join(',')
      ),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'customers.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="notice ok">{notice}</p>}

      {isAdmin && dupPairs.length > 0 && (
        <div className="notice hold">
          <strong>Possible duplicates ({dupPairs.length}).</strong>{' '}
          {dupPairs.slice(0, 3).map((d, i) => (
            <span key={`${d.a}-${d.b}`}>
              {i > 0 ? ' · ' : ' '}
              <button
                className="linklike"
                type="button"
                onClick={() => setMerging([d.a, d.b])}
              >
                {d.aRow!.firstName} {d.aRow!.lastName} / {d.bRow!.firstName} {d.bRow!.lastName} ({d.reason})
              </button>
            </span>
          ))}
          {dupPairs.length > 3 && <span className="dim"> …and {dupPairs.length - 3} more</span>}
        </div>
      )}

      <div className="filters">
        <input
          type="search"
          placeholder="Search name, email, phone or site address…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={portalFilter} onChange={(e) => setPortalFilter(e.target.value as PortalFilter)}>
          <option value="any">Any portal state</option>
          <option value="none">No portal access</option>
          <option value="invited">Invited, never logged in</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </select>
        <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value as ProjectFilter)}>
          <option value="any">Any projects</option>
          <option value="has_active">Has an active project</option>
          <option value="completed_only">Completed only</option>
          <option value="none">No projects yet</option>
        </select>
        <label className="check-inline">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived
        </label>
        <span className="spacer" />
        <button className="btn secondary" type="button" onClick={exportCsv}>
          Export CSV
        </button>
        <button className="btn" type="button" onClick={() => setDrawer({ customer: null })}>
          + Add customer
        </button>
      </div>

      {selected.size > 0 && (
        <div className="bulk-bar">
          <strong>{selected.size} selected</strong>
          <button className="btn" type="button" disabled={busy} onClick={bulkInvite}>
            Invite to portal
          </button>
          {isAdmin && selected.size >= 2 && (
            <button
              className="btn secondary"
              type="button"
              disabled={busy}
              onClick={() => setMerging([...selected])}
            >
              Merge…
            </button>
          )}
          <button className="btn secondary" type="button" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}

      <div className="table-wrap">
        <table className="projects-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={visible.length > 0 && visible.every((c) => selected.has(c.id))}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(visible.map((c) => c.id)) : new Set())
                  }
                />
              </th>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>City / state</th>
              <th>Projects</th>
              <th>Current stage</th>
              <th>Portal access</th>
              <th>Last activity</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((c) => (
              <tr key={c.id} className={c.isArchived ? 'dim' : ''}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={() =>
                      setSelected((s) => {
                        const next = new Set(s);
                        if (next.has(c.id)) next.delete(c.id);
                        else next.add(c.id);
                        return next;
                      })
                    }
                  />
                </td>
                <td>
                  <button className="linklike" type="button" onClick={() => setDrawer({ customer: c })}>
                    {c.firstName} {c.lastName}
                  </button>
                  {c.anonymisedAt && <span className="dim"> · anonymised</span>}
                  {c.isArchived && !c.anonymisedAt && <span className="dim"> · archived</span>}
                </td>
                <td>{c.email ?? '—'}</td>
                <td>{c.phone ?? '—'}</td>
                <td>{c.cityState ?? '—'}</td>
                <td>
                  {c.projectCount === 0 ? '0' : (
                    <Link href={`/projects?q=${encodeURIComponent(`${c.firstName} ${c.lastName}`)}`}>
                      {c.projectCount}
                    </Link>
                  )}
                  {c.completedCount > 0 && <span className="dim"> ({c.completedCount} done)</span>}
                </td>
                <td>
                  {c.currentStage
                    ? (STAGE_LABELS[c.currentStage as StageKey] ?? c.currentStage)
                    : '—'}
                </td>
                <td>{PORTAL_LABELS[c.portal]}</td>
                <td>{c.lastActivity ? c.lastActivity.slice(0, 10) : '—'}</td>
                <td>
                  <span className="ref-row">
                    <button
                      className="btn secondary small"
                      type="button"
                      onClick={() => setDrawer({ customer: c })}
                    >
                      Open
                    </button>
                    {c.portal === 'none' && c.email && (
                      <button
                        className="btn secondary small"
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          call(`/api/customers/${c.id}/portal`,
                            { method: 'POST', body: JSON.stringify({ action: 'invite' }) },
                            'Invitation sent.')
                        }
                      >
                        Invite
                      </button>
                    )}
                    {c.portal === 'invited' && (
                      <button
                        className="btn secondary small"
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          call(`/api/customers/${c.id}/portal`,
                            { method: 'POST', body: JSON.stringify({ action: 'resend_invite' }) },
                            'Invitation re-sent.')
                        }
                      >
                        Resend
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={10} className="dim">
                  No customers{search ? ' match that search' : ' yet'}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {drawer && (
        <CustomerDrawer
          customer={drawer.customer}
          dealers={dealers}
          isAdmin={isAdmin}
          onClose={() => setDrawer(null)}
          onSaved={() => {
            setDrawer(null);
            router.refresh();
          }}
        />
      )}

      {merging && (
        <MergeDialog
          ids={merging}
          onClose={() => setMerging(null)}
          onMerged={(summary) => {
            setMerging(null);
            setSelected(new Set());
            setNotice(
              `Merged. ${summary.projects} project(s), ${summary.documents} document(s) and ` +
              `${summary.messages ?? summary.requests ?? 0} message(s) now belong to the surviving record.`
            );
            router.refresh();
          }}
        />
      )}
    </>
  );
}
