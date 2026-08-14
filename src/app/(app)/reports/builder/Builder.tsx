'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DATE_GRAINS, EMPTY_DEFINITION, RELATIVE_RANGES,
  type DateGrain, type ReportDefinition, type ReportFilter,
} from '@/lib/reports/definition';
import { AGGREGATIONS, type Aggregation } from '@/lib/reports/fields';
import { STAGES, STAGE_LABELS } from '@/lib/stages/definitions';
import { FieldLibrary, type LibraryField } from './FieldLibrary';
import { FilterEditor, describeFilter } from './FilterEditor';
import { PreviewTable, type PreviewData } from './PreviewTable';

type Zone = 'columns' | 'groupBy' | 'filters' | 'summarise';

export interface BuilderRefs {
  dealers: Array<{ id: string; name: string }>;
  reps: Array<{ id: string; name: string }>;
  pms: Array<{ id: string; name: string }>;
}

/**
 * The report canvas: four drop zones (Columns · Group by · Filters ·
 * Summarise), a settings panel, and a live preview that re-runs on every
 * change. A zone that cannot accept the field being dragged greys out, and the
 * reason is shown rather than the drop being silently ignored.
 */
export function Builder({
  fields,
  refs,
  initial,
  savedReportId,
  initialName,
  initialDescription,
  canShare,
}: {
  fields: LibraryField[];
  refs: BuilderRefs;
  initial: ReportDefinition;
  savedReportId?: string;
  initialName: string;
  initialDescription?: string | null;
  canShare: boolean;
}) {
  const byKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const [definition, setDefinition] = useState<ReportDefinition>({ ...EMPTY_DEFINITION, ...initial });
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription ?? '');
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState<LibraryField | null>(null);
  const [filterDraft, setFilterDraft] = useState<{ field: LibraryField; existing?: ReportFilter; index?: number } | null>(null);
  const [savedId, setSavedId] = useState(savedReportId);
  const [visibility, setVisibility] = useState<'private' | 'role' | 'users'>('private');
  const [sharedRoles, setSharedRoles] = useState<string[]>([]);
  const runToken = useRef(0);

  /** Which zones may accept a field, with the reason when they may not. */
  const zoneRejection = useCallback((zone: Zone, field: LibraryField): string | null => {
    if (zone === 'summarise' && !field.summarisable) {
      return 'Only numbers and dates can be summarised';
    }
    if (zone === 'groupBy' && !field.groupable) return 'This field cannot be grouped';
    if (zone === 'groupBy' && definition.groupBy.length >= 3) return 'Up to three group levels';
    if (zone === 'filters' && !field.filterable) return 'This field cannot be filtered';
    return null;
  }, [definition.groupBy.length]);

  // Live preview: every change re-runs the first 50 rows.
  useEffect(() => {
    const token = ++runToken.current;
    const timer = setTimeout(async () => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch('/api/reports/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ definition, reportId: savedId, name }),
        });
        const json = await res.json().catch(() => null);
        if (token !== runToken.current) return;
        if (!res.ok) {
          setError(json?.error ?? `Preview failed (${res.status}).`);
          return;
        }
        setPreview(json as PreviewData);
      } finally {
        if (token === runToken.current) setBusy(false);
      }
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(definition)]);

  function onDrop(zone: Zone, e: React.DragEvent) {
    e.preventDefault();
    const key = e.dataTransfer.getData('text/plain');
    const field = byKey.get(key);
    setDragging(null);
    if (!field) return;
    const reason = zoneRejection(zone, field);
    if (reason) {
      setNotice(reason);
      setTimeout(() => setNotice(null), 3000);
      return;
    }
    setDefinition((d) => {
      switch (zone) {
        case 'columns':
          return d.columns.some((c) => c.field === key)
            ? d
            : { ...d, columns: [...d.columns, { field: key }] };
        case 'groupBy':
          return d.groupBy.some((g) => g.field === key)
            ? d
            : { ...d, groupBy: [...d.groupBy, { field: key }] };
        case 'summarise': {
          const agg: Aggregation = field.type === 'date' ? 'max' : 'sum';
          return d.summarise.some((s) => s.field === key && s.agg === agg)
            ? d
            : { ...d, summarise: [...d.summarise, { field: key, agg }] };
        }
        default:
          return d;
      }
    });
    if (zone === 'filters') setFilterDraft({ field });
  }

  const label = (key: string) => byKey.get(key)?.label ?? key;

  async function save(asNew: boolean) {
    if (!name.trim()) {
      setError('Give the report a name before saving.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: asNew ? undefined : savedId,
          name,
          description: description || null,
          definition,
          visibility,
          sharedRoles,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `Save failed (${res.status}).`);
        return;
      }
      setSavedId(json.id);
      setNotice(asNew ? 'Saved as a new report.' : 'Report saved.');
      setTimeout(() => setNotice(null), 3000);
    } finally {
      setBusy(false);
    }
  }

  async function exportAs(format: 'xlsx' | 'csv') {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/reports/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition, format, name, description, reportId: savedId }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        setError(json?.error ?? `Export failed (${res.status}).`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name.trim().replaceAll(' ', '-').toLowerCase() || 'report'}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  }

  const dropZone = (zone: Zone, title: string, hint: string, body: React.ReactNode) => {
    const reason = dragging ? zoneRejection(zone, dragging) : null;
    return (
      <section
        className={`drop-zone${dragging ? (reason ? ' invalid' : ' valid') : ''}`}
        onDragOver={(e) => {
          if (!reason) e.preventDefault();
        }}
        onDrop={(e) => onDrop(zone, e)}
        title={reason ?? undefined}
      >
        <header>
          <strong>{title}</strong>
          <span className="dim">{hint}</span>
        </header>
        <div className="chips">{body}</div>
      </section>
    );
  };

  return (
    <div className="report-builder" onDragEnd={() => setDragging(null)}>
      <div className="report-topbar">
        <input
          className="report-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Report name"
        />
        <span className="spacer" />
        {busy && <span className="dim">working…</span>}
        <button className="btn secondary" type="button" disabled={busy} onClick={() => save(false)}>
          Save
        </button>
        {savedId && (
          <button className="btn secondary" type="button" disabled={busy} onClick={() => save(true)}>
            Save as
          </button>
        )}
        <button className="btn" type="button" disabled={busy} onClick={() => exportAs('xlsx')}>
          Export Excel
        </button>
        <button className="btn secondary" type="button" disabled={busy} onClick={() => exportAs('csv')}>
          CSV
        </button>
        <button className="btn secondary" type="button" onClick={() => window.print()}>
          Print / PDF
        </button>
        <Link className="btn-link" href="/reports">
          Library
        </Link>
      </div>

      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="notice ok">{notice}</p>}

      <div className="report-grid">
        <FieldLibrary fields={fields} onDragField={setDragging} />

        <div className="report-canvas">
          {dropZone('columns', 'Columns', 'what appears, left to right',
            definition.columns.length === 0 ? <span className="dim">Drag fields here.</span> :
            definition.columns.map((c, i) => (
              <ColumnChip
                key={`${c.field}-${i}`}
                label={c.label ?? label(c.field)}
                type={byKey.get(c.field)?.type ?? 'text'}
                grain={c.grain}
                onRename={(next) =>
                  setDefinition((d) => ({
                    ...d,
                    columns: d.columns.map((x, j) => (j === i ? { ...x, label: next } : x)),
                  }))
                }
                onGrain={(g) =>
                  setDefinition((d) => ({
                    ...d,
                    columns: d.columns.map((x, j) => (j === i ? { ...x, grain: g } : x)),
                  }))
                }
                onMove={(dir) =>
                  setDefinition((d) => {
                    const next = [...d.columns];
                    const target = i + dir;
                    if (target < 0 || target >= next.length) return d;
                    [next[i], next[target]] = [next[target], next[i]];
                    return { ...d, columns: next };
                  })
                }
                onRemove={() =>
                  setDefinition((d) => ({ ...d, columns: d.columns.filter((_, j) => j !== i) }))
                }
              />
            ))
          )}

          {dropZone('groupBy', 'Group by', 'row grouping · up to 3 levels',
            definition.groupBy.length === 0 ? <span className="dim">Optional.</span> :
            definition.groupBy.map((g, i) => (
              <span className="chip" key={`${g.field}-${i}`}>
                {i + 1}. {label(g.field)}
                {byKey.get(g.field)?.type === 'date' && (
                  <select
                    value={g.grain ?? 'day'}
                    onChange={(e) =>
                      setDefinition((d) => ({
                        ...d,
                        groupBy: d.groupBy.map((x, j) =>
                          j === i ? { ...x, grain: e.target.value as DateGrain } : x
                        ),
                      }))
                    }
                  >
                    {DATE_GRAINS.map((gr) => (
                      <option key={gr} value={gr}>{gr}</option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setDefinition((d) => ({ ...d, groupBy: d.groupBy.filter((_, j) => j !== i) }))
                  }
                >
                  ×
                </button>
              </span>
            ))
          )}

          {dropZone('filters', 'Filters', 'which records',
            definition.filters.length === 0 ? <span className="dim">Everything in scope.</span> :
            definition.filters.map((f, i) => (
              <span className="chip" key={`${f.field}-${i}`}>
                <button
                  className="chip-label"
                  type="button"
                  onClick={() => {
                    const fld = byKey.get(f.field);
                    if (fld) setFilterDraft({ field: fld, existing: f, index: i });
                  }}
                >
                  {describeFilter(f, label(f.field))}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setDefinition((d) => ({ ...d, filters: d.filters.filter((_, j) => j !== i) }))
                  }
                >
                  ×
                </button>
              </span>
            ))
          )}

          {dropZone('summarise', 'Summarise', 'totals and averages',
            definition.summarise.length === 0 ? <span className="dim">Numbers and dates only.</span> :
            definition.summarise.map((s, i) => (
              <span className="chip" key={`${s.field}-${s.agg}-${i}`}>
                <select
                  value={s.agg}
                  onChange={(e) =>
                    setDefinition((d) => ({
                      ...d,
                      summarise: d.summarise.map((x, j) =>
                        j === i ? { ...x, agg: e.target.value as Aggregation } : x
                      ),
                    }))
                  }
                >
                  {AGGREGATIONS.filter((a) =>
                    byKey.get(s.field)?.type === 'date' ? ['count', 'min', 'max'].includes(a) : true
                  ).map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
                {label(s.field)}
                <button
                  type="button"
                  onClick={() =>
                    setDefinition((d) => ({ ...d, summarise: d.summarise.filter((_, j) => j !== i) }))
                  }
                >
                  ×
                </button>
              </span>
            ))
          )}

          <PreviewTable data={preview} busy={busy} />
        </div>

        <aside className="report-panel">
          <h3>Settings</h3>
          <label className="field">
            <span>Description</span>
            <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>

          <h4>Stage scope</h4>
          <div className="stage-scope">
            {STAGES.map((s) => (
              <label className="check-inline" key={s}>
                <input
                  type="checkbox"
                  checked={definition.stages.length === 0 || definition.stages.includes(s)}
                  onChange={(e) =>
                    setDefinition((d) => {
                      const current = d.stages.length === 0 ? [...STAGES] : d.stages;
                      const next = e.target.checked
                        ? [...new Set([...current, s])]
                        : current.filter((x) => x !== s);
                      return { ...d, stages: next.length === STAGES.length ? [] : next };
                    })
                  }
                />
                {STAGE_LABELS[s]}
              </label>
            ))}
          </div>
          <label className="field">
            <span>Stage question</span>
            <select
              value={definition.stageMode}
              onChange={(e) =>
                setDefinition((d) => ({
                  ...d,
                  stageMode: e.target.value === 'passed_through' ? 'passed_through' : 'currently_in',
                }))
              }
            >
              <option value="currently_in">Currently in those stages</option>
              <option value="passed_through">Ever passed through them</option>
            </select>
            <small className="dim">
              Cycle-time and throughput reporting needs “passed through”; a snapshot needs
              “currently in”.
            </small>
          </label>
          <label className="check-inline">
            <input
              type="checkbox"
              checked={definition.includeHold}
              onChange={(e) => setDefinition((d) => ({ ...d, includeHold: e.target.checked }))}
            />
            Include projects on hold
          </label>
          <label className="check-inline">
            <input
              type="checkbox"
              checked={definition.includeCancelled}
              onChange={(e) => setDefinition((d) => ({ ...d, includeCancelled: e.target.checked }))}
            />
            Include cancelled
          </label>

          <h4>Date range</h4>
          <label className="field">
            <span>Applies to</span>
            <select
              value={definition.dateRange?.field ?? ''}
              onChange={(e) =>
                setDefinition((d) => ({
                  ...d,
                  dateRange: e.target.value
                    ? { field: e.target.value, mode: 'relative', relative: 'last_30_days' }
                    : undefined,
                }))
              }
            >
              <option value="">No date limit</option>
              {fields.filter((f) => f.type === 'date').map((f) => (
                <option key={f.key} value={f.key}>{f.label}</option>
              ))}
            </select>
          </label>
          {definition.dateRange && (
            <>
              <label className="field">
                <span>Window</span>
                <select
                  value={definition.dateRange.mode === 'fixed' ? 'fixed' : definition.dateRange.relative}
                  onChange={(e) =>
                    setDefinition((d) => ({
                      ...d,
                      dateRange: e.target.value === 'fixed'
                        ? { ...d.dateRange!, mode: 'fixed', relative: undefined }
                        : { ...d.dateRange!, mode: 'relative', relative: e.target.value as typeof RELATIVE_RANGES[number] },
                    }))
                  }
                >
                  {RELATIVE_RANGES.map((r) => (
                    <option key={r} value={r}>{r.replaceAll('_', ' ')}</option>
                  ))}
                  <option value="fixed">fixed dates…</option>
                </select>
              </label>
              {definition.dateRange.mode === 'fixed' && (
                <div className="ref-row">
                  <input
                    type="date"
                    value={definition.dateRange.from ?? ''}
                    onChange={(e) =>
                      setDefinition((d) => ({ ...d, dateRange: { ...d.dateRange!, from: e.target.value } }))
                    }
                  />
                  <input
                    type="date"
                    value={definition.dateRange.to ?? ''}
                    onChange={(e) =>
                      setDefinition((d) => ({ ...d, dateRange: { ...d.dateRange!, to: e.target.value } }))
                    }
                  />
                </div>
              )}
            </>
          )}

          <h4>Record scope</h4>
          <label className="field">
            <select
              value={definition.recordScope.type}
              onChange={(e) =>
                setDefinition((d) => ({
                  ...d,
                  recordScope: { type: e.target.value as ReportDefinition['recordScope']['type'] },
                }))
              }
            >
              <option value="all">All projects</option>
              <option value="mine">My projects (assigned PM)</option>
              <option value="dealer">By dealer…</option>
              <option value="rep">By sales rep…</option>
              <option value="pm">By PM…</option>
            </select>
          </label>
          {['dealer', 'rep', 'pm'].includes(definition.recordScope.type) && (
            <label className="field">
              <select
                value={definition.recordScope.id ?? ''}
                onChange={(e) =>
                  setDefinition((d) => ({
                    ...d,
                    recordScope: { ...d.recordScope, id: e.target.value || undefined },
                  }))
                }
              >
                <option value="">Choose…</option>
                {(definition.recordScope.type === 'dealer' ? refs.dealers
                  : definition.recordScope.type === 'rep' ? refs.reps : refs.pms).map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
            </label>
          )}

          <h4>Sort</h4>
          <div className="ref-row">
            <select
              value={definition.sort?.field ?? ''}
              onChange={(e) =>
                setDefinition((d) => ({
                  ...d,
                  sort: e.target.value ? { field: e.target.value, dir: d.sort?.dir ?? 'desc' } : undefined,
                }))
              }
            >
              <option value="">Newest first</option>
              {definition.columns.map((c) => (
                <option key={c.field} value={c.field}>{label(c.field)}</option>
              ))}
            </select>
            {definition.sort && (
              <select
                value={definition.sort.dir}
                onChange={(e) =>
                  setDefinition((d) => ({
                    ...d,
                    sort: { field: d.sort!.field, dir: e.target.value === 'asc' ? 'asc' : 'desc' },
                  }))
                }
              >
                <option value="desc">descending</option>
                <option value="asc">ascending</option>
              </select>
            )}
          </div>

          <h4>Sharing</h4>
          <label className="field">
            <select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as 'private' | 'role' | 'users')}
              disabled={!canShare}
            >
              <option value="private">Private (only me)</option>
              <option value="role">Shared with a role…</option>
            </select>
          </label>
          {visibility === 'role' && (
            <div className="stage-scope">
              {['admin', 'ops', 'finance'].map((r) => (
                <label className="check-inline" key={r}>
                  <input
                    type="checkbox"
                    checked={sharedRoles.includes(r)}
                    onChange={(e) =>
                      setSharedRoles((rs) => (e.target.checked ? [...rs, r] : rs.filter((x) => x !== r)))
                    }
                  />
                  {r === 'ops' ? 'PMs' : r}
                </label>
              ))}
            </div>
          )}
          {definition.includeInternalNotes !== undefined && (
            <label className="check-inline">
              <input
                type="checkbox"
                checked={definition.includeInternalNotes === true}
                onChange={(e) =>
                  setDefinition((d) => ({ ...d, includeInternalNotes: e.target.checked }))
                }
              />
              Include internal notes
            </label>
          )}
        </aside>
      </div>

      {filterDraft && (
        <FilterEditor
          field={filterDraft.field}
          initial={filterDraft.existing}
          onCancel={() => setFilterDraft(null)}
          onSave={(filter) => {
            setDefinition((d) => ({
              ...d,
              filters: filterDraft.index === undefined
                ? [...d.filters, filter]
                : d.filters.map((x, j) => (j === filterDraft.index ? filter : x)),
            }));
            setFilterDraft(null);
          }}
        />
      )}
    </div>
  );
}

function ColumnChip({
  label,
  type,
  grain,
  onRename,
  onGrain,
  onMove,
  onRemove,
}: {
  label: string;
  type: string;
  grain?: DateGrain;
  onRename: (next: string) => void;
  onGrain: (g: DateGrain) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="chip">
      <button className="chip-label" type="button" onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      <button type="button" onClick={() => onMove(-1)} title="Move left">‹</button>
      <button type="button" onClick={() => onMove(1)} title="Move right">›</button>
      <button type="button" onClick={onRemove} title="Remove">×</button>
      {open && (
        <span className="chip-menu">
          <input
            defaultValue={label}
            placeholder="Header"
            onBlur={(e) => {
              onRename(e.target.value);
              setOpen(false);
            }}
          />
          {type === 'date' && (
            <select value={grain ?? 'day'} onChange={(e) => onGrain(e.target.value as DateGrain)}>
              {DATE_GRAINS.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          )}
        </span>
      )}
    </span>
  );
}
