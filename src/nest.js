/* ===== nest.js — true-shape nesting =====

   The old nester packed bounding boxes. An L-bracket fills only 56% of its
   box and a disc 79%, so every box reserved sheet that another part could
   have used. This one works on the real outline.

   Each part is rasterised into a bitmap at a fixed resolution and placed
   bottom-left-first on a bitmap of the bed. That handles concave parts nesting
   into each other's notches, discs tucking into corners, and — because a
   part's holes are left unfilled — small parts nesting inside the waste of big
   ones, all of which bounding boxes make impossible.

   Clearance between parts is a dilation of the occupancy mask, so the gap is
   measured between the true outlines rather than their boxes. Parts are placed
   at whole cells; the resolution is therefore the placement granularity, not
   the accuracy of the parts themselves, which are never modified. */
const NEST = (() => {
  const G = typeof GEOM !== 'undefined' ? GEOM : require('./geom.js');

  /* ---------- rasterising ----------
     Even-odd scanline fill over every loop of a unit at once: outer boundaries
     fill, holes punch back out. That is what lets another part sit inside a
     hole. */
  function rasterize(loops, res, rotDeg) {
    const rad = (rotDeg || 0) * Math.PI / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    const polys = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const loop of loops) {
      if (!loop || !loop.length) continue;
      const pts = G.loopPts(loop, Math.max(res / 2, 1e-4)).map(p => {
        const x = p.x * c - p.y * s, y = p.x * s + p.y * c;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        return { x, y };
      });
      if (pts.length > 2) polys.push(pts);
    }
    if (!polys.length) return null;

    const w = Math.max(1, Math.ceil((x1 - x0) / res));
    const h = Math.max(1, Math.ceil((y1 - y0) / res));
    const data = new Uint8Array(w * h);
    const xs = [];
    for (let r = 0; r < h; r++) {
      const yc = y0 + (r + 0.5) * res;
      xs.length = 0;
      for (const pts of polys) {
        for (let i = 0, n = pts.length; i < n; i++) {
          const a = pts[i], b = pts[(i + 1) % n];
          if ((a.y > yc) === (b.y > yc)) continue;
          xs.push(a.x + (yc - a.y) * (b.x - a.x) / (b.y - a.y));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        let ca = Math.floor((xs[k] - x0) / res);
        let cb = Math.ceil((xs[k + 1] - x0) / res);
        if (cb <= ca) cb = ca + 1;                       // never lose a sliver
        if (ca < 0) ca = 0; if (cb > w) cb = w;
        data.fill(1, r * w + ca, r * w + cb);
      }
    }
    return { w, h, data, x0, y0, res, rot: rotDeg || 0 };
  }

  /* Grow a mask by k cells. Separable (rows then columns) so the cost is
     O(cells * 1) per pass instead of O(cells * k^2). The kernel is square, so
     diagonal clearance comes out slightly larger than asked - erring towards
     more gap, never less. */
  function dilate(m, k) {
    if (k <= 0) return m;
    const w = m.w + 2 * k, h = m.h + 2 * k;
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let r = 0; r < m.h; r++) {
      for (let x = 0; x < m.w; x++) {
        if (m.data[r * m.w + x]) tmp[(r + k) * w + (x + k)] = 1;
      }
    }
    for (let r = 0; r < h; r++) {                         // horizontal
      let run = 0;
      const base = r * w;
      for (let x = 0; x < w; x++) {
        if (tmp[base + x]) run = k + 1; else if (run > 0) run--;
        if (run > 0) out[base + x] = 1;
      }
      run = 0;
      for (let x = w - 1; x >= 0; x--) {
        if (tmp[base + x]) run = k + 1; else if (run > 0) run--;
        if (run > 0) out[base + x] = 1;
      }
    }
    const fin = new Uint8Array(w * h);
    for (let x = 0; x < w; x++) {                         // vertical
      let run = 0;
      for (let r = 0; r < h; r++) {
        if (out[r * w + x]) run = k + 1; else if (run > 0) run--;
        if (run > 0) fin[r * w + x] = 1;
      }
      run = 0;
      for (let r = h - 1; r >= 0; r--) {
        if (out[r * w + x]) run = k + 1; else if (run > 0) run--;
        if (run > 0) fin[r * w + x] = 1;
      }
    }
    return { w, h, data: fin, x0: m.x0 - k * m.res, y0: m.y0 - k * m.res, res: m.res, rot: m.rot };
  }

  // occupied spans per row: a fit test only has to walk real material
  function runsOf(m) {
    const rows = [];
    for (let r = 0; r < m.h; r++) {
      const base = r * m.w;
      let x = 0;
      const runs = [];
      while (x < m.w) {
        while (x < m.w && !m.data[base + x]) x++;
        if (x >= m.w) break;
        const s = x;
        while (x < m.w && m.data[base + x]) x++;
        runs.push(s, x);
      }
      rows.push(runs);
    }
    return rows;
  }

  /* ---------- placing ----------
     units: [{ id, loops:[loop], clearance, rotations:[deg] }]
       loops   - every boundary of the unit in world space, holes included
       clearance - inches to keep clear of other parts (tool diameter + gap)
     Returns { placed:[{id, rot, x, y}], failed:[id], used, ... } where x,y is
     where the unit's rotated bounding box should land. */
  function nestParts(units, opts = {}) {
    const t0 = Date.now();
    const bedW = opts.bedW, bedH = opts.bedH;
    const margin = opts.margin || 0;
    const res = opts.resolution || pickResolution(units, bedW, bedH);
    const gw = Math.floor(bedW / res), gh = Math.floor(bedH / res);
    const bed = new Uint8Array(gw * gh);

    // the margin is simply sheet that is already spoken for
    const mc = Math.round(margin / res);
    if (mc > 0) {
      for (let r = 0; r < gh; r++) {
        for (let x = 0; x < gw; x++) {
          if (r < mc || r >= gh - mc || x < mc || x >= gw - mc) bed[r * gw + x] = 1;
        }
      }
    }

    // biggest first: the classic ordering, and the one that leaves usable gaps
    const order = units.map((u, i) => ({ u, i, area: unitArea(u) }))
      .sort((a, b) => (b.area - a.area) || (a.i - b.i));

    const placed = [], failed = [];
    let usedCells = 0;

    for (const { u } of order) {
      const rots = (u.rotations && u.rotations.length) ? u.rotations : [0];
      const k = Math.max(0, Math.round((u.clearance || 0) / res));
      let best = null;

      const seen = [];
      for (const rot of rots) {
        const raw = rasterize(u.loops, res, rot);
        if (!raw) continue;
        if (raw.w > gw || raw.h > gh) continue;
        /* A rectangle looks the same at 0 and 180, a square at every quarter
           turn. Rasterising is cheap but SEARCHING is not, so drop rotations
           that produce a mask we have already tried. */
        const sig = signature(raw);
        if (seen.includes(sig)) continue;
        seen.push(sig);

        /* Search with the DILATED mask, not the bare one. Testing the bare
           outline against a neighbour's dilated footprint would only honour one
           side's clearance, so two parts ended up half the intended gap apart.
           Searching dilated-against-dilated gives each part its own standoff and
           the gap between outlines becomes the sum, which is what "tool radius
           plus half the gap, each" is meant to add up to. */
        const occ = dilate(raw, k);
        const rows = runsOf(occ);
        const offX = k, offY = k;                         // where the outline sits inside it

        /* Two passes over x. A coarse sweep finds roughly where the part wants
           to sit, then a fine sweep either side of it settles the exact column.
           Scanning every column outright costs eight times as much and lands in
           the same place, because a part that fits at column x almost always
           fits within a few columns of it. */
        if (occ.w > gw || occ.h > gh) continue;
        const step = Math.max(1, Math.round(occ.w / 8));
        const lowest = (x) => {
          const yCap = best ? best.y : gh - occ.h;        // only a lower y can win
          for (let y = 0; y <= yCap && y + occ.h <= gh; y++) {
            if (fits(bed, gw, rows, occ.w, x, y)) return y;
          }
          return -1;
        };
        const consider = (x, y) => {
          if (y < 0) return;
          if (!best || y < best.y || (y === best.y && x < best.x)) best = { x, y, rot, raw, occ, rows, offX, offY };
        };

        let coarseX = -1, coarseY = Infinity;
        for (let x = 0; x + occ.w <= gw; x += step) {
          const y = lowest(x);
          if (y >= 0 && y < coarseY) { coarseY = y; coarseX = x; }
          consider(x, y);
        }
        if (coarseX >= 0 && step > 1) {
          const lo = Math.max(0, coarseX - step), hi = Math.min(gw - occ.w, coarseX + step);
          for (let x = lo; x <= hi; x++) consider(x, lowest(x));
        }
      }

      if (!best) { failed.push(u.id); continue; }

      stamp(bed, gw, gh, best.occ, best.x, best.y);
      usedCells += countCells(best.raw);
      /* Where the part's own outline should END UP, in bed coordinates. This is
         a position on the sheet, not a delta: it must not carry any trace of
         where the part happened to be drawn, or every part lands offset by its
         old position. The caller moves the rotated bounding box's lower-left
         corner here. */
      placed.push({
        id: u.id, rot: best.rot,
        x: (best.x + best.offX) * res,
        y: (best.y + best.offY) * res,
      });
    }

    const usable = Math.max(1e-9, (bedW - 2 * margin) * (bedH - 2 * margin));
    return {
      placed, failed,
      resolution: res,
      used: usedCells * res * res / usable,
      ms: Date.now() - t0,
    };
  }

  function fits(bed, gw, rows, mw, x, y) {
    for (let r = 0; r < rows.length; r++) {
      const runs = rows[r];
      if (!runs.length) continue;
      const base = (y + r) * gw + x;
      for (let i = 0; i < runs.length; i += 2) {
        for (let c = runs[i]; c < runs[i + 1]; c++) if (bed[base + c]) return false;
      }
    }
    return true;
  }

  function stamp(bed, gw, gh, m, x, y) {
    for (let r = 0; r < m.h; r++) {
      const yy = y + r;
      if (yy < 0 || yy >= gh) continue;
      const base = yy * gw, mb = r * m.w;
      for (let c = 0; c < m.w; c++) {
        const xx = x + c;
        if (xx < 0 || xx >= gw) continue;
        if (m.data[mb + c]) bed[base + xx] = 1;
      }
    }
  }

  // enough to tell two rasterised rotations apart without comparing every cell
  function signature(m) {
    let n = 0, h = 0;
    for (let i = 0; i < m.data.length; i++) if (m.data[i]) { n++; h = (h * 31 + i) | 0; }
    return m.w + 'x' + m.h + ':' + n + ':' + h;
  }

  function countCells(m) { let n = 0; for (let i = 0; i < m.data.length; i++) if (m.data[i]) n++; return n; }

  function unitArea(u) {
    let a = 0;
    for (const loop of u.loops) { try { a += G.signedArea(loop); } catch (e) { } }
    return Math.abs(a);
  }

  /* Fine enough that the smallest part still has shape, coarse enough that a
     full sheet does not take all day. Placement lands on this grid, so it is
     also the packing granularity. */
  function pickResolution(units, bedW, bedH) {
    let smallest = Infinity;
    for (const u of units) {
      for (const loop of u.loops) {
        try { const b = G.bbox(loop); smallest = Math.min(smallest, Math.max(b.w, b.h)); } catch (e) { }
      }
    }
    if (!isFinite(smallest)) smallest = 1;
    const byPart = smallest / 6;
    const byBed = Math.max(bedW, bedH) / 1400;             // keep the grid sane
    return Math.min(0.25, Math.max(0.02, byBed, Math.min(byPart, 0.1)));
  }

  /* ---------- legacy rectangular packer ----------
     Kept because it is exact for genuinely rectangular jobs and needs no
     rasterising. nestParts supersedes it for everything else. */
  function nest(items, bedW, bedH, gap = 0.5, margin = 0.5, allowRotate = true) {
    const placed = [];
    const order = items.slice().sort((a, b) => (b.h * b.w) - (a.h * a.w));
    const overlaps = (r) => placed.some(p => !(r.x + r.w + gap <= p.x || p.x + p.w + gap <= r.x || r.y + r.h + gap <= p.y || p.y + p.h + gap <= r.y));
    const fitsBed = (r) => r.x >= margin - 1e-9 && r.y >= margin - 1e-9 && r.x + r.w <= bedW - margin + 1e-9 && r.y + r.h <= bedH - margin + 1e-9;
    const result = [];
    for (const it of order) {
      const cands = [{ x: margin, y: margin }];
      for (const p of placed) { cands.push({ x: p.x + p.w + gap, y: p.y }); cands.push({ x: p.x, y: p.y + p.h + gap }); cands.push({ x: margin, y: p.y + p.h + gap }); cands.push({ x: p.x + p.w + gap, y: margin }); }
      cands.sort((a, b) => (a.y - b.y) || (a.x - b.x));
      let best = null;
      const tryDims = allowRotate && Math.abs(it.w - it.h) > 1e-9 ? [[it.w, it.h, false], [it.h, it.w, true]] : [[it.w, it.h, false]];
      outer: for (const c of cands) {
        for (const [w, h, rot] of tryDims) {
          const r = { x: c.x, y: c.y, w, h };
          if (fitsBed(r) && !overlaps(r)) { best = { ...r, rotated: rot }; break outer; }
        }
      }
      if (!best) { result.push({ id: it.id, fail: true }); continue; }
      placed.push(best); result.push({ id: it.id, x: best.x, y: best.y, rotated: best.rotated });
    }
    return result;
  }

  return { nestParts, nest, rasterize, dilate, runsOf, pickResolution };
})();
if (typeof module !== 'undefined') module.exports = NEST;
