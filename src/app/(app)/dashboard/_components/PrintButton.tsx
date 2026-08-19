'use client';

/**
 * Spec §10 asks for a full-dashboard PDF "for board packs and meetings".
 *
 * The browser's own print dialogue is that PDF: every desktop browser can save
 * a print to PDF, the print stylesheet already lays the bands out one per column
 * with the sidebar and the filter controls dropped, and it costs no server-side
 * renderer, no headless Chrome on the deployment, and no second layout to keep
 * in step with the first. The button exists because 'press Ctrl+P' is not a
 * feature anyone finds.
 */
export function PrintButton() {
  return (
    <button className="toggle-chip print" type="button" onClick={() => window.print()}>
      Print / PDF
    </button>
  );
}
