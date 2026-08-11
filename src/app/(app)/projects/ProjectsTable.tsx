'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { RefOption } from '@/lib/projects/details';
import { STAGE_LABELS, type StageKey } from '@/lib/stages/definitions';
import type { ProjectCard } from '@/lib/stages/service';

/**
 * The Projects table body with bulk edit: select rows, then set the assigned
 * PM, dealer, or sales rep on all of them in one action — the common case
 * when a rep leaves or a PM takes over a book. Finished projects are skipped
 * by the server and reported back.
 */
export function ProjectsTable({
  rows,
  sortLinks,
  canBulk,
  bulkRefs,
}: {
  rows: ProjectCard[];
  sortLinks: Record<string, string>;
  canBulk: boolean;
  bulkRefs: { pms: RefOption[]; dealers: RefOption[]; salesReps: RefOption[] };
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [field, setField] = useState<'assigned_pm' | 'dealer_id' | 'sales_rep_id'>('assigned_pm');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const options =
    field === 'assigned_pm' ? bulkRefs.pms : field === 'dealer_id' ? bulkRefs.dealers : bulkRefs.salesReps;

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function apply() {
    if (!target || selected.size === 0) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch('/api/projects/bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [...selected], set: { [field]: target } }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setNotice(json?.error ?? `Bulk update failed (${res.status}).`);
        return;
      }
      setNotice(
        `Updated ${json.updated} project${json.updated === 1 ? '' : 's'}` +
          (json.skipped ? ` — ${json.skipped} finished project${json.skipped === 1 ? '' : 's'} skipped.` : '.')
      );
      setSelected(new Set());
      setTarget('');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const allVisible = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <>
      {canBulk && selected.size > 0 && (
        <div className="bulk-bar">
          <strong>{selected.size} selected</strong>
          <select
            value={field}
            onChange={(e) => {
              setField(e.target.value as typeof field);
              setTarget('');
            }}
          >
            <option value="assigned_pm">Set assigned PM</option>
            <option value="dealer_id">Set dealer</option>
            <option value="sales_rep_id">Set sales rep</option>
          </select>
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose…</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <button className="btn" type="button" disabled={busy || !target} onClick={apply}>
            {busy ? 'Applying…' : 'Apply'}
          </button>
          <button
            className="btn secondary"
            type="button"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </button>
        </div>
      )}
      {notice && <p className="notice ok">{notice}</p>}

      <div className="table-wrap">
        <table className="projects-table">
          <thead>
            <tr>
              {canBulk && (
                <th>
                  <input
                    type="checkbox"
                    checked={allVisible}
                    onChange={() =>
                      setSelected(allVisible ? new Set() : new Set(rows.map((r) => r.id)))
                    }
                  />
                </th>
              )}
              <th><Link href={sortLinks.name}>Customer</Link></th>
              <th>Address</th>
              <th><Link href={sortLinks.size}>kW</Link></th>
              <th><Link href={sortLinks.stage}>Stage</Link></th>
              <th><Link href={sortLinks.days}>Days in stage</Link></th>
              <th><Link href={sortLinks.missing}>Missing</Link></th>
              <th>Jurisdiction</th>
              <th>Dealer</th>
              <th>PM</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                {canBulk && (
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={() => toggle(p.id)}
                    />
                  </td>
                )}
                <td>
                  <Link href={`/projects/${p.id}`}>{p.name}</Link>
                  <div className="dim">{p.code}</div>
                </td>
                <td>{p.address ?? '—'}</td>
                <td>{p.systemSizeKw ?? '—'}</td>
                <td>{STAGE_LABELS[p.stage as StageKey] ?? p.stage}</td>
                <td>{p.daysInStage}</td>
                <td>
                  {p.status === 'complete' ? (
                    '—'
                  ) : p.missing.length > 0 ? (
                    <span className="missing-badge" title={p.missing.join('\n')}>
                      {p.missing.length}
                    </span>
                  ) : (
                    <span className="ok-dot" title="Ready to advance">✓</span>
                  )}
                </td>
                <td>{p.jurisdictionName ?? '—'}</td>
                <td>{p.dealerName ?? '—'}</td>
                <td>{p.pmName ?? '—'}</td>
                <td>{p.status.replace('_', ' ')}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={canBulk ? 11 : 10} className="dim">
                  No projects match. <Link href="/projects/new">Create the first one</Link>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
