/* ===== post.js — toolpath generation + WinCNC TAP post-processor ===== */
const POST = (() => {
  const G = typeof GEOM !== 'undefined' ? GEOM : require('./geom.js');

  /* Machine definition. Defaults reproduce the original sample TAP
     (Sides_manav.tap) exactly; ENROUTE_CURRENT below matches the machine's
     present EnRoute configuration, taken from real production output and the
     driver screenshots. */
  const DEFAULT_MACHINE = {
    name: 'WinCNC 5x10',
    bedW: 60, bedH: 120, units: 'in', // X = 60" (5 ft), Y = 120" (10 ft) — matches G53 X0 Y120 park in sample
    safeZ: 1.1875,
    zLift: null,          // if set, safe Z = material thickness + this ("Z Lift" in the driver)
    leadIn: 0,            // ramp-on length in inches; 0 = plunge straight down
    creationDate: false,  // emit "[Creation Date: ...]" as the first line
    spindleInToolChange: false, // S inside the tool block, vs at the first plunge
    header: 'G90\nG53\nM61\n',
    toolChange: '\n[{toolName}]\nM5\nT{slot}\nM3\n\n',
    footer: 'M5\nG53\nM62\nG53 X0 Y120\n',
    lineEnding: '\r\n',
    decimals: 4,
    plungeFeedOnFirstOnly: true, // sample: F on first plunge only
  };

  /* The machine's current EnRoute setup, matched line-for-line against three
     production jobs (17K_* .tap) and the Wincnc15 driver dialogs:
       Z Lift 0.1 in, arc tolerance 0.0004 in, resolution 1000 steps/in,
       feed default 300 (max 1200), plunge default 50 (max 400), arcs enabled,
       drill cycles disabled.
     The 1 in ramp is measured from those files - every lead-in in all three is
     exactly 1.000 in, run backwards along the toolpath. */
  const ENROUTE_CURRENT = {
    ...DEFAULT_MACHINE,
    name: 'WinCNC 5x10 (EnRoute current)',
    zLift: 0.1,
    leadIn: 1.0,
    creationDate: true,
    spindleInToolChange: true,
    header: 'G90\nG53\nM61\nM5\n',
    toolChange: '\n[{toolName}]\nT{slot}\nS{rpm}\nM3\n\n',
  };
  /* The actual turret, from the Tool Changer Definition dialog: 8 positions,
     6 and 8 empty. Feeds/speeds for slot 2 are taken from the production
     files (S17000, F217 cut, F20 plunge). */
  const DEFAULT_TOOLS = [
    { id: 1, slot: 1, name: '3/8" Upspiral', dia: 0.375, rpm: 17000, feed: 217, plunge: 20, passDepth: 0.125, type: 'endmill' },
    { id: 2, slot: 2, name: '1/4" Upspiral', dia: 0.25, rpm: 17000, feed: 217, plunge: 20, passDepth: 0.125, type: 'endmill' },
    { id: 3, slot: 3, name: '1/2" Straight', dia: 0.5, rpm: 17000, feed: 250, plunge: 25, passDepth: 0.1875, type: 'endmill' },
    { id: 4, slot: 4, name: '3/16" straight', dia: 0.1875, rpm: 17000, feed: 150, plunge: 20, passDepth: 0.0625, type: 'endmill' },
    { id: 5, slot: 5, name: '1/8" straight cutter', dia: 0.125, rpm: 17000, feed: 120, plunge: 15, passDepth: 0.0625, type: 'endmill' },
    { id: 7, slot: 7, name: '1/16" Straight Cutter', dia: 0.0625, rpm: 17000, feed: 80, plunge: 12, passDepth: 0.03125, type: 'endmill' },
  ];
  const DEFAULT_MATERIALS = [
    { name: '3/16" Acrylic', thickness: 0.1875 },
    { name: '1/4" Acrylic', thickness: 0.25 },
    { name: '1/8" Acrylic', thickness: 0.125 },
    { name: '1/2" HDPE', thickness: 0.5 },
    { name: '3/4" HDPE', thickness: 0.75 },
  ];

  // "9/2/2026 - 10:48:38 AM" - no zero padding on the date, 12-hour clock
  function formatStamp(d) {
    let h = d.getHours();
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} - ${p2(h)}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${ap}`;
  }

  // number format: 4 decimals, strip trailing zeros, keep trailing "." (WinCNC/EnRoute style: 0. / 6.125)
  function fmt(n, dec = 4) {
    let s = (Math.abs(n) < 1e-9 ? 0 : n).toFixed(dec);
    if (s.indexOf('.') >= 0) { s = s.replace(/0+$/, ''); }
    if (s === '-0.') s = '0.';
    return s;
  }
  function rnd(n, dec = 4) { return parseFloat(n.toFixed(dec)); }

  // compute pass depths (Z values, Z0 = bed). Returns array from first cut to last.
  function passDepths(thickness, passDepth, cutThrough = 0) {
    const out = []; const bottom = -cutThrough; let z = thickness - passDepth;
    if (passDepth <= 0) return [bottom];
    while (z > bottom + 1e-6) { out.push(z); z -= passDepth; }
    out.push(bottom);
    return out;
  }

  /* Does this offset toolpath cross itself? An inward offset of a concave
     outline past its local width folds the path over, and the fold cuts
     straight through material that should have been left. Bounded to small
     paths: the check is O(n^2) and the shapes it protects (holes, slots,
     pockets, brackets) have few segments, while a traced outline with hundreds
     is both expensive and unlikely to be offset that far. */
  /* snap.js owns the exact line/line, line/arc and arc/arc intersection maths.
     It is concatenated AFTER this file in the bundle, so it is looked up when
     called rather than when loaded. */
  const snapMod = () => (typeof SNAP !== 'undefined' ? SNAP : require('./snap.js'));

  function selfIntersects(path, limit = 48) {
    const n = path.length;
    if (n < 4 || n > limit) return false;
    const SN = snapMod();
    /* This used to sample each segment into a polyline and skip any pair whose
       determinant was near zero. On an offset path the pieces are often
       parallel - a comb, a slot, anything with repeated sides - and that skip
       threw away exactly the pairs that fold over. Measured on a comb with legs
       0.4 in apart cut with a 0.5 in tool: crossings between sides 0-3, 3-6 and
       4-7, and this returned false. Exact intersection instead, with only the
       joints where neighbours legitimately meet excluded. */
    const closed = G.dist(path[n - 1].b, path[0].a) < 1e-6;
    const ends = (sg) => [sg.a, sg.b];
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (closed && i === 0 && j === n - 1) continue;      // ends meet by design
        let hits;
        try { hits = SN.segSegPoints(path[i], path[j]); } catch (e) { continue; }
        for (const q of hits) {
          /* A point that ends BOTH segments is the outline meeting itself - the
             seam of a closed loop, say - and is no fold. A point that ends only
             ONE of them is a T: that segment's end has landed partway along
             another, which is exactly what a fold looks like once the joints
             have been mitred. Measured on a comb with legs 0.4 in apart cut
             with a 0.5 in tool, all three folds present that way (sides 0-3,
             3-6, 4-7), so excluding a point at EITHER endpoint hid every one of
             them. It has to be both. */
          const onI = ends(path[i]).some(e => G.dist(q, e) < 1e-6);
          const onJ = ends(path[j]).some(e => G.dist(q, e) < 1e-6);
          if (!(onI && onJ)) return true;
        }
      }
    }
    return false;
  }

  // ---- toolpath from a shape
  /* shape: {loop:[segs], open?:bool, op:'outside'|'inside'|'on', tool, startHint?}
     opts.onIssue(msg) is called when a shape cannot be cut as asked. Returning
     an empty path silently is the dangerous outcome: the operator runs the job
     and finds a missing hole, or a slot cut to the wrong width, only after the
     material is gone. */
  /* Which way an open path runs must not depend on which way it was drawn:
     left has to stay left. So the path is turned to run a fixed way - left to
     right, and bottom to top when it is vertical - before a side is taken. */
  function canonicalOpen(loop) {
    const a = loop[0].a, b = loop[loop.length - 1].b;
    const dx = b.x - a.x, dy = b.y - a.y;
    const backwards = Math.abs(dx) > 1e-9 ? dx < 0 : dy < 0;
    return backwards ? G.reverseLoop(loop) : loop;
  }

  function buildToolpathLoop(shape, tool, opts = {}) {
    const issue = (msg) => { if (opts.onIssue) opts.onIssue(msg); return []; };
    let loop = shape.loop;
    /* An open path has no inside, so 'left' and 'right' name the side instead.
        Cutting ON the line takes half a cutter off each side of it, which is
        how an inner dimension ends up a tool radius out. Naming the side makes
        the drawn line the finished edge. */
    if (shape.open) {
      const side = shape.op === 'left' ? -1 : shape.op === 'right' ? 1 : 0;
      if (!side) return loop;                      // 'on': engrave down the line
      const rr = tool.dia / 2;
      const src = canonicalOpen(loop);
      const path = G.offsetOpen(src, side * rr);
      /* An empty offset means the path could not be taken to one side at all -
         an arc tighter than the cutter radius turns inside out. Falling through
         to the unoffset line would cut down the middle of it and leave the edge
         a radius out, silently, which is the whole failure this option exists
         to prevent. */
      if (!path.length) {
        return issue(`cannot be cut to one side with a ${tool.dia}" tool - a curve on it is tighter than the cutter radius`);
      }
      if (selfIntersects(path)) {
        return issue(`folds over when offset for a ${tool.dia}" tool - part of it is narrower than the cutter`);
      }
      return path;
    }
    if (G.signedArea(loop) < 0) loop = G.reverseLoop(loop);
    const r = tool.dia / 2;

    /* An inside cut removes material from within the outline, so the feature
       has to be wider than the cutter in BOTH directions. A 0.20 slot asked of
       a 0.25 cutter used to emit a path anyway - a collapsed sliver that would
       cut the slot to the tool's width instead of the drawing's. */
    if (shape.op === 'inside') {
      const b = G.bbox(loop);
      if (b.w <= tool.dia + 1e-9 || b.h <= tool.dia + 1e-9) {
        return issue(`is ${fmt(b.w, 4)} x ${fmt(b.h, 4)} in, too small to cut inside with a ${tool.dia}" tool`);
      }
    }

    let path;
    if (shape.op === 'inside') path = G.offsetLoop(loop, -r);
    else if (shape.op === 'outside') path = G.offsetLoop(loop, r);
    else path = loop.map(s => ({ ...s }));
    if (!path.length) return issue(`is too small for a ${tool.dia}" tool at this cut setting`);

    if (shape.op !== 'on') {
      // an offset that turns the outline inside out would cut in the wrong place
      if (G.signedArea(path) * G.signedArea(loop) <= 0) {
        return issue(`turns inside out when offset for a ${tool.dia}" tool - the feature is narrower than the cutter`);
      }
      if (selfIntersects(path)) {
        return issue(`folds over on itself when offset for a ${tool.dia}" tool - a narrow part of it is smaller than the cutter`);
      }
    }
    // direction: default CCW for outside (matches EnRoute sample), CW (climb) for inside
    const wantCCW = shape.op === 'inside' ? !!opts.climb : !opts.climb;
    // outside default: CCW (conventional). climb flips.
    const isCCW = G.signedArea(path) > 0;
    if (isCCW !== wantCCW) path = G.reverseLoop(path);
    // start point
    let start = shape.startHint;
    if (!start) { const s = path[G.longestLineIndex(path)]; start = G.midOfSeg(s); }
    path = G.startLoopAt(path, start);
    return G.splitArcs(path, 90);
  }

  /* Walk backwards along a closed toolpath from its start point and return the
     sub-segments covering the last `len` inches, in forward order, ending at
     the start. The tool ramps down along these instead of plunging straight in
     - which is what EnRoute does, and what keeps a downcut bit from burying
     itself in acrylic. Returns null when there is no room to ramp. */
  function leadInSegs(path, len) {
    if (!path.length || len <= 0) return null;
    const total = path.reduce((a, sg) => a + G.segLen(sg), 0);
    if (total <= len * 1.05) return null;         // path too short to ramp on
    let remaining = len;
    const out = [];
    for (let k = path.length - 1; k >= 0 && remaining > 1e-9; k--) {
      const sg = path[k];
      const L = G.segLen(sg);
      if (L <= 1e-12) continue;
      if (L <= remaining + 1e-12) { out.unshift(sg); remaining -= L; }
      else {
        const t = 1 - remaining / L;              // split this segment
        out.unshift(subSegment(sg, t, 1));
        remaining = 0;
      }
    }
    return out.length ? out : null;
  }
  function subSegment(sg, u0, u1) {
    if (sg.type === 'line') return G.line(G.pointAt(sg, u0), G.pointAt(sg, u1));
    return G.arc(G.pointAt(sg, u0), G.pointAt(sg, u1), sg.c, sg.ccw);
  }

  // order shapes nearest-neighbour by start point
  function orderPaths(paths) {
    const rem = paths.slice(); const out = []; let cur = { x: 0, y: 0 };
    while (rem.length) {
      let bi = 0, bd = Infinity;
      rem.forEach((p, i) => { const d = G.dist(p.path[0].a, cur); if (d < bd) { bd = d; bi = i; } });
      const p = rem.splice(bi, 1)[0]; out.push(p); const last = p.path[p.path.length - 1]; cur = last.b;
    }
    return out;
  }

  // ---- generate G-code
  // job: {shapes:[{loop, op, toolId, open}], tools, material:{thickness}, machine, cutThrough}
  function generate(job) {
    const m = { ...DEFAULT_MACHINE, ...(job.machine || {}) };
    const dec = m.decimals;
    const L = [];
    const emit = (s) => L.push(s);
    const tpl = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] !== undefined ? vars[k] : '');
    const pushBlock = (s) => { s.replace(/\r\n/g, '\n').split('\n').forEach((ln, i, arr) => { if (i === arr.length - 1 && ln === '') return; emit(ln); }); };

    /* "[Creation Date: 9/2/2026 - 10:48:38 AM]" - EnRoute stamps this as the
       first line. WinCNC treats a bracketed line as a comment. */
    if (m.creationDate) emit('[Creation Date: ' + formatStamp(job.now || new Date()) + ']');
    /* Safe Z. The driver's "Z Lift" is a height ABOVE the material, not an
       absolute Z, so it has to track material thickness: 0.375 stock gives
       0.475, 0.25 stock gives 0.35. An absolute safeZ is kept for machines
       configured the older way. */
    const safeZ = m.zLift != null ? (job.material.thickness + m.zLift) : m.safeZ;
    const matTop = job.material.thickness;

    pushBlock(m.header);
    // group by tool in slot order of first use (or explicit order)
    const byTool = new Map();
    for (const sh of job.shapes) { if (!byTool.has(sh.toolId)) byTool.set(sh.toolId, []); byTool.get(sh.toolId).push(sh); }
    const stats = { length: 0, rapid: 0, timeMin: 0, passes: 0, tools: [], issues: [] };

    /* Depth sanity. These do not change what is cut - the operator may mean it -
       but they must not pass unremarked. */
    if (job.cutThrough > job.material.thickness) {
      stats.issues.push(`Cut-through ${fmt(job.cutThrough, 4)} in is deeper than the ${fmt(job.material.thickness, 4)} in material - the tool will go ${fmt(job.cutThrough - job.material.thickness, 4)} in into the bed`);
    }
    let pos = { x: null, y: null, z: null };
    for (const [toolId, shapes] of byTool) {
      const tool = job.tools.find(t => t.id === toolId) || job.tools[0];
      stats.tools.push(tool.name);
      pushBlock(tpl(m.toolChange, { toolName: tool.name, slot: String(tool.slot).padStart(2, '0'), rpm: tool.rpm }));
      pos = { x: null, y: null, z: pos.z };
      // toolpaths
      if (!(tool.passDepth > 0)) {
        stats.issues.push(`Tool "${tool.name}" has a pass depth of ${tool.passDepth} - everything on it will be cut in one full-depth pass`);
      }
      let paths = shapes.map(sh => ({
        shape: sh,
        path: buildToolpathLoop(sh, tool, {
          climb: sh.climb,
          onIssue: (msg) => stats.issues.push(`"${sh.name || 'a part'}" ${msg} - it will not be cut`),
        }),
      })).filter(p => p.path.length);
      paths = orderPaths(paths);
      const depths = passDepths(job.material.thickness, tool.passDepth, job.cutThrough || 0);
      let first = true;
      for (const { shape, path } of paths) {
        const sd = shape.depth != null ? passDepths(shape.depth, tool.passDepth, 0).map(z => z + (job.material.thickness - shape.depth)) : depths;
        const useDepths = shape.op === 'on' && shape.depth != null ? sd : depths;
        for (const z of useDepths) {
          stats.passes++;
          const st = path[0].a;
          // ramp on only where there is a closed path long enough to do it
          const ramp = (m.leadIn > 0 && !shape.open) ? leadInSegs(path, m.leadIn) : null;
          const entry = ramp ? ramp[0].a : st;

          emit(`G0 X${fmt(entry.x, dec)} Y${fmt(entry.y, dec)}`);
          if (pos.x != null) stats.rapid += G.dist(pos, entry);
          pos = { x: rnd(entry.x, dec), y: rnd(entry.y, dec), z: pos.z };

          if (ramp) {
            // down to the surface, then ramp along the path to full depth
            if (first) emit(`G0 Z${fmt(safeZ, dec)}`);
            emit(`G1 Z${fmt(matTop, dec)}` + (first ? `F${tool.plunge}` : ''));
            emit(`F${tool.plunge}`);
            const rampLen = ramp.reduce((a, sg) => a + G.segLen(sg), 0) || 1;
            let run = 0;
            for (const sg of ramp) {
              run += G.segLen(sg);
              const zz = matTop + (z - matTop) * Math.min(1, run / rampLen);
              const b = { x: rnd(sg.b.x, dec), y: rnd(sg.b.y, dec) };
              const parts = [];
              if (b.x !== pos.x) parts.push(`X${fmt(b.x, dec)}`);
              if (b.y !== pos.y) parts.push(`Y${fmt(b.y, dec)}`);
              if (sg.type === 'arc') {
                const i = sg.c.x - sg.a.x, j = sg.c.y - sg.a.y;
                emit(`${sg.ccw ? 'G3' : 'G2'} X${fmt(b.x, dec)} Y${fmt(b.y, dec)} I${fmt(i, dec)} J${fmt(j, dec)} Z${fmt(zz, dec)}`);
              } else {
                emit(`G1 ${parts.join(' ')}${parts.length ? ' ' : ''}Z${fmt(zz, dec)}`.replace('G1  ', 'G1 '));
              }
              pos = { x: b.x, y: b.y, z: zz };
              stats.length += G.segLen(sg);
              stats.timeMin += G.segLen(sg) / tool.plunge;
            }
            emit(`F${tool.feed}`);
            first = false;
          } else if (first) {
            if (!m.spindleInToolChange) emit(`S${tool.rpm}`);
            emit(`G0 Z${fmt(safeZ, dec)}`);
            emit(`G1 Z${fmt(z, dec)}F${tool.plunge}`);
            emit(`F${tool.feed}`);
            first = false;
          } else {
            emit(`G1 Z${fmt(z, dec)}`);
          }
          stats.timeMin += (safeZ - z) / tool.plunge;
          for (const s of path) {
            const b = { x: rnd(s.b.x, dec), y: rnd(s.b.y, dec) };
            if (s.type === 'line') {
              const parts = [];
              if (b.x !== pos.x) parts.push(`X${fmt(b.x, dec)}`);
              if (b.y !== pos.y) parts.push(`Y${fmt(b.y, dec)}`);
              if (parts.length) emit(`G1 ${parts.join(' ')}`);
            } else {
              const i = s.c.x - s.a.x, j = s.c.y - s.a.y;
              emit(`${s.ccw ? 'G3' : 'G2'} X${fmt(b.x, dec)} Y${fmt(b.y, dec)} I${fmt(i, dec)} J${fmt(j, dec)}`);
            }
            const l = G.segLen(s); stats.length += l; stats.timeMin += l / tool.feed;
            pos = { x: b.x, y: b.y, z };
          }
          emit(`G0 Z${fmt(safeZ, dec)}`);
          emit('');
        }
      }
    }
    pushBlock(m.footer);
    stats.timeMin += stats.rapid / 600; // rough rapid rate 600 ipm
    return { gcode: L.join(m.lineEnding) + m.lineEnding, stats };
  }

  // ---- parse G-code for simulation / import preview
  function parseGcode(text) {
    const moves = []; let x = 0, y = 0, z = 1, feed = 0, tool = null, rpm = 0;
    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
      const ln = raw.trim(); if (!ln) continue;
      const mt = ln.match(/^\[(.*)\]$/); if (mt) { tool = mt[1]; continue; }
      if (/^T(\d+)/.test(ln)) { continue; }
      if (/^S(\d+)/.test(ln)) { rpm = parseInt(ln.slice(1), 10); continue; }
      const gm = ln.match(/^G(\d+)/); if (!gm) { const fm = ln.match(/^F([\d.]+)/); if (fm) feed = parseFloat(fm[1]); continue; }
      const g = parseInt(gm[1], 10);
      if (![0, 1, 2, 3].includes(g)) continue;
      const w = {}; for (const mm of ln.matchAll(/([XYZIJF])(-?[\d.]+)/g)) w[mm[1]] = parseFloat(mm[2]);
      if (w.F !== undefined) feed = w.F;
      const nx = w.X !== undefined ? w.X : x, ny = w.Y !== undefined ? w.Y : y, nz = w.Z !== undefined ? w.Z : z;
      const mv = { g, from: { x, y, z }, to: { x: nx, y: ny, z: nz }, feed, tool };
      if (g === 2 || g === 3) mv.c = { x: x + (w.I || 0), y: y + (w.J || 0) };
      moves.push(mv); x = nx; y = ny; z = nz;
    }
    return moves;
  }

  return { DEFAULT_MACHINE, ENROUTE_CURRENT, DEFAULT_TOOLS, leadInSegs, formatStamp, selfIntersects, DEFAULT_MATERIALS, fmt, rnd, passDepths, buildToolpathLoop, orderPaths, generate, parseGcode };
})();
if (typeof module !== 'undefined') module.exports = POST;
