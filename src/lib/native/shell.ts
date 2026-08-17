import { headers } from 'next/headers';

/**
 * Is this request coming from the installed store app rather than a browser?
 *
 * The Capacitor shell appends `SolarFlowApp/<n>` to its user agent
 * (capacitor.config.ts), which is the only signal available server-side. It is
 * used for one purpose: keeping the app to the homeowner's portal.
 *
 * Deliberately NOT used for anything security-relevant. A user agent is
 * client-supplied and trivially forged, so it decides presentation only — who
 * may read which row is still decided by the session, guardPath() and RLS,
 * exactly as it is in a browser. Someone who spoofs this header gains nothing.
 */
export async function isAppShell(): Promise<boolean> {
  const ua = (await headers()).get('user-agent') ?? '';
  return ua.includes('SolarFlowApp/');
}
