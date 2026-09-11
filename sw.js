// Sristi Farm Verification — Service Worker
// Cache version: bump this string whenever index.html changes significantly.
const CACHE = 'sristi-fv-v279';

// The one entry that IS the app. Everything else in SHELL is a library the app
// can survive one session without; without this there is nothing to show.
const SHELL_KEY = './index.html';

/* The app cannot start without these. index.html loads the three Firebase
   compat scripts as ordinary blocking <script src> tags before its own code
   runs, so a cache holding the page but not them produces a blank screen and
   no explanation. Leaflet and html2pdf are fetched on demand and are not on
   this list: a missing map is a missing map, not a dead app. */
const CRITICAL = [
  './index.html',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js',
];

const SHELL = [
  './',
  './index.html',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js',
  // v181 — App Check SDK. Precached like the others so an offline reopen does
  // not sit waiting on a CDN. If it fails to cache, allSettled shrugs and the
  // activation guard in index.html skips App Check entirely.
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-check-compat.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/html2pdf.js@0.10.1/dist/html2pdf.bundle.min.js',
];

/* ==================== v264 — "This site can't be reached" ====================

   Reported from the installed desktop app: launching it showed the browser's
   own network-error page, and pressing refresh opened it normally. That is not
   a server outage — an outage does not mend itself on one refresh — and it is
   not a caching subtlety either. It was this service worker answering the
   navigation with nothing at all.

   The old shell handler ended in `return cached || networkFetch`, where
   networkFetch was `fetch(...).catch(() => cached)`. Follow both halves being
   empty at once: the cache has no shell, the fetch rejects, the catch hands
   back the same empty `cached`, and respondWith is left resolving to undefined.
   A service worker that resolves respondWith with undefined does not fall back
   to the network — the browser treats it as a failed response and shows
   exactly the page Guru saw. The next launch found the network back and worked,
   which is why it looked intermittent.

   The cache could be empty because install used allSettled, deliberately, so a
   flaky CDN could not sink the whole precache. The cost of that tolerance was
   that index.html itself was allowed to fail quietly too, and activate then
   deleted the previous version's cache — the one copy of the app still on the
   machine — before anyone checked whether the new cache could serve anything.
   Deploying eleven versions in a few days made that window come round often.

   Three changes, and any one of them alone would have prevented it:

     the shell is no longer best-effort. install retries it, and if the network
     will not give it up, lifts it out of the previous version's cache.

     activate keeps the old caches until the new one is proven able to serve the
     app. Nothing is deleted on the strength of having been replaced.

     no path through the fetch handler can end in undefined. When the cache is
     empty and the network is gone, the last resort is a small page that says so
     in Gujarati and reloads itself the moment the connection returns.

   None of this touches Firebase, reads or writes any farmer data, or changes
   what the app does once it is open. It is cache-first exactly as before, so
   a launch with a warm cache is the same instant launch it was. */

/* v264b - nothing here may wait for ever. While this worker is activating the
   browser holds every fetch event, so an attempt that hangs holds the app. */
const SHELL_FETCH_MS = 8000;
function timed(p, ms){
  return new Promise(function(resolve, reject){
    const t = setTimeout(function(){ reject(new Error('timed out')); }, ms);
    Promise.resolve(p).then(
      function(v){ clearTimeout(t); resolve(v); },
      function(e){ clearTimeout(t); reject(e); });
  });
}

/* v264b - A RESPONSE THAT REMEMBERS A REDIRECT CANNOT ANSWER A LAUNCH.

   A navigation request has redirect mode 'manual', and handing it a Response
   whose `redirected` flag is set is a hard failure in the browser - the same
   error page this release is named after. Cache.put makes no such check, so
   one fetch that passed through a captive portal or a proxy 302 is enough to
   store a shell that can never be served again.

   Rebuilding the response drops the flag and keeps the body, status and
   headers. Done on the way IN, so nothing poisoned is ever stored, and checked
   again on the way out for the copies already sitting on people's machines. */
function isRedirected(r){
  try{ return !!(r && r.redirected); }catch(e){ return false; }
}
async function withoutRedirect(r){
  if(!isRedirected(r)) return r;
  try{
    const body = await r.blob();
    return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
  }catch(e){ return null; }
}

/* v264b - which of these caches is the NEWEST build? Walking them in creation
   order and taking the first hit meant reaching for the OLDEST copy on the
   machine, and activate then deleted every newer one, so a bad-network install
   could quietly move a coordinator back several versions. */
function cacheVersionNumber(name){
  const m = /(\d+)/.exec(String(name || ''));
  return m ? parseInt(m[1], 10) : -1;
}
async function otherCacheNames(){
  let keys = [];
  try{ keys = await caches.keys(); }catch(e){ return []; }
  return keys.filter(function(k){ return k !== CACHE; })
             .sort(function(a, b){ return cacheVersionNumber(b) - cacheVersionNumber(a); });
}
async function findShellInAnyCache(){
  for(const k of await otherCacheNames()){
    try{
      const c = await caches.open(k);
      const r = (await c.match(SHELL_KEY)) || (await c.match('./'));
      if(r && !isRedirected(r)) return r;
    }catch(e){ /* a cache we cannot open is simply not a source */ }
  }
  return null;
}

/* v264c - take the WHOLE donor cache, not just the page.

   Copying only index.html and then letting activate delete the donor was the
   worst outcome of the three: the app opened and died on a missing Firebase
   SDK, with no offline message, because a cached shell was found and the
   offline page therefore never ran. An honest error page is better than that.

   Best effort per entry. The shell is written LAST, so a copy that gives up
   half way leaves no shell here and this cache is not treated as usable. */
async function salvageFromOldCache(cache){
  for(const k of await otherCacheNames()){
    let c = null;
    try{ c = await caches.open(k); }catch(e){ continue; }
    let shell = null;
    try{ shell = (await c.match(SHELL_KEY)) || (await c.match('./')); }catch(e){}
    if(!shell || isRedirected(shell)) continue;
    try{
      const reqs = await c.keys();
      for(const rq of reqs){
        try{
          const r = await c.match(rq);
          if(r && !isRedirected(r)) await cache.put(rq, r);
        }catch(e){}
      }
    }catch(e){ /* an old cache that will not enumerate still gives us the page */ }
    try{
      const clean = await withoutRedirect(shell);
      if(clean){ await cache.put(SHELL_KEY, clean); return true; }
    }catch(e){}
  }
  return false;
}

/* Can this cache actually start the app? Asked by activate before it throws
   anything away. Deliberately a question about the CACHE and not about how the
   shell got there: install and activate are separate events, they can run in
   separate worker instances, and nothing remembered in a variable survives
   that. Asking the cache gives the same answer to both. */
async function cacheCanBoot(cache){
  for(const u of CRITICAL){
    try{ if(!(await cache.match(u))) return false; }
    catch(e){ return false; }
  }
  return true;
}

/* v264b - the libraries live in the old cache too./* v264b - the libraries live in the old cache too. When the shell had to be
   copied out of one, that cache is kept (see activate) and this is how the
   Firebase SDK, Leaflet and html2pdf are still reachable from it offline. */
async function findInAnyCache(request){
  for(const k of await otherCacheNames()){
    try{
      const c = await caches.open(k);
      const r = await c.match(request);
      if(r) return r;
    }catch(e){}
  }
  return null;
}

/* Make sure this cache can serve the app at all. */
async function ensureShell(cache){
  try{ if(await cache.match(SHELL_KEY)) return true; }catch(e){}

  /* Both attempts force revalidation. A bare string would use the default
     cache mode and could be answered entirely from the browser's disk cache,
     installing the PREVIOUS build as this version's shell without ever
     touching the network. The second attempt exists for the directory URL,
     which some proxies treat differently, not to relax freshness. */
  for(const a of [SHELL_KEY, './']){
    try{
      const r = await timed(fetch(new Request(a, { cache: 'reload' })), SHELL_FETCH_MS);
      if(r && r.ok){
        const clean = await withoutRedirect(r.clone());
        if(clean){ await cache.put(SHELL_KEY, clean); return true; }
      }
    }catch(e){ /* try the next one */ }
  }

  // Still nothing from the network. An older version of the app, with its
  // libraries, is far better than no app.
  return await salvageFromOldCache(cache);
}

// Pre-cache app shell on install.
// v22: TOLERANT precache. addAll() is all-or-nothing, so one failing CDN (common on
// a flaky field connection) used to leave the WHOLE cache empty → offline reopen
// served nothing. allSettled lets each entry fail independently; the same-origin
// shell ('./' , './index.html') is what MUST cache for offline reopen and is the most
// reliable to fetch — CDN libs are best-effort.
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    /* v264c - the shell is NOT in this list any more. cache.add stores exactly
       what the network returned, redirect flag included, and a redirected
       response handed to a navigation is a hard failure in the browser. The
       libraries are subresources and unaffected by that, so they still go
       through add; the page goes through ensureShell, which cleans it. */
    await Promise.allSettled(SHELL.filter(u => u !== './' && u !== SHELL_KEY).map(u => {
      // v22: fetch the same-origin shell with cache:'reload' so the precached
      // index.html is the FRESHLY-DEPLOYED build, not a stale copy from the browser
      // HTTP cache (that staleness is the real "stuck on old version" cause). Install
      // only runs on a new/bumped sw.js, so fetching fresh here is exactly right.
      // Versioned CDN libs are immutable — a normal cached add is fine.
      return cache.add(u);
    }));
    // v264 — the shell is not allowed to have quietly failed above.
    await ensureShell(cache);
    await self.skipWaiting();
  })());
});

// Remove old caches on activate, then take control.
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    /* v264b - a ceiling on the whole thing, not just on each attempt. The
       browser holds every fetch event while a worker is activating, including
       the Firebase bypass, so nothing in here may be allowed to run long. If
       it does time out the fetch handler's own fallbacks take over, which is
       the same position this worker is in on any cold start. */
    let ready = false;
    try{ ready = await timed(ensureShell(cache), 20000); }catch(e){}
    /* v264c - and then ask the cache itself, because "ensureShell managed it"
       does not distinguish a complete install from a page salvaged out of the
       cache we are about to delete. */
    let complete = false;
    try{ complete = ready && await cacheCanBoot(cache); }catch(e){}
    /* v264 - the old cache is this machine's only other copy of the app. It is
       deleted once the new one is known to hold a shell, and not before. If the
       install landed on a dead connection the previous version stays put and
       keeps launching; the next activate with a working connection clears it.

       v264c - and "ensureShell managed it" is not good enough to delete on.
       It answers the same for a clean install and for a page lifted out of the
       very cache about to be deleted, and those are not the same thing: the
       Firebase SDK is a blocking script tag, so a shell without it opens and
       then dies with no message, which is worse than the error page this
       release removes. cacheCanBoot asks the cache instead, and salvage now
       copies the whole donor rather than one file, so the usual answer is yes.
    */
    if(complete){
      const keys = await caches.keys();
      await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    }
    await self.clients.claim();
  })());
});

/* The last resort, and the only response here that is never cached. It carries
   no app logic and reads no data — it exists so that a launch with an empty
   cache and no network ends in a sentence the person can act on rather than a
   browser error page, and so that it lets them back in by itself. */
function offlineShellResponse(){
  const html = '<!doctype html><html lang="gu"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>\u0ab8\u0acd\u0ab0\u0abf\u0ab7\u0acd\u0a9f\u0abf \u0a96\u0ac7\u0aa4\u0ac0 \u0a9a\u0a95\u0abe\u0ab8\u0aa3\u0ac0</title>'
    + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    + 'background:#f5f7fa;color:#1f2937;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;'
    + 'text-align:center;padding:24px}.b{max-width:340px}h1{font-size:19px;margin:0 0 8px}'
    + 'p{font-size:14px;line-height:1.7;color:#4b5563;margin:0 0 20px}'
    + 'button{font:inherit;font-size:15px;font-weight:600;padding:12px 26px;border:0;border-radius:10px;'
    + 'background:#3b82f6;color:#fff;cursor:pointer}</style></head><body><div class="b">'
    + '<div style="font-size:38px;margin-bottom:10px">\ud83d\udcf6</div>'
    + '<h1>\u0a87\u0aa8\u0acd\u0a9f\u0ab0\u0aa8\u0ac7\u0a9f \u0a9c\u0acb\u0aa1\u0abe\u0aaf\u0ac7\u0ab2\u0ac1\u0a82 \u0aa8\u0aa5\u0ac0</h1>'
    + '<p>\u0aa8\u0ac7\u0a9f\u0ab5\u0ab0\u0acd\u0a95 \u0a86\u0ab5\u0aa4\u0abe\u0a82 \u0a8f\u0aaa \u0a86\u0aaa\u0acb\u0a86\u0aaa \u0a96\u0ac2\u0ab2\u0ab6\u0ac7'
    + '<br><span style="font-size:12.5px;color:#6b7280">No connection yet \u2014 this page will open the app by itself</span></p>'
    + '<button onclick="location.reload()">\u0aab\u0ab0\u0ac0 \u0aaa\u0acd\u0ab0\u0aaf\u0abe\u0ab8 \u0a95\u0ab0\u0acb</button>'
    /* v264b - ONE reload, and only when the browser says the network came
       back. A repeating timer here is actively harmful: this page is shown
       while the shell may still be downloading behind it, and location.reload()
       ABORTS that download and starts again. On one bar of GPRS a 2.3MB shell
       needs over a minute, so a four-second timer killed it every time and the
       app could never install at all. navigator.onLine is not a test of
       anything either - it is true whenever any interface is up. */
    + '</div><script>var r=0;addEventListener("online",function(){if(r++)return;'
    + 'setTimeout(function(){location.reload();},1200);});<\/script>'
    + '</body></html>';
  return new Response(html, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

/* v264 — one function, and every branch of it returns a Response. */
async function serveShell(request){
  /* v264b - caches.open() itself can throw: Firefox private browsing, storage
     pressure, a corrupt store on iOS. It sat outside every try, so the one
     property this whole change exists to guarantee - that a navigation is
     never answered with a rejection - had a hole in it. */
  let cache = null;
  try{ cache = await caches.open(CACHE); }catch(e){}
  if(!cache){
    try{
      const r = await fetch(request);
      if(r && r.ok) return r;
    }catch(e){}
    return offlineShellResponse();
  }
  let cached = null;
  try{ cached = (await cache.match(SHELL_KEY)) || (await cache.match('./')); }catch(e){}
  /* Machines already carrying a poisoned copy from an earlier version: treat it
     as a miss so the network answer replaces it, rather than failing the launch
     on it for ever. */
  if(isRedirected(cached)) cached = null;

  if(cached){
    // Instant, then refresh in the background so the next launch is current.
    // Detached on purpose: the person waits for the cache, never for the network.
    fetch(request).then(resp => {
      if(resp && resp.ok) return withoutRedirect(resp.clone()).then(function(clean){
        if(clean) return cache.put(SHELL_KEY, clean);
      });
    }).catch(() => {});
    return cached;
  }

  // Cold cache. Now the network genuinely is the only source, so wait for it —
  // but never hand back whatever it gave us without checking that it is real.
  try{
    const resp = await fetch(request);
    if(resp && resp.ok){
      withoutRedirect(resp.clone()).then(function(clean){
        if(clean) return cache.put(SHELL_KEY, clean);
      }).catch(() => {});
      return resp;
    }
    /* A 5xx from GitHub Pages used to be served straight to the person as the
       app. Prefer any older copy over an error page pretending to be the app. */
    const older = await findShellInAnyCache();
    if(older) return older;
    if(resp) return resp;
  }catch(e){
    // findShellInAnyCache swallows its own failures and answers null.
    const older = await findShellInAnyCache();
    if(older) return older;
  }
  return offlineShellResponse();
}

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
    e.respondWith(serveShell(e.request));
    return;
  }

  // Cache-first for everything else (versioned/immutable assets), revalidate in
  // background. v264 — this branch could resolve to undefined in the same way
  // the shell branch did: cache miss plus a failed fetch handed respondWith
  // nothing, which surfaces as a resource that failed for no stated reason. A
  // real network error is now reported as one, which is what the browser would
  // have done had this service worker not been here at all.
  e.respondWith((async () => {
    let cache = null;
    try{ cache = await caches.open(CACHE); }catch(err){}
    let cached = null;
    if(cache){ try{ cached = await cache.match(e.request); }catch(err){} }
    if(cached){
      fetch(e.request).then(resp => {
        if(resp && resp.ok) return cache.put(e.request, resp.clone());
      }).catch(() => {});
      return cached;
    }
    try{
      const resp = await fetch(e.request);
      if(resp && resp.ok && cache) cache.put(e.request, resp.clone()).catch(() => {});
      if(resp) return resp;
    }catch(err){}
    /* v264b - when the shell had to be copied out of an older cache, that
       cache was KEPT and it is where the Firebase SDK, Leaflet and html2pdf
       still are. Look there before reporting a failure, or the app opens
       offline and then cannot reach a database or draw a map. */
    try{
      const older = await findInAnyCache(e.request);
      if(older) return older;
    }catch(err){}
    return Response.error();
  })());
});
