'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { IntakeForm, type IntakeRefs, type IntakeValues } from '@/app/(app)/_components/IntakeForm';
import { INTAKE_REQUIRED, type IntakeField } from '@/lib/crm/intake';

interface Duplicate {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  projects: number;
}

/**
 * Create Contact: the whole record on one page.
 *
 * Contacts holds everybody — the ones who have signed and the ones who never
 * will — so this form asks for what is known and insists on almost nothing. The
 * three fields it does insist on are the ones that make the record findable: a
 * surname, and a way to reach them.
 *
 * A few of the fields here — the dealer code, the sales notes, the reschedule
 * reason — live on a deal rather than on the person, so filling any of them in
 * creates the first deal alongside the contact. A contact typed in from a
 * business card gets no deal at all: an empty opportunity on the board and in
 * the forecast is worse than no opportunity.
 *
 * The system, the usage and the price are not asked for here at all. They belong
 * to an opportunity, and they are edited on the deal record under Solar details.
 */
export function CreateContactForm({
  refs,
  ready = true,
  currentUserId,
}: {
  refs: IntakeRefs;
  /** False when the database is missing the file that creates contacts. */
  ready?: boolean;
  /** Whoever is filling the form in, pre-selected as the contact's owner. */
  currentUserId?: string | null;
}) {
  const router = useRouter();

  /**
   * What a blank form starts with: this stage, and this owner.
   *
   * The owner is the person typing, because in practice it always is — the rep
   * who takes the call is the rep who works it. It is pre-selected rather than
   * assigned invisibly, so somebody entering a contact on a colleague's behalf
   * can see the wrong name and change it before saving, which is the difference
   * between a default and a decision made for you.
   *
   * Only when they are on the owners list: a finance user filling in a form is
   * not somebody a contact can be assigned to, and offering their own name in a
   * dropdown that will not accept it is worse than leaving it empty.
   */
  const blank = (): IntakeValues => ({
    contact_stage: 'created',
    ...(currentUserId && refs.owners.some((o) => o.id === currentUserId)
      ? { owner_id: currentUserId }
      : {}),
  });

  const [values, setValues] = useState<IntakeValues>(blank);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [duplicates, setDuplicates] = useState<Duplicate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function change(field: IntakeField, value: unknown) {
    setValues((v) => ({ ...v, [field.name]: value }));
    setMissing((m) => {
      if (!m.has(field.name)) return m;
      const next = new Set(m);
      next.delete(field.name);
      return next;
    });
    setDuplicates(null);
  }

  /**
   * What the form checks before it asks the server. Deliberately the same rule
   * the server enforces: a surname, and either an email or a phone number. A rep
   * standing on a driveway with a mobile number and no email still gets to save.
   */
  function shortfall(): Set<string> {
    const gaps = new Set<string>();
    const has = (name: string) => String(values[name] ?? '').trim() !== '';
    if (!has('last_name')) gaps.add('last_name');
    if (!has('email') && !has('phone')) {
      gaps.add('email');
      gaps.add('phone');
    }
    return gaps;
  }

  async function save(again: boolean, allowDuplicate = false) {
    const gaps = shortfall();
    if (gaps.size > 0) {
      setMissing(gaps);
      setError(
        gaps.has('last_name') && gaps.size === 1
          ? 'A last name, so the record can be found again.'
          : 'A last name and a way to reach them — an email or a phone number.'
      );
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values, allowDuplicate }),
      });
      const json = await res.json().catch(() => null);
      if (res.status === 409 && json?.duplicates) {
        setDuplicates(json.duplicates);
        setError(json.error ?? 'Somebody with this email or phone is already on file.');
        return;
      }
      if (!res.ok) {
        setError(json?.error ?? `Could not save (${res.status}).`);
        return;
      }
      if (again) {
        setValues(blank());
        setDuplicates(null);
        setError(null);
        window.scrollTo({ top: 0 });
        router.refresh();
        return;
      }
      router.push(`/admin/people/${json.clientId}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="record-bar">
        <h1>Create Contact</h1>
        <span className="spacer" />
        <Link className="btn secondary" href="/admin/people">
          Cancel
        </Link>
        <button className="btn secondary" type="button" disabled={busy || !ready} onClick={() => void save(true)}>
          Save and New
        </button>
        <button className="btn" type="button" disabled={busy || !ready} onClick={() => void save(false)}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>

      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      {duplicates && duplicates.length > 0 && (
        <div className="notice hold">
          <strong>Already on file.</strong> Open the existing record rather than making a second one:
          <ul>
            {duplicates.map((d) => (
              <li key={d.id}>
                <Link href={`/admin/people/${d.id}`}>{d.name}</Link>{' '}
                <span className="dim">
                  {[d.email, d.phone].filter(Boolean).join(' · ')}
                  {d.projects > 0 ? ` · ${d.projects} project${d.projects === 1 ? '' : 's'}` : ''}
                </span>
              </li>
            ))}
          </ul>
          <button className="btn secondary" type="button" disabled={busy} onClick={() => void save(false, true)}>
            They are a different person — save anyway
          </button>
        </div>
      )}

      <p className="dim">
        {INTAKE_REQUIRED.length > 0 && (
          <>
            Fields marked <b className="req">*</b> are needed to save. Everything else can be filled
            in later from the contact’s own record.
          </>
        )}
      </p>

      <IntakeForm
        mode="create"
        values={values}
        refs={refs}
        documents={[]}
        dealId={null}
        missing={missing}
        onChange={change}
        onUpload={() => undefined}
        onRemoveDoc={() => undefined}
      />

      <div className="save-bar">
        <Link className="btn secondary" href="/admin/people">
          Cancel
        </Link>
        <button className="btn" type="button" disabled={busy || !ready} onClick={() => void save(false)}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  );
}
