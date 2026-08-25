'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { isoDate } from '@/lib/dates';
import {
  PERMIT_OPTIONS,
  statusLabel,
  type StageCard,
  type StageField,
} from '@/lib/stages/fields';

interface Option {
  id: string;
  name: string;
}

interface DocItem {
  id: string;
  title: string | null;
}

const AGE_AMBER_DAYS = 14;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Days between two calendar dates. Both ends go through isoDate first, because
 * a half-parsed date is worse than no chip at all: 'Tue Aug 25' is a *valid*
 * date to `new Date` — it means 2001 — and that is what made a survey completed
 * today report 9,142 days.
 */
function daysBetween(from: unknown, to: unknown): number | null {
  const start = isoDate(from);
  if (!start) return null;
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endIso = isoDate(to);
  const endMs = endIso ? Date.parse(`${endIso}T00:00:00Z`) : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(0, Math.round((endMs - startMs) / 86_400_000));
}

/**
 * The stage form renderer, driven by the field registry. Track cards are
 * collapsible with a status chip in the header (a PM sees which of the five
 * Permit tracks is outstanding without scrolling); status dropdowns
 * auto-stamp their matching date (always editable); 'Days' counters run live
 * and turn amber past the ageing threshold; Drive Updated closes the stage.
 */
export function StageForm({
  projectId,
  stage,
  cards,
  initialValues,
  docs,
  refs,
  projectCreatedAt,
  editable,
}: {
  projectId: string;
  stage: string;
  cards: StageCard[];
  initialValues: Record<string, unknown>;
  docs: Record<string, DocItem[]>;
  refs: { designers: Option[]; staff: Option[]; financePartners: Option[] };
  projectCreatedAt: string;
  editable: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, unknown>>(initialValues);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const savable = useMemo(
    () =>
      cards
        .flatMap((c) => c.fields)
        .filter((f) => f.type !== 'upload')
        .map((f) => f.name),
    [cards]
  );

  function set(name: string, value: unknown) {
    setValues((v) => ({ ...v, [name]: value }));
    setDirty(true);
    setNotice(null);
  }

  function setStatus(field: StageField, value: string) {
    setValues((v) => {
      const next: Record<string, unknown> = { ...v, [field.name]: value || null };
      const stampField = field.stamp?.[value];
      if (stampField && !next[stampField]) next[stampField] = today();
      return next;
    });
    setDirty(true);
    setNotice(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {};
      for (const name of savable) payload[name] = values[name] ?? null;
      const res = await fetch(`/api/projects/${projectId}/stages/${stage}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: payload }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `Save failed (${res.status}).`);
        return;
      }
      setDirty(false);
      setNotice('Saved.');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function upload(category: string, files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploadBusy(category);
    setError(null);
    try {
      const body = new FormData();
      body.append('category', category);
      for (const f of Array.from(files)) body.append('file', f);
      const res = await fetch(`/api/projects/${projectId}/documents`, { method: 'POST', body });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `Upload failed (${res.status}).`);
        return;
      }
      router.refresh();
    } finally {
      setUploadBusy(null);
    }
  }

  async function removeDoc(docId: string) {
    if (!window.confirm('Remove this file? (Logged to the activity log.)')) return;
    const res = await fetch(`/api/documents/${docId}`, { method: 'DELETE' });
    if (res.ok) router.refresh();
  }

  function renderField(field: StageField) {
    const value = values[field.name];
    const reqMark = field.required === true ? ' *' : '';

    if (field.type === 'upload') {
      const list = docs[field.name] ?? [];
      return (
        <div className="field" key={field.name}>
          <span>
            {field.label}
            {reqMark}
          </span>
          {list.length > 0 && (
            <ul className="upload-list">
              {list.map((doc) => (
                <li key={doc.id}>
                  <a href={`/api/files/${doc.id}`} target="_blank" rel="noreferrer">
                    {doc.title ?? 'file'}
                  </a>
                  {editable && (
                    <button type="button" onClick={() => removeDoc(doc.id)} aria-label="Remove">
                      ✕
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {editable && (
            <label className="upload-drop">
              {uploadBusy === field.name
                ? 'Uploading…'
                : `+ ${field.multiple ? 'Add files' : list.length ? 'Replace / add file' : 'Upload file'}`}
              <input
                type="file"
                hidden
                multiple={field.multiple}
                accept={field.accept === 'pdf' ? 'application/pdf' : 'image/*'}
                onChange={(e) => {
                  upload(field.name, e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
          )}
          {field.note && <em className="field-note">{field.note}</em>}
        </div>
      );
    }

    if (field.type === 'permits') {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      const custom = selected.filter((s) => !(PERMIT_OPTIONS as readonly string[]).includes(s));
      return (
        <div className="field" key={field.name}>
          <span>
            {field.label}
            {reqMark}
          </span>
          <div className="permit-checks">
            {PERMIT_OPTIONS.map((opt) => (
              <label key={opt} className="check-inline">
                <input
                  type="checkbox"
                  disabled={!editable}
                  checked={selected.includes(opt)}
                  onChange={(e) =>
                    set(
                      field.name,
                      e.target.checked
                        ? [...selected, opt]
                        : selected.filter((s) => s !== opt)
                    )
                  }
                />
                {opt[0].toUpperCase() + opt.slice(1)}
              </label>
            ))}
          </div>
          <input
            placeholder="Other permits (comma-separated)"
            disabled={!editable}
            defaultValue={custom.join(', ')}
            onBlur={(e) => {
              const extras = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
              const base = selected.filter((s) => (PERMIT_OPTIONS as readonly string[]).includes(s));
              set(field.name, [...base, ...extras]);
            }}
          />
          {field.note && <em className="field-note">{field.note}</em>}
        </div>
      );
    }

    if (field.type === 'toggle') {
      const stampedAt = values.drive_updated_at;
      return (
        <div className="field" key={field.name}>
          <label className="check-inline big">
            <input
              type="checkbox"
              disabled={!editable}
              checked={value === true}
              onChange={(e) => set(field.name, e.target.checked)}
            />
            {field.label}
            {reqMark}
          </label>
          {value === true && stampedAt ? (
            <em className="field-note">
              Confirmed {new Date(String(stampedAt)).toLocaleDateString()}
            </em>
          ) : field.note ? (
            <em className="field-note">{field.note}</em>
          ) : null}
        </div>
      );
    }

    return (
      <label className="field" key={field.name}>
        <span>
          {field.label}
          {reqMark}
          {field.required === 'cond' && <em className="cond-mark"> · conditional</em>}
        </span>
        {field.type === 'select' ? (
          <select
            disabled={!editable}
            value={String(value ?? '')}
            onChange={(e) => setStatus(field, e.target.value)}
          >
            <option value="">—</option>
            {field.options?.map((opt) => (
              <option key={opt} value={opt}>
                {statusLabel(opt)}
              </option>
            ))}
          </select>
        ) : field.type === 'refselect' ? (
          <select
            disabled={!editable}
            value={String(value ?? '')}
            onChange={(e) => set(field.name, e.target.value || null)}
          >
            <option value="">{field.optionsKey === 'financePartners' ? 'N/A (cash)' : '—'}</option>
            {(refs[field.optionsKey!] ?? []).map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.name}
              </option>
            ))}
          </select>
        ) : field.type === 'textarea' ? (
          <textarea
            rows={3}
            disabled={!editable}
            value={String(value ?? '')}
            onChange={(e) => set(field.name, e.target.value)}
          />
        ) : field.type === 'date' ? (
          // Through isoDate, not String(): a date box shows nothing at all
          // unless its value is exactly yyyy-mm-dd, so anything else here is a
          // date the PM entered and can no longer see.
          <input
            type="date"
            disabled={!editable}
            value={isoDate(value)}
            onChange={(e) => set(field.name, e.target.value || null)}
          />
        ) : (
          <input
            type="text"
            disabled={!editable}
            value={String(value ?? '')}
            onChange={(e) => set(field.name, e.target.value)}
          />
        )}
        {field.note && <em className="field-note">{field.note}</em>}
      </label>
    );
  }

  return (
    <div className="stage-form">
      {cards.map((card) => {
        const status = card.statusField ? values[card.statusField] : null;
        const from = card.days?.from ? values[card.days.from] : projectCreatedAt;
        const to = card.days ? isoDate(values[card.days.to]) : '';
        const days = card.days ? daysBetween(from, to) : null;
        const running = card.days ? !to : false;
        return (
          <details className="track-card" key={card.key} open>
            <summary>
              <span className="track-title">{card.title}</span>
              {card.statusField && (
                <span className={`chip status-${String(status ?? 'none')}`}>
                  {statusLabel(status)}
                </span>
              )}
              {days !== null && (
                <span
                  className={`chip days${running && days > AGE_AMBER_DAYS ? ' amber' : ''}`}
                  title={card.days!.label}
                >
                  {days}d{running ? ' ⏱' : ''}
                </span>
              )}
            </summary>
            <div className="track-body">{card.fields.map(renderField)}</div>
          </details>
        );
      })}

      {editable && (
        <div className="save-bar">
          {error && <span className="save-error">{error}</span>}
          {notice && !dirty && <span className="save-ok">{notice}</span>}
          {dirty && <span className="save-dirty">Unsaved changes</span>}
          <button className="btn" type="button" onClick={save} disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  );
}
