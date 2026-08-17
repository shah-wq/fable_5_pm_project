/**
 * The one thin native layer (spec §8, §10).
 *
 * Everything platform-specific in this app lives behind this single interface:
 * push registration, the camera, secure storage, the share sheet, biometric
 * unlock and the app's own version. The rest of the application — every page,
 * every component — talks to these functions and therefore stays
 * platform-agnostic and testable in a plain browser.
 *
 * Two implementations:
 *   * web (this file) — standard browser APIs. Works in the browser, in an
 *     installed PWA, and inside the Capacitor shell's WebView.
 *   * native (loaded lazily, only when a Capacitor shell is detected) — the
 *     Capacitor plugins, which give reliable iOS push and a real share sheet.
 *
 * Adding a capability means adding it here, never scattering
 * `if (Capacitor)` through the pages.
 */

export type Platform = 'web' | 'ios' | 'android';

export interface AppInfo {
  platform: Platform;
  /** True inside the Capacitor shell — i.e. the store-published app. */
  isNativeShell: boolean;
  /** True when running as an installed PWA (home-screen, no browser chrome). */
  isInstalled: boolean;
  version: string;
  build: string;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, unknown>;
}

function capacitor(): CapacitorGlobal | null {
  if (typeof window === 'undefined') return null;
  const c = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return c?.isNativePlatform?.() ? c : null;
}

export function appInfo(): AppInfo {
  const cap = capacitor();
  const platform = (cap?.getPlatform?.() as Platform | undefined) ?? 'web';
  const isInstalled =
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)').matches === true ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true);
  return {
    platform: platform === 'ios' || platform === 'android' ? platform : 'web',
    isNativeShell: cap !== null,
    isInstalled: cap !== null || isInstalled,
    version: process.env.NEXT_PUBLIC_APP_VERSION ?? '1.0.0',
    build: process.env.NEXT_PUBLIC_APP_BUILD ?? 'dev',
  };
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

/** urlBase64 (what VAPID keys are published as) → the Uint8Array the API wants. */
function urlBase64ToBytes(base64: string): Uint8Array {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const b64 = (buf: ArrayBuffer | null): string =>
  buf ? btoa(String.fromCharCode(...new Uint8Array(buf))) : '';

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Whether we have already been granted, refused, or not yet asked. */
export function pushPermission(): NotificationPermission | 'unsupported' {
  if (!pushSupported()) return 'unsupported';
  return Notification.permission;
}

/**
 * Ask, subscribe, and register the device with the server. Call this only from
 * the explainer screen — never on first launch. On iOS the prompt appears once
 * in the app's lifetime, so a cold ask that gets refused is unrecoverable
 * (spec §4).
 */
export async function enablePush(): Promise<{ ok: boolean; reason?: string }> {
  if (!pushSupported()) {
    return { ok: false, reason: 'This device or browser cannot receive notifications.' };
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { ok: false, reason: 'Notifications are turned off for this app.' };
  }

  const registration = await navigator.serviceWorker.ready;
  const keyRes = await fetch('/api/push/key');
  const { publicKey } = (await keyRes.json()) as { publicKey?: string };
  if (!publicKey) {
    return { ok: false, reason: 'Notifications are not configured on the server yet.' };
  }

  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(publicKey) as BufferSource,
    }));

  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      endpoint: subscription.endpoint,
      p256dh: b64(subscription.getKey('p256dh')),
      auth: b64(subscription.getKey('auth')),
      platform: appInfo().platform,
    }),
  });
  if (!res.ok) return { ok: false, reason: 'Could not register this device.' };
  return { ok: true };
}

/** Turn this device off without touching the customer's other devices. */
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await fetch('/api/push/subscribe', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  await subscription.unsubscribe();
}

// ---------------------------------------------------------------------------
// Camera / photos
// ---------------------------------------------------------------------------

/**
 * Shrink a phone photo before upload. A modern phone produces 4–8 MB per shot
 * and customers are often on mobile data, so this is not an optimisation —
 * without it the upload fails on a weak signal (spec §3.4).
 */
export async function compressImage(
  file: File,
  { maxEdge = 1600, quality = 0.82 }: { maxEdge?: number; quality?: number } = {}
): Promise<File> {
  if (!file.type.startsWith('image/') || typeof document === 'undefined') return file;
  // HEIC cannot be decoded by most browsers; send it as-is and let the server
  // store it rather than corrupting it here.
  if (/heic|heif/i.test(file.type)) return file;

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;

  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 1_500_000) return file;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality)
  );
  if (!blob || blob.size >= file.size) return file;
  return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', {
    type: 'image/jpeg',
    lastModified: file.lastModified,
  });
}

// ---------------------------------------------------------------------------
// Share / save
// ---------------------------------------------------------------------------

/**
 * How a customer forwards paperwork to their accountant or lender. The native
 * share sheet where there is one; a download otherwise.
 */
export async function shareFile(
  url: string,
  filename: string,
  title: string
): Promise<'shared' | 'downloaded'> {
  const canShareFiles =
    typeof navigator !== 'undefined' && 'canShare' in navigator && 'share' in navigator;
  if (canShareFiles) {
    try {
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title });
        return 'shared';
      }
    } catch {
      // Cancelled, or the platform refused files — fall through to download.
    }
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.click();
  return 'downloaded';
}

// ---------------------------------------------------------------------------
// Secure storage
// ---------------------------------------------------------------------------

/**
 * Small values the app remembers between launches. In the native shell this is
 * backed by the iOS Keychain / Android Keystore; on the web it is localStorage,
 * which is why nothing secret goes through it — the session credential is an
 * httpOnly cookie the JavaScript cannot read, by design (spec §6).
 */
export const store = {
  get(key: string): string | null {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage.getItem(`sf.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`sf.${key}`, value);
    } catch {
      /* private mode, quota — not worth failing a page render over */
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(`sf.${key}`);
    } catch {
      /* as above */
    }
  },
  /** Sign-out must leave nothing of the project on the device (spec §6). */
  clearAll(): void {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('sf.')) localStorage.removeItem(key);
      }
    } catch {
      /* as above */
    }
  },
};

// ---------------------------------------------------------------------------
// Biometric unlock
// ---------------------------------------------------------------------------
// Face ID / Touch ID / Android biometric re-opens an existing session. It
// unlocks the app; it is NOT the credential — the session cookie is (spec §6).
// So this is deliberately a device-local gate: a passing check reveals the
// already-authenticated page, and a failing one shows the lock screen with a
// way to sign in normally.

const LOCK_KEY = 'biometric.credentialId';

export async function biometricsAvailable(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.PublicKeyCredential) return false;
  const check = (
    window.PublicKeyCredential as unknown as {
      isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
    }
  ).isUserVerifyingPlatformAuthenticatorAvailable;
  if (!check) return false;
  return check.call(window.PublicKeyCredential).catch(() => false);
}

export function biometricsEnabled(): boolean {
  return store.get(LOCK_KEY) !== null;
}

export async function enableBiometrics(userId: string, label: string): Promise<boolean> {
  if (!(await biometricsAvailable())) return false;
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userIdBytes = new TextEncoder().encode(userId);
  try {
    const credential = (await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: 'SolarFlow', id: location.hostname },
        user: { id: userIdBytes, name: label, displayName: label },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred',
        },
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;
    if (!credential) return false;
    store.set(LOCK_KEY, b64(credential.rawId));
    return true;
  } catch {
    return false;
  }
}

export function disableBiometrics(): void {
  store.remove(LOCK_KEY);
}

/** Ask the device to confirm it is the owner. True unlocks the app. */
export async function biometricUnlock(): Promise<boolean> {
  const id = store.get(LOCK_KEY);
  if (!id) return true;
  try {
    const raw = Uint8Array.from(atob(id), (c) => c.charCodeAt(0));
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: 'public-key', id: raw as BufferSource }],
        userVerification: 'required',
        timeout: 60_000,
      },
    });
    return assertion !== null;
  } catch {
    return false;
  }
}
