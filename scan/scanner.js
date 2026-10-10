/* CardLog scanner UI: offline status, camera, auto-capture, reprint/printing popup.
 *
 * index.html loads this file (small) in admin mode and calls
 *   CardLogScanner.mountStatus(el)        offline indicator + one-time download
 *   CardLogScanner.open({ onConfirm })    full-screen scanner
 * onConfirm({ record, printing, photoBlob }) receives the chosen card record
 * (pokemontcg fields), the chosen printing {code, label} and a straightened
 * JPEG of the card for the front photo.
 * Heavy pieces (OpenCV.js, ONNX Runtime, model, catalog) load on first open.
 */
(function (global) {
  'use strict';

  var SCRIPTS = ['scan/detect.js', 'scan/engine.js', 'scan/label.js'];
  var CONFIDENT = 0.65;          // below: "No confident match" (tuned on the owner's 41 photos)
  var STABLE_MS = 300;           // outline must hold still this long to auto-capture
  var STABLE_TOL = 0.025;        // corner movement allowed, as a fraction of card height
  var DETECT_EVERY_MS = 140;
  var LIVE_SIDE = 480;           // live detection resolution; capture re-detects at 1000
  var LOG_KEY = 'cardlog.scanlog', LOG_MAX = 300;
  var PRINTING_LABELS = {
    unlimited: 'Unlimited', normal: 'Normal', holo: 'Holo', reverse_holo: 'Reverse Holo',
    '1st_edition': '1st Edition', shadowless: 'Shadowless', '4th_print': '4th Print (UK)'
  };

  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  var depsLoading = null;
  function loadDeps() {
    if (global.ScanEngine && global.CardDetect && global.CardLabel) return Promise.resolve();
    if (depsLoading) return depsLoading;
    depsLoading = SCRIPTS.reduce(function (p, src) {
      return p.then(function () {
        return new Promise(function (res, rej) {
          var s = document.createElement('script');
          s.src = src; s.onload = res; s.onerror = function () { rej(new Error('could not load ' + src)); };
          document.head.appendChild(s);
        });
      });
    }, Promise.resolve());
    return depsLoading;
  }

  /* ---------------- styles ---------------- */
  var css = [
    '.scan-ui{position:fixed;inset:0;z-index:200;background:#000;color:#fff;display:flex;flex-direction:column;font-family:inherit}',
    '.scan-ui *,.scan-status *{box-sizing:border-box}',
    '.scan-sheet{overflow-x:hidden}',
    '.scan-top{display:flex;align-items:center;gap:10px;padding:calc(10px + env(safe-area-inset-top,0px)) 14px 10px;background:rgba(0,0,0,.6)}',
    '.scan-top .scan-title{flex:1;font-weight:700;font-size:15px}',
    '.scan-x{background:none;border:none;color:#fff;font-size:24px;padding:2px 8px}',
    '.scan-badge{font-size:11px;color:#aaa}',
    '.scan-stage{position:relative;flex:1;overflow:hidden;background:#000}',
    '.scan-stage video,.scan-stage canvas.scan-overlay{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
    '.scan-hint{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);background:rgba(0,0,0,.6);padding:7px 14px;border-radius:16px;font-size:13px;white-space:nowrap}',
    '.scan-bottom{display:flex;align-items:center;justify-content:space-around;padding:14px 14px calc(14px + env(safe-area-inset-bottom,0px));background:rgba(0,0,0,.75)}',
    '.scan-shutter{width:68px;height:68px;border-radius:50%;border:4px solid #fff;background:var(--accent,#f5c518)}',
    '.scan-shutter:disabled{opacity:.4}',
    '.scan-side{background:none;border:1px solid #555;color:#fff;border-radius:10px;padding:10px 12px;font-size:13px;font-weight:700;position:relative;overflow:hidden}',
    '.scan-side input{position:absolute;inset:0;opacity:0}',
    '.scan-msg{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;gap:14px;background:var(--bg,#1a1a2e)}',
    '.scan-msg p{color:#ccc;font-size:14px;max-width:340px;line-height:1.4}',
    '.scan-bar{width:80%;max-width:320px;height:8px;background:#333;border-radius:4px;overflow:hidden}',
    '.scan-bar div{height:100%;background:var(--green,#2ecc71);width:0}',
    '.scan-sheet{position:absolute;left:0;right:0;bottom:0;max-height:88%;overflow-y:auto;background:var(--panel,#16213e);border-radius:18px 18px 0 0;padding:16px 14px calc(16px + env(safe-area-inset-bottom,0px));z-index:5}',
    '.scan-sheet h3{font-size:18px;margin-bottom:2px}',
    '.scan-sub{color:var(--muted,#8888aa);font-size:13px;margin-bottom:12px}',
    '.scan-conf{display:inline-block;font-size:11px;font-weight:800;padding:2px 7px;border-radius:5px;margin-left:6px;vertical-align:middle}',
    '.scan-conf.ok{background:var(--green,#2ecc71);color:#0a0a1a}.scan-conf.low{background:var(--orange,#e67e22);color:#fff}',
    '.scan-label{font-size:11px;color:var(--muted,#8888aa);font-weight:700;letter-spacing:.4px;text-transform:uppercase;margin:12px 0 6px}',
    '.scan-row{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px}',
    '.scan-tile{flex:0 0 92px;border:2px solid var(--border,#2a2a4a);border-radius:10px;padding:5px;background:var(--bg,#1a1a2e);text-align:left;color:#fff}',
    '.scan-tile.sel{border-color:var(--accent,#f5c518)}',
    '.scan-tile .th{width:100%;aspect-ratio:5/7;border-radius:5px;background:#0f0f22;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:10px;color:#888;text-align:center}',
    '.scan-tile .th img{width:100%;height:100%;object-fit:cover;display:block}',
    '.scan-tile .nm{font-size:10px;font-weight:700;margin-top:4px;line-height:1.2;display:flex;align-items:center;gap:3px}',
    '.scan-tile .nm img{width:14px;height:14px;object-fit:contain;flex:0 0 auto}',
    '.scan-tile .yr{font-size:10px;color:var(--muted,#8888aa)}',
    '.scan-chips{display:flex;gap:8px;flex-wrap:wrap}',
    '.scan-labelread{margin-top:8px;font-size:13px;color:#ddd}',
    '.scan-chip{padding:9px 13px;border-radius:20px;border:1px solid var(--border,#2a2a4a);background:var(--bg,#1a1a2e);color:#ddd;font-size:13px;font-weight:700}',
    '.scan-chip.sel{background:var(--accent,#f5c518);color:#16213e;border-color:var(--accent,#f5c518)}',
    '.scan-actions{display:flex;gap:10px;margin-top:16px}',
    '.scan-actions button{flex:1;padding:14px;border-radius:10px;border:none;font-weight:800;font-size:15px}',
    '.scan-ok{background:var(--accent,#f5c518);color:#16213e}.scan-again{background:var(--bg,#1a1a2e);color:#fff;border:1px solid var(--border,#2a2a4a)!important}',
    '.scan-more{background:none;border:none;color:var(--accent,#f5c518);font-size:13px;font-weight:700;padding:10px 0}',
    '.scan-list{display:flex;flex-direction:column;gap:6px}',
    '.scan-li{display:flex;gap:10px;align-items:center;background:var(--bg,#1a1a2e);border:1px solid var(--border,#2a2a4a);border-radius:10px;padding:6px;color:#fff;text-align:left;width:100%}',
    '.scan-li img{width:36px;height:50px;object-fit:cover;border-radius:4px;background:#0f0f22}',
    '.scan-li .t{flex:1;font-size:13px;font-weight:700}.scan-li .t span{display:block;font-size:11px;color:var(--muted,#8888aa);font-weight:400}',
    '.scan-search{width:100%;background:var(--bg,#1a1a2e);border:1px solid var(--border,#2a2a4a);border-radius:10px;padding:11px 12px;color:#fff;font-size:16px;margin-bottom:8px}',
    '.scan-status{font-size:12px;padding:10px 12px;background:var(--panel,#16213e);border-radius:10px;margin-bottom:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.scan-status .dot{width:8px;height:8px;border-radius:50%;background:var(--muted,#8888aa)}',
    '.scan-status .dot.green{background:var(--green,#2ecc71)}.scan-status .dot.amber{background:var(--yellow,#f1c40f)}',
    '.scan-status button{margin-left:auto;padding:7px 11px;border-radius:8px;border:1px solid var(--border,#2a2a4a);background:var(--bg,#1a1a2e);color:#fff;font-size:12px;font-weight:700}',
    '.scan-debug{font-size:10px;color:#777;margin-top:10px}'
  ].join('\n');
  var styled = false;
  function ensureStyle() {
    if (styled) return;
    var s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); styled = true;
  }

  /* ---------------- offline status widget ---------------- */
  var statusEls = [], lastStatus = null, progressText = '';

  function renderStatus() {
    statusEls.forEach(function (el) {
      var s = lastStatus;
      if (!s) { el.innerHTML = '<span class="dot"></span><span>Scanner: checking offline data…</span>'; return; }
      var done = s.tier1[0] + s.tier2[0], total = s.tier1[1] + s.tier2[1];
      var complete = s.ready && s.tier2[0] === s.tier2[1] && total > 0;
      var dot = complete ? 'green' : (s.ready ? 'amber' : '');
      var text;
      if (!s.manifest) text = 'Scanner not downloaded yet';
      else text = 'Offline ready: ' + done.toLocaleString() + ' / ' + total.toLocaleString();
      if (progressText) text += ' · ' + progressText;
      var btn = !s.ready && !progressText ? '<button type="button" data-act="setup">Download scanner (' + estimateMB(s) + ')</button>' : '';
      el.innerHTML = '<span class="dot ' + dot + '"></span><span>' + esc(text) + '</span>' + btn;
      var b = el.querySelector('[data-act=setup]');
      if (b) b.onclick = function () { startSync(); };
    });
  }

  function estimateMB(s) {
    var b = s.manifest && s.manifest.bytes ? s.manifest.bytes.tier1 + 36e6 : 112e6;   // + libraries
    return Math.round(b / 1e6) + ' MB';
  }

  function refreshStatus() {
    return loadDeps().then(function () { return global.ScanEngine.status(); }).then(function (s) {
      lastStatus = s; renderStatus(); return s;
    }).catch(function () { lastStatus = { ready: false, tier1: [0, 0], tier2: [0, 0] }; renderStatus(); return lastStatus; });
  }

  var syncPromise = null, tier1Announced = false;
  function startSync() {
    if (syncPromise) return syncPromise;
    tier1Announced = false;
    syncPromise = loadDeps().then(function () {
      return global.ScanEngine.sync(function (p) {
        var mb = p.bytesTotal ? ' ' + Math.round(p.bytesDone / 1e6) + '/' + Math.round(p.bytesTotal / 1e6) + ' MB' : '';
        progressText = p.done < p.total ? (p.tier === 1 ? 'Downloading scanner ' : 'Thumbnails ') + p.done + '/' + p.total + mb : '';
        if (lastStatus && p.tier === 2) lastStatus.tier2 = [lastStatus.tier2[1] - (p.total - p.done), lastStatus.tier2[1]];
        renderStatus();
        var bp = ui && $('[data-el=bprog]', ui);   // bulk add's setup screen
        if (bp) bp.textContent = progressText;
        if (setupBar && p.tier === 1 && p.total) setupBar.style.width = Math.round(100 * p.done / p.total) + '%';
        if (p.tier === 2 && !tier1Announced) {
          tier1Announced = true;   // scanner usable now; thumbnails continue in the background
          global.ScanEngine.status().then(function (s) { lastStatus = s; renderStatus(); });
          if (setupDone) { setupDone(); setupDone = null; }
        }
      });
    }).then(function (s) {
      progressText = ''; lastStatus = s; renderStatus();
      if (setupDone) { setupDone(); setupDone = null; }
      syncPromise = null;
      return s;
    }, function (e) { progressText = ''; syncPromise = null; renderStatus(); throw e; });
    return syncPromise;
  }

  function mountStatus(el) {
    ensureStyle();
    el.classList.add('scan-status');
    statusEls.push(el);
    renderStatus();
    refreshStatus().then(function (s) {
      if (!s.ready) return;
      // Already set up: quietly fetch updates (only changed files) when online,
      // and warm the engine (~2 s when cached) so the Scan button opens instantly.
      if (navigator.onLine) startSync().catch(function () {});
      setTimeout(function () { global.ScanEngine.load().catch(function () {}); }, 1500);
    });
  }

  /* ---------------- scanner overlay ---------------- */
  var ui = null, opts = null, E = null, stream = null, loopTimer = null;
  var setupBar = null, setupDone = null;
  var history = [], stableSince = 0, busy = false, liveQuad = null;

  function buildUI() {
    var root = document.createElement('div');
    root.className = 'scan-ui';
    root.innerHTML =
      '<div class="scan-top"><button class="scan-x" data-act="close" aria-label="Close">✕</button>' +
      '<div class="scan-title">Scan card</div><button class="scan-badge" data-act="badge" data-el="badge" style="background:none;border:1px solid #444;border-radius:6px;padding:3px 7px;color:#aaa"></button></div>' +
      '<div class="scan-stage"><video playsinline muted autoplay></video><canvas class="scan-overlay"></canvas>' +
      '<div class="scan-hint" data-el="hint">Starting…</div></div>' +
      '<div class="scan-bottom"><button class="scan-side" data-act="search">🔍 Search</button>' +
      '<button class="scan-shutter" data-act="shoot" aria-label="Capture" disabled></button>' +
      '<label class="scan-side">🖼 Photo<input type="file" accept="image/*" data-el="file"></label></div>';
    document.body.appendChild(root);
    root.addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      var a = act.dataset.act;
      if (a === 'close') close();
      else if (a === 'shoot') capture('manual');
      else if (a === 'search') openSearch();
      else if (a === 'badge') toggleBackend();
    });
    $('[data-el=file]', root).addEventListener('change', function (e) {
      var f = e.target.files[0];
      e.target.value = '';
      if (f) captureFile(f);
    });
    return root;
  }

  function hint(t) { var h = ui && $('[data-el=hint]', ui); if (h) h.textContent = t; }

  /* Tap the GPU/CPU badge to flip this phone's preference. Takes effect the
   * next time the page loads, since a running model can't change backend. */
  function toggleBackend() {
    var SE = global.ScanEngine;
    if (!SE) return;
    var nowCpu = !SE.cpuOnly();
    SE.setCpuOnly(nowCpu);
    hint((nowCpu ? 'CPU' : 'GPU') + ' mode saved. Close CardLog fully and reopen to apply.');
  }

  function showMessage(html) {
    var stage = $('.scan-stage', ui), m = $('.scan-msg', stage);
    if (!m) { m = document.createElement('div'); m.className = 'scan-msg'; stage.appendChild(m); }
    m.innerHTML = html;
    return m;
  }
  function hideMessage() { var m = ui && $('.scan-msg', ui); if (m) m.remove(); }

  function open(o) {
    opts = o || {};
    ensureStyle();
    if (ui) return;
    ui = buildUI();
    hint('Loading…');
    loadDeps().then(function () { global.ScanEngine.setPaused(true); return refreshStatus(); }).then(function (s) {
      if (s.ready) return;
      if (!navigator.onLine) {
        showMessage('<h3>Scanner not downloaded</h3><p>Connect to the internet once to download the scanner. After that it works offline.</p>');
        throw new Error('offline, not set up');
      }
      var m = showMessage('<h3>One-time download</h3><p>The scanner needs about ' + estimateMB(s) +
        ' to work offline (Wi-Fi recommended). Card thumbnails (' + Math.round(((s.manifest && s.manifest.bytes.tier2) || 136e6) / 1e6) +
        ' MB) follow in the background.</p><button class="scan-ok" style="padding:13px 22px;border:none;border-radius:10px;font-weight:800" data-el="go">Download</button>');
      return new Promise(function (resolve, reject) {
        $('[data-el=go]', m).onclick = function () {
          m.innerHTML = '<h3>Downloading scanner</h3><div class="scan-bar"><div></div></div><p>Keep this screen open.</p>';
          setupBar = $('.scan-bar div', m);
          setupDone = resolve;
          startSync().then(function (st) { if (!st.ready) reject(new Error(st.syncError || 'download incomplete')); }, reject);
        };
      });
    }).then(function () {
      setupBar = null;
      showMessage('<h3>Starting scanner</h3><p data-el="step">Loading…</p>');
      return global.ScanEngine.load(function (step) { var p = ui && $('[data-el=step]', ui); if (p) p.textContent = step + '…'; });
    }).then(function (engine) {
      E = engine;
      preloadStamp();
      if (!ui) return;
      hideMessage();
      $('[data-el=badge]', ui).textContent = E.backend === 'webgpu' ? 'GPU' : 'CPU';
      $('[data-act=shoot]', ui).disabled = false;
      return startCamera();
    }).catch(function (e) {
      if (!ui) return;
      if (!$('.scan-msg', ui)) showMessage('<h3>Scanner unavailable</h3><p>' + esc(e.message || e) + '</p>');
      hint('');
    });
  }

  function close() {
    stopCamera();
    if (ui) ui.remove();
    ui = null; history = []; busy = false;
    if (global.ScanEngine) global.ScanEngine.setPaused(false);   // thumbnails resume
  }

  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      hint('No camera here. Use Photo or Search.');
      return;
    }
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    }).then(function (s) {
      if (!ui) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
      stream = s;
      var v = $('video', ui);
      v.srcObject = s;
      return v.play().then(function () { hint('Hold the card flat inside the frame'); loop(); });
    }).catch(function (e) {
      hint('Camera unavailable (' + (e.name || e) + '). Use Photo or Search.');
    });
  }

  function stopCamera() {
    clearTimeout(loopTimer);
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
  }

  var work = document.createElement('canvas');

  function grabFrame(maxSide) {
    var v = $('video', ui), w = v.videoWidth, h = v.videoHeight;
    if (!w) return null;
    var s = Math.min(1, maxSide / Math.max(w, h));
    work.width = Math.round(w * s); work.height = Math.round(h * s);
    work.getContext('2d').drawImage(v, 0, 0, work.width, work.height);
    return { canvas: work, scale: s, w: w, h: h };
  }

  function loop() {
    if (!ui || !stream) return;
    if (!busy && $('.scan-sheet', ui) === null) {
      var f = grabFrame(LIVE_SIDE);
      if (f) {
        var cv = E.cv, src = cv.imread(f.canvas), q = null;
        try { q = global.CardDetect.findCardQuad(cv, src, LIVE_SIDE); } catch (e) { q = null; }
        src.delete();
        liveQuad = q ? q.map(function (p) { return [p[0] / f.scale, p[1] / f.scale]; }) : null;
        drawOverlay(liveQuad, f.w, f.h);
        trackStability(liveQuad);
      }
    }
    loopTimer = setTimeout(loop, DETECT_EVERY_MS);
  }

  function drawOverlay(q, vw, vh) {
    var c = $('canvas.scan-overlay', ui), r = c.getBoundingClientRect();
    c.width = r.width * devicePixelRatio; c.height = r.height * devicePixelRatio;
    var ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    if (!q) return;
    // video is object-fit: cover; map video pixels to canvas pixels
    var s = Math.max(c.width / vw, c.height / vh), ox = (c.width - vw * s) / 2, oy = (c.height - vh * s) / 2;
    ctx.lineWidth = 4 * devicePixelRatio;
    ctx.strokeStyle = stableSince ? '#2ecc71' : '#f5c518';
    ctx.beginPath();
    q.forEach(function (p, i) { var x = p[0] * s + ox, y = p[1] * s + oy; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.closePath(); ctx.stroke();
  }

  function trackStability(q) {
    var now = performance.now();
    if (!q) { history = []; stableSince = 0; hint('Hold the card flat inside the frame'); return; }
    var prev = history[history.length - 1];
    history.push(q);
    if (history.length > 5) history.shift();
    var size = global.CardDetect.quadSize(q).h, moved = prev ? Math.max.apply(null, q.map(function (p, i) {
      return Math.hypot(p[0] - prev[i][0], p[1] - prev[i][1]);
    })) / size : 1;
    if (moved <= STABLE_TOL) {
      if (!stableSince) stableSince = now;
      hint('Hold still…');
      if (now - stableSince >= STABLE_MS) { stableSince = 0; history = []; capture('auto'); }
    } else {
      stableSince = 0;
      hint('Card found, hold steady');
    }
  }

  /* ---------------- capture → match ---------------- */
  function capture(how) {
    if (busy || !E) return;
    var v = ui && $('video', ui);
    if (!v || !v.videoWidth) return;
    var c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    processCanvas(c, how, liveQuad);
  }

  function captureFile(file) {
    if (busy || !E) return;
    var img = new Image(), url = URL.createObjectURL(file);
    img.onload = function () {
      var maxSide = 2000, s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      var c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      processCanvas(c, 'photo', null);
    };
    img.onerror = function () { URL.revokeObjectURL(url); hint('Could not read that photo'); };
    img.src = url;
  }

  function backendName() { return E && E.backend === 'webgpu' ? 'GPU' : 'CPU'; }

  function processCanvas(canvas, how, hintQuad) {
    busy = true;
    var t0 = performance.now(), stage = 'Finding card';
    // Live progress with elapsed seconds, so a stall shows exactly where it is.
    function tick() { hint(stage + '… ' + Math.round((performance.now() - t0) / 1000) + ' s'); }
    tick();
    var ticker = setInterval(tick, 500);
    E.onBackendChange = function () {
      stage = 'GPU too slow, switching to CPU';
      tick();
      if (ui) $('[data-el=badge]', ui).textContent = 'CPU';
    };
    // Let the hint paint before the synchronous OpenCV work starts.
    setTimeout(function () {
      identify(canvas, hintQuad, function (s) { stage = s; tick(); }).then(function (res) {
        clearInterval(ticker);
        busy = false;
        res.how = how;
        showResult(res);
      }, function (e) {
        clearInterval(ticker);
        busy = false;
        hint('Scan failed: ' + (e.message || e));
      });
    }, 30);
  }

  /* Detect, straighten, embed and match one image. Shared by the camera,
   * the photo picker and bulk add. Resolves with
   *   { top: [{i, score}], ms, detectMs, detected, rotated, photos: {raw, graded}, slabKind } */
  function identify(canvas, hintQuad, setStage) {
    setStage = setStage || function () {};
    var t0 = performance.now(), cv = E.cv, src = cv.imread(canvas), quad = null, slab = null, slabKind = null;
    try {
      var found = global.CardDetect.findCardAndSlab(cv, src, 1000, true);
      quad = found.card; slab = found.slab; slabKind = found.slabKind;
    } catch (e) { quad = null; }
    if (!quad && hintQuad) quad = hintQuad;
    var card = quad ? global.CardDetect.warpCard(cv, src, quad) : global.CardDetect.fallbackCard(cv, src);
    var slabQuad = quad && slab ? global.CardDetect.slabPhotoQuad(quad, slab, slabKind) : null;
    var photoBlobP = makePhotos(cv, src, quad, slabQuad);
    var labelImage = slabQuad ? makeLabelImage(cv, src, quad, slab) : null;
    var big = quad ? global.CardDetect.warpCard(cv, src, quad, 1000, 1397) : global.CardDetect.fallbackCard(cv, src, 1000, 1397);
    var stamp = quad ? firstEditionStamp(cv, big) : null;
    var bands = nameBands(cv, big);
    big.delete();
    var nameP = readCardName(bands);       // OCR runs in its worker while the card is embedded
    var tDetect = performance.now() - t0;
    setStage('Reading card (' + backendName() + ')');
    return global.ScanEngine.embed(E, [card]).then(function (q1) {
      setStage('Matching');
      var top = global.ScanEngine.match(E, q1, 5);
      if (top[0].score >= CONFIDENT) return { top: top, rotated: false, scores: E.lastScores };
      // Low score: maybe the card is upside down. Embed it rotated and keep the better.
      var rot = new cv.Mat();
      cv.rotate(card, rot, cv.ROTATE_180);
      setStage('Checking upside down (' + backendName() + ')');
      return global.ScanEngine.embed(E, [rot]).then(function (q2) {
        rot.delete();
        return { top: global.ScanEngine.match(E, [q1[0], q2[0]], 5), rotated: true, scores: E.lastScores };
      });
    }).then(function (r) {
      card.delete(); src.delete();
      setStage('Reading the name');
      return nameP.then(function (nm) {
        var named = nm && nm.ok ? rankNamed(r.scores, nm.key) : null;
        // Safety net for a misread: the picture is sure of another card and
        // nothing with the read name looks anywhere near as close.
        if (named && named.length && r.top[0].score >= 0.8 && named[0].score < r.top[0].score - 0.2) named = null;
        var ms = performance.now() - t0;
        return photoBlobP.then(function (photos) {
          return { top: named && named.length ? named : r.top, artTop: r.top, ms: ms, detectMs: tDetect, detected: !!quad,
                   rotated: r.rotated, photos: photos, slabKind: slabQuad ? slabKind : null, labelImage: labelImage,
                   stamp: stamp, name: nm && nm.name ? { name: nm.name, score: Math.round(nm.score * 100) / 100, read: nm.read,
                                                         used: !!(named && named.length), ms: nm.ms } : null,
                   nameWords: nm && nm.words };
        });
      });
    }, function (e) {
      try { card.delete(); src.delete(); } catch (x) {}
      throw e;
    });
  }

  /* Front photos for CardLog: { raw, graded } JPEG blobs.
   *   raw     the straightened card (or the whole frame if no card was found)
   *   graded  the straightened slab, label included (or the whole frame)
   * Both are made at capture so the popup's Raw/Graded switch is instant. */
  function makePhotos(cv, src, quad, slabQuad) {
    function toBlob(mat) {
      var c = document.createElement('canvas');
      cv.imshow(c, mat); mat.delete();
      return new Promise(function (res) { c.toBlob(function (b) { res(b); }, 'image/jpeg', 0.88); });
    }
    function frame() {
      var s = Math.min(1, 1600 / Math.max(src.cols, src.rows)), tmp = new cv.Mat();
      cv.resize(src, tmp, new cv.Size(Math.round(src.cols * s), Math.round(src.rows * s)), 0, 0, cv.INTER_AREA);
      return tmp;
    }
    var raw = quad ? global.CardDetect.warpCard(cv, src, quad, 1000, 1397) : frame();
    var graded;
    if (slabQuad) {
      var sz = global.CardDetect.quadSize(slabQuad);
      graded = global.CardDetect.warpCard(cv, src, slabQuad, 1000, Math.round(1000 * sz.h / sz.w));
    } else {
      graded = frame();
    }
    return Promise.all([toBlob(raw), toBlob(graded)]).then(function (b) { return { raw: b[0], graded: b[1] }; });
  }

  /* 1st Edition stamp templates, loaded once the engine (OpenCV) is up. */
  var stampTemplates = null;
  function preloadStamp() {
    warmOcr();
    if (stampTemplates || !E || !E.cv) return;
    global.CardDetect.loadStampTemplates(E.cv).then(function (t) { stampTemplates = t; }, function () {});
  }

  /* ---------------- name filter ----------------
   * The name band (top of the straightened card, and the bottom turned
   * upright in case the card is upside down) is read with OCR and snapped to
   * a catalog name; when that's a confident match, only cards with that name
   * are ranked by the picture. Anything uncertain (glare, foil, no OCR yet,
   * slow phone) falls back to the picture-only ranking. */
  var NAME_WAIT_MS = 4000;

  function nameBands(cv, big) {
    function band(m) {
      var r = new cv.Rect(30, 20, 770, 150), roi = m.roi(r), c = document.createElement('canvas');   // x .03-.80, y .015-.12
      cv.imshow(c, roi); roi.delete();
      return c;
    }
    try {
      var up = band(big), flipped = new cv.Mat();
      cv.flip(big, flipped, -1);
      var down = band(flipped); flipped.delete();
      return { up: up, down: down };
    } catch (e) { return null; }
  }

  /* Resolves the best name read ({ key, name, score, read, ms }) or null;
   * never rejects, and gives up after NAME_WAIT_MS. */
  function readCardName(bands) {
    if (!bands || !global.CardLabel) return Promise.resolve(null);
    function one(c) {
      return global.CardLabel.readName(c).then(function (o) {
        var m = global.ScanEngine.matchName(E, o.words) || { score: 0 };
        m.ms = o.ms; m.words = o.words;
        return m;
      });
    }
    var work = one(bands.up).then(function (m) {
      return m.ok ? m : one(bands.down).then(function (m2) {
        return m2.ok || m2.score > m.score ? m2 : m;
      });
    }).catch(function () { return null; });
    var timeout = new Promise(function (res) { setTimeout(function () { res(null); }, NAME_WAIT_MS); });
    return Promise.race([work, timeout]);
  }

  /* Cards with catalog name key, best picture score first (top 5). */
  function rankNamed(scores, key) {
    if (!scores) return null;
    return global.ScanEngine.cardsNamed(E, key).map(function (i) { return { i: i, score: scores[i] }; })
      .sort(function (a, b) { return b.score - a.score; }).slice(0, 5);
  }

  /* Start the OCR worker in the background once the scanner is up, so the
   * first scan doesn't wait for it. */
  var ocrWarmed = false;
  function warmOcr() {
    if (ocrWarmed || !global.CardLabel) return;
    ocrWarmed = true;
    setTimeout(function () { global.CardLabel.warm().catch(function () { ocrWarmed = false; }); }, 800);
  }

  /* { score, found } for the 1st Edition stamp in a 1000 x 1397 card,
   * checking it upside down too; null when the templates aren't loaded. */
  function firstEditionStamp(cv, big) {
    if (!stampTemplates) { preloadStamp(); return null; }
    var c = big.clone(), score = 0;
    try {
      score = global.CardDetect.stampScore(cv, c, stampTemplates);
      if (score < global.CardDetect.STAMP_MIN) {
        cv.flip(c, c, -1);   // 180 degrees
        score = Math.max(score, global.CardDetect.stampScore(cv, c, stampTemplates));
      }
    } catch (e) { score = 0; }
    c.delete();
    return { score: Math.round(score * 1000) / 1000, found: score >= global.CardDetect.STAMP_MIN };
  }

  /* The grading label above the card, straightened, at the photo's own
   * resolution (capped at 1600 px wide), as a canvas for CardLabel.read. */
  function makeLabelImage(cv, src, quad, slab) {
    try {
      var lq = global.CardDetect.labelQuad(quad, slab);
      var w = Math.min(1600, Math.round(lq.w)), h = Math.max(1, Math.round(w * lq.h / lq.w));
      var m = global.CardDetect.warpCard(cv, src, lq.quad, w, h), c = document.createElement('canvas');
      cv.imshow(c, m); m.delete();
      return c;
    } catch (e) { return null; }
  }

  /* Read the label of a graded scan in the background; done(label) gets
   * { grader, grade, cert } (empty strings for what couldn't be read) or
   * null when there's no label or OCR failed. Memoized on the scan result. */
  function readLabel(res, done) {
    if (!res || !res.labelImage || !global.CardLabel) { done(null); return; }
    if (!res.labelP) {
      res.labelP = global.CardLabel.read(res.labelImage).then(function (l) {
        return l.grader || l.grade || l.cert || l.other ? l : null;
      }, function (e) { res.labelError = String(e && e.message || e); return null; });
    }
    res.labelP.then(done);
  }

  /* Start reading view v's label; the popup redraws when it's done. */
  function startLabel(v) {
    if (!v || !v.res || !v.res.labelImage) return;
    readLabel(v.res, function (l) {
      v.label = l;
      if (view === v && v.mode === 'main' && ui) renderSheet();
    });
  }

  function labelText(l) {
    if (!l) return 'Label not readable: enter grader and grade by hand';
    if (l.other) return 'Label from a grader not in your list';
    return '🏷 ' + [l.grader || 'Grader ?', l.grade || 'grade ?', l.cert ? '· cert ' + l.cert : ''].filter(Boolean).join(' ');
  }

  function usableLabel(l) { return l && !l.other ? l : null; }

  /* ---------------- popup ---------------- */
  var view = null;   // { top, selected (record index), printingIdx, confident, ... }

  function recOf(i) { return E.records[i]; }
  function year(r) { return (r.release_date || '').slice(0, 4); }
  function num(r) {
    return /^\d+$/.test(r.number) && r.printed_total ? r.number + '/' + r.printed_total : r.number;
  }

  function thumbHTML(r) {
    var local = r.thumb ? global.ScanEngine.abs(global.ScanEngine.DATA + r.thumb) : '';
    var remote = r.image_url_small || '';
    var src = local || remote;
    if (!src) return esc(r.name);
    // cached local thumbnail -> hotlinked small image -> text
    return '<img src="' + esc(src) + '" alt="" loading="lazy" data-remote="' + esc(remote) + '" data-name="' + esc(r.name) +
      '" onerror="if(this.dataset.remote&&this.src!==this.dataset.remote){this.src=this.dataset.remote}else{this.parentNode.textContent=this.dataset.name}">';
  }

  function symbolHTML(r) {
    return r.set_symbol ? '<img src="' + esc(global.ScanEngine.abs(global.ScanEngine.DATA + r.set_symbol)) + '" alt="" onerror="this.remove()">' : '';
  }

  function groupReprints(i) {
    var r = recOf(i), g = r.art_group_id && E.groups[r.art_group_id];
    if (!g) return [i];
    return g.reprints.map(function (id) { return E.byId[id]; }).filter(function (x) { return x !== undefined; });
  }

  /* The reprint tile that represents card i (its same-set cluster's representative). */
  function representative(i) {
    var id = recOf(i).id, v = E.variants[id];
    if (v && v.same_set_cluster) return E.byId[v.same_set_cluster[0]];
    return i;
  }

  function printings(i) {
    var v = E.variants[recOf(i).id];
    return v && v.printings && v.printings.length ? v : null;
  }

  function makeView(res) {
    var topI = res.top[0].i;
    var reps = groupReprints(topI);
    var v = {
      res: res, reps: reps, top: res.top,
      // A name read off the card settles which Pokémon it is; the picture only picks the printing.
      confident: res.top[0].score >= CONFIDENT || !!(res.name && res.name.used),
      selected: reps[0],                 // oldest printing of the art is the default
      defaultSel: reps[0], printingIdx: null, defaultPrinting: null, mode: 'main',
      graded: !!res.slabKind, gradedDefault: !!res.slabKind   // slab or grading label seen around the card
    };
    var p = printings(v.selected);
    v.printingIdx = v.defaultPrinting = p ? p.default : null;
    if (stampPrinting(v, p)) v.defaultPrinting = v.printingIdx;
    return v;
  }

  /* Stamp seen: switch view v's printing to the matching 1st Edition chip
   * (holo stays holo). Returns true when it switched. */
  function stampPrinting(v, p) {
    if (!p || !v.res || !v.res.stamp || !v.res.stamp.found) return false;
    var cur = p.printings[v.printingIdx] || {}, k = -1;
    p.printings.forEach(function (c, i) {
      if (c.code !== '1st_edition') return;
      if (k < 0 || (c.card === cur.card && p.printings[k].card !== cur.card)) k = i;
    });
    if (k < 0) return false;
    v.printingIdx = k;
    v.stampApplied = true;
    return true;
  }

  function showResult(res) {
    view = makeView(res);
    renderSheet();
    startLabel(view);
  }

  /* What the current selection resolves to: the card record, printing,
   * Raw/Graded and the matching front photo. */
  function resultOf(v) {
    var saved = view;
    view = v;
    var c = chosenRecord();
    view = saved;
    var printing = c.chip ? { code: c.chip.code, label: PRINTING_LABELS[c.chip.code] || c.chip.label } : null;
    var photos = (v.res && v.res.photos) || {};
    var res = v.res || {};
    return { record: c.record, printing: printing, graded: !!v.graded,
             photoBlob: (v.graded ? photos.graded : photos.raw) || null,
             // label: read already; labelP: resolves with it when the read is still running
             label: v.graded ? usableLabel(v.label) : null,
             labelP: v.graded && res.labelP ? res.labelP.then(usableLabel) : null };
  }

  function selectCard(i, fromTop) {
    var rep = representative(i);
    if (fromTop) { view.reps = groupReprints(i); }
    view.selected = rep;
    var p = printings(rep);
    view.printingIdx = p ? p.default : null;
    // A tap on a holo from the "Not it?" list should preselect its holo chip.
    if (p && i !== rep) {
      var k = p.printings.findIndex(function (c) { return c.card === recOf(i).id && !c.optional; });
      if (k >= 0) view.printingIdx = k;
    }
    view.stampApplied = false;
    stampPrinting(view, p);
    view.mode = 'main';
    renderSheet();
  }

  function chosenRecord() {
    var p = printings(view.selected), chip = p && view.printingIdx != null ? p.printings[view.printingIdx] : null;
    var id = chip ? chip.card : recOf(view.selected).id;
    return { record: recOf(E.byId[id]), chip: chip };
  }

  function sheetEl() {
    var s = $('.scan-sheet', ui);
    if (!s) { s = document.createElement('div'); s.className = 'scan-sheet'; $('.scan-stage', ui).appendChild(s); }
    return s;
  }

  function renderSheet() {
    if (!ui) return;
    var s = sheetEl(), sel = recOf(view.selected), res = view.res;
    if (view.mode === 'search') return renderSearch(s);
    var cr = chosenRecord().record;
    var conf = view.confident
      ? '<span class="scan-conf ok">' + (res.name && res.name.used && !view.manual ? 'Name ✓ · ' : '') + Math.round(res.top[0].score * 100) + '% match</span>'
      : '<span class="scan-conf low">No confident match</span>';
    var html = '<h3>' + esc(cr.name) + conf + '</h3>' +
      '<div class="scan-sub">' + esc(cr.set_name) + ' · ' + esc(num(cr)) + ' · ' + esc(year(cr)) + (cr.rarity ? ' · ' + esc(cr.rarity) : '') + '</div>';
    if (!view.confident) {
      html += '<input class="scan-search" placeholder="Search name or number, e.g. charizard 4" data-el="q">';
    }
    html += '<div class="scan-label">Reprints</div><div class="scan-row">';
    view.reps.forEach(function (i) {
      var r = recOf(i);
      html += '<button class="scan-tile' + (i === view.selected ? ' sel' : '') + '" data-rep="' + i + '"><div class="th">' + thumbHTML(r) +
        '</div><div class="nm">' + symbolHTML(r) + '<span>' + esc(r.set_name) + '</span></div><div class="yr">' + esc(year(r)) + ' · ' + esc(num(r)) + '</div></button>';
    });
    html += '</div>';
    var p = printings(view.selected);
    if (p) {
      html += '<div class="scan-label">Printing' + (view.stampApplied ? ' · 1st Edition stamp detected' : '') + '</div><div class="scan-chips">';
      p.printings.forEach(function (c, k) {
        html += '<button class="scan-chip' + (k === view.printingIdx ? ' sel' : '') + '" data-chip="' + k + '">' + esc(c.label) + '</button>';
      });
      html += '</div>';
    }
    html += '<div class="scan-label">Type' + (view.gradedDefault ? ' · slab detected' : '') + '</div><div class="scan-chips">' +
      '<button class="scan-chip' + (!view.graded ? ' sel' : '') + '" data-type="raw">Raw</button>' +
      '<button class="scan-chip' + (view.graded ? ' sel' : '') + '" data-type="graded">Graded</button></div>';
    if (view.graded && res.labelImage) {
      html += '<div class="scan-labelread">' + (view.label === undefined ? '🔎 Reading the label…' : esc(labelText(view.label))) + '</div>';
    }
    html += '<div class="scan-actions"><button class="scan-again" data-act2="again">' + (view.bulkIndex != null ? 'Back' : 'Rescan') +
      '</button><button class="scan-ok" data-act2="ok">Confirm</button></div>';
    html += '<button class="scan-more" data-act2="more">' + (view.showTop ? 'Hide' : 'Not it?') + ' Top 5 matches</button>';
    if (view.showTop) {
      html += '<div class="scan-list">';
      view.top.forEach(function (t) {
        var r = recOf(t.i);
        html += '<button class="scan-li" data-top="' + t.i + '">' + thumbHTML(r).replace('loading="lazy"', '') +
          '<div class="t">' + esc(r.name) + '<span>' + esc(r.set_name) + ' · ' + esc(num(r)) + ' · ' + esc(year(r)) + '</span></div>' +
          '<div style="font-size:12px;color:#aaa">' + Math.round(t.score * 100) + '%</div></button>';
      });
      html += '</div>';
    }
    html += '<div class="scan-debug">' + Math.round(res.ms) + ' ms · ' + (res.detected ? 'card outline found' : 'no outline, used whole frame') +
      (res.rotated ? ' · checked upside down' : '') + ' · ' + E.backend +
      (res.name ? ' · name ' + (res.name.used ? 'read: ' : 'unsure: ') + esc(res.name.name) + ' (' + Math.round(res.name.score * 100) + '%)'
                : (res.top.length ? ' · name not read' : '')) +
      (E.timings.warmup ? ' · model ready in ' + (E.timings.warmup / 1000).toFixed(1) + ' s' : '') +
      (E.gpuError ? ' · GPU problem: ' + esc(E.gpuError.slice(0, 120)) : '') + '</div>';
    s.innerHTML = html;
    wireSheet(s);
  }

  function wireSheet(s) {
    s.onclick = function (e) {
      var t = e.target.closest('[data-rep],[data-chip],[data-act2],[data-top],[data-type]');
      if (!t) return;
      if (t.dataset.type) { view.graded = t.dataset.type === 'graded'; renderSheet(); }
      else if (t.dataset.rep) { selectCard(+t.dataset.rep, false); }
      else if (t.dataset.chip) { view.printingIdx = +t.dataset.chip; renderSheet(); }
      else if (t.dataset.top) { selectCard(+t.dataset.top, true); }
      else if (t.dataset.act2 === 'more') { view.showTop = !view.showTop; renderSheet(); }
      else if (t.dataset.act2 === 'again') { s.remove(); view = null; hint('Hold the card flat inside the frame'); }
      else if (t.dataset.act2 === 'ok') confirm();
      else if (t.dataset.act2 === 'back') { view.mode = 'main'; renderSheet(); }
    };
    var q = $('[data-el=q]', s);
    if (q) q.oninput = function () { view.mode = 'search'; view.query = q.value; renderSheet(); };
  }

  function openSearch() {
    if (!E) return;
    if (!view) view = { res: { top: [], ms: 0 }, reps: [], top: [], confident: false, selected: null, mode: 'search', query: '' };
    else view.mode = 'search';
    renderSheet();
  }

  function renderSearch(s) {
    var hits = global.ScanEngine.search(E, view.query || '', 40);
    var html = '<h3>Search</h3><input class="scan-search" placeholder="Name and/or number, e.g. charizard 4/102" data-el="q2" value="' + esc(view.query || '') + '">' +
      '<div class="scan-list">';
    hits.forEach(function (i) {
      var r = recOf(i);
      html += '<button class="scan-li" data-pick="' + i + '">' + thumbHTML(r).replace('loading="lazy"', '') +
        '<div class="t">' + esc(r.name) + '<span>' + esc(r.set_name) + ' · ' + esc(num(r)) + ' · ' + esc(year(r)) + '</span></div></button>';
    });
    if (view.query && !hits.length) html += '<div class="scan-sub">No cards found.</div>';
    html += '</div><div class="scan-actions"><button class="scan-again" data-act2="' + (view.selected != null ? 'back' : 'again') + '">Back</button></div>';
    s.innerHTML = html;
    var q = $('[data-el=q2]', s);
    q.oninput = function () { view.query = q.value; var pos = q.selectionStart; renderSheet(); var n = $('[data-el=q2]', ui); n.focus(); n.setSelectionRange(pos, pos); };
    if (!view.query) q.focus();
    s.onclick = function (e) {
      var t = e.target.closest('[data-pick],[data-act2]');
      if (!t) return;
      if (t.dataset.pick) {
        var i = +t.dataset.pick;
        view.top = view.top && view.top.length ? view.top : [{ i: i, score: 0 }];
        view.res = view.res || { top: view.top, ms: 0 };
        view.manual = true;
        selectCard(i, true);
      } else if (t.dataset.act2 === 'back') { view.mode = 'main'; renderSheet(); }
      else { s.remove(); view = null; }
    };
  }

  function confirm() {
    var result = resultOf(view);
    if (view.bulkIndex != null) {          // editing one row of bulk add (logged when saved)
      bulkApply(view.bulkIndex, view);
      return;
    }
    logScan(result.record, result.printing);
    close();
    if (opts && opts.onConfirm) opts.onConfirm(result);
  }

  function logScan(r, printing) {
    try {
      var log = JSON.parse(lsGet(LOG_KEY) || '[]');
      log.push({
        t: Date.now(),
        top: (view.top || []).map(function (t) { return [recOf(t.i).id, Math.round(t.score * 1000) / 1000]; }),
        chosen: r.id, printing: printing && printing.code,
        keptDefault: view.selected === view.defaultSel && view.printingIdx === view.defaultPrinting && !view.manual,
        ms: Math.round(view.res.ms || 0), detected: !!view.res.detected, how: view.res.how, backend: E.backend,
        slab: view.res.slabKind || null, graded: !!view.graded,
        stamp: view.res.stamp ? view.res.stamp.score : null
      });
      while (log.length > LOG_MAX) log.shift();
      lsSet(LOG_KEY, JSON.stringify(log));
    } catch (e) {}
  }

  /* ---------------- bulk add from photos ----------------
   * Pick many photos, identify each with the same pipeline as a scan, review
   * them in a list (price, condition or grader/grade, fix any match with the
   * usual popup), then hand them all to CardLog, which queues them in the
   * offline outbox and uploads them one by one. */
  var bulk = null;   // { items: [], onSave }
  var CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'], GRADERS = ['PSA', 'BGS', 'CGC', 'TAG'];

  var bulkCss = [
    '.bulk-list{position:absolute;inset:0;overflow-y:auto;padding:10px 12px 20px;background:var(--bg,#1a1a2e)}',
    '.bulk-empty{text-align:center;color:#aaa;padding:40px 20px;font-size:14px;line-height:1.5}',
    '.bulk-row{display:flex;gap:10px;align-items:flex-start;background:var(--panel,#16213e);border:1px solid var(--border,#2a2a4a);border-radius:12px;padding:8px;margin-bottom:8px}',
    '.bulk-row.need{border-color:var(--orange,#e67e22)}',
    '.bulk-row img.ph{width:54px;height:75px;object-fit:cover;border-radius:6px;background:#0f0f22;flex:0 0 auto}',
    '.bulk-info{flex:1;min-width:0}',
    '.bulk-card{background:none;border:none;color:#fff;text-align:left;padding:0;width:100%;font-size:14px;font-weight:800}',
    '.bulk-card span{display:block;font-size:11px;color:var(--muted,#8888aa);font-weight:600;margin-top:2px}',
    '.bulk-card .bulk-check{display:inline-block;margin-top:0;font-size:10px;font-weight:800;background:var(--orange,#e67e22);color:#fff;border-radius:4px;padding:1px 5px;margin-left:5px;vertical-align:middle}',
    '.bulk-fields{display:flex;gap:6px;margin-top:7px;flex-wrap:wrap}',
    '.bulk-fields select,.bulk-fields input{background:var(--bg,#1a1a2e);border:1px solid var(--border,#2a2a4a);color:#fff;border-radius:8px;padding:8px;font-size:16px}',
    '.bulk-fields input[data-f=price]{width:96px}.bulk-fields input[data-f=grade]{width:70px}',
    '.bulk-fields input.missing{border-color:var(--orange,#e67e22)}',
    '.bulk-lab{font-size:11px;color:var(--muted,#8888aa);margin-top:5px}',
    '.bulk-x{background:none;border:none;color:#888;font-size:18px;padding:0 4px}',
    '.bulk-save{background:var(--accent,#f5c518);color:#16213e;border:none;border-radius:10px;padding:13px 18px;font-weight:800;font-size:15px}',
    '.bulk-save:disabled{opacity:.4}',
    '.bulk-status{font-size:12px;color:#aaa;padding:0 4px}'
  ].join('\n');
  var bulkStyled = false;

  function openBulk(o) {
    ensureStyle();
    if (!bulkStyled) { var s = document.createElement('style'); s.textContent = bulkCss; document.head.appendChild(s); bulkStyled = true; }
    if (ui) return;
    opts = {};
    bulk = { items: [], onSave: o && o.onSave };
    ui = document.createElement('div');
    ui.className = 'scan-ui';
    ui.innerHTML =
      '<div class="scan-top"><button class="scan-x" data-act="bclose" aria-label="Close">✕</button>' +
      '<div class="scan-title">Bulk add from photos</div><div class="scan-badge" data-el="badge"></div></div>' +
      '<div class="scan-stage"><div class="bulk-list" data-el="list"></div></div>' +
      '<div class="scan-bottom"><label class="scan-side">🖼 Add photos<input type="file" accept="image/*" multiple data-el="files"></label>' +
      '<span class="bulk-status" data-el="bstatus"></span>' +
      '<button class="bulk-save" data-act="bsave" disabled>Save all</button></div>';
    document.body.appendChild(ui);
    ui.addEventListener('click', bulkClick);
    ui.addEventListener('input', bulkInput);
    ui.addEventListener('change', function (e) {
      if (e.target.dataset.el === 'files') { var fs = Array.prototype.slice.call(e.target.files); e.target.value = ''; bulkAddFiles(fs); }
      else bulkInput(e);
    });
    renderBulk();
    loadDeps().then(function () { global.ScanEngine.setPaused(true); return refreshStatus(); }).then(function (s) {
      if (s.ready) return;
      if (!navigator.onLine) throw new Error('The scanner isn\'t downloaded yet. Connect to the internet once to download it.');
      // Not set up yet: offer the one-time download here, then carry on.
      bulk.blocked = 'setup';
      renderBulk();
      return new Promise(function (resolve, reject) {
        bulk.startSetup = function () {
          bulk.blocked = 'downloading';
          renderBulk();
          setupDone = resolve;
          startSync().then(function (st) { if (!st.ready) reject(new Error(st.syncError || 'Download incomplete. Try again on Wi-Fi.')); }, reject);
        };
      });
    }).then(function () {
      if (bulk) { bulk.blocked = 'loading'; renderBulk(); }
      return global.ScanEngine.load();
    }).then(function (engine) {
      E = engine;
      preloadStamp();
      if (!bulk) return;
      bulk.blocked = null;
      if (ui) $('[data-el=badge]', ui).textContent = backendName();
      renderBulk();
      bulkNext();
    }).catch(function (e) {
      if (!bulk) return;
      bulk.blocked = 'error';
      bulk.error = String(e && e.message || e);
      renderBulk();
    });
  }

  function bulkAddFiles(files) {
    files.forEach(function (f) { bulk.items.push({ file: f, status: 'queued', price: '', condition: 'NM', grader: 'PSA', grade: '' }); });
    renderBulk();
    bulkNext();
  }

  var bulkBusy = false;
  function bulkNext() {
    if (!E || bulkBusy || !bulk) return;
    var idx = bulk.items.findIndex(function (it) { return it.status === 'queued'; });
    if (idx < 0) { renderBulkStatus(); return; }
    var it = bulk.items[idx];
    it.status = 'working';
    bulkBusy = true;
    renderBulkStatus();
    decodeFile(it.file).then(function (canvas) {
      return identify(canvas, null);
    }).then(function (res) {
      res.how = 'bulk';
      it.view = makeView(res);
      it.status = 'ok';
      bulkApplyFields(it);
      if (it.view.graded) { it.grader = GRADERS[0]; bulkLabel(it, idx); }
    }).catch(function (e) {
      it.status = 'failed';
      it.error = String(e && e.message || e);
    }).then(function () {
      it.file = null;   // free the original photo
      bulkBusy = false;
      renderBulkRow(idx);
      setTimeout(bulkNext, 0);
    });
  }

  function decodeFile(file) {
    var maxSide = 2000;
    function draw(src, w, h) {
      var s = Math.min(1, maxSide / Math.max(w, h)), c = document.createElement('canvas');
      c.width = Math.round(w * s); c.height = Math.round(h * s);
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      return c;
    }
    if (global.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bmp) {
        var c = draw(bmp, bmp.width, bmp.height);
        if (bmp.close) bmp.close();
        return c;
      }).catch(function () { return decodeWithImg(); });
    }
    return decodeWithImg();
    function decodeWithImg() {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file), img = new Image();
        img.onload = function () { URL.revokeObjectURL(url); resolve(draw(img, img.naturalWidth, img.naturalHeight)); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('could not read this photo')); };
        img.src = url;
      });
    }
  }

  /* Read a bulk row's slab label in the background and fill grader, grade
   * and cert, leaving anything the owner already changed. Updates the row's
   * fields in place so typing in another field isn't interrupted. */
  function bulkLabel(it, idx) {
    it.labelReading = true;
    readLabel(it.view.res, function (l) {
      it.labelReading = false;
      it.view.label = l;
      var u = usableLabel(l), row = ui && $('.bulk-row[data-idx="' + idx + '"]', ui);
      if (u) {
        if (u.grader && !it.graderTouched) it.grader = u.grader;
        if (u.grade && !String(it.grade || '').trim()) it.grade = u.grade;
        if (u.cert) it.cert = u.cert;
      }
      if (!row || !it.graded) return;
      var g = $('[data-f=grader]', row), gr = $('[data-f=grade]', row), lab = $('.bulk-lab', row);
      if (g && document.activeElement !== g) g.value = it.grader;
      if (gr && document.activeElement !== gr) gr.value = it.grade || '';
      if (lab) lab.textContent = bulkLabelText(it);
    });
  }

  function bulkLabelText(it) {
    if (it.labelReading) return '🔎 Reading the label…';
    if (!it.view.res.labelImage) return '';
    return it.cert ? 'Cert ' + it.cert + ' (from the label)' : labelText(it.view.label);
  }

  /* Copy the chosen card, printing, type and photo from the row's view. */
  function bulkApplyFields(it) {
    var r = resultOf(it.view);
    it.record = r.record; it.printing = r.printing; it.graded = r.graded; it.photoBlob = r.photoBlob;
    if (it.thumbURL) URL.revokeObjectURL(it.thumbURL);
    it.thumbURL = r.photoBlob ? URL.createObjectURL(r.photoBlob) : '';
  }

  /* Confirm in the popup while editing row idx. */
  function bulkApply(idx, v) {
    var it = bulk && bulk.items[idx];
    var s = ui && $('.scan-sheet', ui);
    if (s) s.remove();
    view = null;
    if (!it) return;
    delete v.bulkIndex;
    v.confident = true;   // the owner confirmed this match: no more "Check"
    var wasGraded = it.graded;
    it.view = v;
    bulkApplyFields(it);
    if (it.graded && !wasGraded) {
      if (!it.grader) it.grader = GRADERS[0];
      if (v.res.labelImage) bulkLabel(it, idx);
    }
    renderBulkRow(idx);
  }

  function bulkRowHTML(it, idx) {
    if (it.status === 'queued' || it.status === 'working') {
      return '<div class="bulk-row" data-idx="' + idx + '"><div class="bulk-info"><div class="bulk-card">' +
        (it.status === 'working' ? 'Identifying…' : 'Waiting…') + '<span>Photo ' + (idx + 1) + '</span></div></div></div>';
    }
    if (it.status === 'failed') {
      return '<div class="bulk-row need" data-idx="' + idx + '"><div class="bulk-info"><div class="bulk-card">Couldn\'t read this photo' +
        '<span>' + esc(it.error || '') + '</span></div></div><button class="bulk-x" data-remove="' + idx + '" aria-label="Remove">✕</button></div>';
    }
    var r = it.record, conf = it.view.confident;
    var num = /^\d+$/.test(r.number) && r.printed_total ? r.number + '/' + r.printed_total : r.number;
    var fields = it.graded
      ? '<select data-f="grader">' + GRADERS.map(function (g) { return '<option' + (g === it.grader ? ' selected' : '') + '>' + g + '</option>'; }).join('') + '</select>' +
        '<input data-f="grade" placeholder="Grade" value="' + esc(it.grade) + '">'
      : '<select data-f="condition">' + CONDITIONS.map(function (c) { return '<option' + (c === it.condition ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select>';
    fields += '<input data-f="price" inputmode="decimal" placeholder="Price $" value="' + esc(it.price) + '"' + (it.missing ? ' class="missing"' : '') + '>';
    return '<div class="bulk-row' + (it.missing || !conf ? ' need' : '') + '" data-idx="' + idx + '">' +
      (it.thumbURL ? '<img class="ph" src="' + it.thumbURL + '" alt="">' : '') +
      '<div class="bulk-info"><button class="bulk-card" data-edit="' + idx + '">' + esc(r.name) + (conf ? '' : '<span class="bulk-check">Check</span>') +
      '<span>' + esc(r.set_name) + ' · ' + esc(num) + (it.printing ? ' · ' + esc(it.printing.label) : '') + ' · ' + (it.graded ? 'Graded' : 'Raw') + ' · tap to change</span></button>' +
      '<div class="bulk-fields">' + fields + '</div>' +
      (it.graded && it.view.res.labelImage ? '<div class="bulk-lab">' + esc(bulkLabelText(it)) + '</div>' : '') + '</div>' +
      '<button class="bulk-x" data-remove="' + idx + '" aria-label="Remove">✕</button></div>';
  }

  function renderBulk() {
    if (!ui || !bulk) return;
    var l = $('[data-el=list]', ui);
    var queued = bulk.items.filter(function (it) { return it.status !== 'removed'; }).length;
    var note = queued ? '<br><br>' + queued + (queued === 1 ? ' photo is' : ' photos are') + ' waiting and will be identified after.' : '';
    if (bulk.blocked === 'setup') {
      l.innerHTML = '<div class="bulk-empty">The scanner needs a one-time download (about ' + estimateMB(lastStatus || {}) +
        ', Wi-Fi recommended) before it can identify cards.' + note +
        '<br><br><button class="bulk-save" data-act="bsetup">Download scanner</button></div>';
      return renderBulkStatus();
    }
    if (bulk.blocked === 'downloading' || bulk.blocked === 'loading') {
      l.innerHTML = '<div class="bulk-empty">' + (bulk.blocked === 'downloading'
        ? 'Downloading the scanner… <span data-el="bprog">' + esc(progressText) + '</span><br>Keep this screen open.'
        : 'Starting the scanner…') + note + '</div>';
      return renderBulkStatus();
    }
    if (bulk.blocked === 'error') {
      l.innerHTML = '<div class="bulk-empty">' + esc(bulk.error) + '</div>';
      return renderBulkStatus();
    }
    if (!bulk.items.length) {
      l.innerHTML = '<div class="bulk-empty">Tap <b>🖼 Add photos</b> and pick as many card photos as you like.<br>' +
        'Each one is identified, then you add prices and save them all at once.</div>';
    } else {
      l.innerHTML = bulk.items.map(function (it, i) { return it.status === 'removed' ? '' : bulkRowHTML(it, i); }).join('');
    }
    renderBulkStatus();
  }

  function renderBulkRow(idx) {
    if (bulk && bulk.blocked) return renderBulk();
    var row = ui && $('.bulk-row[data-idx="' + idx + '"]', ui);
    if (!row) return renderBulk();
    row.outerHTML = bulkRowHTML(bulk.items[idx], idx);
    renderBulkStatus();
  }

  function renderBulkStatus() {
    if (!ui || !bulk) return;
    var items = bulk.items.filter(function (it) { return it.status !== 'removed'; });
    var ready = items.filter(function (it) { return it.status === 'ok'; }).length;
    var working = items.filter(function (it) { return it.status === 'queued' || it.status === 'working'; }).length;
    var st = $('[data-el=bstatus]', ui), btn = $('[data-act=bsave]', ui);
    st.textContent = bulk.blocked ? (items.length ? items.length + ' waiting' : '')
      : working ? 'Identifying ' + (items.length - working + 1) + ' / ' + items.length + '…' : (ready ? ready + ' ready' : '');
    btn.disabled = !ready || working > 0;
    btn.textContent = ready ? 'Save all (' + ready + ')' : 'Save all';
  }

  function bulkInput(e) {
    var f = e.target.dataset.f, row = e.target.closest('.bulk-row');
    if (!f || !row) return;
    var it = bulk.items[+row.dataset.idx];
    it[f] = e.target.value;
    if (f === 'grader') it.graderTouched = true;
    if (f === 'price' && e.target.value) { it.missing = false; e.target.classList.remove('missing'); }
  }

  function bulkClick(e) {
    var t = e.target.closest('[data-act],[data-edit],[data-remove]');
    if (!t) return;
    if (t.dataset.act === 'bclose') {
      var unsaved = bulk.items.some(function (it) { return it.status === 'ok'; });
      if (!unsaved || global.confirm('Discard these cards without saving?')) closeBulk();
    } else if (t.dataset.act === 'bsave') {
      bulkSave();
    } else if (t.dataset.act === 'bsetup') {
      if (bulk.startSetup) bulk.startSetup();
    } else if (t.dataset.edit) {
      var idx = +t.dataset.edit, it = bulk.items[idx];
      view = Object.assign({}, it.view);   // a copy: Back must leave the row untouched
      view.bulkIndex = idx;
      view.mode = 'main';
      renderSheet();
      startLabel(view);
    } else if (t.dataset.remove) {
      var i = +t.dataset.remove;
      bulk.items[i].status = 'removed';
      var row = $('.bulk-row[data-idx="' + i + '"]', ui);
      if (row) row.remove();
      renderBulkStatus();
    }
  }

  function bulkSave() {
    var items = bulk.items.filter(function (it) { return it.status === 'ok'; });
    var missing = 0;
    items.forEach(function (it) {
      it.missing = !String(it.price || '').trim();
      if (it.missing) missing++;
    });
    if (missing) {
      renderBulk();
      var first = $('.bulk-fields input.missing', ui);
      if (first) { first.scrollIntoView({ block: 'center' }); first.focus(); }
      $('[data-el=bstatus]', ui).textContent = missing + (missing === 1 ? ' card needs' : ' cards need') + ' a price';
      return;
    }
    var out = items.map(function (it) {
      view = it.view;                      // logScan reads the row's match details
      logScan(it.record, it.printing);
      view = null;
      return { record: it.record, printing: it.printing, graded: it.graded, photoBlob: it.photoBlob,
               price: String(it.price).replace(/[^0-9.]/g, ''), condition: it.condition,
               grader: it.graded ? it.grader : '', grade: it.graded ? it.grade : '', cert: it.graded ? it.cert || '' : '' };
    });
    var onSave = bulk.onSave;
    closeBulk();
    if (onSave) onSave(out);
  }

  function closeBulk() {
    if (bulk) bulk.items.forEach(function (it) { if (it.thumbURL) URL.revokeObjectURL(it.thumbURL); });
    bulk = null; bulkBusy = false; view = null;
    if (ui) ui.remove();
    ui = null;
    if (global.ScanEngine) global.ScanEngine.setPaused(false);
  }

  /* Scan a still image (canvas or loaded <img>) with the open scanner: the
   * Photo button's path, also used by the local test page. */
  function scanImage(el) {
    if (!E || !ui) return false;
    var c = el;
    if (!(el instanceof HTMLCanvasElement)) {
      c = document.createElement('canvas');
      c.width = el.naturalWidth || el.width; c.height = el.naturalHeight || el.height;
      c.getContext('2d').drawImage(el, 0, 0);
    }
    processCanvas(c, 'photo', null);
    return true;
  }

  global.CardLogScanner = {
    mountStatus: mountStatus, open: open, openBulk: openBulk, sync: startSync, refreshStatus: refreshStatus, scanImage: scanImage,
    addBulkFiles: function (files) { if (bulk) bulkAddFiles(Array.prototype.slice.call(files)); },   // same path as the picker
    isReady: function () { return !!(E && ui); },
    identify: function (canvas) { return E ? identify(canvas, null) : Promise.reject(new Error('scanner not loaded')); },   // tests
    record: function (i) { return E && E.records[i]; }
  };
})(window);
