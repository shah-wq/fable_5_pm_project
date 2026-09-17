'use client';

import { useRouter } from 'next/navigation';
import { IntakeForm } from '@/app/(app)/_components/IntakeForm';
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
 */
export function ContactIntake({ clientId }: { clientId: string }) {
  const router = useRouter();
  const intake = useIntake(clientId);

  if (intake.loading) return <p className="dim">Loading…</p>;

  return (
    <>
      {intake.error && (
        <p className="notice error" role="alert">
          {intake.error}
        </p>
      )}
      {intake.notice && !intake.dirty && <p className="notice ok">{intake.notice}</p>}

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
          groups={CONTACT_GROUPS}
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
          onClick={() => void intake.save(() => router.refresh())}
        >
          {intake.busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  );
}
