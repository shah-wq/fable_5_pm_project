import { loadPortalPage, NO_PROJECT_MESSAGE } from '@/lib/portal/page';
import { PhotoGallery } from './PhotoGallery';
import { PhotoUploader } from './PhotoUploader';

export const dynamic = 'force-dynamic';

/**
 * Photos (spec §3.4). Two halves: the customer's own system, and the camera for
 * the times we have asked them for something.
 *
 * Survey photos stay internal — the gallery shows only what the PM marked
 * visible, which for most projects means the install photos and anything the
 * customer sent themselves.
 */
export default async function PortalPhotos({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project: p } = await loadPortalPage(searchParams);

  if (!p) {
    return (
      <div className="app-page">
        <h1>Photos</h1>
        <p className="notice hold">{NO_PROJECT_MESSAGE}</p>
      </div>
    );
  }

  const photos = p.documents.filter((d) => d.isPhoto);

  return (
    <div className="app-page">
      <h1>Photos</h1>

      <PhotoUploader projectId={p.id} asks={p.asks} />

      <section className="panel">
        <h2>Your system</h2>
        {photos.length === 0 ? (
          <p className="dim">
            Photos of your installation will appear here once the crew has been on site.
          </p>
        ) : (
          <PhotoGallery photos={photos} />
        )}
      </section>
    </div>
  );
}
