'use client';

import { prettyDate } from '@/lib/portal/home';

import { useState } from 'react';
import { shareFile } from '@/lib/native';

interface Doc {
  id: string;
  title: string;
  category: string;
  date: string;
}

/**
 * Groups documents by what they are, in customer wording, and opens a PDF in an
 * in-app viewer rather than bouncing the customer out to a browser (spec §3.3).
 *
 * 'Share' uses the platform's own share sheet where there is one — this is how
 * a homeowner forwards paperwork to their accountant or lender, and it is the
 * single most-used action on this screen. Where there is no share sheet it
 * falls back to a download, which is the same outcome by a different route.
 */
const GROUPS: Array<{ label: string; categories: string[] }> = [
  { label: 'Your agreement', categories: ['signed_co', 'signature_docs', 'contract'] },
  { label: 'Design and plans', categories: ['plan_set_dwg', 'design', 'layout'] },
  { label: 'Permits and approvals', categories: ['permit_letter_city', 'permit_letter_utility', 'hoa'] },
  { label: 'Power on', categories: ['pto_letter', 'inspection'] },
  { label: 'Things you sent us', categories: ['customer_upload'] },
];

function groupOf(category: string): string {
  return GROUPS.find((g) => g.categories.includes(category))?.label ?? 'Other documents';
}

export function DocumentList({
  documents,
  projectId,
  offerZip,
}: {
  documents: Doc[];
  projectId: string;
  offerZip: boolean;
}) {
  const [viewing, setViewing] = useState<Doc | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (documents.length === 0) {
    return (
      <p className="dim">
        Your documents will appear here as your project progresses — your agreement, your plans,
        your permits and finally your power-on letter.
      </p>
    );
  }

  // Newest first inside each group; groups in the order the project reaches them.
  const grouped = new Map<string, Doc[]>();
  for (const doc of [...documents].sort((a, b) => b.date.localeCompare(a.date))) {
    const key = groupOf(doc.category);
    grouped.set(key, [...(grouped.get(key) ?? []), doc]);
  }
  const order = [...GROUPS.map((g) => g.label), 'Other documents'];

  async function share(doc: Doc) {
    setBusy(doc.id);
    await shareFile(`/api/files/${doc.id}`, `${doc.title || 'document'}.pdf`, doc.title).catch(
      () => undefined
    );
    setBusy(null);
  }

  return (
    <>
      {offerZip && (
        <p className="notice ok">
          Your project is complete.{' '}
          <a href={`/api/portal/documents/zip?project=${projectId}`}>
            Download all your documents as one file
          </a>
          .
        </p>
      )}

      {order
        .filter((label) => grouped.has(label))
        .map((label) => (
          <section className="panel" key={label}>
            <h2>{label}</h2>
            <ul className="doc-list">
              {grouped.get(label)!.map((doc) => (
                <li key={doc.id}>
                  <button className="doc-open" type="button" onClick={() => setViewing(doc)}>
                    <span className="doc-title">{doc.title}</span>
                    <span className="dim">{prettyDate(doc.date) ?? doc.date}</span>
                  </button>
                  <button
                    className="btn secondary small"
                    type="button"
                    onClick={() => share(doc)}
                    disabled={busy === doc.id}
                  >
                    {busy === doc.id ? '…' : 'Share'}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}

      {viewing && (
        <div className="viewer" role="dialog" aria-modal aria-label={viewing.title}>
          <header className="viewer-bar">
            <button className="btn secondary small" type="button" onClick={() => setViewing(null)}>
              Close
            </button>
            <span className="viewer-title">{viewing.title}</span>
            <button className="btn small" type="button" onClick={() => share(viewing)}>
              Share
            </button>
          </header>
          {/* An in-app frame, not a redirect: the customer stays in the app and
              Close returns them to the list where they were. */}
          <iframe className="viewer-frame" src={`/api/files/${viewing.id}`} title={viewing.title} />
        </div>
      )}
    </>
  );
}
