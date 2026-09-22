'use client';

import { useEffect, useState } from 'react';
import { EmbeddedSigning, type EnvelopeView } from '@/app/(app)/_components/Esign';
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
 *
 * With PandaDoc connected there is a second way out: Send for e-signature.
 * The same form, checked the same way, goes to the homeowner instead — by
 * email, or signed here on this screen — and nothing moves until they sign.
 * When they do, the project is made from exactly what was sent.
 */
export function SignContractDialog({
  clientId,
  personName,
  dealId,
  onSigned,
  onCancel,
  onSent,
}: {
  clientId: string;
  personName: string;
  /** The deal to record against, when the screen already knows which. */
  dealId?: string | null;
  onSigned: (result: SignedResult) => void;
  onCancel: () => void;
  /** Sent for e-signature rather than signed: the contact has not moved. */
  onSent?: (envelope: EnvelopeView) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<IntakeValues>({});
  const [refs, setRefs] = useState<IntakeRefs | null>(null);
  const [openDealId, setOpenDealId] = useState<string | null>(null);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // E-signature: whether it can be offered, and the send pane's own state.
  const [esign, setEsign] = useState<{ ready: boolean; reason: string | null } | null>(null);
  const [pane, setPane] = useState<'form' | 'send' | 'sent' | 'embedded'>('form');
  const [signer, setSigner] = useState({ name: '', email: '' });
  const [delivery, setDelivery] = useState<'email' | 'embedded'>('email');
  const [sent, setSent] = useState<{ envelope: EnvelopeView; sessionUrl: string | null } | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/contacts/${clientId}/esign`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!live || !j) return;
        setEsign({ ready: Boolean(j.ready), reason: j.reason ?? null });
        setSigner({ name: j.signer?.name ?? '', email: j.signer?.email ?? '' });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [clientId]);

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
      if (e.key === 'Escape' && !busy && pane === 'form') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel, pane]);

  function change(field: IntakeField, value: unknown) {
    setValues((v) => ({ ...v, [field.name]: value }));
    setMissing((m) => {
      if (!m.has(field.name)) return m;
      const next = new Set(m);
      next.delete(field.name);
      return next;
    });
  }

  /** The three things a project cannot be made without; false when any is missing. */
  function checkRequired(): boolean {
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
      return false;
    }
    return true;
  }

  function formValues(): IntakeValues {
    // Every field the form shows, emptied ones included: an emptied box is
    // somebody taking an answer back, and leaving it out would keep the old one.
    const out: IntakeValues = {};
    for (const f of signingColumns()) out[f.name] = values[f.name] ?? null;
    return out;
  }

  async function send() {
    if (!checkRequired()) {
      setPane('form');
      return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(signer.email.trim())) {
      setError('Enter the email address of the person signing.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/contacts/${clientId}/esign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          values: formValues(),
          dealId: openDealId,
          signerName: signer.name,
          signerEmail: signer.email.trim(),
          delivery,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        if (Array.isArray(json?.missing)) {
          setMissing(new Set(json.missing));
          setPane('form');
        }
        setError(json?.error ?? `Could not send (${res.status}).`);
        return;
      }
      setSent({ envelope: json.envelope, sessionUrl: json.sessionUrl ?? null });
      setPane(json.sessionUrl ? 'embedded' : 'sent');
    } finally {
      setBusy(false);
    }
  }

  function finishedEmbedded(envelope: EnvelopeView) {
    if (envelope.appliedAt && envelope.projectId) {
      onSigned({
        dealId: '',
        dealCreated: false,
        projectId: envelope.projectId,
        projectCode: envelope.projectCode,
      });
    } else {
      // Signed, but the outcome needs a person: the record shows why.
      onSent?.(envelope);
      if (!onSent) onCancel();
    }
  }

  async function sign() {
    if (!checkRequired()) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/contacts/${clientId}/sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: formValues(), dealId: openDealId }),
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

        {pane === 'sent' && sent && (
          <div className="esign-sent">
            <p className="notice ok">
              {`Sent to ${sent.envelope.signerEmail}. ${personName} stays where they are until they sign; then the project is created from this form and the signed agreement is filed on it.`}
            </p>
            <div className="dialog-actions">
              <button
                className="btn"
                type="button"
                onClick={() => (onSent ? onSent(sent.envelope) : onCancel())}
              >
                Done
              </button>
            </div>
          </div>
        )}

        {pane === 'embedded' && sent?.sessionUrl && (
          <EmbeddedSigning
            sessionUrl={sent.sessionUrl}
            envelopeId={sent.envelope.id}
            onDone={finishedEmbedded}
            onClose={() => (onSent ? onSent(sent.envelope) : onCancel())}
          />
        )}

        {pane === 'send' && (
          <div className="esign-send">
            <h3>Send for e-signature</h3>
            <div className="form-grid">
              <label className="field">
                <span>Signer’s name</span>
                <input
                  value={signer.name}
                  onChange={(e) => setSigner((v) => ({ ...v, name: e.target.value }))}
                />
              </label>
              <label className="field">
                <span>Signer’s email</span>
                <input
                  type="email"
                  value={signer.email}
                  onChange={(e) => setSigner((v) => ({ ...v, email: e.target.value }))}
                />
              </label>
            </div>
            <fieldset className="radio-row">
              <label>
                <input
                  type="radio"
                  name="delivery"
                  checked={delivery === 'email'}
                  onChange={() => setDelivery('email')}
                />{' '}
                Email it to them to sign
              </label>
              <label>
                <input
                  type="radio"
                  name="delivery"
                  checked={delivery === 'embedded'}
                  onChange={() => setDelivery('embedded')}
                />{' '}
                They are here — sign on this screen
              </label>
            </fieldset>
          </div>
        )}

        {pane !== 'form' ? null : loading ? (
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

        {pane === 'form' && (
          <div className="dialog-actions sign-actions">
            <button className="btn secondary" type="button" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
            {esign?.ready ? (
              <button
                className="btn secondary"
                type="button"
                disabled={busy || loading || !refs}
                onClick={() => {
                  if (checkRequired()) {
                    setError(null);
                    setPane('send');
                  }
                }}
              >
                Send for e-signature…
              </button>
            ) : esign?.reason ? (
              <span className="small dim esign-off" title={esign.reason}>
                E-signature off
              </span>
            ) : null}
            <button className="btn" type="button" disabled={busy || loading || !refs} onClick={() => void sign()}>
              {busy ? 'Signing…' : 'Sign and create project'}
            </button>
          </div>
        )}
        {pane === 'send' && (
          <div className="dialog-actions sign-actions">
            <button className="btn secondary" type="button" disabled={busy} onClick={() => setPane('form')}>
              Back
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => void send()}>
              {busy ? 'Sending…' : delivery === 'email' ? 'Send' : 'Open signing'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
