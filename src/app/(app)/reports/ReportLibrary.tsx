'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface SavedReport {
  id: string;
  name: string;
  description: string | null;
  visibility: string;
  ownerName: string | null;
  isMine: boolean;
  updatedAt: string;
}

/** My reports / Shared with me, with run, duplicate and delete. */
export function ReportLibrary({ reports }: { reports: SavedReport[] }) {
  const router = useRouter();
  const [tab, setTab] = useState<'mine' | 'shared'>('mine');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = reports.filter((r) => (tab === 'mine' ? r.isMine : !r.isMine));

  async function remove(report: SavedReport) {
    if (!window.confirm(`Delete “${report.name}”? Saved reports can be rebuilt, but this cannot be undone.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/reports/${report.id}`, { method: 'DELETE' });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `Delete failed (${res.status}).`);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="admin-tabs">
        <button
          className={`linklike${tab === 'mine' ? ' active' : ''}`}
          type="button"
          onClick={() => setTab('mine')}
        >
          My reports ({reports.filter((r) => r.isMine).length})
        </button>
        <button
          className={`linklike${tab === 'shared' ? ' active' : ''}`}
          type="button"
          onClick={() => setTab('shared')}
        >
          Shared with me ({reports.filter((r) => !r.isMine).length})
        </button>
      </div>

      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      <div className="table-wrap">
        <table className="projects-table">
          <thead>
            <tr>
              <th>Report</th>
              <th>Owner</th>
              <th>Visibility</th>
              <th>Last modified</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/reports/builder?report=${r.id}`}>{r.name}</Link>
                  {r.description && <div className="dim">{r.description}</div>}
                </td>
                <td>{r.isMine ? 'me' : (r.ownerName ?? '—')}</td>
                <td>{r.visibility === 'role' ? 'shared with role' : r.visibility}</td>
                <td>{new Date(r.updatedAt).toLocaleDateString()}</td>
                <td>
                  <span className="ref-row">
                    <Link className="btn secondary small" href={`/reports/builder?report=${r.id}`}>
                      Open
                    </Link>
                    <Link className="btn secondary small" href={`/reports/builder?report=${r.id}&copy=1`}>
                      Duplicate
                    </Link>
                    {r.isMine && (
                      <button
                        className="btn secondary small"
                        type="button"
                        disabled={busy}
                        onClick={() => remove(r)}
                      >
                        Delete
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr>
                <td colSpan={5} className="dim">
                  {tab === 'mine'
                    ? 'No saved reports yet — open a template above and save it.'
                    : 'Nothing shared with you yet.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
