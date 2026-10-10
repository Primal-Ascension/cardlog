/* CardLog service worker.
 *
 * Tier 0 (app shell) is cached on install. Scanner data and libraries are
 * copied into the 'cardlog-scanner-v1' cache by the page (scan/engine.js), not
 * here: iOS stops service workers that run long downloads. This worker only
 * answers requests:
 *   - pages and the app's own JS: network first (so edits deploy), cache fallback
 *   - scanner/ data and scan/lib/: cache first (versioned by manifest hashes)
 *   - Drive inventory photos: saved copy if there is one (the page saves them)
 *   - other origins (Apps Script API, pokemontcg card images): untouched
 */
'use strict';

var SHELL = 'cardlog-shell-v1';
var SCANNER = 'cardlog-scanner-v1';
var SHELL_FILES = ['./', 'index.html', 'icon-180.png', 'scan/scanner.js', 'scan/engine.js', 'scan/detect.js', 'scan/label.js',
                   'img/graders/psa.svg', 'img/graders/cgc.svg', 'img/graders/tag.png', 'img/graders/bgs.svg',
                   'scan/img/stamp-1st-1.png', 'scan/img/stamp-1st-2.png', 'scan/img/stamp-1st-3.png'];
var NETWORK_TIMEOUT_MS = 3500;

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) {
    return Promise.all(SHELL_FILES.map(function (f) {
      return fetch(f, { cache: 'reload' }).then(function (r) { if (r.ok) return c.put(f, r); }).catch(function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) {
      return k.indexOf('cardlog-shell-') === 0 && k !== SHELL;
    }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function networkFirst(req) {
  return new Promise(function (resolve) {
    var settled = false;
    function fromCache() {
      return caches.match(req, { ignoreSearch: true }).then(function (r) { return r || caches.match('index.html'); });
    }
    var timer = setTimeout(function () {
      fromCache().then(function (r) { if (r && !settled) { settled = true; resolve(r); } });
    }, NETWORK_TIMEOUT_MS);
    // cache: 'no-cache' revalidates with GitHub Pages every time (a cheap 304
    // when nothing changed), so a push shows on the next open instead of
    // after Pages' 10-minute browser cache expires.
    fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(function (resp) {
      if (resp.ok) {
        var copy = resp.clone();
        caches.open(SHELL).then(function (c) { c.put(req, copy); });
      }
      clearTimeout(timer);
      if (!settled) { settled = true; resolve(resp); }
    }).catch(function () {
      clearTimeout(timer);
      fromCache().then(function (r) {
        if (!settled) { settled = true; resolve(r || new Response('Offline', { status: 503 })); }
      });
    });
  });
}

function cacheFirst(req) {
  return caches.open(SCANNER).then(function (c) {
    return c.match(req, { ignoreSearch: true });
  }).then(function (r) {
    return r || fetch(req);
  });
}

/* Inventory photos (Google Drive thumbnails): served from the saved copy when
 * there is one, otherwise from the network. The page fills and verifies the
 * cache (index.html savePhotosForOffline); this worker never writes to it,
 * because Drive responses are opaque and an error page can't be told apart
 * from a photo here. A photo's Drive id changes when it is replaced, so a
 * saved copy never goes stale and is never re-downloaded. */
var PHOTOS = 'cardlog-photos-v1';

function isInventoryPhoto(url) {
  return (url.hostname === 'drive.google.com' && url.pathname === '/thumbnail') ||
         /(^|\.)googleusercontent\.com$/.test(url.hostname);
}

function photoResponse(e) {
  var req = e.request;
  return caches.open(PHOTOS).then(function (c) {
    return c.match(req.url);
  }).then(function (hit) {
    return hit || fetch(req);
  }).catch(function () { return fetch(req); });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (isInventoryPhoto(url)) { e.respondWith(photoResponse(e)); return; }
  if (url.origin !== self.location.origin) return;             // Apps Script API, card images: browser default
  var scope = new URL(self.registration.scope);
  var path = url.pathname.slice(scope.pathname.length);
  if (path.indexOf('scanner/') === 0 || path.indexOf('scan/lib/') === 0) {
    e.respondWith(cacheFirst(req));
  } else if (req.mode === 'navigate' || path === '' || path === 'index.html' || /\.js$/.test(path)) {
    e.respondWith(networkFirst(req));
  } else if (SHELL_FILES.indexOf(path) >= 0) {
    e.respondWith(caches.match(req).then(function (r) { return r || fetch(req); }));
  }
});
