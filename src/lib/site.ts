/**
 * The app's public origin for links in emails (invites, recovery). Trailing
 * slashes are stripped so `${siteOrigin(...)}/auth/update-password` never
 * doubles up.
 */
export function siteOrigin(fallback: string): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? fallback).replace(/\/+$/, '');
}
