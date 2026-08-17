/* SolarFlow service worker — the installable portal's offline and push layer.
 *
 * Three jobs, and deliberately no more:
 *
 *  1. Push. Show the notification, and open the exact screen it refers to.
 *     A notification that dumps the customer on a generic home tab is worse
 *     than no notification (spec §4).
 *  2. A read cache for the app shell and for documents the customer has
 *     already opened, so a basement with no signal still shows something
 *     useful (spec §5).
 *  3. Nothing else. It never caches an HTML page: pages are per-customer and
 *     server-rendered, and a stale private page served to the next person to
 *     pick up the phone is not a trade worth making. The offline status view is
 *     a JSON snapshot the page itself stores, with a visible timestamp — the
 *     server is always the authoritative copy.
 */

const SHELL = 'sf-shell-v1';
const FILES = 'sf-files-v1';

const SHELL_URLS = [
  '/offline.html',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(SHELL_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL && k !== FILES).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

/* Sign-out clears every cached byte of the project from the device (spec §6). */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'sf-clear-cache') {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  /* A document or photo the customer has opened once stays available offline.
   * Cache-first: these files never change under a given id. */
  if (url.pathname.startsWith('/api/files/')) {
    event.respondWith(
      caches.open(FILES).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok && response.status === 200) cache.put(request, response.clone());
        return response;
      })
    );
    return;
  }

  /* Static build assets and icons: cache-first, they are content-hashed. */
  if (url.pathname.startsWith('/_next/static/') || SHELL_URLS.includes(url.pathname)) {
    event.respondWith(
      caches.open(SHELL).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
    );
    return;
  }

  /* Any portal page requested with no network falls back to the offline view,
   * which renders the last snapshot the app stored, with its timestamp. */
  if (request.mode === 'navigate' && url.pathname.startsWith('/portal')) {
    event.respondWith(
      fetch(request).catch(() => caches.match('/offline.html').then((r) => r ?? Response.error()))
    );
  }
});

/* ------------------------------------------------------------------------- */
/* Push                                                                       */
/* ------------------------------------------------------------------------- */

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'SolarFlow', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'SolarFlow';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      /* Deep link — the whole value of the notification (spec §4, §10). */
      data: { url: payload.url || '/portal' },
      /* One notification per category replaces the previous one rather than
       * stacking five 'project moved forward' cards. */
      tag: payload.tag || payload.category || 'solarflow',
      renotify: true,
      requireInteraction: false,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/portal';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        /* Already open: navigate the existing window rather than opening a
         * second copy of the app. */
        if (client.url.includes('/portal') && 'navigate' in client) {
          return client.navigate(target).then((c) => c && c.focus());
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
