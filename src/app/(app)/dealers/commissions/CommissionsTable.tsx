'use client';

import Link from 'next/link';

interface Row {
  id: string;
  name: string;
  projectTotal: number | null;
  base: number;
  adjustment: number;
  status: string;
  payableDate: string | null;
  paidDate: string | null;
}

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

/** Commission rows + pending/payable/paid totals + CSV statement export. */
export function CommissionsTable({ rows }: { rows: Row[] }) {
  const totals = { pending: 0, payable: 0, paid: 0 };
  for (const r of rows) {
    const t = r.base + r.adjustment;
    if (r.status === 'paid') totals.paid += t;
    else if (r.status === 'payable') totals.payable += t;
    else totals.pending += t;
  }

  function exportCsv() {
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    };
    const lines = [
      ['Customer', 'Project total', 'Base commission', 'Adjustment', 'Total', 'Status', 'Payable date', 'Paid date'].join(','),
      ...rows.map((r) =>
        [r.name, r.projectTotal ?? '', r.base.toFixed(2), r.adjustment.toFixed(2),
         (r.base + r.adjustment).toFixed(2), r.status, r.payableDate ?? '', r.paidDate ?? '']
          .map(esc).join(',')
      ),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'commission-statement.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="stat-cards">
        <div className="stat-card">
          <span className="stat-value">{money(totals.pending)}</span>
          <span className="stat-label">Pending</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{money(totals.payable)}</span>
          <span className="stat-label">Payable</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{money(totals.paid)}</span>
          <span className="stat-label">Paid</span>
        </div>
      </div>

      <div className="filters">
        <span className="dim">{rows.length} project{rows.length === 1 ? '' : 's'}</span>
        <span className="spacer" />
        <button className="btn secondary" type="button" onClick={exportCsv}>
          Export statement (CSV)
        </button>
      </div>

      <div className="table-wrap">
        <table className="projects-table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Project total</th>
              <th>Base</th>
              <th>Adjustment</th>
              <th>Total</th>
              <th>Status</th>
              <th>Payable</th>
              <th>Paid</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/dealers/projects/${r.id}`}>{r.name}</Link>
                </td>
                <td>{r.projectTotal === null ? '—' : money(r.projectTotal)}</td>
                <td>{money(r.base)}</td>
                <td>{money(r.adjustment)}</td>
                <td>
                  <strong>{money(r.base + r.adjustment)}</strong>
                </td>
                <td>{r.status}</td>
                <td>{r.payableDate ? new Date(r.payableDate).toLocaleDateString() : '—'}</td>
                <td>{r.paidDate ? new Date(r.paidDate).toLocaleDateString() : '—'}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="dim">
                  No commissions set yet — they appear here once the PM team enters them.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
