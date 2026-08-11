'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  DETAIL_BLOCKS,
  fieldVisible,
  type DetailBlock,
  type RefKey,
  type RefOption,
} from '@/lib/projects/details';
import { DetailsFields, type DetailRefs, type DetailValues } from '../../_components/DetailsFields';

/**
 * The Details tab: the New Project form's four blocks, read-only with an Edit
 * button per block — editable at any time, from any stage. Once the project
 * is Complete or Cancelled the blocks lock; an admin can unlock them for a
 * correction with a mandatory reason (sent with every save and logged).
 */
export function DetailsPanel({
  projectId,
  initialValues,
  refs: initialRefs,
  fallbackLabels,
  status,
  isAdmin,
  canEdit,
}: {
  projectId: string;
  initialValues: DetailValues;
  refs: DetailRefs;
  /** Display names for referenced rows missing from the active lists. */
  fallbackLabels: Record<string, string | null>;
  status: string;
  isAdmin: boolean;
  /** admin/ops only — read-only for everyone else. */
  canEdit: boolean;
}) {
  const router = useRouter();
  const [refs, setRefs] = useState(initialRefs);
  const [saved, setSaved] = useState<DetailValues>(initialValues);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<DetailValues>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unlockReason, setUnlockReason] = useState<string | null>(null);
  const [askUnlock, setAskUnlock] = useState<string | null>(null);

  const locked = ['complete', 'cancelled'].includes(status) && unlockReason === null;

  function refName(key: RefKey | undefined, fieldName: string, id: unknown): string {
    if (!id) return '—';
    const opt = key ? refs[key].find((o) => o.id === id) : undefined;
    return opt?.name ?? fallbackLabels[fieldName] ?? '(inactive option)';
  }

  function startEdit(blockKey: string) {
    if (locked) {
      if (isAdmin) setAskUnlock(blockKey);
      return;
    }
    setDraft({ ...saved });
    setEditing(blockKey);
    setError(null);
  }

  async function save(block: DetailBlock) {
    const values: DetailValues = {};
    for (const f of block.fields) values[f.name] = draft[f.name] ?? null;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/details`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values, ...(unlockReason ? { reason: unlockReason } : {}) }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `Save failed (${res.status}).`);
        return;
      }
      setSaved((s) => ({ ...s, ...values }));
      setEditing(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {['complete', 'cancelled'].includes(status) && (
        <p className="dim">
          {unlockReason
            ? `Details unlocked for correction — every save is logged with your reason.`
            : `This project is ${status === 'complete' ? 'complete' : 'cancelled'}, so its details are read-only.${isAdmin ? ' Use Edit to unlock a block with a reason.' : ' Ask an admin to unlock them for a correction.'}`}
        </p>
      )}
      <div className="detail-grid">
        {DETAIL_BLOCKS.map((block) => (
          <section className="panel" key={block.key}>
            <div className="panel-head">
              <h2>{block.title}</h2>
              {canEdit && editing !== block.key && (
                <button
                  className="btn secondary small"
                  type="button"
                  onClick={() => startEdit(block.key)}
                  disabled={busy || (locked && !isAdmin)}
                >
                  {locked ? '🔒 Edit' : 'Edit'}
                </button>
              )}
            </div>

            {editing === block.key ? (
              <>
                {error && (
                  <p className="notice error" role="alert">
                    {error}
                  </p>
                )}
                <DetailsFields
                  block={block}
                  values={draft}
                  refs={refs}
                  onChange={(name, value) => setDraft((d) => ({ ...d, [name]: value }))}
                  onRefAdded={(key: RefKey, option: RefOption) =>
                    setRefs((r) => ({
                      ...r,
                      [key]: [...r[key], option].sort((a, b) => a.name.localeCompare(b.name)),
                    }))
                  }
                />
                <div className="dialog-actions">
                  <button
                    className="btn secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </button>
                  <button className="btn" type="button" disabled={busy} onClick={() => save(block)}>
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </>
            ) : (
              <dl className="facts">
                {block.fields.map((f) => {
                  const value = saved[f.name];
                  const hasValue = value !== null && value !== undefined && value !== '';
                  if (!fieldVisible(f, saved, refs) && !hasValue) return null;
                  return (
                    <span key={f.name} style={{ display: 'contents' }}>
                      <dt>{f.label}</dt>
                      <dd>
                        {f.type === 'ref'
                          ? refName(f.refKey, f.name, value)
                          : f.type === 'currency' && hasValue
                            ? `$${Number(value).toLocaleString()}`
                            : hasValue
                              ? String(value)
                              : '—'}
                      </dd>
                    </span>
                  );
                })}
              </dl>
            )}
          </section>
        ))}
      </div>

      {askUnlock && (
        <UnlockDialog
          onClose={() => setAskUnlock(null)}
          onUnlock={(reason) => {
            setUnlockReason(reason);
            setAskUnlock(null);
            setDraft({ ...saved });
            setEditing(askUnlock);
            setError(null);
          }}
        />
      )}
    </>
  );
}

function UnlockDialog({
  onClose,
  onUnlock,
}: {
  onClose: () => void;
  onUnlock: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal>
        <h2>Unlock details</h2>
        <p>
          This project is finished. A reason is required to edit its details, and it is written to
          the activity log with every change.
        </p>
        <label className="field">
          <span>Reason *</span>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <div className="dialog-actions">
          <button className="btn secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn"
            type="button"
            disabled={reason.trim().length < 5}
            onClick={() => onUnlock(reason.trim())}
          >
            Unlock
          </button>
        </div>
      </div>
    </div>
  );
}
