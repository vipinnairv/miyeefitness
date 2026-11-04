/* MiyeeFit Pro service worker: makes the app installable and usable offline.
 * Miyee Tech Labs • miyeetechlabs.com
 *
 * - App pages: network first, so a new deploy shows up immediately; the cached copy is used offline.
 * - Icons, manifest and screenshots: served from cache and refreshed in the background.
 * - Libraries and fonts from CDNs: cached on first use so the app also loads offline.
 * - /api/* (sign-in and cloud data): never cached, always goes to the network.
 */
const VERSION = 'miyeefit-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const SHELL = ['./', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/icon.svg', './icons/apple-touch-icon.png'];
const CDN_HOSTS = ['cdn.tailwindcss.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put('./', response.clone());
    return response;
  } catch (e) {
    return (await cache.match('./')) || (await cache.match(request)) || Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then((response) => {
    if (response && (response.ok || response.type === 'opaque')) cache.put(request, response.clone());
    return response;
  }).catch(() => cached);
  return cached || network;
}

async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && (response.ok || response.type === 'opaque')) cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin && url.pathname.includes('/api/')) return;
  if (request.mode === 'navigate') { event.respondWith(networkFirst(request)); return; }
  if (url.origin === self.location.origin) { event.respondWith(staleWhileRevalidate(request)); return; }
  if (CDN_HOSTS.includes(url.hostname)) { event.respondWith(cacheFirst(request)); return; }
});
