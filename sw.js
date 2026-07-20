// Sristi Farm Verification — Service Worker
// Cache version: bump this string whenever index.html changes significantly.
const CACHE = 'sristi-fv-v78';

const SHELL = [
  './',
  './index.html',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/html2pdf.js@0.10.1/dist/html2pdf.bundle.min.js',
];

// Pre-cache app shell on install.
// v22: TOLERANT precache. addAll() is all-or-nothing, so one failing CDN (common on
// a flaky field connection) used to leave the WHOLE cache empty → offline reopen
// served nothing. allSettled lets each entry fail independently; the same-origin
// shell ('./' , './index.html') is what MUST cache for offline reopen and is the most
// reliable to fetch — CDN libs are best-effort.
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.allSettled(SHELL.map(u => {
        // v22: fetch the same-origin shell with cache:'reload' so the precached
        // index.html is the FRESHLY-DEPLOYED build, not a stale copy from the browser
        // HTTP cache (that staleness is the real "stuck on old version" cause). Install
        // only runs on a new/bumped sw.js, so fetching fresh here is exactly right.
        // Versioned CDN libs are immutable — a normal cached add is fine.
        const req = (u === './' || u === './index.html') ? new Request(u, { cache: 'reload' }) : u;
        return cache.add(req);
      })))
      .then(() => self.skipWaiting())
  );
});

// Remove old caches on activate, then take control.
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Fetch strategy (v22 — reverted to CACHE-FIRST for field reliability):
//   - Firebase RTDB / Auth / Cloudinary → network only (live data, never cache).
//   - App shell (index.html / navigations) → CACHE-FIRST: serve the cached shell
//     INSTANTLY (works fully offline and on weak signal), revalidate in background so
//     the next launch is fresh. New deploys still apply promptly: a bumped sw.js
//     installs a fresh shell, skipWaiting()s, and the MAIN app (not the old iframe)
//     does a single guarded reload on controllerchange.
//     (v21 used network-first, which made EVERY launch depend on a live fetch of the
//      ~1.3MB shell — fatal offline / on flaky field networks. Reverted.)
//   - Versioned CDN libs (leaflet/sheetjs/firebase) → cache-first (immutable).
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Never intercept live-data or auth endpoints
  if (url.hostname.endsWith('firebasedatabase.app') ||
      url.hostname.endsWith('firebaseio.com') ||
      url.hostname.endsWith('googleapis.com') ||   // Firebase Auth token exchange
      url.hostname.endsWith('firebaseapp.com') ||  // Auth redirect domain
      url.hostname.endsWith('cloudinary.com')) {
    return; // let browser handle normally
  }

  // Shareable direct-to-form shortlinks (/haat/, /conv/) — always network,
  // never cached. Without this, the "isShell" navigate-request match below
  // would catch these too (mode:'navigate' matches ANY full-page nav, not
  // just the app root) and silently serve the cached MAIN APP shell instead
  // of the tiny redirect stub, breaking the shortlink for anyone whose
  // browser already has this service worker installed from a prior visit.
  if (/\/(haat|conv)\/?(index\.html)?$/i.test(url.pathname)) {
    return; // let browser handle normally
  }

  const isShell = e.request.mode === 'navigate' ||
                  url.pathname.endsWith('/') ||
                  url.pathname.endsWith('/index.html');

  if (isShell) {
    // Cache-first on the canonical './index.html' (ignores any ?query so every
    // navigation maps to the same cached entry), revalidate in the background.
    e.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match('./index.html').then(cached => {
          const networkFetch = fetch(e.request).then(resp => {
            if (resp && resp.ok) cache.put('./index.html', resp.clone());
            return resp;
          }).catch(() => cached); // offline / flaky — fall back to the cached shell
          return cached || networkFetch; // instant if cached; else go to network
        })
      )
    );
    return;
  }

  // Cache-first for everything else (versioned/immutable assets), revalidate in background.
  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(e.request).then(cached => {
        const networkFetch = fetch(e.request).then(response => {
          if (response.ok) cache.put(e.request, response.clone());
          return response;
        }).catch(() => cached); // network failed — fall back to cache
        return cached || networkFetch;
      })
    )
  );
});
