'use client';

import { useEffect, useState } from 'react';
import { appInfo, biometricUnlock, biometricsEnabled, store } from '@/lib/native';

/**
 * The bits of the installable app that have to run in the browser: registering
 * the service worker, the offline banner, the biometric lock screen, and the
 * forced-update check.
 *
 * Deliberately does NOT ask for notification permission — that is a separate,
 * deferred, explained decision (spec §4), and asking here would burn the one
 * chance iOS gives you.
 */
export function AppRuntime({ snapshot }: { snapshot: OfflineSnapshot }) {
  const [offline, setOffline] = useState(false);
  const [locked, setLocked] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [update, setUpdate] = useState<{ store: string | null } | null>(null);

  // --- Service worker: the offline read cache and the push receiver ---------
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }, []);

  // --- Keep the last-seen status on the device (spec §5) -------------------
  useEffect(() => {
    if (!snapshot.headline) return;
    store.set('snapshot', JSON.stringify({ ...snapshot, savedAt: new Date().toISOString() }));
    // The customer has now seen their status once, which is the moment it
    // becomes reasonable to ask about notifications.
    store.set('seenStatus', '1');
  }, [snapshot]);

  // --- Offline banner ------------------------------------------------------
  useEffect(() => {
    const sync = () => setOffline(!navigator.onLine);
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  // --- Biometric lock -----------------------------------------------------
  // The session cookie is the credential; this only decides whether to reveal
  // the already-authenticated page to whoever is holding the phone (spec §6).
  useEffect(() => {
    if (!biometricsEnabled()) return;
    const info = appInfo();
    if (!info.isInstalled) return; // browser tabs are not the locked surface
    setLocked(true);
    void attemptUnlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function attemptUnlock() {
    setUnlocking(true);
    const ok = await biometricUnlock();
    setUnlocking(false);
    if (ok) setLocked(false);
  }

  // --- Forced update (spec §8) --------------------------------------------
  useEffect(() => {
    const info = appInfo();
    if (!info.isNativeShell) return; // only the store build can be out of date
    fetch('/api/app/version')
      .then((r) => r.json())
      .then((v: { minVersion: string | null; stores: { ios: string | null; android: string | null } }) => {
        if (!v.minVersion) return;
        if (compareVersions(info.version, v.minVersion) < 0) {
          setUpdate({ store: info.platform === 'ios' ? v.stores.ios : v.stores.android });
        }
      })
      .catch(() => undefined);
  }, []);

  if (update) {
    return (
      <div className="app-block" role="alertdialog">
        <div className="app-block-card">
          <h2>Time to update</h2>
          <p>
            This version of the app is too old to show your project correctly. Updating takes a
            few seconds.
          </p>
          {update.store && (
            <a className="btn" href={update.store}>
              Update now
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      {offline && (
        <p className="offline-bar" role="status">
          No connection — showing what we last loaded
          {snapshot.savedAt ? ` (${relative(snapshot.savedAt)})` : ''}.
        </p>
      )}
      {locked && (
        <div className="app-block" role="alertdialog">
          <div className="app-block-card">
            <h2>Locked</h2>
            <p>Unlock with Face ID, Touch ID or your fingerprint to see your project.</p>
            <button className="btn" type="button" onClick={attemptUnlock} disabled={unlocking}>
              {unlocking ? 'Waiting…' : 'Unlock'}
            </button>
            <p className="dim">
              <a href="/auth/signout">Sign out instead</a>
            </p>
          </div>
        </div>
      )}
    </>
  );
}

export interface OfflineSnapshot {
  headline: string | null;
  stageLabel: string | null;
  address: string | null;
  estimate: string | null;
  savedAt?: string;
}

/** '1.4.0' vs '1.10.0' — numeric per part, not lexicographic. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function relative(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
