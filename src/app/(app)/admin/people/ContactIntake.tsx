'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { EnvelopeList, type EnvelopeView } from '@/app/(app)/_components/Esign';
import { IntakeForm } from '@/app/(app)/_components/IntakeForm';
import { SignContractDialog } from '@/app/(app)/_components/SignContractDialog';
import { useIntake } from '@/app/(app)/_components/useIntake';
import { CONTACT_GROUPS } from '@/lib/crm/intake';

/**
 * The contact's own fields: who they are, where post goes, where they are in the
 * pipeline, and the notes that travel with them.
 *
 * The system, the price and the paperwork are not here. Those belong to a deal —
 * a person with two properties has two of each — and they are edited on the deal
 * record, under Solar details.
 *
 * A couple of the fields below (lead status, dealer code, the notes) are stored
 * on the deal even though they are asked for here. The picker at the top says
 * which deal, and only appears when there is more than one to be confused about.
 *
 * Choosing Contract signed in Lead status is the same move as dropping the card
 * in that column on the board, and goes the same way: Save keeps everything
 * else, then opens the signing form for the system. Cancel it and they stay at
 * the stage they were at.
 *
 * Once signing has made a project, Lead status is shown rather than offered:
 * the project holds them in Contract signed until it is deleted, and a box that
 * lets somebody choose Quoted only to refuse it on Save is a box that lies.
 */
export function ContactIntake({ clientId }: { clientId: string }) {
  const router = useRouter();
  const intake = useIntake(clientId);
  const [signing, setSigning] = useState(false);
  // Contracts sent for e-signature. Loaded on their own: on a database without
  // 004400 the list is simply empty and the record works as before.
  const [envelopes, setEnvelopes] = useState<EnvelopeView[]>([]);
  const loadEnvelopes = useCallback(async () => {
    const res = await fetch(`/api/contacts/${clientId}/esign`).catch(() => null);
    const json = res?.ok ? await res.json().catch(() => null) : null;
    setEnvelopes(Array.isArray(json?.envelopes) ? json.envelopes : []);
  }, [clientId]);
  useEffect(() => {
    void loadEnvelopes();
  }, [loadEnvelopes]);

  // The same groups, with Lead status turned into a statement while a project
  // holds them. Read-only fields are not sent as edits, so nothing to refuse.
  const groups = useMemo(
    () =>
      intake.project
        ? CONTACT_GROUPS.map((g) => ({
            ...g,
            fields: g.fields.map((f) =>
              f.name === 'contact_stage'
                ? { ...f, type: 'readonly' as const, note: 'Held here by the project.' }
                : f
            ),
          }))
        : CONTACT_GROUPS,
    [intake.project]
  );

  async function saveOrSign() {
    const before = intake.original.contact_stage;
    const signingNow = intake.values.contact_stage === 'contract_signed' && before !== 'contract_signed';
    if (!signingNow) {
      await intake.save(() => router.refresh());
      return;
    }
    // Everything else first, with the stage held where it was; the form moves it.
    const ok = await intake.save(undefined, { contact_stage: before });
    if (ok) setSigning(true);
  }

  if (intake.loading) return <p className="dim">Loading…</p>;

  return (
    <>
      {intake.error && (
        <p className="notice error" role="alert">
          {intake.error}
        </p>
      )}
      {intake.notice && !intake.dirty && <p className="notice ok">{intake.notice}</p>}

      {intake.project && (
        <p className="notice hold">
          {'Contract signed, and held there by project '}
          <Link href={`/projects/${intake.project.id}`}>{intake.project.code}</Link>
          {'. To move them to another stage, an admin deletes the project first.'}
        </p>
      )}

      {envelopes.length > 0 && (
        <section className="esign-panel">
          <h3>Contract e-signature</h3>
          <EnvelopeList
            envelopes={envelopes}
            onChanged={() => void loadEnvelopes()}
            onSigned={() => {
              void intake.load(intake.dealId);
              router.refresh();
            }}
          />
        </section>
      )}

      {intake.deals.length === 0 ? (
        <p className="notice">
          Lead status and the dealer notes belong to a deal, and this person has none yet. Create
          one from the Deals board and they will fill in here.
        </p>
      ) : intake.deals.length > 1 ? (
        <label className="field">
          <span>Which deal</span>
          <select
            value={intake.dealId ?? ''}
            onChange={(e) => {
              intake.setDealId(e.target.value);
              void intake.load(e.target.value);
            }}
          >
            {intake.deals.map((d) => (
              <option key={d.id} value={d.id}>
                {`${d.code ?? d.id.slice(0, 8)} · ${d.stage.replaceAll('_', ' ')} · updated ${d.updated_at.slice(0, 10)}`}
              </option>
            ))}
          </select>
          <em className="field-note">
            This person has {intake.deals.length} deals. The status and dealer fields below belong
            to the one selected here.
          </em>
        </label>
      ) : null}

      {intake.refs && (
        <IntakeForm
          groups={groups}
          values={intake.values}
          refs={intake.refs}
          documents={intake.documents}
          dealId={intake.dealId}
          onChange={intake.change}
          onUpload={intake.upload}
          onRemoveDoc={intake.removeDoc}
        />
      )}

      <div className="save-bar">
        {intake.dirty && <span className="save-dirty">Unsaved changes</span>}
        <button
          className="btn"
          type="button"
          disabled={intake.busy || !intake.dirty}
          onClick={() => void saveOrSign()}
        >
          {intake.busy ? 'Saving…' : 'Save'}
        </button>
      </div>

      {signing && (
        <SignContractDialog
          clientId={clientId}
          personName={
            `${String(intake.values.first_name ?? '')} ${String(intake.values.last_name ?? '')}`.trim() ||
            'this contact'
          }
          dealId={intake.dealId}
          onCancel={() => {
            setSigning(false);
            // Back to what the database says: the other edits were saved, and
            // the stage never moved.
            void intake.load(intake.dealId);
          }}
          onSent={() => {
            setSigning(false);
            void intake.load(intake.dealId);
            void loadEnvelopes();
          }}
          onSigned={() => {
            setSigning(false);
            void loadEnvelopes();
            void intake.load(intake.dealId);
            // The page reads again so the System tab appears on the record.
            router.refresh();
          }}
        />
      )}
    </>
  );
}
