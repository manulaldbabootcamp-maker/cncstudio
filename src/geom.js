/* ===== geom.js — 2D geometry core: segments, loops, offsetting, DXF ===== */
const GEOM = (() => {
  const EPS = 1e-7;
  const P = (x, y) => ({ x, y });
  const add = (a, b) => P(a.x + b.x, a.y + b.y);
  const sub = (a, b) => P(a.x - b.x, a.y - b.y);
  const mul = (a, s) => P(a.x * s, a.y * s);
  const dot = (a, b) => a.x * b.x + a.y * b.y;
  const cross = (a, b) => a.x * b.y - a.y * b.x;
  const len = (a) => Math.hypot(a.x, a.y);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const norm = (a) => { const l = len(a) || 1; return P(a.x / l, a.y / l); };
  const rightN = (d) => P(d.y, -d.x);           // normal to the right of travel
  const rot = (p, ang) => P(p.x * Math.cos(ang) - p.y * Math.sin(ang), p.x * Math.sin(ang) + p.y * Math.cos(ang));
  const same = (a, b, e = 1e-6) => Math.abs(a.x - b.x) < e && Math.abs(a.y - b.y) < e;

  // ---- segments: {type:'line',a,b} | {type:'arc',a,b,c,ccw}
  const line = (a, b) => ({ type: 'line', a, b });
  const arc = (a, b, c, ccw) => ({ type: 'arc', a, b, c, ccw });
  const radius = (s) => dist(s.a, s.c);
  const angOf = (c, p) => Math.atan2(p.y - c.y, p.x - c.x);
  function sweep(s) { // signed sweep angle, + for ccw
    let a0 = angOf(s.c, s.a), a1 = angOf(s.c, s.b), d = a1 - a0;
    if (s.ccw) { while (d <= 1e-9) d += 2 * Math.PI; } else { while (d >= -1e-9) d -= 2 * Math.PI; }
    return d;
  }
  function tangentAt(s, atStart) {
    if (s.type === 'line') return norm(sub(s.b, s.a));
    const p = atStart ? s.a : s.b, r = sub(p, s.c);
    const t = s.ccw ? P(-r.y, r.x) : P(r.y, -r.x);
    return norm(t);
  }
  function segLen(s) { return s.type === 'line' ? dist(s.a, s.b) : Math.abs(sweep(s)) * radius(s); }
  function pointAt(s, t) { // t in 0..1
    if (s.type === 'line') return add(s.a, mul(sub(s.b, s.a), t));
    const a0 = angOf(s.c, s.a), sw = sweep(s), r = radius(s);
    return P(s.c.x + r * Math.cos(a0 + sw * t), s.c.y + r * Math.sin(a0 + sw * t));
  }
  function samplePts(s, maxSeg = 0.02) {
    if (s.type === 'line') return [s.a, s.b];
    const n = Math.max(2, Math.ceil(segLen(s) / maxSeg));
    const out = [];
    for (let i = 0; i <= n; i++) out.push(pointAt(s, i / n));
    return out;
  }
  /* Sample a loop to points. Each segment contributes its start plus interior
     samples; its end is the next segment's start, so it is skipped to avoid
     duplicates. On an OPEN path there is no next segment for the last one, so
     its endpoint must be added explicitly - without it bbox() collapsed a
     single-segment open path to a point, which broke nesting, bed-limit
     warnings and anything else measuring an open path. */
  function loopPts(loop, maxSeg = 0.02) {
    const pts = [];
    for (const s of loop) { const p = samplePts(s, maxSeg); for (let i = 0; i < p.length - 1; i++) pts.push(p[i]); }
    if (loop.length) {
      const end = loop[loop.length - 1].b;
      if (!pts.length || !same(pts[0], end, 1e-9)) pts.push(end);
    }
    return pts;
  }
  function signedArea(loop) {
    const pts = loopPts(loop, 0.01); let a = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
    return a / 2;
  }
  function reverseLoop(loop) {
    return loop.slice().reverse().map(s => s.type === 'line' ? line(s.b, s.a) : arc(s.b, s.a, s.c, !s.ccw));
  }
  function bbox(loop) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of loopPts(loop, 0.05)) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  }
  function transformLoop(loop, fn) {
    return loop.map(s => s.type === 'line' ? line(fn(s.a), fn(s.b)) : arc(fn(s.a), fn(s.b), fn(s.c), s.ccw));
  }
  function translateLoop(loop, dx, dy) { return transformLoop(loop, p => P(p.x + dx, p.y + dy)); }
  function rotateLoop(loop, ang, about) { return transformLoop(loop, p => add(about, rot(sub(p, about), ang))); }
  function mirrorLoopX(loop, cx) { // mirror across vertical line x=cx, keeps orientation by reversing
    const m = transformLoop(loop, p => P(2 * cx - p.x, p.y)).map(s => s.type === 'arc' ? arc(s.a, s.b, s.c, !s.ccw) : s);
    return reverseLoop(m);
  }
  function pointInLoop(pt, loop) {
    const pts = loopPts(loop, 0.05); let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  // ---- shape builders (all loops returned CCW)
  // pts: [{x,y,r?,arcR?}] — r = fillet radius at the vertex, arcR = arc radius of the edge leaving this vertex
  // (arcR>0 bulges outward from the part, <0 bulges inward). Loop is returned CCW.
  function normalizePolyPts(pts) {
    const n = pts.length; let area = 0;
    for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; area += p.x * q.y - q.x * p.y; }
    if (area >= 0) return pts.map(p => ({ ...p }));
    const out = [];
    for (let j = 0; j < n; j++) { const o = pts[n - 1 - j]; const prevOld = pts[(n - 2 - j + n) % n]; out.push({ x: o.x, y: o.y, r: o.r || 0, arcR: prevOld.arcR || 0 }); }
    return out;
  }
  function polyLoop(pts) {
    const n = pts.length; if (n < 3) return [];
    const order = normalizePolyPts(pts);
    const isArc = (i) => Math.abs(order[i].arcR || 0) > EPS;
    const segs = []; const corner = [];
    for (let i = 0; i < n; i++) {
      const prev = order[(i - 1 + n) % n], cur = order[i], next = order[(i + 1) % n];
      const r = cur.r || 0;
      if (r <= EPS || isArc(i) || isArc((i - 1 + n) % n)) { corner.push({ in: P(cur.x, cur.y), out: P(cur.x, cur.y) }); continue; }
      const d1 = norm(sub(P(prev.x, prev.y), P(cur.x, cur.y))), d2 = norm(sub(P(next.x, next.y), P(cur.x, cur.y)));
      const ang = Math.acos(Math.max(-1, Math.min(1, dot(d1, d2))));
      if (ang < 1e-6 || Math.abs(ang - Math.PI) < 1e-6) { corner.push({ in: P(cur.x, cur.y), out: P(cur.x, cur.y) }); continue; }
      const t = Math.min(r / Math.tan(ang / 2), dist(P(prev.x, prev.y), P(cur.x, cur.y)) / 2, dist(P(next.x, next.y), P(cur.x, cur.y)) / 2);
      const rr = t * Math.tan(ang / 2);
      const pin = add(P(cur.x, cur.y), mul(d1, t)), pout = add(P(cur.x, cur.y), mul(d2, t));
      const bis = norm(add(d1, d2)); const c = add(P(cur.x, cur.y), mul(bis, rr / Math.sin(ang / 2)));
      const ccw = cross(d1, d2) < 0;
      corner.push({ in: pin, out: pout, arc: arc(pin, pout, c, ccw) });
    }
    for (let i = 0; i < n; i++) {
      const c = corner[i], nx = corner[(i + 1) % n];
      if (c.arc) segs.push(c.arc);
      const a = c.out, b = nx.in; const chord = dist(a, b);
      if (chord <= EPS) continue;
      if (isArc(i)) {
        let R = Math.abs(order[i].arcR); if (R < chord / 2) R = chord / 2;
        const theta = 2 * Math.asin(Math.min(1, chord / (2 * R)));
        const mag = Math.tan(theta / 4);
        segs.push(bulgeArc(a, b, order[i].arcR > 0 ? mag : -mag));
      } else segs.push(line(a, b));
    }
    return segs;
  }
  function rectLoop(x, y, w, h, r = 0, rc) { const R = (i) => (rc && rc[i] != null ? rc[i] : r); return polyLoop([{ x, y, r: R(0) }, { x: x + w, y, r: R(1) }, { x: x + w, y: y + h, r: R(2) }, { x, y: y + h, r: R(3) }]); }
  function circleLoop(cx, cy, r) {
    const c = P(cx, cy);
    return [arc(P(cx + r, cy), P(cx - r, cy), c, true), arc(P(cx - r, cy), P(cx + r, cy), c, true)];
  }
  /* Ellipse as a fine polyline. A true ellipse is not an arc, and the machine
     only understands lines and circular arcs, so it has to be approximated
     either way - doing it here, visibly, beats pretending otherwise. Point
     count comes from the sagitta tolerance at the tightest end of the curve. */
  function ellipseLoop(cx, cy, rx, ry, rotDeg = 0, tol = 0.002) {
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (rx < EPS || ry < EPS) return [];
    if (Math.abs(rx - ry) < 1e-9 && Math.abs(rotDeg) < 1e-9) return circleLoop(cx, cy, rx);
    const rmin = Math.min(rx, ry), rmax = Math.max(rx, ry);
    const kappa = rmax / (rmin * rmin);                 // max curvature
    const step = Math.acos(Math.max(-1, 1 - tol * kappa));
    let n = Math.ceil((2 * Math.PI) / (isFinite(step) && step > 1e-4 ? step : 0.05));
    n = Math.max(24, Math.min(2000, n));
    const a = rotDeg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * 2 * Math.PI;
      const x = rx * Math.cos(t), y = ry * Math.sin(t);
      pts.push(P(cx + x * ca - y * sa, cy + x * sa + y * ca));
    }
    const segs = [];
    for (let i = 0; i < n; i++) segs.push(line(pts[i], pts[(i + 1) % n]));
    return segs;
  }
  /* Catmull-Rom spline through the given points, flattened to line segments.
     Passes through every control point, which is what an operator expects when
     they place points; a B-spline would not. */
  function splineLoop(pts, closed = false, seg = 16) {
    const n = pts.length;
    if (n < 2) return [];
    if (n === 2) return closed ? [] : [line(P(pts[0].x, pts[0].y), P(pts[1].x, pts[1].y))];
    const at = (i) => { const k = closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i)); return pts[k]; };
    const out = [];
    const last = closed ? n : n - 1;
    let prev = P(pts[0].x, pts[0].y);
    for (let i = 0; i < last; i++) {
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      for (let s = 1; s <= seg; s++) {
        const t = s / seg, t2 = t * t, t3 = t2 * t;
        const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
        const y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
        const q = P(x, y);
        if (dist(prev, q) > 1e-9) { out.push(line(prev, q)); prev = q; }
      }
    }
    return out;
  }

  // ---- intersections
  function lineLine(p1, d1, p2, d2) {
    const den = cross(d1, d2); if (Math.abs(den) < 1e-12) return null;
    const t = cross(sub(p2, p1), d2) / den; return add(p1, mul(d1, t));
  }
  function lineCircle(p, d, c, r) {
    const f = sub(p, c), a = dot(d, d), b = 2 * dot(f, d), cc = dot(f, f) - r * r;
    let disc = b * b - 4 * a * cc; if (disc < 0) { if (disc > -1e-9) disc = 0; else return []; }
    const s = Math.sqrt(disc); return [add(p, mul(d, (-b - s) / (2 * a))), add(p, mul(d, (-b + s) / (2 * a)))];
  }
  function circleCircle(c1, r1, c2, r2) {
    const d = dist(c1, c2); if (d < 1e-12 || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
    const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d); let h2 = r1 * r1 - a * a; if (h2 < 0) h2 = 0;
    const h = Math.sqrt(h2), m = add(c1, mul(sub(c2, c1), a / d)), n = norm(sub(c2, c1));
    return [P(m.x - n.y * h, m.y + n.x * h), P(m.x + n.y * h, m.y - n.x * h)];
  }
  function nearest(pts, ref) { let best = null, bd = Infinity; for (const p of pts) { const d = dist(p, ref); if (d < bd) { bd = d; best = p; } } return best; }
  function segSegTrim(s1, s2, ref) { // intersection of (extended) s1 and s2 nearest to ref
    if (s1.type === 'line' && s2.type === 'line') return lineLine(s1.a, sub(s1.b, s1.a), s2.a, sub(s2.b, s2.a));
    if (s1.type === 'line') return nearest(lineCircle(s1.a, sub(s1.b, s1.a), s2.c, radius(s2)), ref);
    if (s2.type === 'line') return nearest(lineCircle(s2.a, sub(s2.b, s2.a), s1.c, radius(s1)), ref);
    return nearest(circleCircle(s1.c, radius(s1), s2.c, radius(s2)), ref);
  }

  // ---- offset a closed loop. d>0 = to the right of travel (outside for CCW loops)
  const STRAIGHT_TOL = 5e-3;
  function offsetLoop(loop, d) {
    if (Math.abs(d) < EPS) return loop.map(s => ({ ...s }));
    // 1. offset each segment; arcs that collapse become vertices
    const items = [];
    for (const s of loop) {
      const t0 = tangentAt(s, true), t1 = tangentAt(s, false);
      if (s.type === 'line') {
        const n = rightN(norm(sub(s.b, s.a)));
        items.push({ seg: line(add(s.a, mul(n, d)), add(s.b, mul(n, d))), t0, t1, oa: s.a, ob: s.b });
      } else {
        const r = radius(s), nr = s.ccw ? r + d : r - d;
        if (nr <= 5e-4) { items.push({ vertex: s.c, t0, t1 }); continue; }
        const na = add(s.c, mul(norm(sub(s.a, s.c)), nr)), nb = add(s.c, mul(norm(sub(s.b, s.c)), nr));
        items.push({ seg: arc(na, nb, s.c, s.ccw), t0, t1, oa: s.a, ob: s.b });
      }
    }
    if (!items.some(i => i.seg)) return [];
    let idx = 0; while (!items[idx].seg) idx++;
    const ordered = items.slice(idx).concat(items.slice(0, idx));
    // 2. build sequence: seg, turns..., seg, turns..., (wrap)
    const seq = [];
    for (let i = 0; i < ordered.length; i++) {
      const it = ordered[i], nx = ordered[(i + 1) % ordered.length];
      if (it.seg) { seq.push({ seg: { ...it.seg } }); seq.push({ turn: true, dirIn: it.t1, dirOut: nx.t0, origin: it.ob }); }
      else { seq.push({ turn: true, dirIn: it.t0, dirOut: it.t1, origin: it.vertex }); seq.push({ turn: true, dirIn: it.t1, dirOut: nx.t0, origin: it.vertex }); }
    }
    // merge consecutive turns with same origin, drop straight turns
    const seq2 = [];
    for (const e of seq) {
      if (!e.turn) { seq2.push(e); continue; }
      const last = seq2[seq2.length - 1];
      if (last && last.turn && same(last.origin, e.origin, 1e-6)) { last.dirOut = e.dirOut; continue; }
      seq2.push({ ...e });
    }
    const seq3 = seq2.filter(e => !(e.turn && Math.abs(cross(e.dirIn, e.dirOut)) < STRAIGHT_TOL && dot(e.dirIn, e.dirOut) > 0));
    // 3. emit, walking the sequence; cursor = last emitted segment
    const out = [];
    const firstSeg = seq3.findIndex(e => !e.turn);
    const walk = seq3.slice(firstSeg).concat(seq3.slice(0, firstSeg));
    const n = walk.length;
    const nextSegAfter = (k) => { for (let j = 1; j <= n; j++) { const e = walk[(k + j) % n]; if (!e.turn) return e; } return null; };
    for (let k = 0; k < n; k++) {
      const e = walk[k];
      if (!e.turn) { out.push(e.seg); continue; }
      const cur = out[out.length - 1];
      const cr = cross(e.dirIn, e.dirOut);
      const gap = (d > 0 && cr > 0) || (d < 0 && cr < 0);
      const nextIsSeg = !walk[(k + 1) % n].turn;
      const nextSeg = nextSegAfter(k).seg;
      if (gap) {
        const pa = add(e.origin, mul(rightN(e.dirIn), d)), pb = add(e.origin, mul(rightN(e.dirOut), d));
        cur.b = pa; out.push(arc(pa, pb, e.origin, cr > 0));
        if (nextIsSeg) nextSeg.a = pb;
      } else {
        if (nextIsSeg) {
          const ip = segSegTrim(cur, nextSeg, cur.b);
          if (ip && dist(ip, cur.b) < Math.abs(d) * 4 + 1) { cur.b = ip; nextSeg.a = ip; }
          else { out.push(line(cur.b, nextSeg.a)); }
        } else {
          const p2 = add(e.origin, mul(rightN(e.dirOut), d));
          const virt = line(p2, add(p2, e.dirOut));
          const ip = segSegTrim(cur, virt, cur.b);
          if (ip) { cur.b = ip; out.push(line(ip, p2)); } else out.push(line(cur.b, p2));
        }
      }
    }
    // ensure closure between last and first
    const last = out[out.length - 1], first = out[0];
    if (!same(last.b, first.a, 1e-5)) { if (last.type === 'line' && first.type === 'line') { const ip = lineLine(last.a, sub(last.b, last.a), first.a, sub(first.b, first.a)); if (ip && dist(ip, last.b) < 1) { last.b = ip; first.a = ip; } else out.push(line(last.b, first.a)); } else out.push(line(last.b, first.a)); }
    // drop micro lines (numeric noise from tangent joins) and reconnect
    const res = [];
    for (const s of out) {
      if (segLen(s) < 2e-3) { continue; }
      res.push(s);
    }
    for (let i = 0; i < res.length; i++) { const s = res[i], nx = res[(i + 1) % res.length]; if (!same(s.b, nx.a, 1e-9)) { if (nx.type === 'line') nx.a = s.b; else if (s.type === 'line') s.b = nx.a; } }
    return res;
  }
  function fixArcEnd(a) { /* keep b on circle */ const r = radius(a); a.b = add(a.c, mul(norm(sub(a.b, a.c)), r)); }

  // split loop so it starts at the point on a line segment nearest to `pt`
  function startLoopAt(loop, pt) {
    let best = null;
    loop.forEach((s, i) => {
      let cand;
      if (s.type === 'line') {
        const d = sub(s.b, s.a), L2 = dot(d, d) || 1; let t = dot(sub(pt, s.a), d) / L2; t = Math.max(0, Math.min(1, t));
        cand = { p: add(s.a, mul(d, t)), i, t };
      } else {
        // nearest of endpoints only (no arc splitting)
        cand = dist(s.a, pt) <= dist(s.b, pt) ? { p: s.a, i, t: 0 } : { p: s.b, i, t: 1 };
      }
      const dd = dist(cand.p, pt); if (!best || dd < best.d) best = { ...cand, d: dd };
    });
    if (!best) return loop;
    const s = loop[best.i];
    let head, tail;
    if (s.type === 'line' && best.t > 1e-6 && best.t < 1 - 1e-6) { head = [line(best.p, s.b)]; tail = [line(s.a, best.p)]; }
    else if (best.t >= 1 - 1e-6) { head = []; tail = [s]; }
    else { head = [s]; tail = []; }
    return head.concat(loop.slice(best.i + 1), loop.slice(0, best.i), tail);
  }
  function longestLineIndex(loop) {
    let bi = 0, bl = -1; loop.forEach((s, i) => { if (s.type === 'line') { const l = dist(s.a, s.b); if (l > bl) { bl = l; bi = i; } } }); return bi;
  }
  function midOfSeg(s) { return pointAt(s, 0.5); }

  // split arcs so no arc sweeps more than maxDeg (EnRoute/WinCNC style: <= 90 deg)
  function splitArcs(loop, maxDeg = 90) {
    const out = [];
    for (const s of loop) {
      if (s.type !== 'arc') { out.push(s); continue; }
      const sw = sweep(s); const n = Math.ceil(Math.abs(sw) / (maxDeg * Math.PI / 180) - 0.006);
      if (n <= 1) { out.push(s); continue; }
      let prev = s.a;
      for (let i = 1; i <= n; i++) { const p = i === n ? s.b : pointAt(s, i / n); out.push(arc(prev, p, s.c, s.ccw)); prev = p; }
    }
    return out;
  }

  // ---- DXF import/export
  function parseDXF(text) {
    const lines = text.split(/\r?\n/); const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
    const ents = []; let i = 0; let inEntities = false; let insUnits = 1;
    while (i < pairs.length) {
      const [c, v] = pairs[i];
      if (c === 9 && v === '$INSUNITS') { insUnits = parseInt(pairs[i + 1][1], 10); }
      if (c === 2 && v === 'ENTITIES' && pairs[i - 1] && pairs[i - 1][1] === 'SECTION') inSection();
      function inSection() { inEntities = true; }
      if (inEntities && c === 0) {
        if (v === 'ENDSEC') break;
        const ent = { type: v, data: [] }; i++;
        while (i < pairs.length && pairs[i][0] !== 0) { ent.data.push(pairs[i]); i++; }
        ents.push(ent); continue;
      }
      i++;
    }
    const scale = insUnits === 4 ? 1 / 25.4 : insUnits === 5 ? 1 / 2.54 : 1; // mm/cm -> inch
    const get = (e, code, def) => { const f = e.data.find(d => d[0] === code); return f ? parseFloat(f[1]) : def; };
    const loops = [], opens = [];
    for (const e of ents) {
      if (e.type === 'LWPOLYLINE') {
        const verts = []; let closed = (get(e, 70, 0) & 1) === 1; let cur = null;
        for (const [c, v] of e.data) {
          if (c === 10) { cur = { x: parseFloat(v) * scale, y: 0, b: 0 }; verts.push(cur); }
          else if (c === 20 && cur) cur.y = parseFloat(v) * scale;
          else if (c === 42 && cur) cur.b = parseFloat(v);
        }
        const segs = [];
        const nseg = closed ? verts.length : verts.length - 1;
        for (let k = 0; k < nseg; k++) {
          const a = verts[k], b = verts[(k + 1) % verts.length];
          if (same(a, b)) continue;
          if (Math.abs(a.b) < 1e-9) segs.push(line(P(a.x, a.y), P(b.x, b.y)));
          else segs.push(bulgeArc(P(a.x, a.y), P(b.x, b.y), a.b));
        }
        if (!segs.length) continue;
        if (closed) loops.push(segs); else opens.push(segs);
      } else if (e.type === 'CIRCLE') {
        loops.push(circleLoop(get(e, 10, 0) * scale, get(e, 20, 0) * scale, get(e, 40, 0) * scale));
      } else if (e.type === 'ARC') {
        const c = P(get(e, 10, 0) * scale, get(e, 20, 0) * scale), r = get(e, 40, 0) * scale;
        const a0 = get(e, 50, 0) * Math.PI / 180, a1 = get(e, 51, 0) * Math.PI / 180;
        opens.push([arc(P(c.x + r * Math.cos(a0), c.y + r * Math.sin(a0)), P(c.x + r * Math.cos(a1), c.y + r * Math.sin(a1)), c, true)]);
      } else if (e.type === 'LINE') {
        opens.push([line(P(get(e, 10, 0) * scale, get(e, 20, 0) * scale), P(get(e, 11, 0) * scale, get(e, 21, 0) * scale))]);
      } else if (e.type === 'SPLINE') {
        // approximate via fit points / control points
        const pts = []; let cur = null;
        for (const [c, v] of e.data) { if (c === 10) { cur = P(parseFloat(v) * scale, 0); pts.push(cur); } else if (c === 20 && cur) cur.y = parseFloat(v) * scale; }
        const segs = []; for (let k = 0; k + 1 < pts.length; k++) segs.push(line(pts[k], pts[k + 1]));
        if (segs.length) opens.push(segs);
      }
    }
    // chain open segments into loops where possible
    const chained = chainOpen(opens);
    for (const ch of chained) { if (ch.closed) loops.push(ch.segs); else opens2.push(ch.segs); }
    return { loops: loops.map(l => signedArea(l) < 0 ? reverseLoop(l) : l), opens: opens2 };
  }
  const opens2 = [];
  function chainOpen(opens) {
    opens2.length = 0;
    const pool = opens.map(s => s.slice()); const out = [];
    while (pool.length) {
      let cur = pool.shift(); let grew = true;
      while (grew) {
        grew = false;
        const end = cur[cur.length - 1].b, start = cur[0].a;
        for (let k = 0; k < pool.length; k++) {
          const c = pool[k];
          if (same(end, c[0].a, 1e-4)) { cur = cur.concat(c); pool.splice(k, 1); grew = true; break; }
          if (same(end, c[c.length - 1].b, 1e-4)) { cur = cur.concat(reverseLoop(c)); pool.splice(k, 1); grew = true; break; }
          if (same(start, c[c.length - 1].b, 1e-4)) { cur = c.concat(cur); pool.splice(k, 1); grew = true; break; }
          if (same(start, c[0].a, 1e-4)) { cur = reverseLoop(c).concat(cur); pool.splice(k, 1); grew = true; break; }
        }
      }
      const closed = same(cur[0].a, cur[cur.length - 1].b, 1e-4) && cur.length > 1 || (cur.length === 1 && cur[0].type === 'arc' && same(cur[0].a, cur[0].b, 1e-6));
      out.push({ segs: cur, closed });
    }
    return out;
  }
  function bulgeArc(a, b, bulge) {
    const theta = 4 * Math.atan(bulge); const chord = dist(a, b); const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
    const m = mul(add(a, b), 0.5); const dir = norm(sub(b, a)); const h = r * Math.cos(theta / 2);
    const nrm = P(-dir.y, dir.x); // left normal
    const c = add(m, mul(nrm, bulge > 0 ? h : -h));
    return arc(a, b, c, bulge > 0);
  }
  function arcBulge(s) { return Math.tan(sweep(s) / 4); }
  function writeDXF(loops, opens = []) {
    const f = (n) => (+n.toFixed(6)).toString();
    let o = '0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n1\n9\n$ACADVER\n1\nAC1015\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n';
    const emit = (segs, closed) => {
      o += `0\nLWPOLYLINE\n8\n0\n90\n${closed ? segs.length : segs.length + 1}\n70\n${closed ? 1 : 0}\n`;
      segs.forEach(s => { o += `10\n${f(s.a.x)}\n20\n${f(s.a.y)}\n`; if (s.type === 'arc') o += `42\n${f(arcBulge(s))}\n`; });
      if (!closed) { const l = segs[segs.length - 1]; o += `10\n${f(l.b.x)}\n20\n${f(l.b.y)}\n`; }
    };
    loops.forEach(l => emit(l, true)); opens.forEach(l => emit(l, false));
    o += '0\nENDSEC\n0\nEOF\n';
    return o;
  }

  return { EPS, P, add, sub, mul, dot, cross, len, dist, norm, rot, same, line, arc, radius, sweep, tangentAt, segLen, pointAt, samplePts, loopPts, signedArea, reverseLoop, bbox, transformLoop, translateLoop, rotateLoop, mirrorLoopX, pointInLoop, polyLoop, normalizePolyPts, rectLoop, circleLoop, ellipseLoop, splineLoop, offsetLoop, splitArcs, startLoopAt, longestLineIndex, midOfSeg, parseDXF, writeDXF, bulgeArc, arcBulge, chainOpen };
})();
if (typeof module !== 'undefined') module.exports = GEOM;
