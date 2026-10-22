/* ===== trace.js — outlines from a picture (PNG / JPG) =====
   A logo or a scanned drawing arrives as pixels; a router needs closed
   outlines. The picture is reduced to "ink" (how dark each pixel is), and the
   edge where ink crosses the threshold is followed with marching squares,
   reading between pixels so a curve comes out smooth rather than as a
   staircase that the tool would then faithfully cut.
   Pure: pixels in, point rings out (pixel units, y down). Nothing here knows
   about inches, parts or the canvas. */
const RASTER = (() => {
  /* Ink 0..1 per pixel. A transparent pixel is background whatever colour it
     claims - PNG logos are often black ink on clear, and reading clear-black
     as black traced the whole frame as one solid block. */
  function inkOf(rgba, w, h, invert) {
    const ink = new Float32Array(w * h);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      const a = rgba[p + 3] / 255;
      const lum = (0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) / 255;
      ink[i] = (invert ? lum : 1 - lum) * a;
    }
    return ink;
  }

  // Otsu: the level that best splits ink from paper, so most pictures need no slider at all
  function autoLevel(ink) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < ink.length; i++) hist[Math.min(255, Math.round(ink[i] * 255))]++;
    const n = ink.length; let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, at = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = n - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; at = (mB + mF) / 2; }
    }
    /* half-way between the two classes' means, not Otsu's split bin itself: on a
       clean black-and-white picture that bin is 0, and tracing at ink 0.002
       grew every outline by half a pixel all round */
    return best > 0 ? at / 255 : 0.5;
  }

  /* Marching squares over pixel centres. The field is padded with a ring of
     paper so ink touching the picture's edge still closes into a loop. Every
     crossing sits on one grid edge shared by exactly two cells, so each point
     has exactly two neighbours and the rings fall out of a plain walk. */
  function contours(ink, w, h, level) {
    const W = w + 2, H = h + 2;
    const v = (x, y) => (x <= 0 || y <= 0 || x > w || y > h) ? 0 : ink[(y - 1) * w + (x - 1)];
    // crossing on horizontal edge (x,y)-(x+1,y): id 2*(y*W+x); vertical (x,y)-(x,y+1): +1
    const pts = new Map(), nb = new Map();
    const pt = (id, x0, y0, x1, y1, a, b) => {
      if (!pts.has(id)) { const t = (level - a) / (b - a); pts.set(id, { x: x0 + (x1 - x0) * t - 1, y: y0 + (y1 - y0) * t - 1 }); }
      return id;
    };
    const link = (a, b) => {
      if (!nb.has(a)) nb.set(a, []); if (!nb.has(b)) nb.set(b, []);
      nb.get(a).push(b); nb.get(b).push(a);
    };
    for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
      const a = v(x, y), b = v(x + 1, y), c = v(x + 1, y + 1), d = v(x, y + 1);
      const code = (a > level ? 1 : 0) | (b > level ? 2 : 0) | (c > level ? 4 : 0) | (d > level ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const T = () => pt(2 * (y * W + x), x, y, x + 1, y, a, b);
      const R = () => pt(2 * (y * W + x + 1) + 1, x + 1, y, x + 1, y + 1, b, c);
      const B = () => pt(2 * ((y + 1) * W + x), x, y + 1, x + 1, y + 1, d, c);
      const L = () => pt(2 * (y * W + x) + 1, x, y, x, y + 1, a, d);
      switch (code) {
        case 1: case 14: link(L(), T()); break;
        case 2: case 13: link(T(), R()); break;
        case 4: case 11: link(R(), B()); break;
        case 8: case 7: link(B(), L()); break;
        case 3: case 12: link(L(), R()); break;
        case 6: case 9: link(T(), B()); break;
        // saddles: the centre decides whether the two inked corners join
        case 5: if ((a + b + c + d) / 4 > level) { link(L(), B()); link(T(), R()); } else { link(L(), T()); link(R(), B()); } break;
        case 10: if ((a + b + c + d) / 4 > level) { link(L(), T()); link(R(), B()); } else { link(L(), B()); link(T(), R()); } break;
      }
    }
    const rings = [], seen = new Set();
    for (const start of nb.keys()) {
      if (seen.has(start)) continue;
      const ring = []; let prev = null, cur = start;
      while (cur != null && !seen.has(cur)) {
        seen.add(cur); ring.push(pts.get(cur));
        const n = nb.get(cur); const next = n[0] !== prev ? n[0] : n[1];
        prev = cur; cur = next;
      }
      if (ring.length >= 3) rings.push(ring);
    }
    return rings;
  }

  function area(r) { let s = 0; for (let i = 0, n = r.length; i < n; i++) { const p = r[i], q = r[(i + 1) % n]; s += p.x * q.y - q.x * p.y; } return s / 2; }

  // Douglas-Peucker on a closed ring, split at the point farthest from the first
  function simplify(ring, tol) {
    const n = ring.length; if (n < 5) return ring.slice();
    let far = 0, fd = -1;
    for (let i = 1; i < n; i++) { const d = Math.hypot(ring[i].x - ring[0].x, ring[i].y - ring[0].y); if (d > fd) { fd = d; far = i; } }
    const keep = new Uint8Array(n); keep[0] = keep[far] = 1;
    const run = (i0, i1) => {
      const stack = [[i0, i1]];
      while (stack.length) {
        const [s, e] = stack.pop(); const A = ring[s % n], B = ring[e % n];
        const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1e-12;
        let md = -1, mi = -1;
        for (let k = s + 1; k < e; k++) { const P = ring[k % n]; const d = Math.abs((P.x - A.x) * dy - (P.y - A.y) * dx) / L; if (d > md) { md = d; mi = k; } }
        if (md > tol) { keep[mi % n] = 1; stack.push([s, mi], [mi, e]); }
      }
    };
    run(0, far); run(far, n);
    const out = []; for (let i = 0; i < n; i++) if (keep[i]) out.push(ring[i]);
    return out;
  }

  /* Light blur, 1-2-1 each way: a scan's grain and JPEG blocks otherwise
     come back as hundreds of specks and a ragged edge. */
  function smooth(f, w, h) {
    const t = new Float32Array(w * h), o = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, l = x > 0 ? f[i - 1] : f[i], r = x < w - 1 ? f[i + 1] : f[i];
      t[i] = (l + 2 * f[i] + r) / 4;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, u = y > 0 ? t[i - w] : t[i], d = y < h - 1 ? t[i + w] : t[i];
      o[i] = (u + 2 * t[i] + d) / 4;
    }
    return o;
  }
  // mean over a (2r+1)² window, from a summed-area table so the window size costs nothing
  function boxMean(f, w, h, r) {
    const S = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += f[y * w + x]; S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row; } }
    const m = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      m[y * w + x] = (S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    }
    return m;
  }
  /* The field the edge is traced on, and the level it is traced at. With
     uneven light (a phone photo of a drawing, a scan with a shadow down one
     side) no single level splits ink from paper everywhere, so each pixel is
     compared with the paper around it instead: field = ink - local mean, and a
     line is wherever it stands out by more than the level. */
  function field(rgba, w, h, o = {}) {
    let ink = inkOf(rgba, w, h, !!o.invert);
    if (o.smooth) ink = smooth(ink, w, h);
    if (o.adaptive) {
      const m = boxMean(ink, w, h, Math.max(7, Math.round(Math.min(w, h) / 24)));
      const f = new Float32Array(w * h); for (let i = 0; i < f.length; i++) f[i] = ink[i] - m[i];
      return { f, level: o.level != null ? o.level : 0.06 };
    }
    return { f: ink, level: o.level != null ? o.level : autoLevel(ink) };
  }

  /* ---------- centre lines ----------
     A drawing made of lines traces as two outlines per line, one each side of
     the stroke, a hair apart - cut both and the line is cut twice. For those,
     the stroke is thinned to one pixel (Zhang-Suen) and the path runs down
     its middle, to be cut on the line. */
  function skeleton(m, w, h) {
    const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : m[y * w + x];
    const nb = (x, y) => [at(x, y - 1), at(x + 1, y - 1), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1), at(x - 1, y + 1), at(x - 1, y), at(x - 1, y - 1)];
    let live = []; for (let i = 0; i < w * h; i++) if (m[i]) live.push(i);
    for (let changed = true; changed;) {
      changed = false;
      for (let step = 0; step < 2; step++) {
        const del = [];
        for (const i of live) {
          if (!m[i]) continue;
          const x = i % w, y = (i / w) | 0, p = nb(x, y);
          const B = p[0] + p[1] + p[2] + p[3] + p[4] + p[5] + p[6] + p[7]; if (B < 2 || B > 6) continue;
          let A = 0; for (let k = 0; k < 8; k++) if (!p[k] && p[(k + 1) % 8]) A++;
          if (A !== 1) continue;
          if (step === 0 ? (p[0] * p[2] * p[4] || p[2] * p[4] * p[6]) : (p[0] * p[2] * p[6] || p[0] * p[4] * p[6])) continue;
          del.push(i);
        }
        for (const i of del) m[i] = 0;
        if (del.length) changed = true;
      }
      live = live.filter(i => m[i]);
    }
    /* Zhang-Suen leaves an extra pixel on the inside of every corner, which
       reads as a three-way junction and splits the line there. Any pixel whose
       neighbours stay connected without it, and that is not a line end, goes. */
    const adj = [[1, 7, 2, 6], [0, 2], [1, 3, 0, 4], [2, 4], [3, 5, 2, 6], [4, 6], [5, 7, 4, 0], [6, 0]];
    for (const i of live) {
      const x = i % w, y = (i / w) | 0, p = nb(x, y);
      const on = []; for (let k = 0; k < 8; k++) if (p[k]) on.push(k);
      if (on.length < 2) continue;
      const seen = new Set([on[0]]), st = [on[0]];
      while (st.length) { const k = st.pop(); for (const j of adj[k]) if (p[j] && !seen.has(j)) { seen.add(j); st.push(j); } }
      if (seen.size === on.length) m[i] = 0;
    }
    return m;
  }
  function centrelines(f, w, h, level, o = {}) {
    const m = new Uint8Array(w * h); for (let i = 0; i < m.length; i++) m[i] = f[i] > level ? 1 : 0;
    skeleton(m, w, h);
    const D = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
    const nbrs = (i) => { const x = i % w, y = (i / w) | 0, out = []; for (const [dx, dy] of D) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < h && m[Y * w + X]) out.push(Y * w + X); } return out; };
    const N = w * h, used = new Set(), key = (a, b) => a < b ? a * N + b : b * N + a;
    const pt = (i) => ({ x: i % w, y: (i / w) | 0 });
    const paths = [];
    const walk = (a, b) => {
      const ids = [a, b]; used.add(key(a, b)); let prev = a, cur = b;
      for (;;) {
        const n = nbrs(cur); if (n.length !== 2) break;
        const next = n[0] === prev ? n[1] : n[0];
        if (used.has(key(cur, next))) break;
        used.add(key(cur, next)); ids.push(next); prev = cur; cur = next;
      }
      return ids;
    };
    const on = []; for (let i = 0; i < N; i++) if (m[i]) on.push(i);
    for (const i of on) { const n = nbrs(i); if (n.length === 2) continue; for (const j of n) if (!used.has(key(i, j))) paths.push({ pts: walk(i, j).map(pt) }); }
    // what is left unvisited is rings with no ends at all - an O, a circle
    for (const i of on) {
      const n = nbrs(i); if (n.length !== 2 || used.has(key(i, n[0]))) continue;
      const ids = walk(i, n[0]); const last = ids[ids.length - 1];
      if (last === i) ids.pop();
      paths.push({ pts: ids.map(pt), closed: last === i || nbrs(last).includes(i) });
    }
    return joinPaths(paths, o);
  }
  const plen = (p) => { let s = 0; for (let i = 1; i < p.length; i++) s += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y); return s; };
  /* Pieces of one line, put back together: a junction pixel splits a line into
     stubs, short spurs grow off any blob, and a faint or broken stroke leaves a
     gap. Spurs shorter than `spur` with a free end go; ends meeting in pairs
     are joined; a free end within `gap` of another free end is bridged. */
  function joinPaths(paths, o = {}) {
    const spur = o.spur != null ? o.spur : 3, gap = o.gap || 0, near = 1.6;
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    let ps = paths.filter(p => p.pts.length > 1 || p.closed);
    const head = (p) => p.pts[0], tail = (p) => p.pts[p.pts.length - 1];
    /* Ends filed in a grid, so a busy scan with thousands of fragments joins in
       about the time it takes to list them rather than the square of it. */
    let cell = near, grid = new Map();
    const ck = (x, y) => Math.floor(x / cell) + ',' + Math.floor(y / cell);
    const file = (p) => { if (p.closed || p.dead) return; for (const e of [0, 1]) { const q = e ? tail(p) : head(p), k = ck(q.x, q.y); if (!grid.has(k)) grid.set(k, []); grid.get(k).push({ p, e }); } };
    const index = (c) => { cell = c; grid = new Map(); ps.forEach(file); };
    const around = (q, r) => {
      // a path's ends move as it grows and are filed again; seen keeps each end counted once
      const out = [], seen = new Set(), n = Math.ceil(r / cell), cx = Math.floor(q.x / cell), cy = Math.floor(q.y / cell);
      for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) for (const it of grid.get((cx + i) + ',' + (cy + j)) || []) {
        if (it.p.dead || it.p.closed || seen.has(it)) continue;
        const qq = it.e ? tail(it.p) : head(it.p);
        if (d(q, qq) <= r && !out.some(o => o.p === it.p && o.e === it.e)) out.push({ ...it, q: qq });
      }
      return out;
    };
    // how many OTHER path ends sit within `near` of end e of p
    const crowd = (p, e) => { const q = e ? tail(p) : head(p); return around(q, near).filter(it => !(it.p === p && it.e === e)).length; };
    index(near);
    // spurs: one end free, the other on a junction, and short - the hair a thinned blob grows
    for (const p of ps) {
      if (p.closed || plen(p.pts) >= spur) continue;
      const a = crowd(p, 0) - (d(head(p), tail(p)) <= near ? 1 : 0), b = crowd(p, 1) - (d(head(p), tail(p)) <= near ? 1 : 0);
      if ((a === 0) !== (b === 0)) p.dead = true;
    }
    ps = ps.filter(p => !p.dead); index(near);
    /* Grow each path from both ends while its end meets exactly one other end
       (a junction of three or more stays a junction), or, bridging gaps, while
       a free end has another free end within reach. */
    const grow = (limit, freeOnly) => {
      for (const p of ps) {
        if (p.dead || p.closed) continue;
        for (let e = 0; e < 2; e++) {
          for (;;) {
            if (p.closed) break;
            const q = e ? tail(p) : head(p);
            const local = around(q, near).filter(it => !(it.p === p && it.e === e));
            if (freeOnly ? local.length !== 0 : local.length !== 1) break;
            let cands = freeOnly ? around(q, limit).filter(it => !(it.p === p && it.e === e) && crowd(it.p, it.e) === 0) : local;
            if (!cands.length) break;
            cands.sort((a, b) => d(q, a.q) - d(q, b.q));
            const best = cands[0];
            if (best.p === p) { if (p.pts.length > 3) p.closed = true; break; }
            const A = e ? p.pts : p.pts.slice().reverse();
            const B = best.e ? best.p.pts.slice().reverse() : best.p.pts;
            p.pts = A.concat(d(A[A.length - 1], B[0]) < 1e-9 ? B.slice(1) : B);
            if (!e) p.pts.reverse();   // keep growing at the same end
            best.p.dead = true; file(p);
          }
        }
      }
      ps = ps.filter(p => !p.dead);
    };
    grow(near, false);
    if (gap > 0) { index(Math.max(near, gap)); grow(gap, true); }
    return ps.filter(p => plen(p.pts) >= Math.max(1, o.minLen || 0));
  }
  // Douglas-Peucker for an open run, both ends kept
  function simplifyOpen(pts, tol) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const st = [[0, pts.length - 1]];
    while (st.length) {
      const [s, e] = st.pop(), A = pts[s], B = pts[e], dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy);
      let md = -1, mi = -1;
      for (let k = s + 1; k < e; k++) { const P = pts[k]; const dd = L < 1e-12 ? Math.hypot(P.x - A.x, P.y - A.y) : Math.abs((P.x - A.x) * dy - (P.y - A.y) * dx) / L; if (dd > md) { md = dd; mi = k; } }
      if (md > tol) { keep[mi] = 1; st.push([s, mi], [mi, e]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  /* Rings ready to cut, in pixel units: simplified, specks dropped, and each
     marked with how deeply it nests (0 = an outline, 1 = a hole in it, 2 = an
     island in that hole...). With opts.centre, centre-line paths instead. */
  function trace(rgba, w, h, opts = {}) {
    const { f, level } = field(rgba, w, h, opts);
    const minArea = opts.minArea != null ? opts.minArea : 4;
    if (opts.centre) {
      const ps = centrelines(f, w, h, level, { gap: opts.gap, spur: opts.spur, minLen: Math.sqrt(minArea) });
      const ctol = opts.tol != null ? opts.tol : 0.7;
      const paths = ps.map(p => p.closed ? { pts: simplify(p.pts, ctol), closed: true } : { pts: simplifyOpen(p.pts, ctol), closed: false })
        .filter(p => p.pts.length >= (p.closed ? 3 : 2));
      return { rings: [], paths, level };
    }
    const tol = opts.tol != null ? opts.tol : 0.3;
    const rings = [];
    for (const r of contours(f, w, h, level)) {
      const a = Math.abs(area(r)); if (a < minArea) continue;
      const s = simplify(r, tol); if (s.length < 3) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const q of s) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
      rings.push({ pts: s, area: a, bb: { x0, y0, x1, y1 } });
    }
    // contours never cross, so one point decides containment; the box test
    // first keeps a busy scan with thousands of rings from crawling
    for (const r of rings) {
      const p = r.pts[0]; let depth = 0;
      for (const o of rings) if (o !== r && o.area > r.area && p.x >= o.bb.x0 && p.x <= o.bb.x1 && p.y >= o.bb.y0 && p.y <= o.bb.y1 && inside(p, o.pts)) depth++;
      r.depth = depth;
    }
    return { rings, paths: [], level };
  }
  function inside(p, ring) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  }

  return { inkOf, autoLevel, field, smooth, contours, simplify, simplifyOpen, skeleton, centrelines, joinPaths, trace, area };
})();
if (typeof module !== 'undefined') module.exports = RASTER;
