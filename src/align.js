/* ===== align.js — smart guides (edge / centre alignment, equal spacing) =====
   What PowerPoint and Canva show while a picture is dragged: a line when an
   edge or centre lines up with another part, and matching gap markers when the
   spacing equals a neighbour's. Holes in a row that look in line and are 0.01
   off are exactly what a drawing hides and the sheet shows, so the same check
   is offered on a part that is only selected, with no snapping at all.
   Pure geometry on bounding boxes: nothing here touches a part or a toolpath. */
const ALIGN = (() => {
  const keys = (b, ax) => ax === 'x' ? [b.x0, (b.x0 + b.x1) / 2, b.x1] : [b.y0, (b.y0 + b.y1) / 2, b.y1];
  const shift = (b, dx, dy) => ({ x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy });
  // past this many parts in one row the gap search is skipped, so a huge DXF never stalls a drag
  const ROW_CAP = 300;

  /* The parts that share a row with m (a column, for the y axis): they overlap
     it across the axis. A plate the part sits inside overlaps it ALONG the axis
     too, and is never its neighbour, so only parts wholly to one side count. */
  function lane(m, others, ax, eps) {
    const [a0, a1] = ax === 'x' ? ['y0', 'y1'] : ['x0', 'x1'];
    return others.filter(o => o[a0] < m[a1] - eps && o[a1] > m[a0] + eps);
  }
  function sides(m, row, ax, eps) {
    const [lo, hi] = ax === 'x' ? ['x0', 'x1'] : ['y0', 'y1'];
    let L = null, R = null;
    for (const o of row) {
      if (o[hi] <= m[lo] + eps && (!L || o[hi] > L[hi])) L = o;
      if (o[lo] >= m[hi] - eps && (!R || o[lo] < R[lo])) R = o;
    }
    return { L, R };
  }
  // each part's gap to its nearest neighbour on the far side, within the row
  function rowGaps(row, ax, eps) {
    const [lo, hi] = ax === 'x' ? ['x0', 'x1'] : ['y0', 'y1'];
    if (row.length > ROW_CAP) return [];
    const out = [];
    for (const a of row) {
      let b = null;
      for (const o of row) if (o !== a && o[lo] >= a[hi] - eps && (!b || o[lo] < b[lo])) b = o;
      if (b) out.push({ a, b, g: b[lo] - a[hi] });
    }
    return out;
  }

  /* The smallest move along one axis that lines m up with something: an edge or
     centre on another part's edge or centre, or a gap equal to one already in
     the row (or centred between its two neighbours). null when nothing is in
     reach. */
  function bestShift(m, others, ax, tol, eps) {
    let best = null;
    const take = (d) => { if (Math.abs(d) <= tol && (best === null || Math.abs(d) < Math.abs(best))) best = d; };
    const mk = keys(m, ax);
    for (const o of others) for (const k of keys(o, ax)) for (const v of mk) take(k - v);
    const [lo, hi] = ax === 'x' ? ['x0', 'x1'] : ['y0', 'y1'];
    const row = lane(m, others, ax, eps);
    const { L, R } = sides(m, row, ax, tol);
    if (L && R) take(((R[lo] - m[hi]) - (m[lo] - L[hi])) / 2);
    for (const { g } of rowGaps(row, ax, eps)) {
      if (L) take(L[hi] + g - m[lo]);
      if (R) take(R[lo] - g - m[hi]);
    }
    return best;
  }

  /* Guides to draw for m where it now sits: one line per coordinate shared
     exactly, running across every part on it, and the gaps in m's row and
     column that equal one of m's own. */
  function show(m, others, eps) {
    const lines = [], gaps = [];
    for (const ax of ['x', 'y']) {
      const mk = keys(m, ax);
      const [c0, c1] = ax === 'x' ? ['y0', 'y1'] : ['x0', 'x1'];
      for (let i = 0; i < 3; i++) {
        const at = mk[i];
        const hits = others.filter(o => keys(o, ax).some(k => Math.abs(k - at) <= eps));
        if (!hits.length) continue;
        let from = m[c0], to = m[c1];
        for (const o of hits) { from = Math.min(from, o[c0]); to = Math.max(to, o[c1]); }
        lines.push({ axis: ax, at, from, to, kind: i === 1 ? 'centre' : 'edge' });
      }
      const [lo, hi] = ax === 'x' ? ['x0', 'x1'] : ['y0', 'y1'];
      const row = lane(m, others, ax, eps);
      const { L, R } = sides(m, row, ax, eps);
      const mine = [];
      if (L) mine.push({ a: L, b: m, g: m[lo] - L[hi] });
      if (R) mine.push({ a: m, b: R, g: R[lo] - m[hi] });
      const theirs = rowGaps(row, ax, eps);
      for (const own of mine) {
        if (own.g <= eps) continue;
        const same = theirs.filter(t => Math.abs(t.g - own.g) <= eps).concat(mine.filter(t => t !== own && Math.abs(t.g - own.g) <= eps));
        if (!same.length) continue;
        for (const t of [own, ...same]) if (!gaps.some(q => q.axis === ax && q.a === t.a && q.b === t.b)) gaps.push({ axis: ax, a: t.a, b: t.b, g: t.g });
      }
    }
    return { lines, gaps };
  }

  /* m: the box being moved (or checked); others: every other part's box.
     tol: how far a drag may be pulled onto a guide (0 = show only, no pull).
     eps: what counts as exactly in line. Returns the pull and what to draw. */
  function guides(m, others, tol, eps = 1e-4) {
    const dx = tol > 0 ? bestShift(m, others, 'x', tol, eps) : null;
    const dy = tol > 0 ? bestShift(m, others, 'y', tol, eps) : null;
    const at = shift(m, dx || 0, dy || 0);
    return { dx: dx || 0, dy: dy || 0, ...show(at, others, eps) };
  }

  return { guides };
})();
if (typeof module !== 'undefined') module.exports = ALIGN;
