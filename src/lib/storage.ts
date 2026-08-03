/**
 * File-storage conventions. Bytes live in Postgres (storage.object_data) and
 * are reachable only through governed endpoints — there are no public URLs:
 *
 *   downloads  GET /api/files/<documentId>   (session + §2 access rules,
 *              enforced in the database by public.read_document)
 *   grant
 *   uploads    POST /api/u/<token>           (REQ-SEC-01 links; validated,
 *              stored, and audited by public.record_grant_upload)
 */

export const BUCKETS = {
  /** CAD sources — staff only. */
  dwg: 'project-dwg',
  /** Customer-facing PDFs (plan sets, contracts). */
  deliverables: 'project-deliverables',
  /** Site & survey photos; customers may upload their own. */
  photos: 'project-photos',
} as const;

export type BucketName = (typeof BUCKETS)[keyof typeof BUCKETS];

/**
 * Build the object key for a project-scoped file. Storage policies reject any
 * key that doesn't start with a project UUID the caller can access.
 */
export function projectObjectPath(projectId: string, ...segments: string[]): string {
  const cleaned = segments.map((s) => s.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  if (cleaned.length === 0) {
    throw new Error('projectObjectPath requires at least one path segment');
  }
  return `${projectId}/${cleaned.join('/')}`;
}

/** The app-internal URL a document's bytes are served from. */
export function documentUrl(documentId: string): string {
  return `/api/files/${documentId}`;
}
