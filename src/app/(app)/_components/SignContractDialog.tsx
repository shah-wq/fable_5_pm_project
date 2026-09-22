'use client';

import { useEffect, useState } from 'react';
import { IntakeForm, type IntakeRefs, type IntakeValues } from '@/app/(app)/_components/IntakeForm';
import { SIGNING_GROUPS, SIGNING_REQUIRED, signingColumns, type IntakeField } from '@/lib/crm/intake';

export interface SignedResult {
  dealId: string;
  dealCreated: boolean;
  projectId: string | null;
  projectCode: string | null;
}

/** What 003900 wrote on a deal made for a contact with no address. */
const ADDRESS_PLACEHOLDER = 'Address to be confirmed';

function hasText(v: unknown): boolean {
  const t = String(v ?? '').trim();
  return t !== '' && t !== ADDRESS_PLACEHOLDER;
}

/**
 * Contract signed, as a form rather than a drop.
 *
 * Opens whenever somebody moves a contact into Contract signed — from the stage
 * board or from the Lead status box on their record — and asks for the system
 * that was sold. Saving it signs them and creates the project, together.
 * Nothing moves until then: cancel, and the contact stays exactly where they
 * were.
 *
 * The project's dealer and site address are asked first, because the project
 * cannot be made without them. Both start from what the contact already says:
 * their dealer, and the deal's address or else their mailing address.
 *
 * It opens filled in with whatever their open deal already says, so a contact
 * who was quoted a 7.2 kW system arrives at signing with 7.2 in the box. The
 * figures on a lost or won deal are not carried over: that was a different
 * contract, and signing makes a new deal for this one.
 */
export function SignContractDialog({
  clientId,
  personName,
  dealId,
  onSigned,
  onCancel,
}: {
  clientId: string;
  personName: string;
  /** The deal to record against, when the screen already knows which. */
  dealId?: string | null;
  onSigned: (result: SignedResult) => void;
  onCancel: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<IntakeValues>({});
  const [refs, setRefs] = useState<IntakeRefs | null>(null);
  const [openDealId, setOpenDealId] = useState<string | null>(null);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(
          `/api/customers/${clientId}/intake${dealId ? `?deal=${dealId}` : ''}`
        );
        const json = await res.json().catch(() => null);
        if (!live) return;
        if (!res.ok) {
          setError(json?.error ?? `Could not load the contact (${res.status}).`);
          return;
        }
        setRefs(json.refs ?? null);
        const chosen = (json.deals ?? []).find((d: { id: string }) => d.id === json.dealId) as
          | { id: string; stage: string }
          | undefined;
        const open = chosen && !['won', 'lost'].includes(chosen.stage);
        setOpenDealId(open ? chosen.id : null);
        const v = (json.values ?? {}) as IntakeValues;
        const start: IntakeValues = {};
        if (open) {
          for (const f of signingColumns()) {
            if (v[f.name] !== undefined && v[f.name] !== null) start[f.name] = v[f.name];
          }
        }
        // The dealer is the contact's own, so it carries whatever the deal.
        if (!start.dealer_id && v.dealer_id) start.dealer_id = v.dealer_id;
        // The site: an open deal's real address, else where their post goes.
        if (!hasText(start.address)) {
          const mailing = [v.mailing_street, v.mailing_city, v.mailing_state, v.mailing_postal_code]
            .map((part) => String(part ?? '').trim())
            .filter(Boolean)
            .join(', ');
          if (mailing) start.address = mailing;
          else delete start.address;
        }
        setValues(start);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [clientId, dealId]);

  // Escape is Cancel, as on every other dialog: nothing has moved yet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  function change(field: IntakeField, value: unknown) {
    setValues((v) => ({ ...v, [field.name]: value }));
    setMissing((m) => {
      if (!m.has(field.name)) return m;
      const next = new Set(m);
      next.delete(field.name);
      return next;
    });
  }

  async function sign() {
    const gaps = new Set<string>(
      SIGNING_REQUIRED.filter((name) => {
        if (name === 'system_size_kw') {
          const n = Number(values[name]);
          return !(values[name] !== '' && values[name] != null && Number.isFinite(n) && n > 0);
        }
        return !hasText(values[name]);
      })
    );
    if (gaps.size > 0) {
      setMissing(gaps);
      const said = [
        gaps.has('dealer_id') && 'the dealer',
        gaps.has('address') && 'the site address',
        gaps.has('system_size_kw') && 'the system size in kW',
      ].filter(Boolean) as string[];
      setError(
        `Signing creates the project, which needs ${said.join(' and ').replace(/ and (?=.* and )/, ', ')}.`
      );
      return;
    }

    setBusy(true);
    setError(null);
    try {
      // Every field the form shows, emptied ones included: an emptied box is
      // somebody taking an answer back, and leaving it out would keep the old one.
      const sent: IntakeValues = {};
      for (const f of signingColumns()) sent[f.name] = values[f.name] ?? null;
      const res = await fetch(`/api/contacts/${clientId}/sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: sent, dealId: openDealId }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        if (Array.isArray(json?.missing)) setMissing(new Set(json.missing));
        setError(json?.error ?? `Could not sign (${res.status}).`);
        return;
      }
      onSigned({
        dealId: json.dealId,
        dealCreated: Boolean(json.dealCreated),
        projectId: json.projectId ?? null,
        projectCode: json.projectCode ?? null,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="dialog-backdrop"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        className="dialog wide-dialog sign-dialog"
        role="dialog"
        aria-modal
        aria-labelledby="sign-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="sign-title">{`Contract signed — ${personName}`}</h2>
        <p className="dim">
          Record the system that was sold. Signing creates the project from it, and the contact
          stays in Contract signed while the project exists. Nothing moves until this is saved.
          Documents are added on the record afterwards.
        </p>

        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <p className="dim">Loading…</p>
        ) : refs ? (
          <IntakeForm
            groups={SIGNING_GROUPS}
            mode="create"
            values={values}
            refs={refs}
            documents={[]}
            dealId={openDealId}
            missing={missing}
            onChange={change}
            onUpload={() => undefined}
            onRemoveDoc={() => undefined}
          />
        ) : null}

        <div className="dialog-actions sign-actions">
          <button className="btn secondary" type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="btn" type="button" disabled={busy || loading || !refs} onClick={() => void sign()}>
            {busy ? 'Signing…' : 'Sign and create project'}
          </button>
        </div>
      </div>
    </div>
  );
}
