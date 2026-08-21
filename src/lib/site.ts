/**
 * The app's public origin for links in emails (invites, recovery). Trailing
 * slashes are stripped so `${siteOrigin(...)}/auth/update-password` never
 * doubles up.
 */
export function siteOrigin(fallback: string): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? fallback).replace(/\/+$/, '');
}

/**
 * The origin for links written where there is no request to borrow one from —
 * a chat notification, a digest, anything the cron endpoint sends.
 *
 * VERCEL_URL is the per-deployment host, which is right for a preview and wrong
 * for production: it points at one immutable build rather than the live domain.
 * So it is only the fallback, and NEXT_PUBLIC_SITE_URL is what should actually
 * be set — /api/health reports whether it is.
 */
export function siteUrl(): string {
  return siteOrigin(
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'
  );
}
