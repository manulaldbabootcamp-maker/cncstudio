/* ===== post.js — toolpath generation + WinCNC TAP post-processor ===== */
const POST = (() => {
  const G = typeof GEOM !== 'undefined' ? GEOM : require('./geom.js');

  const DEFAULT_MACHINE = {
    name: 'WinCNC 5x10',
    bedW: 60, bedH: 120, units: 'in', // X = 60" (5 ft), Y = 120" (10 ft) — matches G53 X0 Y120 park in sample
    safeZ: 1.1875,
    header: 'G90\nG53\nM61\n',
    toolChange: '\n[{toolName}]\nM5\nT{slot}\nM3\n\n',
    footer: 'M5\nG53\nM62\nG53 X0 Y120\n',
    lineEnding: '\r\n',
    decimals: 4,
    plungeFeedOnFirstOnly: true, // sample: F on first plunge only
  };
  const DEFAULT_TOOLS = [
    { id: 1, slot: 1, name: '3/8" Upspiral', dia: 0.375, rpm: 23000, feed: 180, plunge: 20, passDepth: 0.09375, type: 'endmill' },
    { id: 2, slot: 2, name: '1/4" Upspiral', dia: 0.25, rpm: 20000, feed: 150, plunge: 20, passDepth: 0.125, type: 'endmill' },
    { id: 3, slot: 3, name: '1/8" Downcut', dia: 0.125, rpm: 18000, feed: 100, plunge: 15, passDepth: 0.0625, type: 'endmill' },
    { id: 4, slot: 4, name: '1/2" Compression', dia: 0.5, rpm: 18000, feed: 200, plunge: 25, passDepth: 0.25, type: 'endmill' },
    { id: 5, slot: 5, name: '1/4" Drill', dia: 0.25, rpm: 12000, feed: 60, plunge: 30, passDepth: 0.5, type: 'drill' },
  ];
  const DEFAULT_MATERIALS = [
    { name: '3/16" Acrylic', thickness: 0.1875 },
    { name: '1/4" Acrylic', thickness: 0.25 },
    { name: '1/8" Acrylic', thickness: 0.125 },
    { name: '1/2" HDPE', thickness: 0.5 },
    { name: '3/4" HDPE', thickness: 0.75 },
  ];

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

  // ---- toolpath from a shape
  // shape: {loop:[segs], open?:bool, op:'outside'|'inside'|'on', tool, startHint?}
  function buildToolpathLoop(shape, tool, opts = {}) {
    let loop = shape.loop;
    if (shape.open) return loop; // engrave along open path, no offset
    if (G.signedArea(loop) < 0) loop = G.reverseLoop(loop);
    const r = tool.dia / 2;
    let path;
    if (shape.op === 'inside') path = G.offsetLoop(loop, -r);
    else if (shape.op === 'outside') path = G.offsetLoop(loop, r);
    else path = loop.map(s => ({ ...s }));
    if (!path.length) return [];
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

    pushBlock(m.header);
    // group by tool in slot order of first use (or explicit order)
    const byTool = new Map();
    for (const sh of job.shapes) { if (!byTool.has(sh.toolId)) byTool.set(sh.toolId, []); byTool.get(sh.toolId).push(sh); }
    const stats = { length: 0, rapid: 0, timeMin: 0, passes: 0, tools: [] };
    let pos = { x: null, y: null, z: null };
    for (const [toolId, shapes] of byTool) {
      const tool = job.tools.find(t => t.id === toolId) || job.tools[0];
      stats.tools.push(tool.name);
      pushBlock(tpl(m.toolChange, { toolName: tool.name, slot: String(tool.slot).padStart(2, '0'), rpm: tool.rpm }));
      // toolpaths
      let paths = shapes.map(sh => ({ shape: sh, path: buildToolpathLoop(sh, tool, { climb: sh.climb }) })).filter(p => p.path.length);
      paths = orderPaths(paths);
      const depths = passDepths(job.material.thickness, tool.passDepth, job.cutThrough || 0);
      let first = true;
      for (const { shape, path } of paths) {
        const sd = shape.depth != null ? passDepths(shape.depth, tool.passDepth, 0).map(z => z + (job.material.thickness - shape.depth)) : depths;
        const useDepths = shape.op === 'on' && shape.depth != null ? sd : depths;
        for (const z of useDepths) {
          stats.passes++;
          const st = path[0].a;
          emit(`G0 X${fmt(st.x, dec)} Y${fmt(st.y, dec)}`);
          if (pos.x != null) stats.rapid += G.dist(pos, st);
          pos = { x: rnd(st.x, dec), y: rnd(st.y, dec), z: pos.z };
          if (first) {
            emit(`S${tool.rpm}`);
            emit(`G0 Z${fmt(m.safeZ, dec)}`);
            emit(`G1 Z${fmt(z, dec)}F${tool.plunge}`);
            emit(`F${tool.feed}`);
            first = false;
          } else {
            emit(`G1 Z${fmt(z, dec)}`);
          }
          stats.timeMin += (m.safeZ - z) / tool.plunge;
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
          emit(`G0 Z${fmt(m.safeZ, dec)}`);
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

  return { DEFAULT_MACHINE, DEFAULT_TOOLS, DEFAULT_MATERIALS, fmt, rnd, passDepths, buildToolpathLoop, orderPaths, generate, parseGcode };
})();
if (typeof module !== 'undefined') module.exports = POST;
