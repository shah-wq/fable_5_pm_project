'use client';

import { useRouter } from 'next/navigation';
import { IntakeForm } from '@/app/(app)/_components/IntakeForm';
import { useIntake } from '@/app/(app)/_components/useIntake';
import { DEAL_DETAIL_GROUPS } from '@/lib/crm/intake';

/**
 * Solar details on the deal: the system, the usage, the money and the paperwork.
 *
 * These were briefly on the contact record and came off it — a contact is a
 * person, and a module wattage is not a fact about a person. They are here,
 * against the one opportunity they describe, which is also the only place a
 * second property can have a second answer.
 *
 * The uploads file against this deal and gain the project relation when it is
 * won, so nothing is uploaded twice.
 */
export function DealSolarDetails({
  clientId,
  dealId,
  readOnly,
}: {
  clientId: string | null;
  dealId: string;
  /** Won and lost deals are read-only, as everywhere else on this record. */
  readOnly?: boolean;
}) {
  const router = useRouter();
  const intake = useIntake(clientId, dealId);

  if (!clientId) {
    return (
      <p className="dim">
        This deal is not linked to a person yet, so its detail fields have nowhere to hang. Attach
        it to a contact first.
      </p>
    );
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

      {intake.refs && (
        <IntakeForm
          groups={DEAL_DETAIL_GROUPS}
          values={intake.values}
          refs={intake.refs}
          documents={intake.documents}
          dealId={intake.dealId}
          disabled={readOnly}
          onChange={intake.change}
          onUpload={intake.upload}
          onRemoveDoc={intake.removeDoc}
        />
      )}

      {!readOnly && (
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
      )}
    </>
  );
}
