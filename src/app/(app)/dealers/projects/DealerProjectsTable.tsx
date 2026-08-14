'use client';

import Link from 'next/link';
import type { DealerProjectRow } from '@/lib/dealer/portal';
import { STAGE_LABELS } from '@/lib/stages/definitions';

function pretty(v: string | null): string {
  return v ? v.replaceAll('_', ' ') : '—';
}

/** The dealer's project table with client-side CSV export of what's shown. */
export function DealerProjectsTable({ rows }: { rows: DealerProjectRow[] }) {
  function exportCsv() {
    const header = [
      'Customer', 'Site address', 'System size (kW)', 'Sales rep', 'Current stage',
      'Stage status', 'Days in stage', 'Project total', 'Commission status',
    ];
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    };
    const lines = [
      header.join(','),
      ...rows.map((r) =>
        [
          r.name, r.address ?? '', r.systemSizeKw ?? '', r.salesRepName ?? '',
          STAGE_LABELS[r.stage] ?? r.stage, pretty(r.stageStatus), r.daysInStage,
          r.projectTotal ?? '', r.commissionStatus ?? 'pending',
        ].map(esc).join(',')
      ),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'my-projects.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="filters">
        <span className="dim">{rows.length} project{rows.length === 1 ? '' : 's'}</span>
        <span className="spacer" />
        <button className="btn secondary" type="button" onClick={exportCsv}>
          Export CSV
        </button>
      </div>
      <div className="table-wrap">
        <table className="projects-table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Site address</th>
              <th>kW</th>
              <th>Sales rep</th>
              <th>Stage</th>
              <th>Stage status</th>
              <th>Days in stage</th>
              <th>Project total</th>
              <th>Commission</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/dealers/projects/${r.id}`}>{r.name}</Link>
                </td>
                <td>{r.address ?? '—'}</td>
                <td>{r.systemSizeKw ?? '—'}</td>
                <td>{r.salesRepName ?? '—'}</td>
                <td>
                  {r.status === 'on_hold' ? (
                    <span className="hold-chip">Hold</span>
                  ) : r.status === 'cancelled' ? (
                    'Cancelled'
                  ) : (
                    STAGE_LABELS[r.stage] ?? r.stage
                  )}
                </td>
                <td>{pretty(r.stageStatus)}</td>
                <td>
                  <span className={r.daysInStage > 21 && r.status === 'active' ? 'days-amber' : ''}>
                    {r.daysInStage}
                  </span>
                </td>
                <td>{r.projectTotal === null ? '—' : `$${r.projectTotal.toLocaleString()}`}</td>
                <td>{pretty(r.commissionStatus ?? 'pending')}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="dim">
                  No projects match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
