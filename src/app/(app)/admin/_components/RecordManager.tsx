'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { EntityField } from '@/lib/admin/entities';

type Row = Record<string, unknown> & { id: string; is_active: boolean };

/**
 * The panel's shared section pattern: searchable table with an
 * Active/Inactive filter, + Add opening a form drawer, row click to edit in
 * the same drawer, and a Deactivate toggle (never delete — inactive records
 * vanish from the PM's dropdowns, history keeps them).
 */
export function RecordManager({
  entity,
  nameColumn,
  fields,
  listColumns,
  rows,
}: {
  entity: string;
  nameColumn: string;
  fields: EntityField[];
  listColumns: string[];
  rows: Row[];
}) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [drawer, setDrawer] = useState<{ row: Row | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!showInactive && !r.is_active) return false;
      if (!q) return true;
      return Object.values(r).some(
        (v) => typeof v === 'string' && v.toLowerCase().includes(q)
      );
    });
  }, [rows, search, showInactive]);

  const labels = new Map(fields.map((f) => [f.name, f.label]));

  async function save(row: Row | null, form: FormData, nextActive?: boolean) {
    setBusy(true);
    setError(null);
    try {
      const values: Record<string, unknown> = {};
      for (const f of fields) values[f.name] = form.get(f.name);
      const res = await fetch(`/api/admin/records/${entity}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: row?.id,
          values,
          ...(nextActive === undefined ? {} : { isActive: nextActive }),
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `Save failed (${res.status}).`);
        return;
      }
      setDrawer(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="filters">
        <input
          type="search"
          placeholder="Search…"
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
        <button className="btn" type="button" onClick={() => setDrawer({ row: null })}>
          + Add
        </button>
      </div>

      <div className="table-wrap">
        <table className="projects-table">
          <thead>
            <tr>
              <th>Name</th>
              {listColumns.map((c) => (
                <th key={c}>{labels.get(c) ?? c}</th>
              ))}
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => setDrawer({ row: r })}>
                <td>
                  <span className="row-name">{String(r[nameColumn] ?? '—')}</span>
                </td>
                {listColumns.map((c) => (
                  <td key={c}>
                    {Array.isArray(r[c]) ? (r[c] as string[]).join(', ') : String(r[c] ?? '—')}
                  </td>
                ))}
                <td>{r.is_active ? 'active' : <span className="dim">inactive</span>}</td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={listColumns.length + 2} className="dim">
                  No records{search ? ' match' : ' yet — add the first one'}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {drawer && (
        <div className="drawer-backdrop" onClick={() => !busy && setDrawer(null)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <h2>{drawer.row ? `Edit ${String(drawer.row[nameColumn] ?? '')}` : '+ Add'}</h2>
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                save(drawer.row, new FormData(e.currentTarget));
              }}
            >
              {fields.map((f) => (
                <label className="field" key={f.name}>
                  <span>
                    {f.label}
                    {f.required ? ' *' : ''}
                  </span>
                  {f.type === 'textarea' ? (
                    <textarea
                      name={f.name}
                      rows={3}
                      defaultValue={String(drawer.row?.[f.name] ?? '')}
                    />
                  ) : f.type === 'rating' ? (
                    <select name={f.name} defaultValue={String(drawer.row?.[f.name] ?? '')}>
                      <option value="">—</option>
                      {[1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>
                          {'★'.repeat(n)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      name={f.name}
                      type={f.type === 'number' ? 'number' : f.type === 'email' ? 'email' : 'text'}
                      required={f.required}
                      defaultValue={
                        Array.isArray(drawer.row?.[f.name])
                          ? (drawer.row?.[f.name] as string[]).join(', ')
                          : String(drawer.row?.[f.name] ?? '')
                      }
                    />
                  )}
                </label>
              ))}
              <div className="drawer-actions">
                {drawer.row && (
                  <button
                    className="btn secondary"
                    type="button"
                    disabled={busy}
                    onClick={(e) => {
                      const form = (e.currentTarget.closest('form') as HTMLFormElement) ?? undefined;
                      if (form) save(drawer.row, new FormData(form), !drawer.row!.is_active);
                    }}
                  >
                    {drawer.row.is_active ? 'Deactivate' : 'Reactivate'}
                  </button>
                )}
                <span className="spacer" />
                <button className="btn secondary" type="button" onClick={() => setDrawer(null)}>
                  Cancel
                </button>
                <button className="btn" type="submit" disabled={busy}>
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
