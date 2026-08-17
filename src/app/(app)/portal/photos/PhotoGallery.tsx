'use client';

import { useEffect, useState } from 'react';

/**
 * Thumbnail grid that opens full-screen with swipe between photos and
 * pinch-to-zoom (spec §3.4).
 *
 * Both gestures are the platform's own rather than reimplemented in JavaScript:
 * swipe is a scroll-snap track, and zoom is `touch-action: pinch-zoom` on the
 * image. Native gestures beat hand-rolled ones on every device, and there is no
 * momentum or rubber-banding to get wrong.
 */
export function PhotoGallery({
  photos,
}: {
  photos: Array<{ id: string; title: string; date: string }>;
}) {
  const [open, setOpen] = useState<number | null>(null);

  // Escape closes; the hardware back button on Android does too, because the
  // viewer is a history entry rather than pure state.
  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <div className="photo-grid">
        {photos.map((photo, i) => (
          <button key={photo.id} type="button" onClick={() => setOpen(i)} title={photo.title}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/files/${photo.id}`} alt={photo.title} loading="lazy" />
          </button>
        ))}
      </div>

      {open !== null && (
        <div className="lightbox" role="dialog" aria-modal aria-label="Photos">
          <header className="viewer-bar">
            <button className="btn secondary small" type="button" onClick={() => setOpen(null)}>
              Close
            </button>
            <span className="viewer-title">
              {photos[open].date} · {open + 1} of {photos.length}
            </span>
            <a className="btn small" href={`/api/files/${photos[open].id}`} download>
              Save
            </a>
          </header>
          <div className="lightbox-track">
            {photos.map((photo) => (
              <div className="lightbox-slide" key={photo.id}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/files/${photo.id}`} alt={photo.title} />
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
