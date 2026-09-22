'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { HOLD_REASONS, CANCELLATION_REASONS } from '@/lib/stages/fields';
import { announceProjectsChanged } from '@/lib/projects/live';

/**
 * The header controls the spec puts on every stage form: Put on hold / Cancel
 * project when active; Resume / Reinstate when parked. All bypass field
 * validation and open a reason dialog; reinstate is admin-only.
 *
 * Delete project is admin-only too, and is a different thing from Cancel:
 * cancelling stops a job and keeps it on record; deleting unwinds the sale. It
 * is how a contact held in Contract signed by their project is released.
 */
export function ProjectActions({
  projectId,
  code,
  status,
  isAdmin,
}: {
  projectId: string;
  code: string;
  status: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<'hold' | 'cancel' | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ via: 'button', ...body }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `Failed (${res.status}).`);
        return false;
      }
      setDialog(null);
      router.refresh();
      announceProjectsChanged();
      return true;
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="header-actions">
        {status === 'active' && (
          <>
            <button className="btn-link" type="button" onClick={() => setDialog('hold')}>
              Put on hold
            </button>
            <button className="btn-link danger-text" type="button" onClick={() => setDialog('cancel')}>
              Cancel project
            </button>
          </>
        )}
        {status === 'on_hold' && (
          <button
            className="btn-link primary"
            type="button"
            disabled={busy}
            onClick={() => post({ direction: 'resume' })}
          >
            Resume project
          </button>
        )}
        {status === 'cancelled' &&
          (isAdmin ? (
            <button
              className="btn-link primary"
              type="button"
              disabled={busy}
              onClick={() => {
                const reason = window.prompt('Reason for reinstating (logged):');
                if (reason && reason.trim().length >= 5) post({ direction: 'reinstate', reason });
              }}
            >
              Reinstate project
            </button>
          ) : (
            <span className="dim">Cancelled — an admin can reinstate.</span>
          ))}
        {isAdmin && (
          <button className="btn-link danger-text" type="button" onClick={() => setDeleting(true)}>
            Delete project
          </button>
        )}
      </div>

      {deleting && (
        <DeleteDialog
          projectId={projectId}
          code={code}
          onClose={() => setDeleting(false)}
          onDeleted={(clientId) => router.push(clientId ? `/admin/people/${clientId}` : '/projects')}
        />
      )}

      {dialog && (
        <SideDialog
          kind={dialog}
          busy={busy}
          error={error}
          onClose={() => setDialog(null)}
          onSubmit={post}
        />
      )}
    </>
  );
}

function SideDialog({
  kind,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  kind: 'hold' | 'cancel';
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const hold = kind === 'hold';
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [expected, setExpected] = useState('');
  const [refund, setRefund] = useState(false);
  const [equipment, setEquipment] = useState(false);
  const reasons = hold ? HOLD_REASONS : CANCELLATION_REASONS;

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal>
        <h2>{hold ? 'Put on hold' : 'Cancel project'}</h2>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <label className="field">
          <span>Reason *</span>
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">Select…</option>
            {reasons.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Notes *</span>
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {hold ? (
          <label className="field">
            <span>Expected resume date</span>
            <input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
          </label>
        ) : (
          <>
            <label className="check-inline">
              <input type="checkbox" checked={refund} onChange={(e) => setRefund(e.target.checked)} />
              Refund / clawback required
            </label>
            <label className="check-inline">
              <input
                type="checkbox"
                checked={equipment}
                onChange={(e) => setEquipment(e.target.checked)}
              />
              Equipment return required
            </label>
          </>
        )}
        <div className="dialog-actions">
          <button className="btn secondary" type="button" onClick={onClose}>
            Back
          </button>
          <button
            className={`btn${hold ? '' : ' danger'}`}
            type="button"
            disabled={busy || !reason || notes.trim().length < 3}
            onClick={() =>
              onSubmit(
                hold
                  ? { direction: 'hold', reason, notes, expectedResumeDate: expected || null }
                  : {
                      direction: 'cancel',
                      reason,
                      notes,
                      refundRequired: refund,
                      equipmentReturnRequired: equipment,
                    }
              )
            }
          >
            {hold ? 'Put on hold' : 'Cancel project'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The confirmation for deleting a project: say exactly what goes and what
 * stays, and make the code be typed — a click is too cheap for something with
 * no undo.
 */
function DeleteDialog({
  projectId,
  code,
  onClose,
  onDeleted,
}: {
  projectId: string;
  code: string;
  onClose: () => void;
  onDeleted: (clientId: string | null) => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: typed.trim() }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `Could not delete (${res.status}).`);
        return;
      }
      announceProjectsChanged();
      onDeleted(json?.clientId ?? null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal aria-labelledby="delete-project-title">
        <h2 id="delete-project-title">{`Delete project ${code}`}</h2>
        <p>
          This unwinds the sale. The project goes, with its stages, tasks, messages and forms, and
          it cannot be undone.
        </p>
        <p className="dim">
          Kept: the deal, reopened at Contract out with its system; the documents filed against the
          deal, such as the signed agreement; and the activity log. The contact stays in Contract
          signed and can then be moved. To stop a job but keep it on record, cancel it instead.
        </p>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <label className="field">
          <span>{`Type ${code} to confirm`}</span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </label>
        <div className="dialog-actions">
          <button className="btn secondary" type="button" disabled={busy} onClick={onClose}>
            Keep project
          </button>
          <button
            className="btn danger"
            type="button"
            disabled={busy || typed.trim() !== code}
            onClick={() => void remove()}
          >
            {busy ? 'Deleting…' : 'Delete project'}
          </button>
        </div>
      </div>
    </div>
  );
}
