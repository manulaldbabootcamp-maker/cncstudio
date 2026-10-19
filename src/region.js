/* ===== region.js — planar arrangement and regions =====

   Professional CAD does not ask which curves make a part. It asks which AREA
   you mean. AutoCAD's BOUNDARY is the model: you click a point inside an
   enclosed area and the software works out the loop around it from every curve
   on the drawing. That question has exactly one answer. "Weld these curves into
   a part" has many, which is why merge kept guessing wrong.

   Answering it needs the arrangement: every curve split at every crossing with
   every other curve - arc on arc included - coincident ends welded, and the
   faces traced out of what is left.

   NOTHING HERE TOUCHES THE DRAWING. The arrangement is built from copies, so a
   circle stays a circle on the drawing even though the arrangement cuts it into
   arcs to reason about area. Every bug in this corner of the app came from
   trying to do that destructively: cutting a circle to find a region left the
   operator with a polygon they never asked for, and protecting the circle left
   regions untraceable. Doing it on copies is what dissolves that tension. */
const REGION = (() => {
  const G = typeof GEOM !== 'undefined' ? GEOM : require('./geom.js');
  const SN = typeof SNAP !== 'undefined' ? SNAP : require('./snap.js');

  const TWO_PI = Math.PI * 2;
  const wrap2pi = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

  // how far along a segment a point lies, 0..1
  function paramOn(s, p) {
    if (s.type === 'line') {
      const d = G.sub(s.b, s.a), L2 = G.dot(d, d) || 1;
      return G.dot(G.sub(p, s.a), d) / L2;
    }
    const a0 = Math.atan2(s.a.y - s.c.y, s.a.x - s.c.x), sw = G.sweep(s);
    let da = Math.atan2(p.y - s.c.y, p.x - s.c.x) - a0;
    if (sw > 0) { while (da < -1e-9) da += TWO_PI; } else { while (da > 1e-9) da -= TWO_PI; }
    return sw === 0 ? 0 : da / sw;
  }
  function subSeg(s, u0, u1) {
    if (u1 - u0 < 1e-9) return null;
    if (s.type === 'line') return G.line(G.pointAt(s, u0), G.pointAt(s, u1));
    return G.arc(G.pointAt(s, u0), G.pointAt(s, u1), s.c, s.ccw);
  }
  function segBox(s) {
    const r = s.type === 'arc' ? G.radius(s) : 0;
    return {
      x0: Math.min(s.a.x, s.b.x) - r, x1: Math.max(s.a.x, s.b.x) + r,
      y0: Math.min(s.a.y, s.b.y) - r, y1: Math.max(s.a.y, s.b.y) + r,
    };
  }
  const boxesApart = (p, q, tol) =>
    p.x1 < q.x0 - tol || q.x1 < p.x0 - tol || p.y1 < q.y0 - tol || q.y1 < p.y0 - tol;

  // where a segment runs, so the same edge found twice is recognised
  function segKey(sg, tol) {
    const r = (v) => Math.round(v / Math.max(tol, 1e-9));
    const ka = r(sg.a.x) + ',' + r(sg.a.y), kb = r(sg.b.x) + ',' + r(sg.b.y);
    const mid = G.pointAt(sg, 0.5);
    return (ka < kb ? ka + '|' + kb : kb + '|' + ka) + '|' + r(mid.x) + ',' + r(mid.y);
  }

  /* ---------- the arrangement ----------
     Split every segment wherever another one crosses it, and wherever another
     one's END lands on it - a T-junction is not a crossing but still divides
     the curve. Coincident pieces are dropped, so two parts sharing an edge
     contribute that edge once. */
  function arrange(segs, tol = 0.001) {
    const src = (segs || []).filter(s => s && G.segLen(s) > 1e-9);
    const boxes = src.map(segBox);
    const out = [];
    const seen = new Set();

    for (let i = 0; i < src.length; i++) {
      const sg = src[i];
      const cuts = [];
      const addCut = (q) => {
        const u = paramOn(sg, q);
        if (!(u > 1e-6 && u < 1 - 1e-6)) return;
        for (const v of cuts) if (Math.abs(v - u) < 1e-6) return;
        cuts.push(u);
      };
      for (let j = 0; j < src.length; j++) {
        if (i === j || boxesApart(boxes[i], boxes[j], tol)) continue;
        const o = src[j];
        for (const q of SN.segSegPoints(sg, o)) addCut(q);
        for (const e of [o.a, o.b]) {
          const q = SN.nearestOnSeg(sg, e);
          if (G.dist(q, e) <= tol) addCut(q);
        }
      }
      cuts.sort((a, b) => a - b);
      let from = 0;
      const pieces = [];
      for (const u of cuts) { const p = subSeg(sg, from, u); if (p) pieces.push(p); from = u; }
      const tail = subSeg(sg, from, 1);
      if (tail) pieces.push(tail);
      for (const p of pieces) {
        if (G.segLen(p) <= Math.max(tol / 2, 1e-7)) continue;
        const k = segKey(p, Math.max(tol, 1e-6));
        if (seen.has(k)) continue;          // the same edge from two shapes
        seen.add(k);
        out.push(p);
      }
    }
    return out;
  }

  /* ---------- faces ----------
     Walk the arrangement taking the sharpest clockwise turn available at each
     node. That traces one face at a time; a spur gets walked out and back, and
     the face outside everything comes out with a negative area, which is how it
     is told apart from the regions that enclose something. */
  function faces(segs, tol = 0.001) {
    const nodes = [];
    const nodeAt = (p) => {
      for (let i = 0; i < nodes.length; i++) if (G.dist(nodes[i].p, p) <= tol) return i;
      nodes.push({ p: { x: p.x, y: p.y }, out: [] });
      return nodes.length - 1;
    };
    const de = [];
    const rings = [];
    for (const sg of segs) {
      if (G.segLen(sg) <= 1e-9) continue;
      const a = nodeAt(sg.a), b = nodeAt(sg.b);
      if (a === b) { rings.push([sg]); continue; }     // closes on itself already
      de.push({ seg: sg, from: a, to: b });
      de.push({ seg: G.reverseLoop([sg])[0], from: b, to: a });
    }
    de.forEach((e, i) => nodes[e.from].out.push(i));
    const outAng = (i) => { const t = G.tangentAt(de[i].seg, true); return Math.atan2(t.y, t.x); };
    const backAng = (i) => { const t = G.tangentAt(de[i].seg, false); return Math.atan2(-t.y, -t.x); };

    const found = [];
    const used = new Set();
    for (let start = 0; start < de.length; start++) {
      if (used.has(start)) continue;
      const cyc = [];
      let cur = start;
      while (!used.has(cur)) {
        used.add(cur); cyc.push(cur);
        const outs = nodes[de[cur].to].out;
        if (!outs.length) break;
        const back = backAng(cur);
        let best = -1, bestD = Infinity;
        for (const oi of outs) {
          const d = wrap2pi(back - outAng(oi)) || TWO_PI;   // straight back is the last resort
          if (d < bestD) { bestD = d; best = oi; }
        }
        if (best < 0) break;
        cur = best;
      }
      if (cyc.length && de[cyc[cyc.length - 1]].to === de[cyc[0]].from) found.push(cyc.map(i => de[i].seg));
    }
    for (const r of rings) found.push(G.signedArea(r) < 0 ? G.reverseLoop(r) : r);

    return found
      .map(sgs => ({ segs: sgs, area: G.signedArea(sgs) }))
      .filter(f => f.area > 1e-7)
      .sort((a, b) => b.area - a.area);
  }

  const inside = (pt, loop) => { try { return G.pointInLoop(pt, loop); } catch (e) { return false; } };

  /* The region a point is in: the smallest face that contains it. Faces sitting
     inside that one which do not contain the point are its islands, and become
     inside cuts - which is what BOUNDARY and HATCH do with an island. */
  function faceAt(segs, pt, tol = 0.001) {
    const fs = faces(segs, tol);
    const holding = fs.filter(f => inside(pt, f.segs));
    if (!holding.length) return null;
    const face = holding[holding.length - 1];            // smallest, the list is largest first
    const mid = (f) => G.pointAt(f.segs[0], 0.5);
    const islands = fs.filter(f => f !== face && f.area < face.area
      && inside(mid(f), face.segs) && !inside(pt, f.segs));
    // keep only the outermost islands, so a hole inside a hole is not cut twice
    const outer = islands.filter(f => !islands.some(g => g !== f && g.area > f.area && inside(mid(f), g.segs)));
    return { segs: face.segs, area: face.area, holes: outer.map(f => f.segs) };
  }

  /* Everything the selected curves enclose, as one outline: the faces that
     touch each other are welded by dropping the edges they share. */
  function unionFaces(fs, tol = 0.001) {
    if (!fs.length) return null;
    if (fs.length === 1) return fs[0].segs;
    const count = new Map();
    for (const f of fs) for (const sg of f.segs) {
      const k = segKey(sg, Math.max(tol, 1e-6));
      count.set(k, (count.get(k) || 0) + 1);
    }
    const border = [];
    for (const f of fs) for (const sg of f.segs) if (count.get(segKey(sg, Math.max(tol, 1e-6))) === 1) border.push(sg);
    if (!border.length) return null;
    const runs = G.chainOpen(border.map(sg => [sg]));
    if (runs.length !== 1 || !runs[0].closed) return null;
    return runs[0].segs;
  }

  /* ---------- filled outline ----------
     Cursive letters overlap where they join, and a glyph can overlap itself.
     A font fills by the nonzero rule, so the overlap is solid ink - but cut as
     drawn, the laser runs a line through every join. Split every contour at
     every crossing, keep each piece that has ink on one side and none on the
     other, and chain what is left: the outline of the ink, holes included.
     Straight-line contours only (font outlines are). Returns null when
     nothing crosses - the caller keeps its contours exactly as they were - or
     when the pieces will not chain closed.
     `gaps` are boxes taken out of the ink - stencil bridges, which hold the
     middle of an A or an O to the sheet so it does not drop out. */
  function fillOutline(loops, tol = 1e-5, jump = tol * 200, gaps = []) {
    const ink = [];
    for (const l of loops) for (const s of l) if (G.segLen(s) > 1e-12) ink.push(s);
    if (ink.some(s => s.type !== 'line')) return null;
    const all = ink.concat(gaps.flatMap(g => G.rectLoop(g.x0, g.y0, g.x1 - g.x0, g.y1 - g.y0)));

    /* Split at crossings here rather than through arrange(): a cursive line
       holds thousands of short segments, arrange() was seen to miss a few of
       their crossings (a piece then spans one and is put on the wrong side),
       and computing each crossing ONCE gives both pieces the very same point
       to chain through. Sweep on x so only neighbours are compared. */
    const cuts = all.map(() => []);
    const order = all.map((s, i) => i).sort((i, j) => Math.min(all[i].a.x, all[i].b.x) - Math.min(all[j].a.x, all[j].b.x));
    let crossed = 0;
    for (let oi = 0; oi < order.length; oi++) {
      const i = order[oi], s = all[i], sx1 = Math.max(s.a.x, s.b.x);
      const sy0 = Math.min(s.a.y, s.b.y), sy1 = Math.max(s.a.y, s.b.y);
      for (let oj = oi + 1; oj < order.length; oj++) {
        const j = order[oj], o = all[j];
        if (Math.min(o.a.x, o.b.x) > sx1) break;
        if (Math.max(o.a.y, o.b.y) < sy0 || Math.min(o.a.y, o.b.y) > sy1) continue;
        const rx = s.b.x - s.a.x, ry = s.b.y - s.a.y, qx = o.b.x - o.a.x, qy = o.b.y - o.a.y;
        const den = rx * qy - ry * qx;
        if (Math.abs(den) < 1e-18) continue;              // parallel
        const wx = o.a.x - s.a.x, wy = o.a.y - s.a.y;
        const t = (wx * qy - wy * qx) / den, u = (wx * ry - wy * rx) / den;
        const e = 1e-9;
        if (t < -e || t > 1 + e || u < -e || u > 1 + e) continue;
        const inT = t > e && t < 1 - e, inU = u > e && u < 1 - e;
        if (!inT && !inU) continue;                        // contour vertices meeting: already shared
        const p = { x: s.a.x + rx * t, y: s.a.y + ry * t };
        if (inT) cuts[i].push({ t, p });
        if (inU) cuts[j].push({ t: u, p });
        crossed++;
      }
    }
    if (!crossed && !gaps.length) return null;
    const pieces = [];
    all.forEach((s, i) => {
      const cs = cuts[i].sort((a, b) => a.t - b.t);
      let from = s.a;
      for (const c of cs) { if (G.dist(from, c.p) > 1e-12) pieces.push(G.line(from, c.p)); from = c.p; }
      if (G.dist(from, s.b) > 1e-12) pieces.push(G.line(from, s.b));
    });

    // nonzero winding of the original contours around p; segments banded on y
    let by0 = Infinity, by1 = -Infinity;
    for (const s of ink) { by0 = Math.min(by0, s.a.y, s.b.y); by1 = Math.max(by1, s.a.y, s.b.y); }
    const NB = 256, bh = (by1 - by0) / NB || 1, band = Array.from({ length: NB }, () => []);
    const bandOf = (y) => Math.max(0, Math.min(NB - 1, Math.floor((y - by0) / bh)));
    for (const s of ink) for (let k = bandOf(Math.min(s.a.y, s.b.y)); k <= bandOf(Math.max(s.a.y, s.b.y)); k++) band[k].push(s);
    const wind = (p) => {
      let w = 0;
      for (const s of band[bandOf(p.y)]) {
        const a = s.a, b = s.b, c = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
        if (a.y <= p.y) { if (b.y > p.y && c > 0) w++; }
        else if (b.y <= p.y && c < 0) w--;
      }
      return w;
    };
    const filled = (p) => wind(p) !== 0 && !gaps.some(g => p.x > g.x0 && p.x < g.x1 && p.y > g.y0 && p.y < g.y1);
    const kept = [];
    for (const s of pieces) {
      const L = G.segLen(s), d = { x: (s.b.x - s.a.x) / L, y: (s.b.y - s.a.y) / L };
      const m = G.pointAt(s, 0.5);
      // close enough not to reach past a neighbouring crossing on a short piece
      const h = Math.min(tol * 10, L * 0.02);
      const left = filled({ x: m.x - d.y * h, y: m.y + d.x * h });
      const right = filled({ x: m.x + d.y * h, y: m.y - d.x * h });
      if (left === right) continue;                     // inside the ink, or outside it
      kept.push(left ? s : G.line(s.b, s.a));            // ink always on the left
    }
    if (!kept.length) return null;

    // chain: each piece leads to one that starts where it ends
    const cell = tol * 4, key = (p, i, j) => (Math.round(p.x / cell) + i) + ',' + (Math.round(p.y / cell) + j);
    const starts = new Map();
    kept.forEach((s, i) => { const k = key(s.a, 0, 0); if (!starts.has(k)) starts.set(k, []); starts.get(k).push(i); });
    const used = new Set();
    const nextFrom = (p) => {
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const n of starts.get(key(p, i, j)) || []) if (!used.has(n) && G.dist(kept[n].a, p) <= cell) return n;
      }
      return -1;
    };
    /* Two letters can carry edges a millionth of an inch apart and nearly
       parallel. The slivers between them are too thin to tell ink from paper,
       so a piece or two there lands on the wrong side and a chain stops short.
       Far below anything a beam or bit resolves: bridge a gap up to `jump` to
       the nearest free piece, and drop the specks this leaves. */
    const nearestFree = (p) => {
      let best = -1, bd = jump;
      kept.forEach((s, n) => { if (!used.has(n)) { const d = G.dist(s.a, p); if (d <= bd) { bd = d; best = n; } } });
      return best;
    };
    const out = [];
    for (let s0 = 0; s0 < kept.length; s0++) {
      if (used.has(s0)) continue;
      used.add(s0);
      const loop = [kept[s0]];
      let closed = false;
      for (;;) {
        const end = loop[loop.length - 1].b, home = G.dist(end, loop[0].a);
        if (loop.length > 1 && home <= cell) { closed = true; break; }
        let n = nextFrom(end);
        if (n < 0) {
          n = nearestFree(end);
          if (loop.length > 1 && home <= jump && (n < 0 || home <= G.dist(kept[n].a, end))) { closed = true; break; }
          if (n < 0) break;
          loop.push(G.line(end, kept[n].a));
        }
        used.add(n); loop.push(kept[n]);
      }
      if (!closed) {
        if (loop.reduce((t, s) => t + G.segLen(s), 0) < jump * 10) continue;   // a speck
        return null;
      }
      // close up the gap between the last piece and the first
      const last = loop[loop.length - 1];
      if (G.dist(last.b, loop[0].a) > 1e-12) loop.push(G.line(last.b, loop[0].a));
      if (Math.abs(G.signedArea(loop)) < jump * jump) continue;
      out.push(loop);
    }
    return out.length ? out : null;
  }

  /* Stencil bridges. Cut a letter out of film and the middle of an A, O or R
     is an island with nothing holding it - it drops out. For every hole in
     the ink (`loops` must not overlap: fillOutline's output, or contours that
     never crossed), put a gap of `width` straight up and straight down from
     the hole, through the stroke and just past it, so the island stays tied
     to the sheet. Returns boxes for fillOutline's `gaps`. */
  function bridgeGaps(loops, width) {
    const inLoop = (p, l) => { try { return G.pointInLoop(p, l); } catch (e) { return false; } };
    const depth = loops.map((l, i) => { const p = G.pointAt(l[0], 0.5); return loops.filter((o, j) => j !== i && inLoop(p, o)).length; });
    // where the vertical line x crosses these segments
    const ysAt = (segs, x) => {
      const ys = [];
      for (const s of segs) {
        if ((s.a.x <= x) === (s.b.x <= x)) continue;
        ys.push(s.a.y + (x - s.a.x) * (s.b.y - s.a.y) / (s.b.x - s.a.x));
      }
      return ys.sort((a, b) => a - b);
    };
    const all = loops.flat();
    const gaps = [];
    loops.forEach((hole, i) => {
      if (depth[i] % 2 !== 1) return;                    // ink, not a hole
      const bb = G.bbox(hole), x = (bb.x0 + bb.x1) / 2 + 1e-7;
      const hy = ysAt(hole, x);
      if (hy.length < 2) return;
      const top = hy[hy.length - 1], bot = hy[0], into = Math.min(width, (top - bot) / 2);
      const ys = ysAt(all, x);
      const up = ys.filter(y => y > top + 1e-9), dn = ys.filter(y => y < bot - 1e-9).reverse();
      const w2 = width / 2;
      if (up.length) {
        const past = up.length > 1 ? Math.min(width, (up[1] - up[0]) / 2) : width;
        gaps.push({ x0: x - w2, x1: x + w2, y0: top - into, y1: up[0] + past });
      }
      if (dn.length) {
        const past = dn.length > 1 ? Math.min(width, (dn[0] - dn[1]) / 2) : width;
        gaps.push({ x0: x - w2, x1: x + w2, y0: dn[0] - past, y1: bot + into });
      }
    });
    /* The gap below B's upper hole is the gap above its lower one. Two boxes
       on the same column share their sides exactly, and edges lying on edges
       cannot be split cleanly - merge them into one box first. */
    gaps.sort((a, b) => a.x0 - b.x0 || a.y0 - b.y0);
    const out = [];
    for (const g of gaps) {
      const p = out[out.length - 1];
      if (p && Math.abs(p.x0 - g.x0) < 1e-9 && g.y0 <= p.y1 + 1e-9) p.y1 = Math.max(p.y1, g.y1);
      else out.push({ ...g });
    }
    return out;
  }

  return { arrange, faces, faceAt, unionFaces, fillOutline, bridgeGaps, segKey, paramOn, subSeg };
})();
if (typeof module !== 'undefined') module.exports = REGION;
