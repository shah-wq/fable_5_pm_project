import type { TypedClient } from './supabase/client';

/**
 * Storage helpers for the three private project buckets. All downloads go
 * through short-lived signed URLs; storage RLS additionally scopes every
 * object to its project via the '<project_id>/...' key convention, so a URL
 * can only ever be minted by someone the §2 matrix lets in.
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

const DEFAULT_TTL_SECONDS = 60 * 10;

/**
 * Build the object key for a project-scoped file. Storage policies reject any
 * key that doesn't start with a project UUID the caller can access, so all
 * uploads must go through this.
 */
export function projectObjectPath(projectId: string, ...segments: string[]): string {
  const cleaned = segments
    .map((s) => s.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
  if (cleaned.length === 0) {
    throw new Error('projectObjectPath requires at least one path segment');
  }
  return `${projectId}/${cleaned.join('/')}`;
}

/** Mint a short-lived download URL. RLS decides whether the caller may. */
export async function createSignedDownloadUrl(
  supabase: TypedClient,
  bucket: BucketName,
  objectPath: string,
  expiresInSeconds: number = DEFAULT_TTL_SECONDS
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(objectPath, expiresInSeconds);
  if (error) {
    throw new Error(`Failed to sign ${bucket}/${objectPath}: ${error.message}`);
  }
  return data.signedUrl;
}

/** Mint signed download URLs for many objects in one round trip. */
export async function createSignedDownloadUrls(
  supabase: TypedClient,
  bucket: BucketName,
  objectPaths: string[],
  expiresInSeconds: number = DEFAULT_TTL_SECONDS
): Promise<Map<string, string>> {
  if (objectPaths.length === 0) return new Map();
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrls(objectPaths, expiresInSeconds);
  if (error) {
    throw new Error(`Failed to sign ${objectPaths.length} objects in ${bucket}: ${error.message}`);
  }
  const urls = new Map<string, string>();
  for (const entry of data) {
    if (entry.signedUrl && entry.path) urls.set(entry.path, entry.signedUrl);
  }
  return urls;
}

/**
 * Mint a signed upload URL so browsers can PUT large files (DWGs, photo
 * batches) directly to storage without proxying bytes through the app server.
 */
export async function createSignedUploadUrl(
  supabase: TypedClient,
  bucket: BucketName,
  projectId: string,
  ...pathSegments: string[]
): Promise<{ path: string; token: string; signedUrl: string }> {
  const path = projectObjectPath(projectId, ...pathSegments);
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUploadUrl(path);
  if (error) {
    throw new Error(`Failed to create upload URL for ${bucket}/${path}: ${error.message}`);
  }
  return data;
}
