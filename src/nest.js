/* ===== nest.js — simple bottom-left rectangular nesting within bed limits ===== */
const NEST = (() => {
  const G = typeof GEOM !== 'undefined' ? GEOM : require('./geom.js');
  // items: [{id, w, h}] ; returns [{id, x, y, rotated}] placed from bottom-left, or null if it doesn't fit
  function nest(items, bedW, bedH, gap = 0.5, margin = 0.5, allowRotate = true) {
    const placed = []; // rects {x,y,w,h}
    const order = items.slice().sort((a, b) => (b.h * b.w) - (a.h * a.w));
    const overlaps = (r) => placed.some(p => !(r.x + r.w + gap <= p.x || p.x + p.w + gap <= r.x || r.y + r.h + gap <= p.y || p.y + p.h + gap <= r.y));
    const fits = (r) => r.x >= margin - 1e-9 && r.y >= margin - 1e-9 && r.x + r.w <= bedW - margin + 1e-9 && r.y + r.h <= bedH - margin + 1e-9;
    const result = [];
    for (const it of order) {
      // candidate positions: margin corner + right of / above each placed rect
      const cands = [{ x: margin, y: margin }];
      for (const p of placed) { cands.push({ x: p.x + p.w + gap, y: p.y }); cands.push({ x: p.x, y: p.y + p.h + gap }); cands.push({ x: margin, y: p.y + p.h + gap }); cands.push({ x: p.x + p.w + gap, y: margin }); }
      cands.sort((a, b) => (a.y - b.y) || (a.x - b.x));
      let best = null;
      const tryDims = allowRotate && Math.abs(it.w - it.h) > 1e-9 ? [[it.w, it.h, false], [it.h, it.w, true]] : [[it.w, it.h, false]];
      outer: for (const c of cands) {
        for (const [w, h, rot] of tryDims) {
          const r = { x: c.x, y: c.y, w, h };
          if (fits(r) && !overlaps(r)) { best = { ...r, rotated: rot }; break outer; }
        }
      }
      if (!best) { result.push({ id: it.id, fail: true }); continue; }
      placed.push(best); result.push({ id: it.id, x: best.x, y: best.y, rotated: best.rotated });
    }
    return result;
  }
  return { nest };
})();
if (typeof module !== 'undefined') module.exports = NEST;
