/* ===== bool.js — boolean union / subtract / intersect on closed loops =====

   The rest of the app carries true arcs (G2/G3 in the TAP). Polygon clipping
   cannot work on arcs directly, so this:
       1. flattens each loop to a polygon at a tight tolerance,
       2. clips with Greiner-Hormann,
       3. RE-FITS circular arcs on the result, so a cut edge that was an arc
          before the boolean comes back as an arc afterwards.
   Without step 3 a boolean would silently turn every curve into a few hundred
   tiny G1 moves - slower to cut and visibly faceted on acrylic. */
const BOOL = (() => {
  const G = typeof GEOM !== 'undefined' ? GEOM : require('./geom.js');
  const P = G.P;
  const EPS = 1e-9;

  // ---------- flatten ----------
  // chord tolerance: max deviation of the polyline from the true arc
  function flatten(loop, tol = 0.0015) {
    const pts = [];
    for (const s of loop) {
      if (s.type === 'line') { pts.push({ x: s.a.x, y: s.a.y }); continue; }
      const r = G.radius(s), sw = Math.abs(G.sweep(s));
      // n from sagitta tolerance: tol = r(1-cos(step/2))
      let step = r > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / r)) : sw;
      if (!isFinite(step) || step <= 1e-6) step = sw;
      const n = Math.max(2, Math.ceil(sw / step));
      for (let i = 0; i < n; i++) { const p = G.pointAt(s, i / n); pts.push({ x: p.x, y: p.y }); }
    }
    // drop duplicate consecutive points
    const out = [];
    for (const p of pts) if (!out.length || Math.hypot(p.x - out[out.length - 1].x, p.y - out[out.length - 1].y) > 1e-9) out.push(p);
    if (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 1e-9) out.pop();
    return out;
  }

  function bboxOf(polys) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const poly of polys) for (const p of poly) {
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    }
    return { x0, y0, x1, y1 };
  }

  function area(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y; }
    return a / 2;
  }
  function inside(pt, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  }

  // ---------- Greiner-Hormann ----------
  function node(x, y, alpha, intersect) {
    return { x, y, alpha: alpha || 0, intersect: !!intersect, next: null, prev: null, neighbour: null, entry: false, visited: false };
  }
  function buildList(poly) {
    let first = null, prev = null;
    for (const p of poly) {
      const n = node(p.x, p.y);
      if (!first) first = n; else { prev.next = n; n.prev = prev; }
      prev = n;
    }
    prev.next = first; first.prev = prev;
    return first;
  }
  function forEachVertex(first, fn) { let n = first; do { fn(n); n = n.next; } while (n !== first); }
  function nextNonIntersect(n) { let c = n.next; while (c.intersect) c = c.next; return c; }

  function insertBetween(ins, start, end) {
    let c = start;
    while (c !== end && c.alpha < ins.alpha) c = c.next;
    ins.next = c; ins.prev = c.prev; ins.prev.next = ins; c.prev = ins;
  }

  function segInt(a1, a2, b1, b2) {
    const dax = a2.x - a1.x, day = a2.y - a1.y, dbx = b2.x - b1.x, dby = b2.y - b1.y;
    const den = dax * dby - day * dbx;
    if (Math.abs(den) < 1e-14) return null;
    const tA = ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) / den;
    const tB = ((b1.x - a1.x) * day - (b1.y - a1.y) * dax) / den;
    if (tA < -1e-12 || tA > 1 + 1e-12 || tB < -1e-12 || tB > 1 + 1e-12) return null;
    return { x: a1.x + tA * dax, y: a1.y + tA * day, tA, tB };
  }

  // returns array of polygons, or null if the clip hit a degeneracy
  function clipPolys(subject, clipper, subInside, clipInside) {
    const S = buildList(subject), C = buildList(clipper);
    let count = 0, degenerate = false;

    let s = S;
    do {
      if (!s.intersect) {
        const s2 = nextNonIntersect(s);
        let c = C;
        do {
          if (!c.intersect) {
            const c2 = nextNonIntersect(c);
            const i = segInt(s, s2, c, c2);
            if (i) {
              /* A hit at or very near a vertex makes entry/exit ambiguous and
                 the traversal then silently produces a wrong outline. The
                 threshold is deliberately loose (1e-6 of edge length, not
                 1e-9): a crossing a millionth of the way along an edge is a
                 shared corner in disguise, and treating it as a clean crossing
                 is how this algorithm returns confident garbage. */
              if (i.tA < 1e-6 || i.tA > 1 - 1e-6 || i.tB < 1e-6 || i.tB > 1 - 1e-6) degenerate = true;
              const n1 = node(i.x, i.y, i.tA, true), n2 = node(i.x, i.y, i.tB, true);
              n1.neighbour = n2; n2.neighbour = n1;
              insertBetween(n1, s, s2); insertBetween(n2, c, c2);
              count++;
            }
          }
          c = c.next;
        } while (c !== C);
      }
      s = s.next;
    } while (s !== S);

    if (degenerate) return null;
    if (count === 0) return { disjoint: true };

    // entry/exit flags
    let e = inside({ x: S.x, y: S.y }, clipper) !== subInside;
    forEachVertex(S, n => { if (n.intersect) { n.entry = e; e = !e; } });
    e = inside({ x: C.x, y: C.y }, subject) !== clipInside;
    forEachVertex(C, n => { if (n.intersect) { n.entry = e; e = !e; } });

    const out = [];
    forEachVertex(S, start => {
      if (!start.intersect || start.visited) return;
      const poly = [];
      let cur = start;
      do {
        cur.visited = true;
        if (cur.neighbour) cur.neighbour.visited = true;
        if (cur.entry) { do { cur = cur.next; poly.push({ x: cur.x, y: cur.y }); } while (!cur.intersect); }
        else { do { cur = cur.prev; poly.push({ x: cur.x, y: cur.y }); } while (!cur.intersect); }
        cur.visited = true;
        cur = cur.neighbour;
        if (!cur) break;
      } while (!cur.visited && poly.length < 100000);
      if (poly.length > 2) out.push(poly);
    });
    return out;
  }

  /* Run a boolean, working through a series of perturbations until one produces
     a result that passes `validate`. Each strategy is CHECKED before it is
     accepted: a near-degenerate configuration can yield a plausible-looking but
     wrong outline, and returning the first non-null answer would short-circuit
     the strategies that would have got it right. */
  function clipRobust(a, b, subInside, clipInside, validate, mayTouch) {
    /* "No crossings" is reported as disjoint - but two shapes butted edge to
       edge have no crossings either, they merely touch. Taking that at face
       value returned the two parts unmerged, so their shared edge would be cut
       twice. When the outlines are close enough to touch, a disjoint answer is
       held as a fallback and the perturbations are tried first; a perturbation
       turns a touch into a real crossing and the union comes back merged. */
    let fallback = null;
    const ok = (r) => {
      if (!r) return false;
      if (r.disjoint) { if (!mayTouch) return true; if (!fallback) fallback = r; return false; }
      return r.length && (!validate || validate(r));
    };
    let r = clipPolys(a, b, subInside, clipInside);
    if (ok(r)) return r;

    // 1. rotate both together: shifts axis-aligned degeneracies off the axes
    for (const ang of [1e-5, 3.7e-5, 1.1e-4]) {
      const c = Math.cos(ang), sn = Math.sin(ang);
      const rot = (poly) => poly.map(p => ({ x: p.x * c - p.y * sn, y: p.x * sn + p.y * c }));
      const un = (poly) => poly.map(p => ({ x: p.x * c + p.y * sn, y: -p.x * sn + p.y * c }));
      const rr = clipPolys(rot(a), rot(b), subInside, clipInside);
      if (!rr) continue;
      if (rr.disjoint) { if (!mayTouch) return rr; if (!fallback) fallback = rr; continue; }
      const back = rr.map(un);
      if (ok(back)) return back;
    }

    /* 2. Translate the clip polygon by a hair, clip, then translate the result
       back. Translation is the right perturbation here because it moves EVERY
       vertex off a shared line. The earlier radial nudge could not: for a
       circle centred exactly on the line it is subtracted from, the topmost and
       bottommost vertices move parallel to that line and stay on it - which is
       exactly the semicircular-notch case. Offsets are ~1e-6 in, four orders
       below the 1e-4 the post rounds to, so the cut geometry is unchanged. */
    const dirs = [[1, 0.37], [-0.61, 1], [1, -0.83], [-1, -0.29]];
    for (const mag of [1.7e-6, 1.3e-5, 4.1e-5]) {
      for (const [ux, uy] of dirs) {
        const L = Math.hypot(ux, uy);
        const dx = ux / L * mag, dy = uy / L * mag;
        const moved = b.map(p => ({ x: p.x + dx, y: p.y + dy }));
        const rr = clipPolys(a, moved, subInside, clipInside);
        if (!rr) continue;
        if (rr.disjoint) { if (!mayTouch) return rr; if (!fallback) fallback = rr; continue; }
        const back = rr.map(poly => poly.map(p => ({ x: p.x - dx, y: p.y - dy })));
        if (ok(back)) return back;
      }
    }
    return fallback;      // they really do just touch, or not meet at all
  }

  // ---------- arc refit ----------
  /* Walk the polygon and collapse runs of points that lie on a common circle
     back into arc segments. A run qualifies when every point is within `tol`
     of the circle through its first, middle and last point, and the turn
     direction never flips. */
  function circleThrough(a, b, c) {
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-12) return null;
    const ux = ((a.x * a.x + a.y * a.y) * (b.y - c.y) + (b.x * b.x + b.y * b.y) * (c.y - a.y) + (c.x * c.x + c.y * c.y) * (a.y - b.y)) / d;
    const uy = ((a.x * a.x + a.y * a.y) * (c.x - b.x) + (b.x * b.x + b.y * b.y) * (a.x - c.x) + (c.x * c.x + c.y * c.y) * (b.x - a.x)) / d;
    const ctr = P(ux, uy);
    return { c: ctr, r: Math.hypot(a.x - ux, a.y - uy) };
  }
  /* Arc from a to b passing through m. The negation matters: bulgeArc's
     positive bulge curves to the RIGHT of travel while this sagitta is
     positive to the LEFT, so without it the arc is mirrored about its chord.
     (refitLoop's orientation pass used to hide this by reversing the whole
     loop, which happened to land on the right shape.) */
  function arcThroughPts(a, b, m) {
    const chord = G.dist(a, b);
    const sag = G.cross(G.norm(G.sub(b, a)), G.sub(P(m.x, m.y), a));
    return G.bulgeArc(a, b, (-2 * sag) / chord);
  }
  function refit(poly, tol = 0.004, minRun = 5) {
    const n = poly.length;
    if (n < minRun + 1) return poly.map((p, i) => G.line(P(p.x, p.y), P(poly[(i + 1) % n].x, poly[(i + 1) % n].y)));
    const segs = [];
    let i = 0;
    while (i < n) {
      let best = null;
      // try to grow the longest circular run starting at i
      for (let len = n - 1; len >= minRun; len--) {
        if (i + len > n) continue;
        const a = poly[i], m = poly[i + (len >> 1)], b = poly[(i + len) % n];
        const cir = circleThrough(a, m, b);
        if (!cir || !isFinite(cir.r) || cir.r > 1e6 || cir.r < 1e-6) continue;
        let good = true;
        for (let k = 1; k < len; k++) {
          const p = poly[(i + k) % n];
          if (Math.abs(Math.hypot(p.x - cir.c.x, p.y - cir.c.y) - cir.r) > tol) { good = false; break; }
        }
        if (!good) continue;
        // consistent turn direction, and a real sweep (not a near-straight run)
        const cr = G.cross(G.sub(P(m.x, m.y), P(a.x, a.y)), G.sub(P(b.x, b.y), P(m.x, m.y)));
        if (Math.abs(cr) < 1e-12) continue;
        const chord = Math.hypot(b.x - a.x, b.y - a.y);
        if (chord < 1e-9) continue;
        const sag = Math.abs(G.cross(G.norm(G.sub(P(b.x, b.y), P(a.x, a.y))), G.sub(P(m.x, m.y), P(a.x, a.y))));
        if (sag < tol * 2) continue;          // too flat to be worth an arc
        best = { len, ccw: cr > 0, a, b };
        break;
      }
      if (best) {
        segs.push(arcThroughPts(P(best.a.x, best.a.y), P(best.b.x, best.b.y), poly[i + (best.len >> 1)]));
        i += best.len;
      } else {
        const a = poly[i], b = poly[(i + 1) % n];
        if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-9) segs.push(G.line(P(a.x, a.y), P(b.x, b.y)));
        i++;
      }
    }
    // stitch tiny gaps from rounding
    for (let k = 0; k < segs.length; k++) {
      const s = segs[k], nx = segs[(k + 1) % segs.length];
      if (!G.same(s.b, nx.a, 1e-9)) { if (nx.type === 'line') nx.a = s.b; else if (s.type === 'line') s.b = nx.a; }
    }
    return segs;
  }

  /* op: 'union' | 'subtract' | 'intersect'
     a, b : closed loops (arrays of segments)
     returns { loops: [loop...], note } or { error } */
  function operate(op, a, b, opts = {}) {
    const tol = opts.flatten || 0.0015;
    // only attempt arc refitting if there were arcs to begin with
    opts = { ...opts, hasArcs: a.some(s => s.type === 'arc') || b.some(s => s.type === 'arc') };
    let A = flatten(a, tol), B = flatten(b, tol);
    if (A.length < 3 || B.length < 3) return { error: 'One of the shapes has no area' };
    if (area(A) < 0) A.reverse();
    if (area(B) < 0) B.reverse();

    const cfg = { union: [false, false], intersect: [true, true], subtract: [false, true] }[op];
    if (!cfg) return { error: 'Unknown operation ' + op };
    if (op === 'subtract') B = B.slice().reverse();

    /* Bounds the result must satisfy. Greiner-Hormann can traverse into a
       plausible-looking but wrong outline near a degeneracy, and a wrong
       outline here gets cut into real material. */
    const aA = Math.abs(area(A)), aB = Math.abs(area(B));
    const slack = 1e-4 * Math.max(aA, aB) + 1e-6;
    const bA = bboxOf([A]), bB = bboxOf([B]);
    const reach = 1e-3 * Math.max(bA.x1 - bA.x0, bA.y1 - bA.y0, bB.x1 - bB.x0, bB.y1 - bB.y0) + 1e-6;
    /* Area bounds alone are too weak: when both inputs have the same area, a
       union that returns only ONE of them still satisfies them. So also require
       the result to REACH as far as it must - the union has to span both inputs,
       and the other operations cannot exceed their inputs. */
    const plausible = (polys) => {
      const got = polys.reduce((t, poly) => t + Math.abs(area(poly)), 0);
      const g = bboxOf(polys);
      if (op === 'union') {
        if (!(got >= Math.max(aA, aB) - slack && got <= aA + aB + slack)) return false;
        return g.x0 <= Math.min(bA.x0, bB.x0) + reach && g.x1 >= Math.max(bA.x1, bB.x1) - reach
            && g.y0 <= Math.min(bA.y0, bB.y0) + reach && g.y1 >= Math.max(bA.y1, bB.y1) - reach;
      }
      if (op === 'intersect') {
        if (!(got <= Math.min(aA, aB) + slack)) return false;
        return g.x0 >= Math.max(bA.x0, bB.x0) - reach && g.x1 <= Math.min(bA.x1, bB.x1) + reach
            && g.y0 >= Math.max(bA.y0, bB.y0) - reach && g.y1 <= Math.min(bA.y1, bB.y1) + reach;
      }
      if (!(got <= aA + slack)) return false;         // subtract
      return g.x0 >= bA.x0 - reach && g.x1 <= bA.x1 + reach && g.y0 >= bA.y0 - reach && g.y1 <= bA.y1 + reach;
    };

    // do the outlines come close enough to touch? then "disjoint" needs proving
    const mayTouch = !(bA.x1 < bB.x0 - reach || bB.x1 < bA.x0 - reach
                    || bA.y1 < bB.y0 - reach || bB.y1 < bA.y0 - reach);
    const res = clipRobust(A, B, cfg[0], cfg[1], plausible, mayTouch);
    if (res === null) return { error: 'Could not resolve these shapes (edges may exactly overlap). Nudge one slightly and retry.' };

    if (res.disjoint) {
      // no crossings: decide by containment
      const aInB = inside(A[0], B), bInA = inside(B[0], A);
      if (op === 'union') {
        if (aInB) return { loops: [refitLoop(B, opts)] };
        if (bInA) return { loops: [refitLoop(A, opts)] };
        return { loops: [refitLoop(A, opts), refitLoop(B, opts)], note: 'Shapes do not touch; kept both.' };
      }
      if (op === 'intersect') {
        if (aInB) return { loops: [refitLoop(A, opts)] };
        if (bInA) return { loops: [refitLoop(B, opts)] };
        return { error: 'Shapes do not overlap, so there is nothing in common.' };
      }
      // subtract
      if (bInA) return { loops: [refitLoop(A, opts)], hole: refitLoop(B.slice().reverse(), opts), note: 'Second shape is fully inside; kept it as a hole.' };
      if (aInB) return { error: 'The first shape is entirely inside the second; nothing would be left.' };
      return { loops: [refitLoop(A, opts)], note: 'Shapes do not overlap; nothing to subtract.' };
    }
    if (!res.length) return { error: 'The operation produced nothing.' };

    if (!plausible(res)) return { error: 'These shapes overlap in a way this tool could not resolve reliably (usually a shared edge or corner). Nudge one part slightly and try again.' };

    return { loops: res.map(p => refitLoop(p, opts)) };
  }
  const asLines = (poly) => poly.map((p, i) => G.line(P(p.x, p.y), P(poly[(i + 1) % poly.length].x, poly[(i + 1) % poly.length].y)));

  /* Turn a clipped polygon back into segments.
     Refitting arcs is an optimisation, never a requirement - so it is applied
     only when it is both wanted and provably harmless:
       - points closer than 1e-6 are merged first (clipping leaves near-
         duplicates at nudged corners, and three almost-coincident points
         define a wild circle),
       - it only runs when the ORIGINAL shapes actually contained arcs, so a
         boolean of two rectangles can never sprout a curve,
       - and the refitted outline's area is compared against the polygon's. If
         they disagree, the refit is discarded and plain lines are used.
     That last check is the real safety net: a wrong outline here gets cut into
     material, so "slower but right" beats "curvy but wrong" every time. */
  function refitLoop(poly, opts) {
    const o = opts || {};
    let pts = [];
    for (const p of poly) if (!pts.length || Math.hypot(p.x - pts[pts.length - 1].x, p.y - pts[pts.length - 1].y) > 1e-6) pts.push(p);
    if (pts.length > 2 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-6) pts.pop();
    if (pts.length < 3) pts = poly;

    const orient = (segs) => G.signedArea(segs) < 0 ? G.reverseLoop(segs) : segs;
    if (o.noRefit || !o.hasArcs) return orient(asLines(pts));

    const fitted = refit(pts, o.refitTol);
    const want = Math.abs(area(pts));
    const got = Math.abs(G.signedArea(fitted));
    // an arc bulges slightly outside its chord, so allow a small positive drift
    if (!isFinite(got) || Math.abs(got - want) > Math.max(0.002, want * 0.002)) return orient(asLines(pts));
    return orient(fitted);
  }

  return { operate, flatten, refit, refitLoop, area, inside, clipPolys: clipRobust };
})();
if (typeof module !== 'undefined') module.exports = BOOL;
