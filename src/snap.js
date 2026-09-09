/* ===== snap.js — object snaps (endpoint / midpoint / centre / quadrant /
   intersection / nearest-on-edge) and ortho-polar constraint =====
   Pure geometry: takes world loops, returns a world point + what it snapped to.
   Priority order matters — an endpoint under the cursor must win over the edge
   it sits on, or you could never hit it. */
const SNAP = (() => {
  const G = typeof GEOM !== 'undefined' ? GEOM : require('./geom.js');
  const P = G.P;

  // lower number wins when two candidates are both within tolerance
  const PRIO = { endpoint: 0, intersection: 1, center: 2, midpoint: 3, quadrant: 4, on: 5, grid: 6 };
  const DEFAULTS = { endpoint: true, midpoint: true, center: true, quadrant: true, intersection: true, on: true, grid: true };

  // is the point actually ON the segment, not merely on its infinite line/circle?
  function onSeg(s, p, tol = 1e-6) {
    if (s.type === 'line') {
      const d = G.sub(s.b, s.a), L2 = G.dot(d, d);
      if (L2 < 1e-18) return G.dist(s.a, p) < tol;
      const t = G.dot(G.sub(p, s.a), d) / L2;
      if (t < -1e-9 || t > 1 + 1e-9) return false;
      return G.dist(p, G.add(s.a, G.mul(d, t))) < tol + 1e-6;
    }
    const r = G.radius(s);
    if (Math.abs(G.dist(p, s.c) - r) > tol + 1e-6) return false;
    const a0 = Math.atan2(s.a.y - s.c.y, s.a.x - s.c.x);
    const sw = G.sweep(s);
    let da = Math.atan2(p.y - s.c.y, p.x - s.c.x) - a0;
    if (sw > 0) { while (da < -1e-9) da += 2 * Math.PI; return da <= sw + 1e-9; }
    while (da > 1e-9) da -= 2 * Math.PI;
    return da >= sw - 1e-9;
  }

  // true BOUNDED intersections of two segments (GEOM.segSegTrim extends them; this does not)
  function segSegPoints(s1, s2) {
    const out = [];
    const push = (p) => { if (p && isFinite(p.x) && isFinite(p.y) && onSeg(s1, p, 1e-6) && onSeg(s2, p, 1e-6)) out.push(p); };
    if (s1.type === 'line' && s2.type === 'line') {
      const d1 = G.sub(s1.b, s1.a), d2 = G.sub(s2.b, s2.a);
      const den = G.cross(d1, d2);
      if (Math.abs(den) < 1e-12) return out;
      push(G.add(s1.a, G.mul(d1, G.cross(G.sub(s2.a, s1.a), d2) / den)));
    } else if (s1.type === 'line' || s2.type === 'line') {
      const ln = s1.type === 'line' ? s1 : s2, ar = s1.type === 'line' ? s2 : s1;
      const d = G.sub(ln.b, ln.a), c = ar.c, r = G.radius(ar);
      const f = G.sub(ln.a, c), a = G.dot(d, d), b = 2 * G.dot(f, d), cc = G.dot(f, f) - r * r;
      let disc = b * b - 4 * a * cc;
      if (disc < 0) { if (disc > -1e-9) disc = 0; else return out; }
      const sq = Math.sqrt(disc);
      push(G.add(ln.a, G.mul(d, (-b - sq) / (2 * a))));
      if (sq > 1e-12) push(G.add(ln.a, G.mul(d, (-b + sq) / (2 * a))));
    } else {
      const c1 = s1.c, r1 = G.radius(s1), c2 = s2.c, r2 = G.radius(s2);
      const dd = G.dist(c1, c2);
      if (dd < 1e-12 || dd > r1 + r2 + 1e-9 || dd < Math.abs(r1 - r2) - 1e-9) return out;
      const a = (r1 * r1 - r2 * r2 + dd * dd) / (2 * dd);
      let h2 = r1 * r1 - a * a; if (h2 < 0) h2 = 0;
      const h = Math.sqrt(h2), m = G.add(c1, G.mul(G.sub(c2, c1), a / dd)), n = G.norm(G.sub(c2, c1));
      push(P(m.x - n.y * h, m.y + n.x * h));
      if (h > 1e-12) push(P(m.x + n.y * h, m.y - n.x * h));
    }
    return out;
  }

  function nearestOnSeg(s, p) {
    if (s.type === 'line') {
      const d = G.sub(s.b, s.a), L2 = G.dot(d, d) || 1;
      let t = G.dot(G.sub(p, s.a), d) / L2;
      t = Math.max(0, Math.min(1, t));
      return G.add(s.a, G.mul(d, t));
    }
    const r = G.radius(s), v = G.sub(p, s.c);
    if (G.len(v) < 1e-12) return s.a;
    const cand = G.add(s.c, G.mul(G.norm(v), r));
    if (onSeg(s, cand, 1e-6)) return cand;
    return G.dist(s.a, p) <= G.dist(s.b, p) ? s.a : s.b;   // clamp to the nearer end
  }

  /* Best snap for a cursor position.
       loops : [{id, loop:[segs]}] in world space
       tol   : world-space tolerance (caller converts pixels -> inches)
       opts  : {enabled, gridStep, exclude:Set(id), extra:[{x,y,type}]} */
  function snapPoint(wp, loops, tol, opts = {}) {
    const en = { ...DEFAULTS, ...(opts.enabled || {}) };
    const cands = [];
    const add = (p, type, ref) => {
      if (!p || !isFinite(p.x) || !isFinite(p.y)) return;
      const d = G.dist(p, wp);
      if (d > tol) return;
      cands.push({ p, type, ref, d });
    };
    for (const q of opts.extra || []) add(q, q.type || 'endpoint', q.ref);

    const near = [];   // only segments near the cursor, so intersections stay cheap
    for (const item of loops) {
      if (opts.exclude && opts.exclude.has(item.id)) continue;
      const loop = item.loop;
      if (!loop || !loop.length) continue;
      const seenC = [];
      for (const s of loop) {
        const r = s.type === 'arc' ? G.radius(s) : 0;
        const bx0 = Math.min(s.a.x, s.b.x) - r, bx1 = Math.max(s.a.x, s.b.x) + r;
        const by0 = Math.min(s.a.y, s.b.y) - r, by1 = Math.max(s.a.y, s.b.y) + r;
        if (wp.x < bx0 - tol || wp.x > bx1 + tol || wp.y < by0 - tol || wp.y > by1 + tol) continue;
        near.push({ s, id: item.id });
        if (en.endpoint) { add(s.a, 'endpoint', item.id); add(s.b, 'endpoint', item.id); }
        if (en.midpoint) add(G.pointAt(s, 0.5), 'midpoint', item.id);
        if (s.type === 'arc') {
          if (en.center && !seenC.some(c => G.same(c, s.c, 1e-9))) { seenC.push(s.c); add(s.c, 'center', item.id); }
          if (en.quadrant) {
            const rr = G.radius(s);
            for (const q of [P(s.c.x + rr, s.c.y), P(s.c.x - rr, s.c.y), P(s.c.x, s.c.y + rr), P(s.c.x, s.c.y - rr)]) {
              if (onSeg(s, q, 1e-6)) add(q, 'quadrant', item.id);
            }
          }
        }
        if (en.on) add(nearestOnSeg(s, wp), 'on', item.id);
      }
    }
    if (en.intersection) {
      for (let i = 0; i < near.length; i++) {
        for (let j = i + 1; j < near.length; j++) {
          if (near[i].s === near[j].s) continue;
          for (const p of segSegPoints(near[i].s, near[j].s)) add(p, 'intersection', near[i].id);
        }
      }
    }
    if (en.grid && opts.gridStep > 0) {
      const g = opts.gridStep;
      add(P(Math.round(wp.x / g) * g, Math.round(wp.y / g) * g), 'grid', null);
    }
    if (!cands.length) return null;
    /* Rank by type, but only among candidates that are actually close to each
       other. Sorting by priority alone let a far-off endpoint beat an on-edge
       snap right under the cursor: zoomed out the tolerance is inches wide, so
       an arc's seam 3 in away would win over the circumference 0.1 in away and
       the point would jump somewhere unexpected. Candidates outside the band
       are simply too far to have been meant. */
    /* Grid is not an object snap and must not compete on distance: at a 0.001
       step there is always a grid point within half a step of the cursor, so
       it would win every band and swallow real geometry. It is the fallback
       used only when nothing on the drawing is in range. */
    const objs = cands.filter(c => c.type !== 'grid');
    const pool = objs.length ? objs : cands;
    let dMin = Infinity;
    for (const c of pool) if (c.d < dMin) dMin = c.d;
    const band = Math.max(tol * 0.25, 1e-6);
    const close = pool.filter(c => c.d <= dMin + band);
    close.sort((a, b) => (PRIO[a.type] - PRIO[b.type]) || (a.d - b.d));
    return close[0];
  }

  /* Constrain `to` relative to `from`: 90 deg steps, or 45 deg when polar.
     Projects onto the locked direction so the cursor distance still reads
     naturally instead of snapping to a fixed length. */
  function ortho(from, to, polar = false) {
    const dx = to.x - from.x, dy = to.y - from.y;
    if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12) return { p: P(to.x, to.y), ang: 0 };
    const step = polar ? Math.PI / 4 : Math.PI / 2;
    const raw = Math.atan2(dy, dx);
    const a = Math.round(raw / step) * step;
    const L = Math.hypot(dx, dy) * Math.cos(raw - a);   // projection onto locked axis
    return { p: P(from.x + L * Math.cos(a), from.y + L * Math.sin(a)), ang: ((a * 180 / Math.PI) % 360 + 360) % 360 };
  }

  return { snapPoint, ortho, onSeg, segSegPoints, nearestOnSeg, DEFAULTS, PRIO };
})();
if (typeof module !== 'undefined') module.exports = SNAP;
