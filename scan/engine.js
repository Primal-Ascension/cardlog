/* CardLog scanner engine: offline sync, model + catalog loading, embedding, matching.
 *
 * Offline sync runs in the page (not the service worker), because iOS kills a
 * service worker that runs too long. The page copies files into Cache Storage;
 * sw.js only answers requests from that cache. Tiers follow spec section 8:
 *   tier 1  model, index shards, metadata, groups, variants, libraries (needed to scan)
 *   tier 2  thumbnails (background, never blocks scanning)
 * A small "synced" record keeps the sha256 of every cached file, so an update
 * fetches only files whose hash changed in the remote manifest.
 */
(function (global) {
  'use strict';

  var CACHE = 'cardlog-scanner-v1';
  var DATA = 'scanner/';
  var LIB = 'scan/lib/';
  var SYNCED_KEY = DATA + '__synced.json';
  // Self-hosted libraries; the version string doubles as their "hash".
  var LIB_FILES = {
    'scan/lib/ort.webgpu.min.js': 'ort-1.30.0',
    'scan/lib/ort-wasm-simd-threaded.asyncify.mjs': 'ort-1.30.0',
    'scan/lib/ort-wasm-simd-threaded.asyncify.wasm': 'ort-1.30.0',
    'scan/lib/opencv.js': 'opencv-4.9.0',
    // Slab label OCR (scan/label.js). Optional: downloaded with tier 1 but not
    // needed to scan, so a phone set up before these existed stays ready and
    // picks them up in its next background update.
    'scan/lib/tesseract/tesseract.min.js': 'tesseract-6.0.1',
    'scan/lib/tesseract/worker.min.js': 'tesseract-6.0.1',
    'scan/lib/tesseract/tesseract-core-simd-lstm.wasm.js': 'tesseract-core-6.0.0',
    'scan/lib/tesseract/tesseract-core-lstm.wasm.js': 'tesseract-core-6.0.0',
    'scan/lib/tesseract/eng.traineddata.gz': 'tessdata-eng-4.0.0-best-int'
  };

  var BASE = new URL('./', global.location.href).href;   // the app's folder, e.g. https://x.github.io/cardlog/
  function abs(path) { return new URL(path, BASE).href; }

  function openCache() {
    try { return global.caches.open(CACHE); } catch (e) { return Promise.reject(e); }
  }

  function readJSON(cache, path) {
    return cache.match(abs(path)).then(function (r) { return r ? r.json() : null; }).catch(function () { return null; });
  }

  function putJSON(cache, path, obj) {
    return cache.put(abs(path), new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } }));
  }

  function fetchRemoteManifest() {
    return fetch(abs(DATA + 'manifest.json'), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('manifest HTTP ' + r.status);
      return r.json();
    });
  }

  function fileLists(manifest) {
    var t1 = [], t2 = [];
    Object.keys(manifest.files).forEach(function (p) {
      var f = manifest.files[p];
      (f.tier === 2 ? t2 : t1).push({ path: DATA + p, sha: f.sha256, bytes: f.bytes });
    });
    Object.keys(LIB_FILES).forEach(function (p) {
      t1.push({ path: p, sha: LIB_FILES[p], bytes: 0, optional: p.indexOf(LIB + 'tesseract/') === 0 });
    });
    return { t1: t1, t2: t2 };
  }

  /* Offline status from the cached state alone (no network). */
  function status() {
    return openCache().then(function (cache) {
      return Promise.all([readJSON(cache, DATA + 'manifest.json'), readJSON(cache, SYNCED_KEY)]).then(function (r) {
        var manifest = r[0], synced = r[1] || {};
        if (!manifest) return { ready: false, tier1: [0, 0], tier2: [0, 0], manifest: null };
        var l = fileLists(manifest);
        l.t1 = l.t1.filter(function (f) { return !f.optional; });
        var c1 = l.t1.filter(function (f) { return synced[f.path] === f.sha; }).length;
        var c2 = l.t2.filter(function (f) { return synced[f.path] === f.sha; }).length;
        return { ready: c1 === l.t1.length, tier1: [c1, l.t1.length], tier2: [c2, l.t2.length],
                 manifest: manifest, version: manifest.version };
      });
    }).catch(function () { return { ready: false, tier1: [0, 0], tier2: [0, 0], manifest: null, error: 'storage unavailable' }; });
  }

  function pool(items, n, fn) {
    var i = 0;
    function next() {
      if (i >= items.length) return Promise.resolve();
      var item = items[i++];
      return fn(item).then(next);
    }
    var runners = [];
    for (var k = 0; k < Math.min(n, items.length); k++) runners.push(next());
    return Promise.all(runners);
  }

  var syncing = null;
  // Tier 2 (thumbnails) pauses while the scanner is open, so background
  // downloads never compete with a scan for the browser's connections.
  var paused = false;
  function whilePaused() {
    if (!paused) return Promise.resolve();
    return new Promise(function (r) { setTimeout(r, 400); }).then(whilePaused);
  }

  /* Bring the cache up to date with the remote manifest. onProgress(info) gets
   * {tier, done, total, bytesDone, bytesTotal}. Resolves with status(). Offline:
   * resolves with the cached status without throwing. */
  function sync(onProgress) {
    if (syncing) return syncing;
    onProgress = onProgress || function () {};
    syncing = Promise.all([openCache(), fetchRemoteManifest()]).then(function (r) {
      var cache = r[0], manifest = r[1];
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
      return readJSON(cache, SYNCED_KEY).then(function (synced) {
        synced = synced || {};
        var l = fileLists(manifest), dirty = 0;

        function runTier(tier, files, conc) {
          var todo = files.filter(function (f) { return synced[f.path] !== f.sha; });
          var total = todo.length, done = 0, bytesTotal = 0, bytesDone = 0;
          todo.forEach(function (f) { bytesTotal += f.bytes; });
          onProgress({ tier: tier, done: 0, total: total, bytesDone: 0, bytesTotal: bytesTotal });
          return pool(todo, conc, function (f) {
            return (tier === 2 ? whilePaused() : Promise.resolve()).then(function () {
              return fetch(abs(f.path), { cache: 'reload' });
            }).then(function (resp) {
              if (!resp.ok) throw new Error(f.path + ' HTTP ' + resp.status);
              return cache.put(abs(f.path), resp);
            }).then(function () {
              synced[f.path] = f.sha;
              done++; bytesDone += f.bytes; dirty++;
              onProgress({ tier: tier, done: done, total: total, bytesDone: bytesDone, bytesTotal: bytesTotal });
              if (dirty >= 200) { dirty = 0; return putJSON(cache, SYNCED_KEY, synced); }
            }).catch(function (e) {
              done++;
              onProgress({ tier: tier, done: done, total: total, bytesDone: bytesDone, bytesTotal: bytesTotal, error: String(e) });
            });
          }).then(function () { return putJSON(cache, SYNCED_KEY, synced); });
        }

        return runTier(1, l.t1, 4).then(function () {
          // Manifest goes in last for tier 1, so a half-finished sync never
          // claims files it does not have.
          return putJSON(cache, DATA + 'manifest.json', manifest);
        }).then(function () {
          return runTier(2, l.t2, 4);
        }).then(function () {
          // Drop files the new manifest no longer lists.
          var keep = {};
          l.t1.concat(l.t2).forEach(function (f) { keep[abs(f.path)] = true; });
          keep[abs(DATA + 'manifest.json')] = keep[abs(SYNCED_KEY)] = true;
          return cache.keys().then(function (reqs) {
            var stale = reqs.filter(function (q) { return !keep[q.url]; });
            stale.forEach(function (q) { delete synced[q.url.replace(BASE, '')]; });
            return Promise.all(stale.map(function (q) { return cache.delete(q); }));
          }).then(function () { return putJSON(cache, SYNCED_KEY, synced); });
        });
      });
    }).catch(function (e) {
      return status().then(function (s) { s.offline = true; s.syncError = String(e); return s; });
    }).then(function (res) {
      syncing = null;
      return res && res.tier1 ? res : status();
    });
    return syncing;
  }

  /* ---------------- Engine ---------------- */

  var F16 = null;
  function f16Table() {
    if (F16) return F16;
    F16 = new Float32Array(65536);
    for (var h = 0; h < 65536; h++) {
      var s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
      F16[h] = e === 0 ? s * Math.pow(2, -14) * (m / 1024)
             : e === 31 ? (m ? NaN : s * Infinity)
             : s * Math.pow(2, e - 15) * (1 + m / 1024);
    }
    return F16;
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve; s.onerror = function () { reject(new Error('could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  /* The OpenCV.js module is itself a thenable; resolving a promise with it makes
   * the promise adopt it again and again and the page hangs. Strip .then first. */
  function cvReady() {
    function done(resolve, m) {
      try { delete m.then; } catch (e) { m.then = undefined; }
      global.cv = m;
      resolve(m);
    }
    return new Promise(function (resolve) {
      var cv = global.cv;
      if (cv && cv.Mat && cv.getBuildInformation) return done(resolve, cv);
      if (cv && typeof cv.then === 'function') return cv.then(function (m) { done(resolve, m); });
      cv.onRuntimeInitialized = function () { done(resolve, global.cv); };
    });
  }

  function getBytes(cache, path) {
    return cache.match(abs(path)).then(function (r) {
      return r || fetch(abs(path));   // online and not cached yet
    }).then(function (r) {
      if (!r.ok) throw new Error(path + ' HTTP ' + r.status);
      return r.arrayBuffer();
    });
  }

  var engine = null;
  var CPU_KEY = 'cardlog.scan.cpuOnly';
  var GPU_WARMUP_MS = 60000, GPU_RUN_MS = 20000, CPU_RUN_MS = 60000;

  function cpuOnly() { try { return localStorage.getItem(CPU_KEY) === '1'; } catch (e) { return false; } }
  function setCpuOnly(v) { try { if (v) localStorage.setItem(CPU_KEY, '1'); else localStorage.removeItem(CPU_KEY); } catch (e) {} }

  function withTimeout(p, ms, what) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error(what + ' timed out after ' + Math.round(ms / 1000) + ' s')); }, ms);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  /* Create a session on one backend and prove it works with a warm-up run. */
  function createSession(E, ep) {
    var ort = E.ort, s = E.enc.input_size;
    return getBytes(E.cache, DATA + E.enc.file).then(function (buf) {
      return withTimeout(ort.InferenceSession.create(new Uint8Array(buf), {
        executionProviders: [ep], graphOptimizationLevel: 'all'
      }), ep === 'webgpu' ? GPU_WARMUP_MS : CPU_RUN_MS * 2, 'model load');
    }).then(function (session) {
      var x = new ort.Tensor('float32', new Float32Array(3 * s * s), [1, 3, s, s]);
      return withTimeout(session.run({ pixel_values: x }), ep === 'webgpu' ? GPU_WARMUP_MS : CPU_RUN_MS * 2, 'model warm-up')
        .then(function () { E.session = session; E.backend = ep; });
    });
  }

  /* Load everything needed to scan. onStep(text) reports progress. */
  var loading = null, stepListeners = [];
  function load(onStep) {
    if (engine) return Promise.resolve(engine);
    if (onStep) stepListeners.push(onStep);
    if (loading) return loading;           // preload already running: share it
    loading = loadOnce(function (t) { stepListeners.forEach(function (f) { try { f(t); } catch (e) {} }); })
      .then(function (E) { stepListeners = []; return E; },
            function (e) { loading = null; stepListeners = []; throw e; });
    return loading;
  }

  function loadOnce(onStep) {
    var t0 = performance.now(), E = { timings: {} };
    return openCache().then(function (cache) {
      E.cache = cache;
      return readJSON(cache, DATA + 'manifest.json').then(function (m) {
        return m || fetchRemoteManifest();
      });
    }).then(function (manifest) {
      E.manifest = manifest;
      E.enc = manifest.encoder;
      onStep('Loading libraries');
      return Promise.all([loadScript(abs(LIB + 'opencv.js')).then(cvReady), loadScript(abs(LIB + 'ort.webgpu.min.js'))]);
    }).then(function (r) {
      E.cv = r[0];
      var ort = E.ort = global.ort;
      ort.env.wasm.wasmPaths = abs(LIB);
      ort.env.wasm.numThreads = 1;   // Pages cannot send the headers threads need
      ort.env.logLevel = 'error';    // ORT prints harmless graph-optimizer warnings otherwise
      onStep('Loading model');
      // GPU first unless it has failed on this device before. Each backend gets
      // a warm-up run with a timeout: a phone GPU can spend a long time
      // compiling shaders on its first run, or hang outright, and that must
      // happen here (visible as "Preparing model") rather than during a scan.
      var order = navigator.gpu && !cpuOnly() ? ['webgpu', 'wasm'] : ['wasm'];
      function attempt(i) {
        var ep = order[i], t0 = performance.now();
        onStep(ep === 'webgpu' ? 'Preparing model on GPU (first time on this phone can take a minute)' : 'Preparing model');
        return createSession(E, ep).then(function () {
          E.timings.warmup = performance.now() - t0;
        }).catch(function (e) {
          E.gpuError = String(e && e.message || e);
          if (ep === 'webgpu') setCpuOnly(true);
          if (i + 1 < order.length) return attempt(i + 1);
          throw e;
        });
      }
      return attempt(0);
    }).then(function () {
      E.timings.model = performance.now() - t0;
      onStep('Loading catalog');
      var sets = E.manifest.index.sets, dim = E.manifest.index.dim, table = f16Table();
      return Promise.all(sets.map(function (sid) {
        return Promise.all([getBytes(E.cache, DATA + 'index/' + sid + '.bin'),
                            getBytes(E.cache, DATA + 'meta/' + sid + '.json')]);
      })).then(function (parts) {
        var n = 0;
        parts.forEach(function (p) { n += p[0].byteLength / (2 * dim); });
        var vecs = new Float32Array(n * dim), records = new Array(n), off = 0, dec = new TextDecoder();
        parts.forEach(function (p) {
          var h = new Uint16Array(p[0]), meta = JSON.parse(dec.decode(p[1]));
          if (meta.length * dim !== h.length) throw new Error('index/meta mismatch');
          for (var i = 0; i < h.length; i++) vecs[off * dim + i] = table[h[i]];
          for (var j = 0; j < meta.length; j++) records[off + j] = meta[j];
          off += meta.length;
        });
        E.vecs = vecs; E.records = records; E.n = n; E.dim = dim;
        E.byId = {};
        records.forEach(function (r, i) { E.byId[r.id] = i; });
      });
    }).then(function () {
      return Promise.all(['groups.json', 'variants.json', 'sets.json'].map(function (f) {
        return getBytes(E.cache, DATA + f).then(function (b) { return JSON.parse(new TextDecoder().decode(b)); });
      }));
    }).then(function (r) {
      E.groups = r[0]; E.variants = r[1]; E.sets = r[2];
      E.timings.total = performance.now() - t0;
      engine = E;
      return E;
    });
  }

  /* Art-box crop of a warped card (RGBA cv.Mat, 630x880) -> normalized CHW floats. */
  function preprocess(E, card, out, offset) {
    var cv = E.cv, b = E.enc.art_box, s = E.enc.input_size;
    var rect = new cv.Rect(Math.round(b[0] * card.cols), Math.round(b[1] * card.rows),
                           Math.round((b[2] - b[0]) * card.cols), Math.round((b[3] - b[1]) * card.rows));
    var roi = card.roi(rect), small = new cv.Mat();
    cv.resize(roi, small, new cv.Size(s, s), 0, 0, cv.INTER_AREA);
    var d = small.data, mean = E.enc.mean, std = E.enc.std, plane = s * s;
    for (var i = 0; i < plane; i++) {
      out[offset + i] = (d[i * 4] / 255 - mean[0]) / std[0];
      out[offset + plane + i] = (d[i * 4 + 1] / 255 - mean[1]) / std[1];
      out[offset + 2 * plane + i] = (d[i * 4 + 2] / 255 - mean[2]) / std[2];
    }
    roi.delete(); small.delete();
  }

  /* Embed one or more warped cards. Returns an array of Float32Array(dim). */
  function embed(E, cards) {
    var s = E.enc.input_size, per = 3 * s * s, data = new Float32Array(cards.length * per);
    cards.forEach(function (c, i) { preprocess(E, c, data, i * per); });
    var feeds = { pixel_values: new E.ort.Tensor('float32', data, [cards.length, 3, s, s]) };
    function run() {
      return withTimeout(E.session.run(feeds), E.backend === 'webgpu' ? GPU_RUN_MS : CPU_RUN_MS, 'card reading');
    }
    // A GPU that stalls or errors mid-session: switch to CPU for good and retry.
    return run().catch(function (err) {
      if (E.backend !== 'webgpu') throw err;
      E.gpuError = String(err && err.message || err);
      setCpuOnly(true);
      if (E.onBackendChange) E.onBackendChange('wasm');
      return createSession(E, 'wasm').then(run);
    }).then(function (out) {
      var v = out.embedding.data, res = [];
      for (var i = 0; i < cards.length; i++) {
        var vec = new Float32Array(E.dim), norm = 0;
        for (var j = 0; j < E.dim; j++) vec[j] = v[i * E.dim + j];
        for (var k = 0; k < E.dim; k++) norm += vec[k] * vec[k];
        norm = Math.sqrt(norm) || 1;
        for (k = 0; k < E.dim; k++) vec[k] /= norm;
        res.push(vec);
      }
      return res;
    });
  }

  /* Brute-force dot product against the whole index; best of several query
   * vectors per card (upright / rotated). Returns top k [{i, score}]. */
  function match(E, queries, k) {
    k = k || 5;
    var n = E.n, dim = E.dim, V = E.vecs, scores = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var best = -2, base = i * dim;
      for (var q = 0; q < queries.length; q++) {
        var qv = queries[q], s = 0;
        for (var d = 0; d < dim; d++) s += V[base + d] * qv[d];
        if (s > best) best = s;
      }
      scores[i] = best;
    }
    var top = [];
    for (i = 0; i < n; i++) {
      if (top.length < k || scores[i] > top[top.length - 1].score) {
        top.push({ i: i, score: scores[i] });
        top.sort(function (a, b) { return b.score - a.score; });
        if (top.length > k) top.pop();
      }
    }
    E.lastScores = scores;   // kept for top(), which ranks a subset (name filter)
    return top;
  }

  /* Best k of the given record indices by the last match() scores. */
  function top(E, indices, k) {
    var s = E.lastScores;
    return indices.map(function (i) { return { i: i, score: s ? s[i] : 0 }; })
      .sort(function (a, b) { return b.score - a.score; }).slice(0, k || 5);
  }

  /* ---------------- name filter ----------------
   * The scanner reads the card's name (OCR of the name band) and snaps it to
   * the closest catalog name; matching then ranks only cards with that name. */
  function normName(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function nameIndex(E) {
    if (E.names) return E.names;
    var byKey = {}, keys = [];
    E.records.forEach(function (r, i) {
      var k = normName(r.name);
      if (k.length < 3) return;
      if (!byKey[k]) { byKey[k] = []; keys.push(k); }
      byKey[k].push(i);
    });
    E.names = { byKey: byKey, keys: keys };
    return E.names;
  }

  // Edit distance, giving up (returning max + 1) once it can't be <= max.
  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev = new Array(b.length + 1), cur = new Array(b.length + 1), i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur[0] = i;
      var rowMin = i;
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1));
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > max) return max + 1;
      var t = prev; prev = cur; cur = t;
    }
    return prev[b.length];
  }

  var NAME_STOP = { trainer: 1, basic: 1, stage: 1, stage1: 1, stage2: 1, pokemon: 1, hp: 1, evolves: 1, from: 1, put: 1, lv: 1 };

  /* OCR words [{ text }] in reading order -> { key, name, score, dist, ok,
   * read } for the closest catalog name, or null. The pre-evolution in
   * "Evolves from Charmeleon" is skipped (when glare hides the real name it
   * would otherwise win); "Put Charizard on the Stage 1 card" names the card
   * itself, so it may stay. Runs of up to 4 words are tried, and a tie goes
   * to the longer name (Kadabra, not Abra; Dark Charizard, not Charizard).
   * ok: spelled closely enough to trust: exact up to 5 letters, one letter
   * off up to 9, two beyond. */
  function matchName(E, words) {
    var ix = nameIndex(E), ws = [], skip = 0;
    (words || []).forEach(function (w) {
      var k = normName(w.text);
      if (skip > 0) { skip--; return; }
      if (k.length >= 5 && lev(k, 'evolves', 2) <= 2) { skip = 2; return; }    // "Evolves from X"
      if (k.length >= 3 && lev(k, 'from', 1) <= 1) { skip = 1; return; }
      if (/[a-z]{2}/.test(k) && !/^\d+hp$/.test(k) && !NAME_STOP[k]) ws.push({ k: k });
    });
    if (!ws.length) return null;
    var best = null;
    for (var a = 0; a < ws.length; a++) {
      var win = '';
      for (var b = a; b < Math.min(ws.length, a + 4); b++) {
        win += ws[b].k;
        var L = win.length;
        if (L < 3) continue;
        for (var n = 0; n < ix.keys.length; n++) {
          var key = ix.keys[n], m = Math.max(key.length, L), max = Math.floor(m * 0.25);
          var d = lev(win, key, max);
          if (d > max) continue;
          var score = 1 - d / m;
          if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && key.length > best.key.length)) {
            best = { key: key, score: score, dist: d, read: win };
          }
        }
      }
    }
    if (!best) return null;
    best.name = E.records[ix.byKey[best.key][0]].name;
    var n = best.key.length;
    best.ok = best.dist <= (n <= 5 ? 0 : n <= 9 ? 1 : 2);
    return best;
  }

  function cardsNamed(E, key) { return (nameIndex(E).byKey[key] || []).slice(); }

  /* Plain-text search over local metadata: name words and/or a card number. */
  function search(E, text, limit) {
    limit = limit || 30;
    var words = text.toLowerCase().split(/\s+/).filter(Boolean), out = [];
    if (!words.length) return out;
    for (var i = 0; i < E.n && out.length < 400; i++) {
      var r = E.records[i];
      var hay = (r.name + ' ' + r.set_name + ' ' + r.number + ' ' + r.number + '/' + r.printed_total).toLowerCase();
      if (words.every(function (w) { return hay.indexOf(w) >= 0; })) out.push(i);
    }
    out.sort(function (a, b) {   // oldest first, then by number
      var ra = E.records[a], rb = E.records[b];
      return ra.release_date < rb.release_date ? -1 : ra.release_date > rb.release_date ? 1 : 0;
    });
    return out.slice(0, limit);
  }

  global.ScanEngine = {
    status: status, sync: sync, load: load, embed: embed, match: match, search: search,
    top: top, matchName: matchName, cardsNamed: cardsNamed, normName: normName,
    abs: abs, DATA: DATA,
    setPaused: function (p) { paused = !!p; },
    cpuOnly: cpuOnly, setCpuOnly: setCpuOnly,
    setBase: function (url) { BASE = new URL(url, global.location.href).href; }   // test pages only
  };
})(window);
