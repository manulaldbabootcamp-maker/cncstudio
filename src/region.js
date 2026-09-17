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

  return { arrange, faces, faceAt, unionFaces, segKey, paramOn, subSeg };
})();
if (typeof module !== 'undefined') module.exports = REGION;
