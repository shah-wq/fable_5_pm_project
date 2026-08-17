import { loadPortalPage, NO_PROJECT_MESSAGE } from '@/lib/portal/page';
import { DocumentList } from './DocumentList';

export const dynamic = 'force-dynamic';

/**
 * Documents (spec §3.3). Grouped by type, newest first, and only the documents
 * the PM has marked visible to the customer — sharing stays a per-document
 * decision made by a person.
 */
export default async function PortalDocuments({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project: p } = await loadPortalPage(searchParams);

  if (!p) {
    return (
      <div className="app-page">
        <h1>Your documents</h1>
        <p className="notice hold">{NO_PROJECT_MESSAGE}</p>
      </div>
    );
  }

  const files = p.documents.filter((d) => !d.isPhoto);

  return (
    <div className="app-page">
      <h1>Your documents</h1>
      <DocumentList
        documents={files}
        projectId={p.id}
        /* The full pack as one zip is offered at completion, when there is a
         * complete pack to give — offering it at survey stage would hand over
         * three files and look broken (spec §3.3). */
        offerZip={p.isComplete}
      />
    </div>
  );
}
