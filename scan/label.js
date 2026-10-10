/* CardLog slab label reader: grader, grade and cert number from the label
 * above a graded card, read with Tesseract OCR (scan/lib/tesseract, about
 * 7 MB, loaded the first time a slab is scanned).
 *
 * The page fetches the OCR worker, engine and English model itself (the
 * scanner download caches them) and gives the worker blob URLs and a seeded
 * model cache, so reading works offline whether or not the browser lets the
 * service worker see the worker's own requests.
 *
 * Tested on the owner's slabs: PSA and CGC grader + grade 7/7, cert 5/6
 * where visible, and nothing wrong filled in (unreadable or unlisted-grader
 * labels such as PCG are left blank).
 *
 *   CardLabel.read(canvas) -> Promise<{ grader, grade, cert, text, ms }>
 *   CardLabel.parse(text, words, redShare) -> { grader, grade, cert }
 */
(function (global) {
  'use strict';

  var LIB = 'scan/lib/tesseract/';
  var workerP = null;

  function abs(p) { return new URL(p, document.baseURI).href; }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  function fetchOk(p) {
    return fetch(abs(p)).then(function (r) {
      if (!r.ok) throw new Error(p + ': HTTP ' + r.status);
      return r;
    });
  }

  function simd() {
    try {   // smallest module using a v128 instruction
      return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
    } catch (e) { return false; }
  }

  function blobUrl(p) {
    return fetchOk(p).then(function (r) { return r.blob(); }).then(function (b) {
      return URL.createObjectURL(new Blob([b], { type: 'text/javascript' }));
    });
  }

  /* The worker looks for the model in its IndexedDB cache (idb-keyval's
   * "keyval-store") before fetching it; putting it there from the page
   * means the worker never needs the network. Stored once, gzipped (the
   * worker unzips it). */
  var CACHE_PATH = 'cardlog-ocr', MODEL_KEY = CACHE_PATH + '/eng.traineddata';
  function idb(mode, fn) {
    return new Promise(function (resolve, reject) {
      var rq = indexedDB.open('keyval-store');
      rq.onupgradeneeded = function () { rq.result.createObjectStore('keyval'); };
      rq.onerror = function () { reject(rq.error); };
      rq.onsuccess = function () {
        var db = rq.result, tx = db.transaction('keyval', mode), r = fn(tx.objectStore('keyval'));
        tx.oncomplete = function () { db.close(); resolve(r && r.result); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      };
    });
  }
  function seedModel() {
    return idb('readonly', function (s) { return s.getKey(MODEL_KEY); }).then(function (k) {
      if (k !== undefined) return;
      return fetchOk(LIB + 'eng.traineddata.gz').then(function (r) { return r.arrayBuffer(); }).then(function (b) {
        return idb('readwrite', function (s) { return s.put(new Uint8Array(b), MODEL_KEY); });
      });
    });
  }

  function worker() {
    if (workerP) return workerP;
    var core = simd() ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js';
    workerP = Promise.all([
      global.Tesseract ? null : loadScript(abs(LIB + 'tesseract.min.js')),
      blobUrl(LIB + 'worker.min.js'),
      blobUrl(LIB + core),
      seedModel()
    ]).then(function (x) {
      // corePath must end in "js" or the worker treats it as a folder; the
      // fragment satisfies that and is ignored when the blob is loaded.
      return global.Tesseract.createWorker('eng', 1, {
        workerPath: x[1], corePath: x[2] + '#core.js', workerBlobURL: false,
        cachePath: CACHE_PATH, langPath: abs(LIB).replace(/\/$/, ''), gzip: true
      });
    }).then(function (w) {
      return w.setParameters({ tessedit_pageseg_mode: '11', user_defined_dpi: '300' }).then(function () { return w; });
    });
    workerP.catch(function () { workerP = null; });
    return workerP;
  }

  /* Grayscale, scaled so the label is about 1600 px wide (Tesseract reads
   * small print better large); also measures how much of it is PSA red. */
  function prepare(src) {
    var W = 1600, s = W / src.width, c = document.createElement('canvas');
    c.width = W; c.height = Math.round(src.height * s);
    var g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(src, 0, 0, c.width, c.height);
    var img = g.getImageData(0, 0, c.width, c.height), d = img.data, red = 0;
    for (var i = 0; i < d.length; i += 4) {
      var r = d[i], gr = d[i + 1], b = d[i + 2];
      if (r > 140 && gr < 85 && b < 85 && r - gr > 90) red++;
      var y = 0.299 * r + 0.587 * gr + 0.114 * b;
      d[i] = d[i + 1] = d[i + 2] = y;
    }
    g.putImageData(img, 0, 0);
    return { canvas: c, redShare: red / (d.length / 4) };
  }

  // One read at a time: a read changes the worker's settings for its re-read.
  var queue = Promise.resolve();
  function read(canvas) {
    var job = queue.then(function () { return readNow(canvas); });
    queue = job.catch(function () {});
    return job;
  }

  function readNow(canvas) {
    var t0 = performance.now(), p = prepare(canvas), W;
    return worker().then(function (w) {
      W = w;
      return w.recognize(p.canvas, {}, { text: true, blocks: true });
    }).then(function (r) {
      var words = [];
      (r.data.blocks || []).forEach(function (b) {
        (b.paragraphs || []).forEach(function (pa) {
          (pa.lines || []).forEach(function (l) {
            (l.words || []).forEach(function (wd) { words.push({ text: wd.text, h: wd.bbox.y1 - wd.bbox.y0, bbox: wd.bbox }); });
          });
        });
      });
      var out = parse(r.data.text || '', words, p.redShare);
      out.text = r.data.text || '';
      out.redShare = Math.round(p.redShare * 1000) / 1000;
      if (out.cert && certOk(out.grader, out.cert)) return out;
      // Small print: re-read the cert-looking word enlarged, digits only.
      var cw = words.filter(function (wd) { return (String(wd.text).match(/\d/g) || []).length >= 5; })
        .sort(function (a, b) { return String(b.text).length - String(a.text).length; })[0];
      out.cert = '';
      if (!cw) return out;
      return rereadDigits(W, p.canvas, cw.bbox).then(function (d) {
        if (certOk(out.grader, d)) out.cert = d;
        return out;
      }, function () { return out; });
    }).then(function (out) {
      out.ms = Math.round(performance.now() - t0);
      return out;
    });
  }

  /* Words in a card's name band (top of the card), with their heights, for
   * the scanner's name filter. Resolves { words: [{ text, h, conf }], ms }. */
  function readName(canvas) {
    var job = queue.then(function () {
      var t0 = performance.now(), p = prepare(canvas);
      return worker().then(function (w) {
        return w.recognize(p.canvas, {}, { text: true, blocks: true });
      }).then(function (r) {
        var words = [];
        (r.data.blocks || []).forEach(function (b) {
          (b.paragraphs || []).forEach(function (pa) {
            (pa.lines || []).forEach(function (l) {
              (l.words || []).forEach(function (wd) {
                words.push({ text: wd.text, h: wd.bbox.y1 - wd.bbox.y0, conf: wd.confidence, x: wd.bbox.x0, y: wd.bbox.y0 });
              });
            });
          });
        });
        return { words: words, ms: Math.round(performance.now() - t0) };
      });
    });
    queue = job.catch(function () {});
    return job;
  }

  function rereadDigits(w, src, bb) {
    var pad = Math.round((bb.y1 - bb.y0) * 0.6), x0 = Math.max(0, bb.x0 - pad), y0 = Math.max(0, bb.y0 - pad);
    var cw = Math.min(src.width, bb.x1 + pad) - x0, ch = Math.min(src.height, bb.y1 + pad) - y0, S = 3;
    var c = document.createElement('canvas');
    c.width = cw * S; c.height = ch * S;
    var g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, x0, y0, cw, ch, 0, 0, c.width, c.height);
    return w.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789' }).then(function () {
      return w.recognize(c);
    }).then(function (r) {
      return String(r.data.text || '').replace(/\D/g, '');
    }).finally(function () {
      return w.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: '' });
    });
  }

  /* Cert numbers by grader: PSA 8-10 digits, CGC 10 (or 13 on older
   * labels), BGS 10; TAG and unknown graders anything 7-13 long. */
  function certOk(grader, cert) {
    var n = String(cert || '').replace(/\D/g, '').length;
    if (grader === 'PSA') return n >= 8 && n <= 10;
    if (grader === 'CGC') return n === 10 || n === 13;
    if (grader === 'BGS') return n === 10;
    return n >= 7 && n <= 13;
  }

  /* ---------------- parsing ---------------- */

  // Grade words by grader, longest first so "NM-MT" wins over "NM".
  var WORDS = {
    PSA: [['GEM MT', 10], ['GEM-MT', 10], ['GEMMT', 10], ['NM-MT+', 8.5], ['NM-MT', 8], ['NMMT', 8], ['EX-MT+', 6.5], ['EX-MT', 6],
          ['VG-EX+', 4.5], ['VG-EX', 4], ['MINT+', 9.5], ['MINT', 9], ['NM+', 7.5], ['NM', 7], ['EX+', 5.5], ['EX', 5],
          ['VG+', 3.5], ['VG', 3], ['GOOD+', 2.5], ['GOOD', 2], ['FR', 1.5], ['PR', 1]],
    CGC: [['PRISTINE', 10], ['GEM MINT', 10], ['NM/MINT+', 8.5], ['NM/MINT', 8], ['EX/NM+', 6.5], ['EX/NM', 6],
          ['VG/EX+', 4.5], ['VG/EX', 4], ['MINT+', 9.5], ['MINT', 9], ['NM+', 7.5], ['NM', 7], ['EX+', 5.5], ['EX', 5],
          ['VG+', 3.5], ['VG', 3], ['GOOD+', 2.5], ['GOOD', 2], ['FAIR', 1.5], ['POOR', 1]],
    BGS: [['PRISTINE', 10], ['BLACK LABEL', 10], ['GEM MINT', 9.5], ['NM-MT+', 8.5], ['NM-MT', 8], ['EX-MT+', 6.5], ['EX-MT', 6],
          ['VG-EX+', 4.5], ['VG-EX', 4], ['MINT', 9], ['NM+', 7.5], ['NM', 7], ['EX+', 5.5], ['EX', 5], ['VG+', 3.5], ['VG', 3],
          ['GOOD', 2], ['FAIR', 1.5], ['POOR', 1]],
    TAG: [['PRISTINE', 10], ['GEM MINT', 10], ['MINT+', 9.5], ['MINT', 9], ['NM-MT+', 8.5], ['NM-MT', 8], ['NM+', 7.5], ['NM', 7],
          ['EX-MT', 6], ['EX', 5], ['VG-EX', 4], ['VG', 3], ['GOOD', 2], ['FAIR', 1.5], ['POOR', 1]]
  };
  var SUBGRADES = /CENTER|CORNER|EDGE|SURFACE/;

  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); }

  /* "MINT+" also matches "MINT +", "NM-MT" also "NM - MT"; a word must stand
   * alone ("NM" isn't read out of "EX/NM" or "NMX"). */
  function wordRe(w) {
    var body = esc(w).replace(/\\\+$/, '\\s*\\+').replace(/ /g, '\\s*').replace(/\\-/g, '\\s*-\\s*').replace(/\\\//g, '\\s*/\\s*');
    return new RegExp('(^|[^A-Z/\\-])' + body + (/\+$/.test(w) ? '' : '(?![A-Z]|\\s*[+/\\-])'));
  }

  function wordGrade(T, grader) {
    var list = WORDS[grader] || [];
    for (var i = 0; i < list.length; i++) {
      if (wordRe(list[i][0]).test(T)) return list[i][1];
    }
    return null;
  }

  /* Returns PSA/CGC/BGS/TAG, 'other' for a grader CardLog doesn't list (PCG
   * and similar: their grades are left blank rather than guessed), or ''. */
  function graderOf(T, cert, redShare) {
    if (/\bCGC\b|GUARANTY|CERTIFIED GUAR/.test(T)) return 'CGC';
    if (/BECKETT|\bBGS\b/.test(T)) return 'BGS';
    if (/\bTAG\b|TAGGRADING/.test(T)) return 'TAG';
    if (/\bPSA\b/.test(T)) return 'PSA';
    if (/\bPCG\b|CENTERING|CORNERS|SURFACE/.test(T)) return 'other';
    if (redShare > 0.02) return 'PSA';                 // PSA labels have a red frame
    if (/#\s?\d{1,3}\b/.test(T)) return 'PSA';          // PSA prints the card number as "#4"
    if (/(^|[^A-Z])(GEM\s?MT|NM\s?-\s?MT|EX\s?-\s?MT|VG\s?-\s?EX)/.test(T)) return 'PSA';
    if (cert) {
      var d = cert.replace(/\D/g, '');
      if (d.length === 10) return /^00/.test(d) ? 'BGS' : 'CGC';
      if (d.length === 13) return 'CGC';
      if (d.length === 8 || d.length === 9) return 'PSA';
    }
    return '';
  }

  function parse(text, words, redShare) {
    var T = String(text || '').toUpperCase().replace(/[|]/g, ' ');
    // Cert: the longest run of 7-13 digits (OCR sometimes splits it with a space).
    var cert = '', runs = T.replace(/(\d)\s(?=\d{3,})/g, '$1').match(/\b[A-Z]?\d{7,13}\b/g) || [];
    runs.forEach(function (r) { if (r.replace(/\D/g, '').length > cert.replace(/\D/g, '').length) cert = r; });
    var grader = graderOf(T, cert, redShare || 0);
    if (grader === 'other') return { grader: '', grade: '', cert: '', other: true };
    var fromWord = wordGrade(T, grader || 'PSA');
    // Number candidates: 1-10 or a half grade, not a card number (#4, 4/102)
    // and not a subgrade (CENTERING 9.5).
    var cands = [];
    (words || []).forEach(function (w, i) {
      var t = String(w.text).toUpperCase().replace(/[^0-9.#\/]/g, '');
      if (!/^(10|[1-9](\.5)?)$/.test(t)) return;
      var prev = i > 0 ? String(words[i - 1].text).toUpperCase() : '';
      if (/#\s*$/.test(prev) || SUBGRADES.test(prev)) return;
      cands.push({ v: parseFloat(t), h: w.h });
    });
    if (!words || !words.length) {
      (T.match(/(^|\s)(10|[1-9](\.5)?)(?=\s|$)/g) || []).forEach(function (m) { cands.push({ v: parseFloat(m), h: 0 }); });
    }
    // The grade word is the most reliable read (big bold digits often aren't
    // read at all); a lone number is used only when the grader is known.
    var grade = null, agree = fromWord != null && cands.some(function (c) { return c.v === fromWord; });
    if (agree) grade = fromWord;
    else if (grader && fromWord != null) grade = fromWord;
    else if (grader && cands.length) grade = cands.reduce(function (a, c) { return c.h > a.h ? c : a; }).v;
    return { grader: grader, grade: grade == null ? '' : String(grade), cert: cert };
  }

  global.CardLabel = { read: read, readName: readName, parse: parse,
                       warm: function () { return worker().then(function () { return true; }); } };
})(window);
