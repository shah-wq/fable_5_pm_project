'use client';

import { useState } from 'react';
import {
  INTAKE_GROUPS,
  type IntakeField,
  type IntakeRefKey,
} from '@/lib/crm/intake';

export type IntakeRefs = Record<IntakeRefKey, Array<{ id: string; name: string }>>;
export type IntakeValues = Record<string, unknown>;

export interface IntakeDoc {
  id: string;
  category: string;
  title: string | null;
}

/**
 * The intake form: every field on the contact, in the groups a rep fills them.
 *
 * Rendered from lib/crm/intake.ts rather than written out, so the screen, the
 * deal record and the save allowlist cannot disagree about what a field is.
 * Person fields and deal fields sit side by side and are saved to their own
 * tables — which is invisible here, and is the point: the split exists so a
 * person with two properties has two sets of system details, not so anybody has
 * to think about it while typing.
 */
export function IntakeForm({
  values,
  refs,
  documents,
  dealId,
  disabled,
  onChange,
  onUpload,
  onRemoveDoc,
}: {
  values: IntakeValues;
  refs: IntakeRefs;
  documents: IntakeDoc[];
  dealId: string | null;
  disabled?: boolean;
  onChange: (field: IntakeField, value: unknown) => void;
  onUpload: (category: string, files: FileList | null) => void;
  onRemoveDoc: (id: string) => void;
}) {
  const [busyCategory, setBusyCategory] = useState<string | null>(null);

  function renderField(field: IntakeField) {
    const value = values[field.name];
    const locked = disabled || (field.on === 'deal' && !dealId);

    if (field.type === 'upload') {
      const files = documents.filter((d) => d.category === field.name);
      return (
        <div className="field" key={field.name}>
          <span>{field.label}</span>
          {files.length > 0 && (
            <ul className="upload-list">
              {files.map((doc) => (
                <li key={doc.id}>
                  <a href={`/api/files/${doc.id}`} target="_blank" rel="noreferrer">
                    {doc.title ?? 'file'}
                  </a>
                  {!locked && (
                    <button type="button" onClick={() => onRemoveDoc(doc.id)} aria-label="Remove">
                      ✕
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {locked ? (
            <em className="field-note">
              {dealId ? 'Read-only' : 'Add a deal for this person before uploading.'}
            </em>
          ) : (
            <label className="upload-drop">
              {busyCategory === field.name
                ? 'Uploading…'
                : files.length
                  ? '+ Replace / add file'
                  : '+ Upload file'}
              <input
                type="file"
                hidden
                onChange={(e) => {
                  setBusyCategory(field.name);
                  onUpload(field.name, e.target.files);
                  e.target.value = '';
                  setTimeout(() => setBusyCategory(null), 1500);
                }}
              />
            </label>
          )}
        </div>
      );
    }

    if (field.type === 'readonly') {
      return (
        <div className="field" key={field.name}>
          <span>{field.label}</span>
          <p className="readonly-value">{value ? String(value).replaceAll('_', ' ') : '—'}</p>
          {field.note && <em className="field-note">{field.note}</em>}
        </div>
      );
    }

    if (field.type === 'toggle') {
      return (
        <div className="field" key={field.name}>
          <label className="check-inline">
            <input
              type="checkbox"
              disabled={locked}
              checked={value === true}
              onChange={(e) => onChange(field, e.target.checked)}
            />
            {field.label}
          </label>
          {field.note && <em className="field-note">{field.note}</em>}
        </div>
      );
    }

    return (
      <label className="field" key={field.name}>
        <span>{field.label}</span>
        {field.type === 'select' ? (
          <select
            disabled={locked}
            value={String(value ?? '')}
            onChange={(e) => onChange(field, e.target.value || null)}
          >
            <option value="">—</option>
            {field.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : field.type === 'ref' ? (
          <select
            disabled={locked}
            value={String(value ?? '')}
            onChange={(e) => onChange(field, e.target.value || null)}
          >
            <option value="">—</option>
            {(refs[field.refKey!] ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        ) : field.type === 'textarea' ? (
          <textarea
            rows={3}
            disabled={locked}
            value={String(value ?? '')}
            onChange={(e) => onChange(field, e.target.value)}
          />
        ) : (
          <input
            type={
              field.type === 'number' || field.type === 'currency'
                ? 'number'
                : field.type === 'email'
                  ? 'email'
                  : 'text'
            }
            step={field.type === 'currency' ? '0.01' : undefined}
            disabled={locked}
            value={String(value ?? '')}
            onChange={(e) =>
              onChange(
                field,
                field.type === 'number' || field.type === 'currency'
                  ? e.target.value === ''
                    ? null
                    : Number(e.target.value)
                  : e.target.value
              )
            }
          />
        )}
        {field.note && <em className="field-note">{field.note}</em>}
      </label>
    );
  }

  return (
    <div className="stage-form">
      {INTAKE_GROUPS.map((group) => (
        <details className="track-card" key={group.key} open>
          <summary>
            <span className="track-title">{group.title}</span>
          </summary>
          <div className="track-body">
            {group.blurb && <p className="dim">{group.blurb}</p>}
            {group.fields.map(renderField)}
          </div>
        </details>
      ))}
    </div>
  );
}
