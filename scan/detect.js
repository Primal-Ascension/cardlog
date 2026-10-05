/* CardLog scanner: card detection and perspective warp (OpenCV.js).
 * Port of poc/imaging.py, the detector tuned on the owner's photos:
 *   1. yellow-border mask (survives sleeves and slab plastic), then Canny, then
 *      adaptive threshold, as candidate edge maps;
 *   2. each contour's convex hull -> 4-point quad (gapped outlines still work);
 *   3. keep the largest quad that is portrait, 63:88 within 0.09, and has real
 *      edges along >= 70% of its perimeter. Portrait matters: the art window
 *      turned sideways has almost exactly card proportions.
 * Every cv.Mat is deleted before return; OpenCV.js does not garbage-collect.
 */
(function (global) {
  'use strict';

  var CARD_W = 630, CARD_H = 880, CARD_ASPECT = CARD_W / CARD_H, ASPECT_TOL = 0.09;
  var MIN_AREA_FRAC = 0.03, MIN_EDGE_SUPPORT = 0.70;

  function orderQuad(pts) {
    // pts: [[x,y] x4] -> tl, tr, br, bl
    var bySum = pts.slice().sort(function (a, b) { return (a[0] + a[1]) - (b[0] + b[1]); });
    var byDiff = pts.slice().sort(function (a, b) { return (a[1] - a[0]) - (b[1] - b[0]); });
    return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
  }

  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  function quadSize(q) {
    return { w: (dist(q[0], q[1]) + dist(q[3], q[2])) / 2, h: (dist(q[0], q[3]) + dist(q[1], q[2])) / 2 };
  }

  function quadArea(q) {
    var a = 0;
    for (var i = 0; i < 4; i++) {
      var p = q[i], n = q[(i + 1) % 4];
      a += p[0] * n[1] - n[0] * p[1];
    }
    return Math.abs(a) / 2;
  }

  /* A card seen by a hand-held phone: corners near 90 degrees, opposite sides
   * similar. Rejects skewed shapes that happen to pass the aspect test. */
  function isRectangular(q, maxSkew) {
    maxSkew = maxSkew || 25;
    for (var i = 0; i < 4; i++) {
      var a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4];
      var v1x = a[0] - b[0], v1y = a[1] - b[1], v2x = c[0] - b[0], v2y = c[1] - b[1];
      var cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) + 1e-6);
      var deg = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
      if (Math.abs(deg - 90) > maxSkew) return false;
    }
    var s = [0, 1, 2, 3].map(function (k) { return dist(q[k], q[(k + 1) % 4]); });
    return Math.max(s[0], s[2]) <= 1.4 * Math.min(s[0], s[2]) && Math.max(s[1], s[3]) <= 1.4 * Math.min(s[1], s[3]);
  }

  /* All four corners at the photo's corners: the frame or a slab edge, not a card. */
  function isFrame(q, w, h) {
    var corners = [[0, 0], [w, 0], [w, h], [0, h]];
    return q.every(function (p, k) {
      return Math.abs(p[0] - corners[k][0]) <= 0.03 * w && Math.abs(p[1] - corners[k][1]) <= 0.03 * h;
    });
  }

  function matPoints(m) {
    var out = [], d = m.data32S;
    for (var i = 0; i < m.rows; i++) out.push([d[i * 2], d[i * 2 + 1]]);
    return out;
  }

  function edgeSupport(map, q, samples) {
    samples = samples || 240;
    var w = map.cols, h = map.rows, data = map.data, hits = 0, total = 0, per = samples / 4;
    for (var i = 0; i < 4; i++) {
      var p = q[i], n = q[(i + 1) % 4];
      for (var k = 0; k < per; k++) {
        var t = k / per, x = Math.round(p[0] + (n[0] - p[0]) * t), y = Math.round(p[1] + (n[1] - p[1]) * t);
        if (x >= 0 && x < w && y >= 0 && y < h) { total++; if (data[y * w + x]) hits++; }
      }
    }
    return total ? hits / total : 0;
  }

  function yellowMask(cv, rgb) {
    var hsv = new cv.Mat(), mask = new cv.Mat(), filled = cv.Mat.zeros(rgb.rows, rgb.cols, cv.CV_8UC1);
    var lo = new cv.Mat(rgb.rows, rgb.cols, cv.CV_8UC3, [19, 70, 110, 0]);
    var hi = new cv.Mat(rgb.rows, rgb.cols, cv.CV_8UC3, [38, 255, 255, 0]);
    var k = cv.Mat.ones(7, 7, cv.CV_8U), contours = new cv.MatVector(), hier = new cv.Mat();
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    cv.inRange(hsv, lo, hi, mask);
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, k, new cv.Point(-1, -1), 2);
    cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    cv.drawContours(filled, contours, -1, new cv.Scalar(255), -1);
    [hsv, mask, lo, hi, k, contours, hier].forEach(function (m) { m.delete(); });
    return filled;
  }

  function edgeMaps(cv, rgb, gray) {
    var maps = [yellowMask(cv, rgb)];
    var blur = new cv.Mat(), canny = new cv.Mat(), thr = new cv.Mat(), k = cv.Mat.ones(5, 5, cv.CV_8U);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    cv.Canny(blur, canny, 40, 140);
    cv.morphologyEx(canny, canny, cv.MORPH_CLOSE, k, new cv.Point(-1, -1), 2);
    maps.push(canny);
    cv.adaptiveThreshold(blur, thr, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 31, 5);
    cv.bitwise_not(thr, thr);
    maps.push(thr);
    blur.delete(); k.delete();
    return maps;
  }

  function hullQuad(cv, contour) {
    var hull = new cv.Mat(), approx = new cv.Mat(), quad = null;
    cv.convexHull(contour, hull, false, true);
    var hullArea = cv.contourArea(hull);
    cv.approxPolyDP(hull, approx, 0.02 * cv.arcLength(hull, true), true);
    if (approx.rows === 4) {
      quad = orderQuad(matPoints(approx));
    } else {
      var rect = cv.minAreaRect(hull);
      var pts = cv.RotatedRect.points(rect).map(function (p) { return [p.x, p.y]; });
      var r = orderQuad(pts);
      if (hullArea >= 0.85 * quadArea(r)) quad = r;
    }
    hull.delete(); approx.delete();
    return { quad: quad, hullArea: hullArea };
  }

  var NESTED_EDGE_SUPPORT = 0.60;   // lower bar for a card found inside a slab outline

  function bounds(q) {
    var xs = q.map(function (p) { return p[0]; }), ys = q.map(function (p) { return p[1]; });
    return { x0: Math.min.apply(null, xs), y0: Math.min.apply(null, ys), x1: Math.max.apply(null, xs), y1: Math.max.apply(null, ys) };
  }

  /* Is (x, y) inside convex quad q, allowing tol pixels outside? */
  function insideQuad(q, x, y, tol) {
    var area2 = 0;
    for (var j = 0; j < 4; j++) area2 += q[j][0] * q[(j + 1) % 4][1] - q[(j + 1) % 4][0] * q[j][1];
    var orient = area2 >= 0 ? 1 : -1;   // winding direction of the quad
    for (var i = 0; i < 4; i++) {
      var a = q[i], b = q[(i + 1) % 4];
      var cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
      if (orient * cross / (dist(a, b) || 1) < -tol) return false;
    }
    return true;
  }

  function scaleQuad(q, s) { return q.map(function (p) { return [p[0] / s, p[1] / s]; }); }

  /* Grading label or slab outline around a known card quad (working-scale
   * coordinates), for photos where the slab outline itself was not found
   * as a card-shaped candidate. Port of poc/slab.py find_slab. */
  function findLabelOrOutline(cv, maps, card) {
    var b = bounds(card), cw = b.x1 - b.x0, ch = b.y1 - b.y0, ccx = (b.x0 + b.x1) / 2, cardArea = cw * ch;
    var bestLabel = null, bestSlab = null, dk = cv.Mat.ones(5, 5, cv.CV_8U);
    maps.slice(1).forEach(function (edges) {     // Canny + adaptive; the yellow mask is card-only
      var support = new cv.Mat(), contours = new cv.MatVector(), hier = new cv.Mat();
      cv.dilate(edges, support, dk);
      cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (var i = 0; i < contours.size(); i++) {
        var c = contours.get(i);
        if (c.rows < 4) { c.delete(); continue; }
        var res = hullQuad(cv, c);
        c.delete();
        if (!res.quad || res.hullArea < 0.02 * cardArea || !isRectangular(res.quad, 20)) continue;
        var q = res.quad, qb = bounds(q), sz = quadSize(q);
        if (sz.w > sz.h && sz.w / sz.h >= 2.0 && sz.w / sz.h <= 6.5 && sz.w >= 0.7 * cw && sz.w <= 1.3 * cw &&
            Math.abs((qb.x0 + qb.x1) / 2 - ccx) <= 0.2 * cw && qb.y1 >= b.y0 - 0.5 * ch && qb.y1 <= b.y0 + 0.06 * ch &&
            sz.h >= 0.07 * ch && sz.h <= 0.45 * ch && edgeSupport(support, q) >= 0.6 &&
            (!bestLabel || sz.w > bestLabel.w)) {
          bestLabel = { q: q, w: sz.w };
        }
        if (sz.h > sz.w && sz.w / sz.h >= 0.50 && sz.w / sz.h <= 0.70 && sz.w * sz.h >= 1.2 * cardArea && sz.w * sz.h <= 3.0 * cardArea &&
            qb.x0 <= b.x0 + 0.04 * cw && qb.x1 >= b.x1 - 0.04 * cw && qb.y1 >= b.y1 - 0.04 * ch && b.y0 - qb.y0 >= 0.10 * sz.h &&
            edgeSupport(support, q) >= 0.5 && (!bestSlab || sz.w * sz.h < bestSlab.a)) {
          bestSlab = { q: q, a: sz.w * sz.h };
        }
      }
      support.delete(); contours.delete(); hier.delete();
    });
    dk.delete();
    if (bestSlab) return { kind: 'slab', quad: bestSlab.q };
    if (bestLabel) return { kind: 'label', quad: bestLabel.q };
    return null;
  }

  /* Find the card in an RGBA cv.Mat, and the slab around it if graded.
   * Returns { card: quad|null, slab: quad|null, slabKind: 'nested'|'slab'|'label'|null }
   * with quads [tl,tr,br,bl] in the Mat's pixels. maxSide bounds the working
   * resolution. A slab (about 0.62 wide/high) passes the card aspect test, so
   * when the winning quad holds a smaller card-shaped quad sitting low, with
   * more room above it (the label) than below, the outer one is the slab. */
  function findCardAndSlab(cv, rgba, maxSide, wantSlab) {
    maxSide = maxSide || 1000;
    var scale = Math.min(1, maxSide / Math.max(rgba.rows, rgba.cols));
    var small = new cv.Mat(), rgb = new cv.Mat(), gray = new cv.Mat();
    if (scale < 1) cv.resize(rgba, small, new cv.Size(Math.round(rgba.cols * scale), Math.round(rgba.rows * scale)), 0, 0, cv.INTER_AREA);
    else rgba.copyTo(small);
    cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    var minArea = MIN_AREA_FRAC * gray.rows * gray.cols;
    var cands = [];
    var maps = edgeMaps(cv, rgb, gray), dk = cv.Mat.ones(5, 5, cv.CV_8U);
    maps.forEach(function (edges) {
      if (cv.countNonZero(edges) === 0) return;
      var support = new cv.Mat(), contours = new cv.MatVector(), hier = new cv.Mat();
      cv.dilate(edges, support, dk);
      cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (var i = 0; i < contours.size(); i++) {
        var c = contours.get(i);
        // No area prefilter: a gapped outline has almost no area of its own,
        // but its hull is the whole card.
        if (c.rows < 4) { c.delete(); continue; }
        var res = hullQuad(cv, c);
        c.delete();
        if (res.hullArea < minArea || !res.quad) continue;
        var q = res.quad, sz = quadSize(q);
        if (sz.w > sz.h || Math.abs(sz.w / sz.h - CARD_ASPECT) > ASPECT_TOL) continue;
        if (!isRectangular(q) || isFrame(q, gray.cols, gray.rows)) continue;
        var sup = edgeSupport(support, q);
        if (sup >= NESTED_EDGE_SUPPORT) cands.push({ q: q, area: quadArea(q), sup: sup });
      }
      support.delete(); contours.delete(); hier.delete();
    });
    var out = { card: null, slab: null, slabKind: null };
    var winners = cands.filter(function (c) { return c.sup >= MIN_EDGE_SUPPORT; });
    if (winners.length) {
      var best = winners.reduce(function (a, c) { return c.area > a.area ? c : a; });
      var bq = best.q, bb = bounds(bq), bh = bb.y1 - bb.y0, tol = 0.03 * Math.sqrt(best.area), slab = null;
      cands.sort(function (a, c) { return c.area - a.area; });
      for (var k = 0; k < cands.length; k++) {
        var c2 = cands[k];
        if (c2.area < 0.30 * best.area || c2.area > 0.85 * best.area) continue;
        if (!c2.q.every(function (p) { return insideQuad(bq, p[0], p[1], tol); })) continue;
        var b2 = bounds(c2.q), topGap = b2.y0 - bb.y0, bottomGap = bb.y1 - b2.y1;
        if (topGap >= 0.10 * bh && topGap > 1.5 * bottomGap) { slab = bq; bq = c2.q; break; }
      }
      out.card = scaleQuad(bq, scale);
      if (slab) { out.slab = scaleQuad(slab, scale); out.slabKind = 'nested'; }
      else if (wantSlab) {
        var found = findLabelOrOutline(cv, maps, bq);
        if (found) { out.slab = scaleQuad(found.quad, scale); out.slabKind = found.kind; }
      }
    }
    maps.forEach(function (m) { m.delete(); });
    [small, rgb, gray, dk].forEach(function (m) { m.delete(); });
    return out;
  }

  function findCardQuad(cv, rgba, maxSide) {
    return findCardAndSlab(cv, rgba, maxSide, false).card;
  }

  /* Quad covering card + slab for the front photo. A full slab outline is
   * used as is; for a label alone, the card quad is extended upward along its
   * own sides to the label's top, so the grade stays in the picture. */
  function slabPhotoQuad(card, slab, kind) {
    if (!slab) return null;
    if (kind !== 'label') return slab;
    var lb = bounds(slab), cb = bounds(card), ch = cb.y1 - cb.y0;
    var k = Math.max(0, (cb.y0 - lb.y0) / ch) + 0.03;
    var tl = card[0], tr = card[1], br = card[2], bl = card[3];
    return [[tl[0] + (tl[0] - bl[0]) * k, tl[1] + (tl[1] - bl[1]) * k],
            [tr[0] + (tr[0] - br[0]) * k, tr[1] + (tr[1] - br[1]) * k], br, bl];
  }

  /* Warp the quad region of an RGBA Mat to a w x h portrait card (RGBA Mat). */
  function warpCard(cv, rgba, quad, w, h) {
    w = w || CARD_W; h = h || CARD_H;
    var src = cv.matFromArray(4, 1, cv.CV_32FC2, [].concat.apply([], quad));
    var dst = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w - 1, 0, w - 1, h - 1, 0, h - 1]);
    var M = cv.getPerspectiveTransform(src, dst), out = new cv.Mat();
    cv.warpPerspective(rgba, out, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    src.delete(); dst.delete(); M.delete();
    return out;
  }

  /* No card found: squash the whole frame to card shape, like the Python fallback. */
  function fallbackCard(cv, rgba, w, h) {
    var out = new cv.Mat();
    cv.resize(rgba, out, new cv.Size(w || CARD_W, h || CARD_H), 0, 0, cv.INTER_AREA);
    return out;
  }

  global.CardDetect = {
    CARD_W: CARD_W, CARD_H: CARD_H,
    findCardQuad: findCardQuad, findCardAndSlab: findCardAndSlab, slabPhotoQuad: slabPhotoQuad,
    warpCard: warpCard, fallbackCard: fallbackCard, quadSize: quadSize
  };
})(window);
