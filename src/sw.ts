/*
 * sw.ts
 *
 * Service Worker for the transport log PWA. It handles caching of
 * static assets to enable offline access to the application and
 * displays a fallback page if the network is unavailable. To keep
 * things simple, background sync of pending logs is handled in the
 * main thread rather than here. If desired, you can extend this
 * service worker to listen for 'sync' events and post pending logs.
 */

const STATIC_CACHE = 'static-cache-v1';

// A list of resources we want to precache. These should match the
// assets in the build output. During development Vite serves files
// directly from source, so caching is limited.
const PRECACHE_URLS = [
  '/',
  '/manifest.json',
  '/index.html'
];

// Install event: pre-cache the application shell.
self.addEventListener('install', (event: ExtendableEvent) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      return cache.addAll(PRECACHE_URLS);
    })
  );
});

// Activate event: clean up old caches if necessary.
self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== STATIC_CACHE) {
            return caches.delete(key);
          }
        })
      );
    })
  );
});

// Fetch handler: respond with cached resources when offline.
self.addEventListener('fetch', (event: FetchEvent) => {
  const request = event.request;
  // Only handle GET requests
  if (request.method !== 'GET') {
    return;
  }
  event.respondWith(
    (async () => {
      try {
        // Try the network first
        const networkResponse = await fetch(request);
        // Cache the response for future use
        const cache = await caches.open(STATIC_CACHE);
        cache.put(request, networkResponse.clone());
        return networkResponse;
      } catch (err) {
        // If network fails, try cache
        const cacheResponse = await caches.match(request);
        if (cacheResponse) {
          return cacheResponse;
        }
        // Fallback to offline page if available
        const offline = await caches.match('/index.html');
        return offline || new Response('オフラインです。', { status: 503, statusText: 'Offline' });
      }
    })()
  );
});