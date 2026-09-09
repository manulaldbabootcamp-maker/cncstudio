/* ===== app.js — CNC Studio UI ===== */
(() => {
  const G = GEOM, PO = POST, NE = NEST;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  // ---------- settings (persisted) ----------
  const DEFAULT_SETTINGS = {
    machine: { ...PO.DEFAULT_MACHINE },
    tools: PO.DEFAULT_TOOLS.map(t => ({ ...t })),
    materials: PO.DEFAULT_MATERIALS.map(m => ({ ...m })),
    nest: { gap: 0.5, margin: 0.375, rotate: false },
    ai: { key: '', model: 'claude-sonnet-4-5' },
    snap: { on: true, ortho: false, autoSplit: true, trimTol: 0.125, radius: 0.125, types: { endpoint: true, midpoint: true, center: true, quadrant: true, intersection: true, on: true, grid: true } },
  };
  let S = loadSettings();
  function loadSettings() {
    try {
      const j = JSON.parse(localStorage.getItem('cncstudio.settings') || 'null');
      if (j) return {
        ...DEFAULT_SETTINGS, ...j,
        machine: { ...DEFAULT_SETTINGS.machine, ...(j.machine || {}) },
        snap: { ...DEFAULT_SETTINGS.snap, ...(j.snap || {}), types: { ...DEFAULT_SETTINGS.snap.types, ...((j.snap || {}).types || {}) } },
      };
    } catch (e) { LOG.warn('Could not read saved settings, using defaults', e); }
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
  function saveSettings() { try { localStorage.setItem('cncstudio.settings', JSON.stringify(S)); } catch (e) { } }

  // ---------- job state ----------
  let job = newJob();
  function newJob() { return { shapes: [], dims: [], material: { name: S.materials[0].name, thickness: S.materials[0].thickness }, cutThrough: 0, nextId: 1 }; }
  let sel = new Set();
  let undoStack = [], redoStack = [];
  function snapshot() { undoStack.push(JSON.stringify(job)); if (undoStack.length > 60) undoStack.shift(); redoStack = []; }
  function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify(job)); job = JSON.parse(undoStack.pop()); sel.clear(); refresh(); }
  function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(job)); job = JSON.parse(redoStack.pop()); sel.clear(); refresh(); }

  // shape: {id,name,kind:'rect'|'circle'|'poly'|'path', x,y,rot, w,h,r, pts, loop(local), open, op, toolId, climb}
  function makeShape(kind, props) {
    const id = job.nextId++;
    const base = { id, name: `${kind} ${id}`, kind, x: 0, y: 0, rot: 0, op: 'outside', toolId: S.tools[0]?.id || 1, climb: false, open: false };
    return Object.assign(base, props);
  }
  function localLoop(sh) {
    if (sh.kind === 'rect') return G.rectLoop(0, 0, sh.w, sh.h, sh.r || 0, sh.rc);
    if (sh.kind === 'circle') return G.circleLoop(0, 0, sh.r);
    if (sh.kind === 'poly') return sh.open ? polyOpen(sh.pts) : G.polyLoop(sh.pts);
    if (sh.kind === 'ellipse') return G.ellipseLoop(0, 0, sh.rx, sh.ry, 0);
    if (sh.kind === 'spline') return G.splineLoop(sh.pts, !sh.open);
    if (sh.kind === 'path') return sh.loop;
    return [];
  }
  // open polyline; an edge with arcR bows into an arc (same convention as polyLoop)
  function polyOpen(pts) {
    const s = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = G.P(pts[i].x, pts[i].y), b = G.P(pts[i + 1].x, pts[i + 1].y);
      const chord = G.dist(a, b);
      if (chord < 1e-9) continue;
      const R = pts[i].arcR || 0;
      if (Math.abs(R) > 1e-9) {
        const RR = Math.max(Math.abs(R), chord / 2);
        const theta = 2 * Math.asin(Math.min(1, chord / (2 * RR)));
        const mag = Math.tan(theta / 4);
        s.push(G.bulgeArc(a, b, R > 0 ? mag : -mag));
      } else s.push(G.line(a, b));
    }
    return s;
  }
  function worldLoop(sh) {
    let l = localLoop(sh);
    if (sh.rot) l = G.rotateLoop(l, sh.rot * Math.PI / 180, G.P(0, 0));
    return G.translateLoop(l, sh.x, sh.y);
  }
  function shapeBBox(sh) { return G.bbox(worldLoop(sh)); }
  function toolOf(sh) { return S.tools.find(t => t.id === sh.toolId) || S.tools[0]; }
  function toolpathOf(sh) {
    if (sh.op === 'none') return null;
    const t = toolOf(sh); if (!t) return null;
    try { return PO.buildToolpathLoop({ loop: worldLoop(sh), op: sh.op, open: sh.open, startHint: sh.startPt, climb: sh.climb }, t, { climb: sh.climb }); } catch (e) { console.warn(e); return null; }
  }

  // ---------- canvas / view ----------
  const cv = $('#cv'), ctx = cv.getContext('2d');
  const view = { scale: 8, ox: 40, oy: 0 }; // px per inch; origin offset in px (bottom-left)
  let mouse = { x: 0, y: 0, wx: 0, wy: 0, down: false };
  let tool = 'select';
  let drawing = null; // in-progress drawing state
  let drag = null;
  let spaceDown = false;
  let measure = null;   // {a, b, cur} measure-tool state
  let hoverGrip = null; // grip under the cursor, for highlight + cursor shape
  let hoverEdge = null; // line under the cursor, previewed before clicking
  function W2S(p) { return { x: view.ox + p.x * view.scale, y: cv.height - view.oy - p.y * view.scale }; }
  function S2W(p) { return { x: (p.x - view.ox) / view.scale, y: (cv.height - view.oy - p.y) / view.scale }; }
  function fitBed() {
    const m = S.machine; const pad = 30;
    view.scale = Math.min((cv.width - pad * 2) / m.bedW, (cv.height - pad * 2) / m.bedH);
    view.ox = (cv.width - m.bedW * view.scale) / 2; view.oy = (cv.height - m.bedH * view.scale) / 2;
  }
  function resize() {
    const r = $('#center').getBoundingClientRect();
    if (cv.width !== Math.floor(r.width * devicePixelRatio) || cv.height !== Math.floor(r.height * devicePixelRatio)) {
      cv.width = Math.floor(r.width * devicePixelRatio); cv.height = Math.floor(r.height * devicePixelRatio);
      fitBed();
    }
    draw();
  }
  window.addEventListener('resize', resize);

  function snapV() { return parseFloat($('#selSnap').value) || 0; }
  // decimals worth showing: enough for the current snap, capped at the post's 4
  function coordDp() {
    const s = snapV();
    if (!s) return 4;
    if (s >= 0.0625) return 4;
    return 4;
  }
  let zoomToast = 0;
  function showZoomLimit(atMax) {
    if (Date.now() - zoomToast < 1500) return;
    zoomToast = Date.now();
    toast(atMax
      ? 'Maximum zoom — 0.001 in is already about a pixel here'
      : 'Minimum zoom — the whole bed is in view');
  }

  // ---------- object snapping ----------
  let lastSnap = null;          // {p,type} of the most recent snap, for the marker + status
  let orthoTemp = false;        // Shift held: temporary ortho lock
  const SNAP_PX = 11;           // pick radius in screen px
  /* Snap reach is the LARGER of a screen radius and a real-world radius.
     Screen-only was the bug: zoomed in, 11 px can be a few thousandths of an
     inch, so dragging an endpoint towards a line from 1/8 in away snapped to
     nothing. World-only would be worse zoomed out, where 1/8 in is sub-pixel
     and unclickable. Taking the max gives a usable reach at every zoom. */
  function snapTol() {
    const px = SNAP_PX * devicePixelRatio / view.scale;
    const world = S.snap.radius != null ? S.snap.radius : 0.125;
    return Math.max(px, world);
  }

  /* World loops of every shape, for the snap engine.
     Cached: this runs on every mousemove, and rebuilding polyLoop for 30+ parts
     at cursor rate is enough to make dragging feel sticky. Invalidated by
     invalidateLoops() wherever geometry changes. */
  let loopCache = null;
  function invalidateLoops() { loopCache = null; }
  function snapLoops(excludeIds) {
    if (!loopCache) {
      loopCache = [];
      for (const sh of job.shapes) {
        try { loopCache.push({ id: sh.id, loop: worldLoop(sh), centres: centresOf(sh).map(c => c.p) }); }
        catch (e) { LOG.warn(`Snap: could not build geometry for "${sh.name}"`, e); }
      }
    }
    return excludeIds ? loopCache.filter(l => !excludeIds.has(l.id)) : loopCache;
  }

  /* Resolve a raw world point to a snapped one.
     opts.from    : anchor for ortho (the previous click), or null to skip ortho
     opts.exclude : Set of shape ids to ignore (e.g. the one being dragged)
     Ortho is applied FIRST so the axis lock wins, then object snaps refine
     along it - that matches how AutoCAD behaves and avoids the lock fighting
     a nearby endpoint. */
  function resolvePoint(w, opts = {}) {
    let p = w;
    const orthoOn = (S.snap.ortho || orthoTemp) && opts.from;
    if (orthoOn) p = SNAP.ortho(opts.from, w, !!opts.polar).p;
    lastSnap = null;
    if (S.snap.on) {
      const hit = SNAP.snapPoint(p, snapLoops(opts.exclude), opts.tol || snapTol(), {
        enabled: { ...S.snap.types, grid: S.snap.types.grid && snapV() > 0 },
        gridStep: snapV(),
        exclude: opts.exclude,
        // part centres (a rectangle's middle) are not arc centres, so feed them in
        extra: (opts.extra || []).concat(
          S.snap.types.center
            ? snapLoops(opts.exclude).flatMap(l => (l.centres || []).map(p => ({ x: p.x, y: p.y, type: 'center', ref: l.id })))
            : []),
      });
      if (hit) {
        // under ortho, only accept a snap that stays on the locked axis
        if (!orthoOn || Math.abs(G.cross(G.norm(G.sub(p, opts.from)), G.sub(hit.p, opts.from))) < 1e-6) {
          lastSnap = hit; return hit.p;
        }
      }
    }
    if (!orthoOn) { const s = snapV(); if (s) return { x: Math.round(p.x / s) * s, y: Math.round(p.y / s) * s }; }
    return p;
  }
  // legacy grid-only snap, still used where there is no anchor context
  function snap(p) { const s = snapV(); if (!s) return p; return { x: Math.round(p.x / s) * s, y: Math.round(p.y / s) * s }; }
  const SNAP_COLOR = { endpoint: '#41c77a', midpoint: '#4da3ff', center: '#ffb84d', quadrant: '#d38cff', intersection: '#ff5c5c', on: '#9aa3ad', grid: '#5a6473' };
  const SNAP_LABEL = { endpoint: 'endpoint', midpoint: 'midpoint', center: 'centre', quadrant: 'quadrant', intersection: 'intersection', on: 'on edge', grid: 'grid' };

  function draw() {
    const m = S.machine; const dpr = devicePixelRatio;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#15171b'; ctx.fillRect(0, 0, cv.width, cv.height);
    // bed
    const bl = W2S({ x: 0, y: 0 }), tr = W2S({ x: m.bedW, y: m.bedH });
    ctx.fillStyle = '#1c2027'; ctx.fillRect(bl.x, tr.y, tr.x - bl.x, bl.y - tr.y);
    // grid
    const step = view.scale > 20 ? 1 : view.scale > 6 ? 6 : 12;
    ctx.lineWidth = 1;
    for (let x = 0; x <= m.bedW + 1e-9; x += step) { const p = W2S({ x, y: 0 }); ctx.strokeStyle = x % 12 === 0 ? '#343a44' : '#262b33'; ctx.beginPath(); ctx.moveTo(p.x, bl.y); ctx.lineTo(p.x, tr.y); ctx.stroke(); }
    for (let y = 0; y <= m.bedH + 1e-9; y += step) { const p = W2S({ x: 0, y }); ctx.strokeStyle = y % 12 === 0 ? '#343a44' : '#262b33'; ctx.beginPath(); ctx.moveTo(bl.x, p.y); ctx.lineTo(tr.x, p.y); ctx.stroke(); }
    ctx.strokeStyle = '#5a6473'; ctx.lineWidth = 1.5; ctx.strokeRect(bl.x, tr.y, tr.x - bl.x, bl.y - tr.y);
    // axis labels (feet)
    ctx.fillStyle = '#6f7a88'; ctx.font = `${11 * dpr}px system-ui`;
    for (let x = 0; x <= m.bedW; x += 12) { const p = W2S({ x, y: 0 }); ctx.fillText(x + '"', p.x + 2, bl.y + 12 * dpr); }
    for (let y = 0; y <= m.bedH; y += 12) { const p = W2S({ x: 0, y }); ctx.fillText(y + '"', bl.x - 26 * dpr, p.y - 2); }
    // origin marker
    ctx.fillStyle = '#ff5c5c'; ctx.beginPath(); ctx.arc(bl.x, bl.y, 4 * dpr, 0, Math.PI * 2); ctx.fill();
    // shapes
    const showPaths = $('#chkPaths').checked, showKerf = $('#chkKerf').checked;
    for (const sh of job.shapes) {
      const loop = worldLoop(sh); const isSel = sel.has(sh.id);
      const bb = G.bbox(loop);
      const outside = bb.x0 < -1e-6 || bb.y0 < -1e-6 || bb.x1 > m.bedW + 1e-6 || bb.y1 > m.bedH + 1e-6;
      // fill
      if (!sh.open) { ctx.fillStyle = outside ? 'rgba(255,92,92,.18)' : (isSel ? 'rgba(77,163,255,.22)' : 'rgba(120,200,255,.10)'); tracePath(loop, sh.open); ctx.fill(); }
      ctx.strokeStyle = outside ? '#ff5c5c' : (isSel ? '#8cc4ff' : '#c9d3df'); ctx.lineWidth = (isSel ? 2 : 1.2) * dpr; tracePath(loop, sh.open); ctx.stroke();
      // toolpath
      if (showPaths || showKerf) {
        const tp = toolpathOf(sh);
        if (tp && tp.length) {
          if (showKerf) { const t = toolOf(sh); ctx.strokeStyle = 'rgba(255,184,77,.35)'; ctx.lineWidth = t.dia * view.scale; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; tracePath(tp, sh.open); ctx.stroke(); }
          if (showPaths) { ctx.strokeStyle = sh.op === 'inside' ? '#41c77a' : sh.op === 'on' ? '#d38cff' : '#ffb84d'; ctx.lineWidth = 1 * dpr; ctx.setLineDash([4 * dpr, 3 * dpr]); tracePath(tp, sh.open); ctx.stroke(); ctx.setLineDash([]);
            // start point + direction
            const st = tp[0].a, p = W2S(st); ctx.fillStyle = '#ffb84d'; ctx.beginPath(); ctx.arc(p.x, p.y, 3 * dpr, 0, Math.PI * 2); ctx.fill();
          }
        }
      }
      // handles for selection
      if (isSel) {
        ctx.strokeStyle = '#4da3ff'; ctx.setLineDash([3 * dpr, 3 * dpr]); ctx.lineWidth = 1 * dpr;
        const a = W2S({ x: bb.x0, y: bb.y0 }), b = W2S({ x: bb.x1, y: bb.y1 }); ctx.strokeRect(a.x, b.y, b.x - a.x, a.y - b.y); ctx.setLineDash([]);
      }
    }
    // in-progress drawing
    if (drawing) {
      ctx.strokeStyle = '#4da3ff'; ctx.lineWidth = 1.5 * dpr; ctx.setLineDash([5 * dpr, 4 * dpr]);
      if (drawing.kind === 'rect') { const a = W2S(drawing.a), b = W2S(drawing.b); ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); dimLabel(drawing.b, `${fmtIn(Math.abs(drawing.b.x - drawing.a.x))} × ${fmtIn(Math.abs(drawing.b.y - drawing.a.y))}`); }
      if (drawing.kind === 'circle') { const c = W2S(drawing.a); const r = G.dist(drawing.a, drawing.b) * view.scale; ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.stroke(); dimLabel(drawing.b, `R ${fmtIn(G.dist(drawing.a, drawing.b))}  Ø ${fmtIn(2 * G.dist(drawing.a, drawing.b))}`); }
      if (drawing.kind === 'ellipse') { const c = W2S(drawing.a); const rx = Math.abs(drawing.b.x - drawing.a.x) * view.scale, ry = Math.abs(drawing.b.y - drawing.a.y) * view.scale; if (rx > 0.5 && ry > 0.5) { ctx.beginPath(); ctx.ellipse(c.x, c.y, rx, ry, 0, 0, Math.PI * 2); ctx.stroke(); } dimLabel(drawing.b, `${fmtIn(Math.abs(drawing.b.x - drawing.a.x) * 2)} × ${fmtIn(Math.abs(drawing.b.y - drawing.a.y) * 2)}`); }
      if (drawing.kind === 'spline' && drawing.pts.length) { const pv = drawing.pts.concat([drawing.cur]); const prev = pv.length > 2 ? G.splineLoop(pv, false) : []; ctx.beginPath(); if (prev.length) { const s0 = W2S(prev[0].a); ctx.moveTo(s0.x, s0.y); prev.forEach(sg => { const q = W2S(sg.b); ctx.lineTo(q.x, q.y); }); } else { pv.forEach((p, i) => { const q = W2S(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); } ctx.stroke(); pv.forEach(p => { const q = W2S(p); ctx.fillStyle = '#4da3ff'; ctx.fillRect(q.x - 2.5, q.y - 2.5, 5, 5); }); }
      if (drawing.kind === 'poly' || drawing.kind === 'pline') { ctx.beginPath(); drawing.pts.forEach((p, i) => { const s = W2S(p); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); }); const s = W2S(drawing.cur); ctx.lineTo(s.x, s.y); ctx.stroke(); if (drawing.pts.length) { const prev = drawing.pts[drawing.pts.length - 1]; dimLabel(drawing.cur, `${fmtIn(G.dist(prev, drawing.cur))}  ${fmtAng(prev, drawing.cur)}`); } }
      if (drawing.kind === 'arc') {
        const a = drawing.a, b = drawing.b, cur = drawing.cur;
        ctx.beginPath();
        if (drawing.stage === 1) { const p = W2S(a), q = W2S(cur); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); dimLabel(cur, `chord ${fmtIn(G.dist(a, cur))}`); }
        else { const arcSeg = arcThrough(a, b, cur); if (arcSeg) { tracePath([arcSeg], true); ctx.stroke(); dimLabel(cur, `R ${fmtIn(G.radius(arcSeg))}  bulge ${fmtIn(sagitta(a, b, cur))}`); } }
      }
      ctx.setLineDash([]);
    }
    // measure
    if (measure) {
      const a = measure.a, b = measure.b || measure.cur;
      if (a && b) {
        const p = W2S(a), q = W2S(b);
        ctx.strokeStyle = '#ffb84d'; ctx.lineWidth = 1.5 * dpr; ctx.setLineDash([6 * dpr, 4 * dpr]);
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); ctx.setLineDash([]);
        for (const t of [p, q]) { ctx.beginPath(); ctx.arc(t.x, t.y, 4 * dpr, 0, Math.PI * 2); ctx.fillStyle = '#ffb84d'; ctx.fill(); }
        const dx = b.x - a.x, dy = b.y - a.y;
        const lockTag = (b.locked !== undefined) ? `  [${b.locked}° locked]` : '';
        dimLabel({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, `${fmtIn(Math.hypot(dx, dy))}  ${fmtAng(a, b)}${lockTag}  Δ${fmtIn(dx)},${fmtIn(dy)}`);
      }
    }
    // centre marks, then dimensions (both annotation only - never posted)
    drawCentreMarks();
    drawDims();
    drawSizeLabels();
    // selected side + point numbers
    drawEdgeSelection();
    // grips on a single selected shape
    drawGrips();
    // snap marker last, so it sits on top of everything
    // during a drag is precisely when confirmation matters, so keep it visible
    if (lastSnap && (!drag || drag.kind === 'grip' || drag.kind === 'move')) drawSnapMarker(lastSnap);
    if (drag && drag.kind === 'marquee') { const a = W2S(drag.a), b = W2S(drag.cur); ctx.strokeStyle = '#4da3ff'; ctx.setLineDash([3, 3]); ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); ctx.setLineDash([]); }
  }
  function dimLabel(wp, text) {
    const p = W2S(wp), dpr = devicePixelRatio;
    ctx.font = `${12 * dpr}px ui-monospace, monospace`;
    const w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(20,22,26,.82)'; ctx.fillRect(p.x + 8, p.y - 24 * dpr, w + 8, 17 * dpr);
    ctx.fillStyle = '#4da3ff'; ctx.fillText(text, p.x + 12, p.y - 11 * dpr);
  }
  /* Measuring is nearly always along a straight edge, so a reading a couple of
     degrees off square is a slip of the mouse rather than a real angle. Within
     MEASURE_LOCK_DEG of an axis the second point is projected square onto it,
     which keeps the distance honest instead of quietly reporting the hypotenuse.
     Hold Alt to measure a genuine diagonal. */
  const MEASURE_LOCK_DEG = 10;
  function axisLock(from, to, bypass) {
    if (bypass || !from) return to;
    const dx = to.x - from.x, dy = to.y - from.y;
    if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12) return to;
    const deg = ((Math.atan2(dy, dx) * 180 / Math.PI) % 360 + 360) % 360;
    for (const axis of [0, 90, 180, 270, 360]) {
      if (Math.abs(deg - axis) <= MEASURE_LOCK_DEG) {
        const a = (axis % 360) * Math.PI / 180;
        const L = dx * Math.cos(a) + dy * Math.sin(a);       // project onto the axis
        return { x: from.x + L * Math.cos(a), y: from.y + L * Math.sin(a), locked: axis % 360 };
      }
    }
    return to;
  }

  const fmtAng = (a, b) => `${(((Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI) % 360 + 360) % 360).toFixed(2)}°`;

  // sagitta: perpendicular distance from the chord a-b to the point p.
  // This is the "bulge distance" the operator actually measures on the part.
  function sagitta(a, b, p) {
    const d = G.sub(b, a), L = G.len(d);
    if (L < 1e-9) return 0;
    return G.cross(G.norm(d), G.sub(p, a));      // signed: + is left of a->b
  }
  /* Arc through 3 points (start, end, and a point on it). null if collinear.
     NOTE the minus: bulgeArc's positive bulge curves to the RIGHT of travel,
     while sagitta() is positive to the LEFT. Without the negation the arc comes
     out mirrored about its own chord - it still has the right radius, which is
     why a magnitude-only test never caught it. */
  function arcThrough(a, b, p) {
    const s = sagitta(a, b, p);
    if (Math.abs(s) < 1e-6) return null;
    const chord = G.dist(a, b);
    if (chord < 1e-9) return null;
    return G.bulgeArc(a, b, (-2 * s) / chord);
  }
  // build an arc from a chord and a known bulge distance (sagitta)
  function arcFromSagitta(a, b, s) {
    const chord = G.dist(a, b);
    if (chord < 1e-9 || Math.abs(s) < 1e-9) return null;
    return G.bulgeArc(a, b, (2 * s) / chord);
  }

  function drawSnapMarker(hit) {
    const dpr = devicePixelRatio, p = W2S(hit.p), r = 6 * dpr;
    ctx.save();
    ctx.strokeStyle = SNAP_COLOR[hit.type] || '#4da3ff'; ctx.lineWidth = 2 * dpr; ctx.setLineDash([]);
    ctx.beginPath();
    // conventional CAD marker shapes so the type is readable at a glance
    if (hit.type === 'endpoint') ctx.rect(p.x - r, p.y - r, r * 2, r * 2);
    else if (hit.type === 'midpoint') { ctx.moveTo(p.x, p.y - r); ctx.lineTo(p.x + r, p.y + r); ctx.lineTo(p.x - r, p.y + r); ctx.closePath(); }
    else if (hit.type === 'center') ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    else if (hit.type === 'quadrant') { ctx.moveTo(p.x, p.y - r); ctx.lineTo(p.x + r, p.y); ctx.lineTo(p.x, p.y + r); ctx.lineTo(p.x - r, p.y); ctx.closePath(); }
    else if (hit.type === 'intersection') { ctx.moveTo(p.x - r, p.y - r); ctx.lineTo(p.x + r, p.y + r); ctx.moveTo(p.x + r, p.y - r); ctx.lineTo(p.x - r, p.y + r); }
    else if (hit.type === 'on') { ctx.moveTo(p.x - r, p.y + r); ctx.lineTo(p.x + r, p.y + r); ctx.moveTo(p.x - r, p.y - r); ctx.lineTo(p.x + r, p.y - r); }
    else ctx.rect(p.x - r * .7, p.y - r * .7, r * 1.4, r * 1.4);
    ctx.stroke();
    ctx.restore();
  }

  /* ---------- grips ----------
     A single selected shape shows draggable grips:
       - a square at each polygon vertex / rect corner  -> move that point
       - a round grip at each edge midpoint             -> bow the edge into an
         arc; the bulge distance (sagitta) is what you read and can type.
     This is the "grab the middle of a line and pull it to a known distance"
     workflow, instead of computing a radius by hand. */
  function gripShape() {
    if (sel.size !== 1) return null;
    const sh = job.shapes.find(s => sel.has(s.id));
    if (!sh) return null;
    if (sh.kind === 'poly' || sh.kind === 'rect') return sh;
    return null;
  }
  // world-space grips for a shape: [{kind:'vertex'|'edge', i, p}]
  function gripsOf(sh) {
    const out = [];
    if (!sh) return out;
    const pts = gripPts(sh);
    const n = pts.length;
    if (n < 2) return out;
    const toW = (p) => localToWorld(sh, p);
    const closed = !sh.open;
    for (let i = 0; i < n; i++) out.push({ kind: 'vertex', i, p: toW(pts[i]) });
    const edges = closed ? n : n - 1;
    for (let i = 0; i < edges; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      // the grip sits on the current curve, so a bowed edge keeps its handle
      const s = pts[i].arcR ? null : null;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const sag = edgeSagitta(sh, i);
      const d = G.sub(b, a), L = G.len(d) || 1;
      const nrm = { x: -d.y / L, y: d.x / L };
      out.push({ kind: 'edge', i, p: toW({ x: mid.x + nrm.x * sag, y: mid.y + nrm.y * sag }) });
    }
    return out;
  }
  // local points of a grip-able shape (rect is expanded to 4 corners)
  function gripPts(sh) {
    if (sh.kind === 'rect') return [{ x: 0, y: 0 }, { x: sh.w, y: 0 }, { x: sh.w, y: sh.h }, { x: 0, y: sh.h }];
    return sh.pts || [];
  }
  // current bulge distance of edge i, in local units
  function edgeSagitta(sh, i) {
    const pts = gripPts(sh), n = pts.length;
    const R = pts[i] && pts[i].arcR;
    if (!R) return 0;
    const a = pts[i], b = pts[(i + 1) % n];
    const chord = G.dist(a, b);
    if (chord < 1e-9) return 0;
    const RR = Math.max(Math.abs(R), chord / 2);
    const h = Math.sqrt(Math.max(0, RR * RR - (chord / 2) * (chord / 2)));
    const sag = RR - h;
    return R > 0 ? sag : -sag;
  }
  /* Two different sign conventions meet here, and mixing them silently flips
     which way an edge curves:
       - the TYPED bulge column is positive when the edge bows OUTWARD from the
         part, which is what an operator measures;
       - a sagitta computed from geometry via cross(chord, mid) is positive to
         the LEFT of travel, which for a CCW outline points INWARD.
     sagittaToArcR takes the first. Anything handing it a geometric sagitta
     must go through this, or the arc comes back mirrored - which is how a
     circle split into quadrants ended up enclosing 30.9 sq in instead of
     113.1. */
  function arcRFromGeometry(chord, geomSag) { return sagittaToArcR(chord, -geomSag); }

  // sagitta -> arcR (the radius the geometry layer stores)
  function sagittaToArcR(chord, sag) {
    const s = Math.abs(sag);
    if (s < 1e-7 || chord < 1e-9) return 0;
    const R = (s / 2) + (chord * chord) / (8 * s);
    return sag > 0 ? R : -R;
  }
  function localToWorld(sh, p) {
    const c = Math.cos((sh.rot || 0) * Math.PI / 180), s = Math.sin((sh.rot || 0) * Math.PI / 180);
    return { x: sh.x + p.x * c - p.y * s, y: sh.y + p.x * s + p.y * c };
  }
  function worldToLocal(sh, p) {
    const a = -(sh.rot || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const dx = p.x - sh.x, dy = p.y - sh.y;
    return { x: dx * c - dy * s, y: dx * s + dy * c };
  }
  function drawGrips() {
    const sh = gripShape();
    if (!sh) return;
    const dpr = devicePixelRatio, r = 4.5 * dpr;
    for (const g of gripsOf(sh)) {
      const p = W2S(g.p);
      const hot = hoverGrip && hoverGrip.kind === g.kind && hoverGrip.i === g.i;
      ctx.beginPath();
      if (g.kind === 'vertex') ctx.rect(p.x - r, p.y - r, r * 2, r * 2);
      else ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = hot ? '#ffb84d' : (g.kind === 'edge' ? '#4da3ff' : '#8cc4ff');
      ctx.fill();
      ctx.strokeStyle = '#0b1520'; ctx.lineWidth = 1.2 * dpr; ctx.stroke();
    }
  }
  /* Click a dimension on the drawing and retype it. Drawing a rectangle
     roughly and then correcting the numbers on the bed is how this actually
     gets used - the panel on the right is the long way round, and the entry
     box that appears mid-drag disappears the moment the button is released. */
  function hitSizeLabel(sp) {
    for (const h of sizeHits) {
      if (sp.x >= h.x && sp.x <= h.x + h.w && sp.y >= h.y && sp.y <= h.y + h.h) return h;
    }
    return null;
  }
  function openSizeEditor(hit) {
    const sh = job.shapes.find(x => x.id === hit.id);
    if (!sh) return;
    const dpr = devicePixelRatio;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.id = 'sizeEdit';
    inp.value = fmtIn(hit.value);
    inp.title = hit.label;
    inp.style.left = Math.round(hit.x / dpr - 2) + 'px';
    inp.style.top = Math.round(hit.y / dpr - 2) + 'px';
    inp.style.width = Math.max(58, Math.round(hit.w / dpr) + 22) + 'px';
    $('#center').appendChild(inp);
    inp.focus(); inp.select();
    let done = false;
    const finish = (save) => {
      if (done) return; done = true;
      const v = parseFloat(inp.value);
      inp.remove();
      if (save && isFinite(v) && v > 0) applySize(sh, hit.key, v);
      draw();
    };
    inp.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', () => finish(true));
  }
  /* Apply a retyped dimension. A rectangle keeps its bottom-left corner and a
     circle keeps its centre, since those are the points the operator placed.
     Anything else is scaled about its lower-left bound, which keeps it where
     it was nested. */
  function applySize(sh, key, v) {
    snapshot();
    if (sh.kind === 'rect' && (key === 'w' || key === 'h')) sh[key] = v;
    else if (sh.kind === 'circle' && key === 'r') sh.r = v;
    else if (sh.kind === 'ellipse') { if (key === 'dx') sh.rx = v / 2; else sh.ry = v / 2; }
    else {
      const b = shapeBBox(sh);
      const cur = key === 'w' ? b.w : b.h;
      if (!(cur > 1e-9)) { LOG.warn('Cannot resize a part with no extent'); return; }
      const f = v / cur;
      scaleShape(sh, key === 'w' ? f : 1, key === 'h' ? f : 1, b);
    }
    delete sh.startPt;
    invalidateLoops();
    LOG.action(`Set ${key === 'r' ? 'radius' : key === 'h' || key === 'dy' ? 'height' : 'width'} of "${sh.name}" to ${fmtIn(v)} in`);
    refresh();
  }

  function hitGrip(wp) {
    const sh = gripShape();
    if (!sh) return null;
    const tol = 8 * devicePixelRatio / view.scale;
    let best = null;
    for (const g of gripsOf(sh)) {
      const d = G.dist(g.p, wp);
      // vertices win ties so a straight edge's midpoint grip can't block a corner
      if (d < tol && (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) < 1e-9 && g.kind === 'vertex'))) best = { ...g, d, sh };
    }
    return best;
  }
  function tracePath(loop, open) {
    ctx.beginPath();
    loop.forEach((s, i) => {
      const a = W2S(s.a); if (i === 0) ctx.moveTo(a.x, a.y);
      if (s.type === 'line') { const b = W2S(s.b); ctx.lineTo(b.x, b.y); }
      else { const c = W2S(s.c); const r = G.radius(s) * view.scale; const a0 = Math.atan2(-(s.a.y - s.c.y), s.a.x - s.c.x), a1 = Math.atan2(-(s.b.y - s.c.y), s.b.x - s.c.x); ctx.arc(c.x, c.y, r, a0, a1, s.ccw); }
    });
    if (!open) ctx.closePath();
  }
  const fmtIn = (v) => (Math.round(v * 10000) / 10000).toString();

  // ---------- mouse ----------
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('wheel', e => {
    e.preventDefault(); const r = cv.getBoundingClientRect(); const px = (e.clientX - r.left) * devicePixelRatio, py = (e.clientY - r.top) * devicePixelRatio;
    /* Zoom is clamped. MAX puts 0.001 in at ~1.2 screen px, which is as fine as
       the post's 4-decimal output can express - going deeper only costs
       precision in the view transform without buying accuracy. MIN keeps the
       whole bed reachable. */
    const MAXZ = 1200, MINZ = 1.5;
    const before = S2W({ x: px, y: py }); const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const want = view.scale * f;
    if ((want > MAXZ && f > 1) || (want < MINZ && f < 1)) { showZoomLimit(want > MAXZ); return; }
    view.scale = Math.max(MINZ, Math.min(MAXZ, want));
    const after = S2W({ x: px, y: py }); view.ox += (after.x - before.x) * view.scale; view.oy += (after.y - before.y) * view.scale; draw();
  }, { passive: false });
  function evPos(e) { const r = cv.getBoundingClientRect(); const p = { x: (e.clientX - r.left) * devicePixelRatio, y: (e.clientY - r.top) * devicePixelRatio }; return { s: p, w: S2W(p) }; }
  function hitShape(wp) {
    const tol = 6 / view.scale;
    for (let i = job.shapes.length - 1; i >= 0; i--) {
      const sh = job.shapes[i]; const loop = worldLoop(sh);
      if (!sh.open && G.pointInLoop(wp, loop)) return sh;
      for (const s of loop) { const pts = G.samplePts(s, 0.1); for (let k = 0; k + 1 < pts.length; k++) if (distToSeg(wp, pts[k], pts[k + 1]) < tol) return sh; }
    }
    return null;
  }
  function distToSeg(p, a, b) { const d = G.sub(b, a); const L2 = G.dot(d, d) || 1; let t = G.dot(G.sub(p, a), d) / L2; t = Math.max(0, Math.min(1, t)); return G.dist(p, G.add(a, G.mul(d, t))); }

  cv.addEventListener('mousedown', e => {
    const { s, w } = evPos(e); mouse.down = true;
    if (e.button === 2 && drawing) {
      // right-click finishes the current path (matches every other CAD tool)
      if (drawing.kind === 'spline') finishSpline(); else finishPoly();
      draw(); syncDyn(); return;
    }
    if (e.button === 1 || e.button === 2 || spaceDown) { drag = { kind: 'pan', sx: s.x, sy: s.y, ox: view.ox, oy: view.oy }; return; }
    const ws = resolvePoint(w, { from: drawAnchor(), polar: e.altKey });
    if (tool === 'measure') {
      if (!measure || measure.b) measure = { a: ws, b: null, cur: ws };
      else {
        measure.b = axisLock(measure.a, ws, e.altKey);
        LOG.action(`Measured ${fmtIn(G.dist(measure.a, measure.b))} in at ${fmtAng(measure.a, measure.b)}`);
      }
      draw(); return;
    }
    if (tool === 'trim') { trimAt(w); return; }
    if (tool === 'extend') { extendAt(w); return; }
    if (tool === 'dim') { dimClick(ws); draw(); return; }
    if (tool === 'select') {
      const sizeHit = hitSizeLabel(s);
      if (sizeHit) { clearDynTarget(); openSizeEditor(sizeHit); return; }
      clearDynTarget();
      // a grip under the cursor takes precedence over selecting/moving the shape
      const g = hitGrip(w);
      if (g) {
        snapshot();
        drag = { kind: 'grip', grip: g, sh: g.sh, moved: false };
        draw(); return;
      }
      const hit = hitShape(w);
      if (hit) {
        /* Clicking a LINE picks that line. Clicking the filled inside of a
           closed part, or double-clicking anywhere on it, picks the whole
           part. Reaching for a leftover line and pressing Delete is the first
           instinct, and it should not need a tool change or a second click. */
        const onLine = edgeIndexAt(hit, w) >= 0;
        if (onLine && !e.altKey) {
          const ed = makeEditable(hit) || hit;
          const i = edgeIndexAt(ed, w);
          if (i >= 0) {
            if (e.shiftKey) { sel.add(ed.id); toggleEdge(ed.id, i); }
            else { sel.clear(); sel.add(ed.id); selEdges = [{ id: ed.id, i }]; }
            // still allow a drag from here to move the part
            drag = { kind: 'move', start: w, orig: job.shapes.filter(x => sel.has(x.id)).map(x => ({ id: x.id, x: x.x, y: x.y })), moved: false, fromEdge: true };
            refreshList(); refreshProps(); draw();
            return;
          }
        }
        if (e.shiftKey) { sel.has(hit.id) ? sel.delete(hit.id) : sel.add(hit.id); clearEdge(); }
        else if (!sel.has(hit.id)) { sel.clear(); sel.add(hit.id); clearEdge(); }
        else clearEdge();
        expandGroups();
        drag = { kind: 'move', start: w, orig: job.shapes.filter(x => sel.has(x.id)).map(x => ({ id: x.id, x: x.x, y: x.y })), moved: false };
      } else { if (!e.shiftKey) sel.clear(); clearEdge(); drag = { kind: 'marquee', a: w, cur: w }; }
      refreshList(); refreshProps(); draw();
    } else if (tool === 'rect' || tool === 'circle' || tool === 'ellipse') {
      drawing = { kind: tool, a: ws, b: ws };
      syncDyn();
    } else if (tool === 'arc') {
      // 3 clicks: start, end, then a point the arc passes through
      if (!drawing) drawing = { kind: 'arc', stage: 1, a: ws, b: null, cur: ws };
      else if (drawing.stage === 1) { drawing.b = ws; drawing.stage = 2; drawing.cur = ws; }
      else finishArc(ws);
      draw();
    } else if (tool === 'poly' || tool === 'pline' || tool === 'spline') {
      if (!drawing) drawing = { kind: tool, pts: [ws], cur: ws };
      else if (tool === 'spline') { if (G.dist(ws, drawing.pts[0]) < 6 / view.scale && drawing.pts.length > 2) { drawing.closeIt = true; finishSpline(); } else drawing.pts.push(ws); }
      else { if (G.dist(ws, drawing.pts[0]) < 4 / view.scale && drawing.pts.length > 2 && tool === 'poly') finishPoly(); else drawing.pts.push(ws); }
      draw();
    }
  });
  // the point ortho measures from: the last placed point of whatever is in progress
  function drawAnchor() {
    if (drawing) {
      if (drawing.kind === 'poly' || drawing.kind === 'pline') return drawing.pts[drawing.pts.length - 1];
      if (drawing.kind === 'arc') return drawing.stage === 1 ? drawing.a : null;
      return drawing.a;
    }
    if (tool === 'measure' && measure && !measure.b) return measure.a;
    return null;
  }
  function finishArc(p3) {
    const d = drawing; drawing = null;
    if (!d || !d.b) { draw(); return; }
    const seg = arcThrough(d.a, d.b, p3);
    if (!seg) { toast('Those three points are in a straight line'); LOG.warn('Arc rejected: collinear points'); draw(); return; }
    // stored as a 2-point open poly whose single edge carries the bulge
    const x0 = Math.min(d.a.x, d.b.x), y0 = Math.min(d.a.y, d.b.y);
    const sag = sagitta(d.a, d.b, p3);
    const sh = makeShape('poly', {
      name: 'arc', x: x0, y: y0, open: true, op: 'on',
      pts: [{ x: d.a.x - x0, y: d.a.y - y0, r: 0, arcR: arcRFromGeometry(G.dist(d.a, d.b), sag) },
            { x: d.b.x - x0, y: d.b.y - y0, r: 0, arcR: 0 }],
    });
    LOG.action(`Arc added: R ${fmtIn(G.radius(seg))}, bulge ${fmtIn(sag)}`);
    addShape(sh);
  }
  cv.addEventListener('dblclick', e => {
    if (drawing && (drawing.kind === 'poly' || drawing.kind === 'pline')) { drawing.pts.pop(); finishPoly(); return; }
    if (tool !== 'select') return;
    // double-click steps back out from a side to the whole part
    const { w } = evPos(e);
    const hit = hitShape(w);
    if (!hit) return;
    clearEdge(); sel.clear(); sel.add(hit.id); expandGroups();
    drag = null;
    refreshList(); refreshProps(); draw();
  });
  cv.addEventListener('mousemove', e => {
    const { s, w } = evPos(e); mouse = { ...mouse, x: s.x, y: s.y, wx: w.x, wy: w.y };
    const excl = drag && drag.kind === 'grip' ? new Set([drag.sh.id]) : undefined;
    const ws = resolvePoint(w, { from: drawAnchor(), polar: e.altKey, exclude: excl });
    $('#stX').textContent = ws.x.toFixed(4); $('#stY').textContent = ws.y.toFixed(4);
    const tag = $('#cursorTag'); tag.style.display = 'block'; tag.style.left = (s.x / devicePixelRatio + 16) + 'px'; tag.style.top = (s.y / devicePixelRatio + 16) + 'px';
    tag.textContent = `${ws.x.toFixed(coordDp())}, ${ws.y.toFixed(coordDp())}` + (lastSnap && lastSnap.type !== 'grid' ? `  ${SNAP_LABEL[lastSnap.type]}` : '');
    $('#stSnap').textContent = (S.snap.ortho || orthoTemp ? 'ORTHO ' : '') + (lastSnap ? SNAP_LABEL[lastSnap.type] : '');
    if (drag) {
      if (drag.kind === 'pan') { view.ox = drag.ox + (s.x - drag.sx); view.oy = drag.oy - (s.y - drag.sy); }
      else if (drag.kind === 'move') {
        if (!drag.moved) { snapshot(); drag.moved = true; }
        let dx = w.x - drag.start.x, dy = w.y - drag.start.y;
        if (S.snap.ortho || orthoTemp) { const o = SNAP.ortho({ x: 0, y: 0 }, { x: dx, y: dy }, e.altKey); dx = o.p.x; dy = o.p.y; }
        const sv = snapV(); if (sv) { dx = Math.round(dx / sv) * sv; dy = Math.round(dy / sv) * sv; }
        /* Snap the grabbed point itself onto other geometry, so dragging a part
           by one of its corners lands that corner exactly on another part. */
        if (S.snap.on && !(S.snap.ortho || orthoTemp)) {
          const moving = new Set(drag.orig.map(o => o.id));
          const held = { x: drag.start.x + dx, y: drag.start.y + dy };
          const hit = SNAP.snapPoint(held, snapLoops(moving), snapTol(), {
            enabled: { ...S.snap.types, grid: false }, gridStep: 0, exclude: moving,
          });
          if (hit) { dx += hit.p.x - held.x; dy += hit.p.y - held.y; lastSnap = hit; }
          else lastSnap = null;
        }
        for (const o of drag.orig) { const sh = job.shapes.find(x => x.id === o.id); sh.x = o.x + dx; sh.y = o.y + dy; }
        refreshProps();
      } else if (drag.kind === 'grip') { dragGrip(drag, ws); drag.moved = true; refreshProps(); }
      else if (drag.kind === 'marquee') drag.cur = w;
      draw(); return;
    }
    hoverGrip = tool === 'select' ? hitGrip(w) : null;
    // which line is under the cursor right now, so the click target is visible
    hoverEdge = null;
    if (tool === 'select' && !hoverGrip && !drag) {
      const hs = hitShape(w);
      if (hs) { const i = edgeIndexAt(hs, w); if (i >= 0) hoverEdge = { id: hs.id, i }; }
    }
    cv.style.cursor = hitSizeLabel(s) ? 'text' : hoverGrip ? (hoverGrip.kind === 'edge' ? 'ns-resize' : 'move') : 'crosshair';
    if (dynTarget && !drawing && !dynActive) placeDyn();
    if (measure && !measure.b) measure.cur = axisLock(measure.a, ws, e.altKey);
    if (dimDraft && dimDraft.b) { const d = dimDraft, dx = d.b.x - d.a.x, dy = d.b.y - d.a.y, L = Math.hypot(dx, dy) || 1; d.off = ((ws.x - d.a.x) * (-dy / L)) + ((ws.y - d.a.y) * (dx / L)); }
    else if (dimDraft) dimDraft.b = null;
    if (drawing) { if (drawing.kind === 'rect' || drawing.kind === 'circle' || drawing.kind === 'ellipse') drawing.b = ws; else drawing.cur = ws; }
    syncDyn();
    draw();
  });

  /* Drag a grip.
     vertex -> move that point.
     edge   -> bow the edge; the perpendicular offset from the chord IS the
               bulge distance, converted to the radius the geometry stores. */
  function dragGrip(d, wp) {
    const sh = d.sh, g = d.grip;
    invalidateLoops();
    const local = worldToLocal(sh, wp);
    if (sh.kind === 'rect') convertRectToPoly(sh);
    const pts = sh.pts, n = pts.length;
    if (g.kind === 'vertex') {
      pts[g.i].x = local.x; pts[g.i].y = local.y;
    } else {
      const a = pts[g.i], b = pts[(g.i + 1) % n];
      const sag = sagitta(a, b, local);
      pts[g.i].arcR = arcRFromGeometry(G.dist(a, b), sag);
      d.lastSag = sag;
    }
    // keep the local origin at the min corner so X/Y stay meaningful
    const x0 = Math.min(...pts.map(t => t.x)), y0 = Math.min(...pts.map(t => t.y));
    if (Math.abs(x0) > 1e-9 || Math.abs(y0) > 1e-9) {
      pts.forEach(t => { t.x -= x0; t.y -= y0; });
      const c = Math.cos((sh.rot || 0) * Math.PI / 180), sn = Math.sin((sh.rot || 0) * Math.PI / 180);
      sh.x += x0 * c - y0 * sn; sh.y += x0 * sn + y0 * c;
    }
    delete sh.startPt;
  }
  // a rect has no editable vertex list; promote it in place the first time a grip moves
  function convertRectToPoly(sh) {
    const rc = sh.rc || [];
    const r = sh.r || 0;
    sh.pts = [{ x: 0, y: 0 }, { x: sh.w, y: 0 }, { x: sh.w, y: sh.h }, { x: 0, y: sh.h }]
      .map((p, i) => ({ ...p, r: rc[i] != null ? rc[i] : r, arcR: 0 }));
    sh.kind = 'poly';
    delete sh.w; delete sh.h; delete sh.rc;
    LOG.info(`Rect "${sh.name}" converted to a polygon so its points can be edited`);
  }
  cv.addEventListener('mouseleave', () => { $('#cursorTag').style.display = 'none'; });
  window.addEventListener('mouseup', e => {
    mouse.down = false;
    if (drag) {
      if (drag.kind === 'marquee') {
        const a = drag.a, b = drag.cur;
        doMarquee(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
      }
      if (drag.kind === 'move' && drag.moved) { updateStats(); LOG.action(`Moved ${drag.orig.length} part(s)`); }
      if (drag.kind === 'grip' && drag.moved) {
        const g = drag.grip;
        if (g.kind === 'edge') LOG.action(`Bowed edge ${g.i + 1} of "${drag.sh.name}" to bulge ${fmtIn(drag.lastSag || 0)} in`);
        else LOG.action(`Moved point ${g.i + 1} of "${drag.sh.name}"`);
        updateStats();
      }
      drag = null; refreshList(); refreshProps(); draw(); return;
    }
    if (drawing && (drawing.kind === 'rect' || drawing.kind === 'circle' || drawing.kind === 'ellipse')) {
      const d = drawing; drawing = null;
      if (d.kind === 'ellipse') { finishEllipse(d); syncDyn(); draw(); return; }
      if (d.kind === 'rect') {
        const w = Math.abs(d.b.x - d.a.x), h = Math.abs(d.b.y - d.a.y);
        if (w > 0.01 && h > 0.01) { const sh = makeShape('rect', { x: Math.min(d.a.x, d.b.x), y: Math.min(d.a.y, d.b.y), w, h, r: 0 }); addShape(sh); dynTarget = sh.id; }
      } else {
        const r = G.dist(d.a, d.b);
        if (r > 0.01) { const sh = makeShape('circle', { x: d.a.x, y: d.a.y, r }); addShape(sh); dynTarget = sh.id; }
      }
      syncDyn();
      draw();
    }
  });
  function finishPoly() {
    const d = drawing; drawing = null; showDyn(false); if (!d || d.pts.length < 2) { draw(); return; }
    const open = d.kind === 'pline'; if (!open && d.pts.length < 3) { draw(); return; }
    const x0 = Math.min(...d.pts.map(p => p.x)), y0 = Math.min(...d.pts.map(p => p.y));
    addShape(makeShape('poly', { x: x0, y: y0, pts: d.pts.map(p => ({ x: p.x - x0, y: p.y - y0, r: 0 })), open, op: open ? 'on' : 'outside' }));
  }
  function addShape(sh) {
    snapshot();
    if (sh.kind === 'poly') normalizePoly(sh);
    job.shapes.push(sh);
    sel.clear(); sel.add(sh.id);
    autoSplitAround(sh);
    setTool('select');
    refresh();
  }

  /* When a new line lands on existing geometry, put a point in at the crossing
     and split BOTH sides of it. Without this a line drawn across a circle
     leaves two semicircles and one long diameter; with it you get the four
     quadrant arcs and the four radii, each selectable on its own.
     Only the shapes the new one actually touches are considered, so drawing in
     empty space costs nothing. */
  function autoSplitAround(sh) {
    if (S.snap.autoSplit === false) return 0;
    let bb;
    try { bb = G.bbox(worldLoop(sh)); } catch (e) { return 0; }
    const pad = trimTol();
    const near = job.shapes.filter(o => {
      if (o.id === sh.id) return false;
      let b;
      try { b = shapeBBox(o); } catch (e) { return false; }
      return !(b.x1 < bb.x0 - pad || b.x0 > bb.x1 + pad || b.y1 < bb.y0 - pad || b.y0 > bb.y1 + pad);
    });
    if (!near.length) return 0;
    const n = splitAtIntersections([sh].concat(near), pad);
    if (n) {
      LOG.action('Added ' + n + ' point(s) where "' + sh.name + '" crosses existing geometry, so each piece can be selected on its own');
      invalidateLoops();
    }
    return n;
  }
  function normalizePoly(sh) { if (!sh.open && sh.pts && sh.pts.length >= 3) sh.pts = G.normalizePolyPts(sh.pts); }

  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if ((drawAnchor() || dynTarget || (drawing && ['rect', 'circle', 'ellipse'].includes(drawing.kind))) && /^[0-9.]$/.test(e.key)) {
      const el = $('#dynLen'); if (el) { el.value = e.key; el.focus(); dynActive = true; e.preventDefault(); return; }
    }
    if (e.code === 'Space') { spaceDown = true; e.preventDefault(); }
    if (e.key === 'Shift') { orthoTemp = true; draw(); }
    if (e.key === 'Escape') { if (clearDynTarget()) { draw(); return; } if (clearEdge()) { refreshProps(); draw(); return; } drawing = null; measure = null; dimDraft = null; showDyn(false); setTool('select'); draw(); }
    if (e.key === 'Enter' && drawing) { if (drawing.kind === 'spline') finishSpline(); else finishPoly(); }
    if (e.key === 'Delete' || e.key === 'Backspace') { if (selEdges.length && deleteSelectedEdge()) return; if (!sel.size && deleteDimNear({ x: mouse.wx, y: mouse.wy })) return; deleteSel(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.shiftKey ? redo() : undo(); e.preventDefault(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { redo(); e.preventDefault(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { duplicateSel(); e.preventDefault(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { job.shapes.forEach(s => sel.add(s.id)); refresh(); e.preventDefault(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { saveProject(); e.preventDefault(); }
    if (e.key.toLowerCase() === 'f') { fitBed(); draw(); }
    if (sel.size && !e.ctrlKey && !e.metaKey) {
      const focusField = (k) => { const inp = document.querySelector(`#props [data-k="${k}"]`); if (inp) { inp.focus(); inp.select(); e.preventDefault(); } };
      if (e.key.toLowerCase() === 'x') return focusField('x');
      if (e.key.toLowerCase() === 'y') return focusField('y');
      if (e.key.toLowerCase() === 'a') return focusField('rot');
      if (e.key === '[' || e.key === ']') { rotateSel((e.key === ']' ? -1 : 1) * (e.shiftKey ? 1 : 15)); e.preventDefault(); return; }
    }
    if (e.key.toLowerCase() === 'v') setTool('select'); if (e.key.toLowerCase() === 'r') setTool('rect'); if (e.key.toLowerCase() === 'c') setTool('circle'); if (e.key.toLowerCase() === 'p') setTool('poly'); if (e.key.toLowerCase() === 'l') setTool('pline');
    if (e.key.toLowerCase() === 'a') setTool('arc');
    if (e.key.toLowerCase() === 'e') setTool('ellipse');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') { e.shiftKey ? ungroupSel() : groupSel(); e.preventDefault(); }
    if (e.key.toLowerCase() === 'm') setTool('measure');
    if (e.key.toLowerCase() === 't' && !sel.size) { openOffsetTrace(); e.preventDefault(); }
    if (e.key.toLowerCase() === 'k') { setTool('trim'); toast('Click the edge you want to remove'); }
    if (e.key.toLowerCase() === 'j' && sel.size > 1) { mergeSelected(trimTol()); e.preventDefault(); }
    if (e.key.toLowerCase() === 'd' && !e.ctrlKey && !e.metaKey) setTool('dim');
    if (e.key.toLowerCase() === 'g' && sel.size) { openMoveBy(); e.preventDefault(); }
    if (e.key === 'F8') { S.snap.ortho = !S.snap.ortho; saveSettings(); syncSnapUI(); toast('Ortho ' + (S.snap.ortho ? 'on' : 'off')); e.preventDefault(); }
    if (e.key === 'F3') { S.snap.on = !S.snap.on; saveSettings(); syncSnapUI(); toast('Object snap ' + (S.snap.on ? 'on' : 'off')); e.preventDefault(); }
    if (e.key.startsWith('Arrow') && sel.size) { const st = e.shiftKey ? 1 : (snapV() || 0.125); const dx = e.key === 'ArrowRight' ? st : e.key === 'ArrowLeft' ? -st : 0, dy = e.key === 'ArrowUp' ? st : e.key === 'ArrowDown' ? -st : 0; snapshot(); for (const sh of job.shapes) if (sel.has(sh.id)) { sh.x += dx; sh.y += dy; } refresh(); e.preventDefault(); }
  });
  window.addEventListener('keyup', e => {
    if (e.code === 'Space') spaceDown = false;
    if (e.key === 'Shift') { orthoTemp = false; draw(); }
  });
  window.addEventListener('blur', () => { orthoTemp = false; spaceDown = false; });
  function setTool(t) { clearDynTarget(); tool = t; $$('button.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t)); $('#stTool').textContent = t === 'select' ? '' : `Tool: ${t}`; updateHint(); syncDyn(); }
  $$('button.tool').forEach(b => b.addEventListener('click', () => { drawing = null; setTool(b.dataset.tool); draw(); }));

  function rotateSel(deg) {
    if (!sel.size) return; snapshot();
    for (const sh of job.shapes) if (sel.has(sh.id)) {
      // rotate about the part's bounding-box centre so it stays in place
      const bb = shapeBBox(sh); const c = { x: (bb.x0 + bb.x1) / 2, y: (bb.y0 + bb.y1) / 2 };
      sh.rot = ((sh.rot || 0) + deg) % 360; delete sh.startPt;
      const nb = shapeBBox(sh); sh.x += c.x - (nb.x0 + nb.x1) / 2; sh.y += c.y - (nb.y0 + nb.y1) / 2;
    }
    refresh();
  }
  function deleteSel() { if (!sel.size) return; snapshot(); job.shapes = job.shapes.filter(s => !sel.has(s.id)); sel.clear(); refresh(); }
  function duplicateSel() {
    if (!sel.size) return; snapshot(); const copies = [];
    for (const sh of job.shapes) if (sel.has(sh.id)) { const c = JSON.parse(JSON.stringify(sh)); c.id = job.nextId++; c.name = sh.name + ' copy'; c.x += 1; c.y += 1; delete c.startPt; copies.push(c); }
    job.shapes.push(...copies); sel = new Set(copies.map(c => c.id)); refresh();
  }
  $('#btnDel').onclick = deleteSel; $('#btnDup').onclick = duplicateSel; $('#btnUndo').onclick = undo;

  // ---------- panels ----------
  function refresh() { invalidateLoops(); refreshList(); refreshProps(); updateStats(); draw(); }
  function refreshList() {
    const el = $('#shapeList'); el.innerHTML = '';
    $('#partCount').textContent = job.shapes.length ? `(${job.shapes.length})` : '';
    for (const sh of job.shapes) {
      const d = document.createElement('div'); d.className = 'item' + (sel.has(sh.id) ? ' sel' : '');
      d.innerHTML = `<span class="nm" title="Double-click to rename">${esc(sh.name)}</span><span class="op">${sh.op}</span>`;
      d.onclick = (e) => { if (e.shiftKey) { sel.has(sh.id) ? sel.delete(sh.id) : sel.add(sh.id); } else { sel.clear(); sel.add(sh.id); } clearEdge(); refreshList(); refreshProps(); draw(); };
      // double-click the name to rename in place
      d.querySelector('.nm').ondblclick = (e) => {
        e.stopPropagation();
        const span = e.currentTarget;
        const inp = document.createElement('input');
        inp.type = 'text'; inp.value = sh.name; inp.className = 'rename';
        span.replaceWith(inp); inp.focus(); inp.select();
        let done = false;
        const commit = (save) => {
          if (done) return; done = true;
          const v = inp.value.trim();
          if (save && v && v !== sh.name) { snapshot(); sh.name = v; LOG.action(`Renamed part to "${v}"`); }
          refreshList(); refreshProps();
        };
        inp.addEventListener('keydown', ev => {
          ev.stopPropagation();
          if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
          if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
        });
        inp.addEventListener('blur', () => commit(true));
      };
      el.appendChild(d);
    }
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function refreshProps() {
    const el = $('#props');
    const shs = job.shapes.filter(s => sel.has(s.id));
    if (!shs.length) { el.innerHTML = `<p class="muted">Select a part to edit it.<br><br><b>Canvas</b><br>Wheel: zoom · Right/middle drag or <span class="kbd">Space</span>+drag: pan<br><span class="kbd">Del</span> delete · <span class="kbd">Ctrl+D</span> duplicate · <span class="kbd">Ctrl+Z</span> undo · arrows nudge<br><span class="kbd">F</span> fit bed · <span class="kbd">Esc</span> cancel tool</p>`; return; }
    const sh = shs[0]; const multi = shs.length > 1;
    const num = (k, label, step = 0.125) => `<div class="row"><label>${label}</label><input type="number" step="${step}" data-k="${k}" value="${fmtIn(sh[k] ?? 0)}"></div>`;
    // same treatment the selected edge gets: type an exact value or drag it
    const numSlide = (k, label, step = 0.125, max) => {
      const v = +(sh[k] ?? 0);
      const hi = max || Math.max(1, Math.ceil(v * 2));
      return `<div class="row"><label>${label}</label><input type="number" step="${step}" data-k="${k}" value="${fmtIn(v)}"> in</div>`
        + `<div class="row"><input type="range" class="slider" data-ks="${k}" min="${step}" max="${hi}" step="${step / 8}" value="${v}"></div>`;
    };
    let h = `<h3>${multi ? shs.length + ' parts' : esc(sh.kind)}</h3>`;
    if (!multi) h = edgePanel(sh) + h;
    if (!multi) h += `<div class="row"><label>Name</label><input type="text" data-k="name" value="${esc(sh.name)}" style="flex:1"></div>`;
    h += num('x', 'X') + num('y', 'Y');
    if (!multi && sh.kind === 'rect') {
      h += numSlide('w', 'Width') + numSlide('h', 'Height') + num('r', 'All corners R', 0.0625);
      const rc = sh.rc || [null, null, null, null]; const lab = ['BL', 'BR', 'TR', 'TL'];
      h += `<div class="row"><label>Corner R</label>` + lab.map((l, i) => `<span class="muted">${l}</span><input type="number" step="0.0625" data-rc="${i}" value="${rc[i] != null ? fmtIn(rc[i]) : ''}" placeholder="${fmtIn(sh.r || 0)}" style="width:58px">`).join('') + `</div>`;
    }
    if (!multi && sh.kind === 'ellipse') h += numSlide('rx', 'Radius X', 0.0625) + numSlide('ry', 'Radius Y', 0.0625);
    if (!multi && sh.textSpec) h += `<div class="row"><button class="small" id="btnEditText">Edit text…</button></div>`;
    if (!multi && sh.group) h += `<div class="row muted">In group ${esc(sh.group)}</div>`;
    if (!multi && sh.kind === 'circle') h += numSlide('r', 'Radius', 0.0625) + `<div class="row"><label>Diameter</label><input type="number" step="0.125" data-k="dia" value="${fmtIn(sh.r * 2)}"> in</div>`;
    if (!multi && sh.kind === 'poly' && !sh.open) h += `<div class="row"><label>All corners R</label><input type="number" step="0.0625" data-k="allr" value="${fmtIn(sh.pts[0].r || 0)}"></div>`;
    if (!multi && sh.kind === 'poly') h += polyTable(sh);
    h += num('rot', 'Rotation °', 15) + `<div class="row"><label></label><button class="small" data-rot="-90">↺ 90</button><button class="small" data-rot="90">↻ 90</button><button class="small" data-rot="-15">↺ 15</button><button class="small" data-rot="15">↻ 15</button></div>`;
    const bb = shapeBBox(sh);
    if (!multi) h += `<div class="row muted">Size ${fmtIn(bb.w)} × ${fmtIn(bb.h)}</div>`;
    h += `<h3>Cut</h3><div class="row"><label>Operation</label><select data-k="op">${['outside', 'inside', 'on', 'none'].map(o => `<option ${sh.op === o ? 'selected' : ''} ${o !== 'on' && o !== 'none' && sh.open ? 'disabled' : ''}>${o}</option>`).join('')}</select></div>`;
    h += `<div class="row"><label>Tool</label><select data-k="toolId">${S.tools.map(t => `<option value="${t.id}" ${t.id === sh.toolId ? 'selected' : ''}>T${t.slot} ${esc(t.name)}</option>`).join('')}</select></div>`;
    h += `<div class="row"><label>Climb</label><input type="checkbox" data-k="climb" ${sh.climb ? 'checked' : ''}> <span class="muted">reverse direction</span></div>`;
    if (!multi) h += `<div class="row"><button class="small" id="btnSetStart">Set start point</button><button class="small" id="btnClearStart">Auto start</button></div>`;
    h += `<div class="row"><button class="small" id="btnMirror">Mirror</button><button class="small" id="btnToOrigin">To 0,0</button></div>`;
    h += `<p class="muted" style="font-size:11px">Keys: <span class="kbd">X</span> <span class="kbd">Y</span> <span class="kbd">A</span> jump to X / Y / angle · <span class="kbd">[</span> <span class="kbd">]</span> rotate 15° (Shift = 1°) · arrows nudge</p>`;
    el.innerHTML = h;
    el.querySelectorAll('[data-rot]').forEach(b => b.onclick = () => rotateSel(parseFloat(b.dataset.rot)));
    el.querySelectorAll('[data-rc]').forEach(inp => inp.addEventListener('change', () => { snapshot(); sh.rc = sh.rc || [null, null, null, null]; sh.rc[+inp.dataset.rc] = inp.value === '' ? null : parseFloat(inp.value); delete sh.startPt; refresh(); }));
    el.querySelectorAll('[data-pv]').forEach(inp => inp.addEventListener('change', () => { snapshot(); polyEdit(sh, inp.dataset.pv, +inp.dataset.i, parseFloat(inp.value)); delete sh.startPt; refresh(); }));
    const pb = $('#btnPolyBuild'); if (pb) pb.onclick = () => openPolyBuilder(sh);
    el.querySelectorAll('tr.edgeRow').forEach(tr => tr.addEventListener('click', (ev) => {
      if (ev.target.tagName === 'INPUT') return;      // let the number fields work
      makeEditable(sh);
      if (ev.shiftKey) toggleEdge(sh.id, +tr.dataset.edge); else selEdges = [{ id: sh.id, i: +tr.dataset.edge }];
      refreshProps(); draw();
    }));
    el.querySelectorAll('[data-ks]').forEach(sl => {
      sl.addEventListener('pointerdown', () => snapshot());
      sl.addEventListener('input', () => {
        const k = sl.dataset.ks, v = parseFloat(sl.value);
        if (!isFinite(v) || v <= 0) return;
        sh[k] = v; delete sh.startPt;
        const num2 = el.querySelector(`[data-k="${k}"]`);
        if (num2) num2.value = fmtIn(v);
        const dia = el.querySelector('[data-k="dia"]');
        if (dia && k === 'r') dia.value = fmtIn(v * 2);
        invalidateLoops(); updateStats(); draw();
      });
      sl.addEventListener('change', () => { refreshList(); refreshProps(); });
    });
    wireEdgePanel(el, sh);
    const et = $('#btnEditText'); if (et) et.onclick = () => openText({ ...sh.textSpec, x: (sh.textAt || sh).x, y: (sh.textAt || sh).y, group: sh.group });
    el.querySelectorAll('[data-k]').forEach(inp => {
      inp.addEventListener('change', () => {
        snapshot();
        const k = inp.dataset.k; let v = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? parseFloat(inp.value) : inp.value;
        if (inp.tagName === 'SELECT' && k === 'toolId') v = parseInt(v, 10);
        for (const s of shs) {
          if (k === 'dia') s.r = v / 2; else if (k === 'allr') s.pts.forEach(p => p.r = v); else s[k] = v;
          if (k === 'w' || k === 'h' || k === 'r' || k === 'dia' || k === 'rot' || k === 'allr') delete s.startPt;
        }
        refresh();
      });
    });
    const bs = $('#btnSetStart'); if (bs) bs.onclick = () => { toast('Click on the part outline to set the start point'); const h2 = (e) => { const { w } = evPos(e); snapshot(); sh.startPt = w; cv.removeEventListener('mousedown', h2, true); e.stopPropagation(); refresh(); }; cv.addEventListener('mousedown', h2, true); };
    const bc = $('#btnClearStart'); if (bc) bc.onclick = () => { snapshot(); delete sh.startPt; refresh(); };
    $('#btnMirror').onclick = () => { snapshot(); for (const s of shs) { const bb = shapeBBox(s); const cx = (bb.x0 + bb.x1) / 2; if (s.kind === 'rect' || s.kind === 'circle') { /* symmetric */ } else if (s.kind === 'poly') { const w = Math.max(...s.pts.map(p => p.x)); s.pts = s.pts.map(p => ({ ...p, x: w - p.x })); } else if (s.kind === 'path') { const l = G.mirrorLoopX(s.loop, 0); const b2 = G.bbox(l); s.loop = G.translateLoop(l, -b2.x0, 0); } delete s.startPt; } refresh(); };
    $('#btnToOrigin').onclick = () => { snapshot(); for (const s of shs) { const bb = shapeBBox(s); s.x -= bb.x0 - S.nest.margin; s.y -= bb.y0 - S.nest.margin; } refresh(); };
  }

  // ---------- polygon dimension editing ----------
  const deg = (r) => r * 180 / Math.PI, rad = (d) => d * Math.PI / 180;
  function polyTable(sh) {
    const pts = sh.pts, n = pts.length; const closed = !sh.open;
    let h = `<h3>Points &amp; edges <span class="muted">(from part origin)</span></h3><div><table style="font-size:11px" id="ptTable"><thead><tr><th>#</th><th>X</th><th>Y</th><th>Fillet R</th><th>Angle</th></tr><tr><th></th><th>edge len</th><th>dir °</th><th>arc R</th><th>bulge</th></tr></thead><tbody>`;
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      let ia = '';
      if (closed || (i > 0 && i < n - 1)) { const a = pts[(i - 1 + n) % n]; const d1 = G.norm(G.sub(a, p)), d2 = G.norm(G.sub(q, p)); const ang = deg(Math.acos(Math.max(-1, Math.min(1, G.dot(d1, d2))))); const cr = G.cross(d1, d2); ia = (cr < 0 ? ang : 360 - ang).toFixed(1) + '°'; }
      h += `<tr><td>P${i + 1}</td><td><input type="number" step="0.125" data-pv="x" data-i="${i}" value="${fmtIn(p.x)}"></td><td><input type="number" step="0.125" data-pv="y" data-i="${i}" value="${fmtIn(p.y)}"></td><td>${closed ? `<input type="number" step="0.0625" data-pv="r" data-i="${i}" value="${fmtIn(p.r || 0)}">` : ''}</td><td class="muted">${ia}</td></tr>`;
      if (closed || i < n - 1) { const L = G.dist(p, q), A = deg(Math.atan2(q.y - p.y, q.x - p.x)); const sg = edgeSagitta(sh, i); h += `<tr class="edgeRow${isEdgeSel(sh.id, i) ? ' edgeSel' : ''}" data-edge="${i}" style="color:var(--muted)"><td title="Click to select this side">→P${(i + 1) % n + 1}</td><td><input type="number" step="0.125" data-pv="len" data-i="${i}" value="${fmtIn(L)}"></td><td><input type="number" step="1" data-pv="ang" data-i="${i}" value="${(+A.toFixed(2))}"></td><td><input type="number" step="0.125" data-pv="arcR" data-i="${i}" value="${p.arcR ? fmtIn(p.arcR) : ''}" placeholder="0"></td><td><input type="number" step="0.0625" data-pv="sag" data-i="${i}" value="${sg ? fmtIn(sg) : ''}" placeholder="0"></td></tr>`; }
    }
    h += `</tbody></table></div><div class="row"><button class="small" id="btnPolyBuild">Edit by lengths &amp; angles…</button></div><p class="muted" style="font-size:11px">Edge dir: 0° = right, 90° = up. Angle column = inside angle at the point.<br><b>Bulge</b> is how far the edge bows out from its straight chord — the distance you can measure on the part. Type it here, or drag the round grip at the middle of the edge. <b>Arc R</b> is the same curve expressed as a radius. + bulges out, − bulges in.</p>`;
    return h;
  }
  function polyEdit(sh, k, i, v) {
    const pts = sh.pts, n = pts.length; const p = pts[i], q = pts[(i + 1) % n];
    if (k === 'x') p.x = v; else if (k === 'y') p.y = v; else if (k === 'r') p.r = Math.max(0, v || 0); else if (k === 'arcR') p.arcR = isNaN(v) ? 0 : v;
    else if (k === 'sag') p.arcR = isNaN(v) ? 0 : sagittaToArcR(G.dist(p, q), v);
    else if (k === 'len' || k === 'ang') { const L = k === 'len' ? v : G.dist(p, q); const A = k === 'ang' ? rad(v) : Math.atan2(q.y - p.y, q.x - p.x); q.x = p.x + L * Math.cos(A); q.y = p.y + L * Math.sin(A); }
    // keep local origin at the min corner
    const x0 = Math.min(...pts.map(t => t.x)), y0 = Math.min(...pts.map(t => t.y));
    if (Math.abs(x0) > 1e-9 || Math.abs(y0) > 1e-9) { pts.forEach(t => { t.x -= x0; t.y -= y0; }); const c = Math.cos(rad(sh.rot || 0)), sn = Math.sin(rad(sh.rot || 0)); sh.x += x0 * c - y0 * sn; sh.y += x0 * sn + y0 * c; }
    if (!sh.open) normalizePoly(sh);
  }
  // builder: successive edges by length + direction (or turn angle); the last edge closes the shape automatically
  function openPolyBuilder(existing) {
    const ov = document.createElement('div'); ov.className = 'overlay';
    let rows = [];
    if (existing) { const pts = existing.pts, n = pts.length; for (let i = 0; i < (existing.open ? n - 1 : n - 1); i++) { const p = pts[i], q = pts[i + 1]; rows.push({ len: +G.dist(p, q).toFixed(4), ang: +deg(Math.atan2(q.y - p.y, q.x - p.x)).toFixed(3) }); } }
    if (!rows.length) rows = [{ len: 10, ang: 0 }, { len: 6, ang: 90 }, { len: 10, ang: 180 }];
    ov.innerHTML = `<div class="dialog"><h3>${existing ? 'Edit' : 'New'} polygon by lengths &amp; angles</h3>
      <p class="muted">Enter each side in order, starting from the bottom-left point going right. Direction: 0° = right, 90° = up, 180° = left, 270° = down (absolute). Or tick "turn" to enter the turn angle from the previous side (left = +). The final side back to the start is closed automatically and shown below.</p>
      <div class="row"><label><input type="checkbox" id="pbTurn"> Angles are turns</label><label><input type="checkbox" id="pbOpen" ${existing && existing.open ? 'checked' : ''}> Open path (no auto-close)</label></div>
      <table><thead><tr><th>#</th><th>Length</th><th>Angle °</th><th></th></tr></thead><tbody id="pbRows"></tbody></table>
      <div class="row"><button class="small" id="pbAdd">+ Add side</button><span id="pbClose" class="muted"></span></div>
      <div class="row" style="margin-top:10px"><button class="primary" id="pbOk">${existing ? 'Apply' : 'Create part'}</button><button id="pbCancel">Cancel</button></div></div>`;
    document.body.appendChild(ov);
    const render = () => {
      const tb = ov.querySelector('#pbRows'); tb.innerHTML = rows.map((r, i) => `<tr><td>${i + 1}</td><td><input type="number" step="0.125" data-f="len" data-i="${i}" value="${r.len}"></td><td><input type="number" step="1" data-f="ang" data-i="${i}" value="${r.ang}"></td><td><button class="small" data-del="${i}">✕</button></td></tr>`).join('');
      tb.querySelectorAll('input').forEach(inp => inp.addEventListener('change', () => { rows[+inp.dataset.i][inp.dataset.f] = parseFloat(inp.value) || 0; update(); }));
      tb.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { rows.splice(+b.dataset.del, 1); render(); update(); });
      update();
    };
    const compute = () => {
      const turn = ov.querySelector('#pbTurn').checked; const pts = [{ x: 0, y: 0 }]; let a = 0;
      for (const r of rows) { a = turn ? a + r.ang : r.ang; const p = pts[pts.length - 1]; pts.push({ x: p.x + r.len * Math.cos(rad(a)), y: p.y + r.len * Math.sin(rad(a)) }); }
      return pts;
    };
    const update = () => {
      const pts = compute(); const last = pts[pts.length - 1]; const L = G.dist(last, pts[0]); const A = deg(Math.atan2(-last.y, -last.x));
      ov.querySelector('#pbClose').textContent = ov.querySelector('#pbOpen').checked ? '' : (L < 1e-6 ? 'Shape closes exactly.' : `Closing side: ${fmtIn(L)} long at ${(+A.toFixed(2))}°`);
    };
    ov.querySelector('#pbTurn').onchange = () => { // convert between absolute and turn representations
      const turn = ov.querySelector('#pbTurn').checked; let prev = 0; rows = rows.map(r => { const out = { ...r }; if (turn) { out.ang = +(r.ang - prev).toFixed(3); prev = r.ang; } else { prev += r.ang; out.ang = +prev.toFixed(3); } return out; }); render(); };
    ov.querySelector('#pbOpen').onchange = update;
    ov.querySelector('#pbAdd').onclick = () => { rows.push({ len: 6, ang: 0 }); render(); };
    ov.querySelector('#pbCancel').onclick = () => ov.remove();
    ov.querySelector('#pbOk').onclick = () => {
      let pts = compute(); const open = ov.querySelector('#pbOpen').checked;
      if (!open && G.dist(pts[pts.length - 1], pts[0]) < 1e-6) pts.pop();
      if (pts.length < (open ? 2 : 3)) return toast('Need more sides');
      const x0 = Math.min(...pts.map(p => p.x)), y0 = Math.min(...pts.map(p => p.y));
      const local = pts.map((p, i) => ({ x: p.x - x0, y: p.y - y0, r: existing?.pts?.[i]?.r || 0, arcR: existing?.pts?.[i]?.arcR || 0 }));
      snapshot();
      if (existing) { existing.pts = local; existing.open = open; if (open) existing.op = 'on'; delete existing.startPt; normalizePoly(existing); }
      else { const sh = makeShape('poly', { x: S.nest.margin, y: S.nest.margin, pts: local, open, op: open ? 'on' : 'outside' }); job.shapes.push(sh); sel.clear(); sel.add(sh.id); }
      ov.remove(); refresh();
    };
    render();
  }
  $('#btnPolyDims').onclick = () => openPolyBuilder(null);

  // ================= trace a paper template from offsets =================
  /* The shop method: lay the cut-out down with one square corner on 0,0 and the
     second square corner along X. That distance is the baseline. Then step
     along it at a fixed interval - 1 in - and measure the perpendicular
     distance up to the curved edge at each station. Type those numbers in and
     the curve is rebuilt exactly.
     No camera, no perspective error, and the accuracy is whatever your ruler
     and square give you. */
  function openOffsetTrace() {
    modal(`<h3>Trace a template from measurements</h3>
      <p class="muted">Lay the cut-out with one square corner on <b>0,0</b> and the second square corner along the baseline.
      Step along the baseline and measure straight up to the curved edge at each station.</p>
      <div class="row"><label>Station step</label><input type="number" step="0.25" id="otStep" value="1"> in
        <label style="min-width:0"><input type="checkbox" id="otPairs"> lines are <code>station,offset</code></label></div>
      <div class="row"><label>Baseline runs</label><select id="otDir" style="flex:1">
        <option value="x">Along X — measure offsets in Y (square corner at 0,0, second along X)</option>
        <option value="y">Along Y — measure offsets in X</option>
      </select></div>
      <div class="row"><label style="align-self:flex-start">Offsets</label>
        <textarea id="otVals" style="flex:1;min-height:120px" placeholder="One measurement per line, starting at the corner:&#10;0&#10;0.42&#10;0.95&#10;1.6&#10;2.3&#10;..."></textarea></div>
      <div class="row"><label>Ends</label><select id="otClose" style="flex:1">
        <option value="square">Close with square corners back to the baseline</option>
        <option value="open">Leave the curve open (cut on the line)</option>
      </select></div>
      <div class="row"><label>Curve fit</label><select id="otFit" style="flex:1">
        <option value="arc">Fit arcs where they match — smoother, faster cut</option>
        <option value="poly">Keep every measured point as straight segments</option>
      </select>
        <input type="number" step="0.001" id="otTol" value="0.01" style="width:74px"> in tol</div>
      <p class="muted" id="otNote" style="font-size:11px"></p>
      <div class="row" style="margin-top:10px"><button class="primary" id="otOk">Create part</button><button id="otCancel">Cancel</button></div>`,
      (ov, close) => {
        const V = ov.querySelector('#otVals'), NOTE = ov.querySelector('#otNote');
        const parse = () => {
          const step = parseFloat(ov.querySelector('#otStep').value) || 1;
          const pairs = ov.querySelector('#otPairs').checked;
          const pts = [];
          const bad = [];
          V.value.split(/[\n;]+/).forEach((raw, i) => {
            const t = raw.trim();
            if (!t) return;
            if (pairs) {
              const m = t.split(/[,\s]+/).map(Number);
              if (m.length < 2 || !isFinite(m[0]) || !isFinite(m[1])) { bad.push(t); return; }
              pts.push({ s: m[0], o: m[1] });
            } else {
              const v = Number(t.replace(/"$/, ''));
              if (!isFinite(v)) { bad.push(t); return; }
              pts.push({ s: pts.length * step, o: v });
            }
          });
          return { pts, bad, step };
        };
        const refresh2 = () => {
          const { pts, bad } = parse();
          const span = pts.length ? (pts[pts.length - 1].s - pts[0].s) : 0;
          NOTE.innerHTML = pts.length
            ? `${pts.length} stations over a ${fmtIn(span)} in baseline` + (bad.length ? ` · <span style="color:var(--warn)">ignoring ${bad.length} unreadable line(s): ${esc(bad.slice(0, 3).join(', '))}</span>` : '')
            : 'Paste or type one measurement per line.';
        };
        V.addEventListener('input', refresh2);
        ov.querySelector('#otStep').addEventListener('input', refresh2);
        ov.querySelector('#otPairs').addEventListener('change', refresh2);
        refresh2();
        ov.querySelector('#otCancel').onclick = close;
        ov.querySelector('#otOk').onclick = () => {
          const { pts } = parse();
          if (pts.length < 2) { toast('Enter at least two measurements'); return; }
          const alongY = ov.querySelector('#otDir').value === 'y';
          const closeIt = ov.querySelector('#otClose').value === 'square';
          const fitArcs = ov.querySelector('#otFit').value === 'arc';
          const tol = parseFloat(ov.querySelector('#otTol').value) || 0.01;
          const made = buildFromOffsets(pts, { alongY, closeIt, fitArcs, tol });
          if (made) close();
        };
      });
  }

  function buildFromOffsets(pts, opts) {
    // station/offset -> world points, in the chosen orientation
    const P = pts.map(p => opts.alongY ? { x: p.o, y: p.s } : { x: p.s, y: p.o });
    // a spline passes THROUGH every measured point, which is the whole point here
    let curve = G.splineLoop(P, false, 12);
    if (!curve.length) { toast('Those measurements do not make a curve'); return 0; }

    if (opts.fitArcs) {
      // resample the spline and refit arcs, so the cut runs G2/G3 rather than
      // thousands of tiny moves - same treatment the boolean results get
      const poly = [];
      for (const sg of curve) poly.push({ x: sg.a.x, y: sg.a.y });
      const last = curve[curve.length - 1].b;
      poly.push({ x: last.x, y: last.y });
      try {
        const fitted = BOOL.refit(poly, opts.tol);
        // refit closes the ring; keep only the run that spans our open curve
        if (fitted && fitted.length) {
          const open = [];
          for (const sg of fitted) {
            open.push(sg);
            if (G.same(sg.b, last, 1e-6)) break;
          }
          if (open.length) curve = open;
        }
      } catch (e) { LOG.warn('Arc fitting failed on the traced curve, keeping segments', e); }
    }

    const a0 = curve[0].a, a1 = curve[curve.length - 1].b;
    let loop = curve;
    if (opts.closeIt) {
      // drop square onto the baseline at both ends and close along it
      const base0 = opts.alongY ? { x: 0, y: a0.y } : { x: a0.x, y: 0 };
      const base1 = opts.alongY ? { x: 0, y: a1.y } : { x: a1.x, y: 0 };
      const segs = curve.slice();
      if (G.dist(a1, base1) > 1e-6) segs.push(G.line(G.P(a1.x, a1.y), G.P(base1.x, base1.y)));
      if (G.dist(base1, base0) > 1e-6) segs.push(G.line(G.P(base1.x, base1.y), G.P(base0.x, base0.y)));
      if (G.dist(base0, a0) > 1e-6) segs.push(G.line(G.P(base0.x, base0.y), G.P(a0.x, a0.y)));
      loop = segs;
    }
    snapshot();
    const sh = pathShape(loop, {
      name: 'template', open: !opts.closeIt,
      op: opts.closeIt ? 'outside' : 'on',
    });
    job.shapes.push(sh);
    sel.clear(); sel.add(sh.id);
    const arcs = loop.filter(s => s.type === 'arc').length;
    LOG.action(`Template traced from ${pts.length} measurements — ${loop.length} segments`
      + (arcs ? `, ${arcs} fitted as arcs` : '') + (opts.closeIt ? ', closed to the baseline' : ', left open'));
    toast(`Traced ${pts.length} points into ${loop.length} segments${arcs ? ` (${arcs} arcs)` : ''}`);
    refresh(); fitBed(); draw();
    return loop.length;
  }
  $('#btnOffsetTrace').onclick = openOffsetTrace;


  // ---------- modal helper ----------
  function modal(html, wire) {
    const ov = document.createElement('div'); ov.className = 'overlay';
    ov.innerHTML = `<div class="dialog">${html}</div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
    const esc = (e) => { if (e.key === 'Escape') { close(); window.removeEventListener('keydown', esc, true); } };
    window.addEventListener('keydown', esc, true);
    wire(ov, close);
    const first = ov.querySelector('input,select'); if (first) { first.focus(); if (first.select) first.select(); }
    return ov;
  }
  const selShapes = () => job.shapes.filter(s => sel.has(s.id));

  // ---------- move by an exact distance ----------
  function openMoveBy() {
    if (!sel.size) return toast('Select something first');
    modal(`<h3>Move ${sel.size} part${sel.size > 1 ? 's' : ''} by</h3>
      <div class="row"><label>ΔX</label><input type="number" step="0.125" id="mvX" value="0"> in</div>
      <div class="row"><label>ΔY</label><input type="number" step="0.125" id="mvY" value="0"> in</div>
      <p class="muted">— or by distance and direction (0° = right, 90° = up) —</p>
      <div class="row"><label>Distance</label><input type="number" step="0.125" id="mvD" value=""> in</div>
      <div class="row"><label>Angle</label><input type="number" step="15" id="mvA" value="0"> °</div>
      <div class="row" style="margin-top:10px"><button class="primary" id="mvOk">Move</button><button id="mvCancel">Cancel</button></div>`,
      (ov, close) => {
        ov.querySelector('#mvCancel').onclick = close;
        const go = () => {
          const d = parseFloat(ov.querySelector('#mvD').value);
          let dx, dy;
          if (!isNaN(d) && d !== 0) { const a = (parseFloat(ov.querySelector('#mvA').value) || 0) * Math.PI / 180; dx = d * Math.cos(a); dy = d * Math.sin(a); }
          else { dx = parseFloat(ov.querySelector('#mvX').value) || 0; dy = parseFloat(ov.querySelector('#mvY').value) || 0; }
          if (!dx && !dy) return close();
          snapshot();
          for (const sh of selShapes()) { sh.x += dx; sh.y += dy; }
          LOG.action(`Moved ${sel.size} part(s) by ${fmtIn(dx)}, ${fmtIn(dy)} in`);
          close(); refresh();
        };
        ov.querySelector('#mvOk').onclick = go;
        ov.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') go(); }));
      });
  }

  // ---------- scale ----------
  function openScale() {
    if (!sel.size) return toast('Select something first');
    const shs = selShapes();
    const bb0 = groupBBox(shs);
    modal(`<h3>Scale ${shs.length} part${shs.length > 1 ? 's' : ''}</h3>
      <p class="muted">Current size ${fmtIn(bb0.w)} × ${fmtIn(bb0.h)} in</p>
      <div class="row"><label>Factor</label><input type="number" step="0.1" id="scF" value="1"></div>
      <p class="muted">— or scale to a target size —</p>
      <div class="row"><label>Width</label><input type="number" step="0.125" id="scW" value="${fmtIn(bb0.w)}"> in</div>
      <div class="row"><label>Height</label><input type="number" step="0.125" id="scH" value="${fmtIn(bb0.h)}"> in</div>
      <div class="row"><label><input type="checkbox" id="scLock" checked> Keep proportions</label></div>
      <p class="muted" style="font-size:11px">Scaling changes part geometry, not tool diameters. Fillet and arc radii scale with the part.</p>
      <div class="row" style="margin-top:10px"><button class="primary" id="scOk">Scale</button><button id="scCancel">Cancel</button></div>`,
      (ov, close) => {
        const F = ov.querySelector('#scF'), W = ov.querySelector('#scW'), H = ov.querySelector('#scH'), L = ov.querySelector('#scLock');
        F.addEventListener('input', () => { const f = parseFloat(F.value) || 1; W.value = fmtIn(bb0.w * f); H.value = fmtIn(bb0.h * f); });
        W.addEventListener('input', () => { const f = (parseFloat(W.value) || bb0.w) / (bb0.w || 1); F.value = +f.toFixed(6); if (L.checked) H.value = fmtIn(bb0.h * f); });
        H.addEventListener('input', () => { const f = (parseFloat(H.value) || bb0.h) / (bb0.h || 1); if (L.checked) { F.value = +f.toFixed(6); W.value = fmtIn(bb0.w * f); } });
        ov.querySelector('#scCancel').onclick = close;
        ov.querySelector('#scOk').onclick = async () => {
          const sx = (parseFloat(W.value) || bb0.w) / (bb0.w || 1);
          const sy = L.checked ? sx : (parseFloat(H.value) || bb0.h) / (bb0.h || 1);
          if (!isFinite(sx) || !isFinite(sy) || sx <= 0 || sy <= 0) { toast('Scale must be positive'); return; }
          if (Math.abs(sx - sy) > 1e-9) {
            // non-uniform scaling cannot preserve circular arcs - they would become ellipses
            const curvy = shs.some(sh => sh.kind === 'circle' || (sh.pts || []).some(p => p.r || p.arcR));
            if (curvy && !(await askConfirm('Non-uniform scale',
              'These parts contain arcs or fillets. Scaling width and height by different amounts turns those into ellipses, which this app cannot cut exactly.\n\nScale anyway?', 'Scale anyway'))) return;
          }
          snapshot();
          for (const sh of shs) scaleShape(sh, sx, sy, bb0);
          LOG.action(`Scaled ${shs.length} part(s) by ${(+sx.toFixed(4))}${Math.abs(sx - sy) > 1e-9 ? ' × ' + (+sy.toFixed(4)) : ''}`);
          close(); refresh();
        };
      });
  }
  function groupBBox(shs) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const sh of shs) { const b = shapeBBox(sh); x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); }
    if (!isFinite(x0)) return { x0: 0, y0: 0, x1: 0, y1: 0, w: 0, h: 0 };
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  }
  function scaleShape(sh, sx, sy, about) {
    sh.x = about.x0 + (sh.x - about.x0) * sx;
    sh.y = about.y0 + (sh.y - about.y0) * sy;
    const uni = Math.abs(sx - sy) < 1e-9 ? sx : Math.sqrt(Math.abs(sx * sy));
    if (sh.kind === 'rect') { sh.w *= sx; sh.h *= sy; sh.r = (sh.r || 0) * uni; if (sh.rc) sh.rc = sh.rc.map(v => v == null ? null : v * uni); }
    else if (sh.kind === 'circle') sh.r *= uni;
    else if (sh.kind === 'poly' && sh.pts) sh.pts = sh.pts.map(p => ({ ...p, x: p.x * sx, y: p.y * sy, r: (p.r || 0) * uni, arcR: (p.arcR || 0) * uni }));
    else if (sh.kind === 'path' && sh.loop) sh.loop = G.transformLoop(sh.loop, p => G.P(p.x * sx, p.y * sy));
    delete sh.startPt;
  }
  $('#btnMoveBy').onclick = openMoveBy;
  $('#btnScale').onclick = openScale;

  // ================= PUSH 2: construction + booleans =================

  // a shape built from a finished loop (result of a boolean / offset / trim)
  function pathShape(loop, props) {
    const bb = G.bbox(loop);
    return makeShape('path', {
      name: 'part', x: 0, y: 0, rot: 0, op: 'outside', toolId: S.tools[0]?.id || 1,
      loop: loop.map(s => s.type === 'line' ? G.line(G.P(s.a.x, s.a.y), G.P(s.b.x, s.b.y))
        : G.arc(G.P(s.a.x, s.a.y), G.P(s.b.x, s.b.y), G.P(s.c.x, s.c.y), s.ccw)),
      ...props,
    });
  }
  const selInOrder = () => Array.from(sel).map(id => job.shapes.find(s => s.id === id)).filter(Boolean);

  // ---------- booleans ----------
  function doBoolean(op) {
    const shs = selInOrder().filter(s => !s.open);
    if (shs.length !== 2) return toast('Select exactly two closed parts (the first is the one kept)');
    const [A, B] = shs;
    const res = BOOL.operate(op, worldLoop(A), worldLoop(B));
    if (res.error) { LOG.warn(`${op} failed: ${res.error}`); return toast(res.error); }
    snapshot();
    job.shapes = job.shapes.filter(s => s.id !== A.id && s.id !== B.id);
    sel.clear();
    const added = [];
    for (const loop of res.loops) {
      const sh = pathShape(loop, { name: `${op} of ${A.name}`, op: A.op, toolId: A.toolId, climb: A.climb });
      job.shapes.push(sh); added.push(sh); sel.add(sh.id);
    }
    if (res.hole) {
      const h = pathShape(res.hole, { name: `${A.name} hole`, op: 'inside', toolId: A.toolId });
      job.shapes.push(h); added.push(h); sel.add(h.id);
    }
    const arcs = added.reduce((n, s) => n + s.loop.filter(x => x.type === 'arc').length, 0);
    LOG.action(`${op}: "${A.name}" and "${B.name}" -> ${added.length} part(s), ${arcs} arc segment(s) preserved`
      + (res.note ? ` (${res.note})` : ''));
    if (res.note) toast(res.note);
    refresh();
  }
  $('#btnUnion').onclick = () => doBoolean('union');
  $('#btnSubtract').onclick = () => doBoolean('subtract');

  // ---------- offset ----------
  function openOffset() {
    const shs = selInOrder().filter(s => !s.open);
    if (!shs.length) return toast('Select a closed part to offset');
    modal(`<h3>Offset ${shs.length} part${shs.length > 1 ? 's' : ''}</h3>
      <div class="row"><label>Distance</label><input type="number" step="0.125" id="ofD" value="0.5"> in</div>
      <div class="row"><label>Direction</label><select id="ofDir"><option value="in">Inward (smaller)</option><option value="out">Outward (larger)</option></select></div>
      <div class="row"><label><input type="checkbox" id="ofKeep" checked> Keep the original</label></div>
      <div class="row"><label>New part cut</label><select id="ofOp"><option value="inside">inside (pocket / border)</option><option value="outside">outside</option><option value="on">on the line</option></select></div>
      <p class="muted" style="font-size:11px">An inward offset of a 0.5" border on a plate gives you the inner outline to pocket or score. Offsetting further than the part can shrink will fail rather than fold the outline inside out.</p>
      <div class="row" style="margin-top:10px"><button class="primary" id="ofOk">Offset</button><button id="ofCancel">Cancel</button></div>`,
      (ov, close) => {
        ov.querySelector('#ofCancel').onclick = close;
        ov.querySelector('#ofOk').onclick = () => {
          const d = parseFloat(ov.querySelector('#ofD').value);
          if (!isFinite(d) || d <= 0) return toast('Enter a positive distance');
          const sign = ov.querySelector('#ofDir').value === 'out' ? 1 : -1;
          const keep = ov.querySelector('#ofKeep').checked;
          const newOp = ov.querySelector('#ofOp').value;
          snapshot();
          let made = 0, failed = 0;
          for (const sh of shs) {
            let loop = worldLoop(sh);
            if (G.signedArea(loop) < 0) loop = G.reverseLoop(loop);
            let out = null;
            try { out = G.offsetLoop(loop, sign * d); } catch (e) { LOG.error(`Offset failed on "${sh.name}"`, e); }
            // an over-shrunk outline collapses or flips sign - reject it
            if (!out || !out.length || (G.signedArea(out) * G.signedArea(loop) <= 0)) { failed++; continue; }
            const ns = pathShape(out, { name: `${sh.name} offset ${d}`, op: newOp, toolId: sh.toolId });
            job.shapes.push(ns); made++;
            if (!keep) job.shapes = job.shapes.filter(s => s.id !== sh.id);
          }
          if (failed) toast(`${failed} part${failed > 1 ? 's' : ''} could not offset that far`);
          LOG.action(`Offset ${made} part(s) by ${sign * d} in` + (failed ? `, ${failed} failed` : ''));
          close(); refresh();
        };
      });
  }
  $('#btnOffset').onclick = openOffset;

  // ---------- array ----------
  function openArray() {
    const shs = selInOrder();
    if (!shs.length) return toast('Select something to array');
    const bb = groupBBox(shs);
    modal(`<h3>Array ${shs.length} part${shs.length > 1 ? 's' : ''}</h3>
      <div class="row"><label>Type</label><select id="arType"><option value="grid">Rows &amp; columns</option><option value="circle">Bolt circle</option></select></div>
      <div id="arGrid">
        <div class="row"><label>Columns</label><input type="number" step="1" min="1" id="arC" value="3"> across</div>
        <div class="row"><label>Rows</label><input type="number" step="1" min="1" id="arR" value="1"> up</div>
        <div class="row"><label>X spacing</label><input type="number" step="0.125" id="arDX" value="${fmtIn(bb.w + 1)}"> in <span class="muted">centre to centre</span></div>
        <div class="row"><label>Y spacing</label><input type="number" step="0.125" id="arDY" value="${fmtIn(bb.h + 1)}"> in</div>
      </div>
      <div id="arCirc" style="display:none">
        <div class="row"><label>Count</label><input type="number" step="1" min="2" id="arN" value="6"></div>
        <div class="row"><label>Circle dia</label><input type="number" step="0.125" id="arBD" value="6"> in</div>
        <div class="row"><label>Centre X</label><input type="number" step="0.125" id="arCX" value="${fmtIn(bb.x0 + bb.w / 2)}"> in</div>
        <div class="row"><label>Centre Y</label><input type="number" step="0.125" id="arCY" value="${fmtIn(bb.y0 + bb.h / 2)}"> in</div>
        <div class="row"><label>Start angle</label><input type="number" step="15" id="arA0" value="0"> °</div>
        <div class="row"><label><input type="checkbox" id="arRot"> Rotate each copy to face out</label></div>
      </div>
      <p class="muted" style="font-size:11px">Copies are added as separate parts, so each can still be edited or re-nested on its own.</p>
      <div class="row" style="margin-top:10px"><button class="primary" id="arOk">Create</button><button id="arCancel">Cancel</button></div>`,
      (ov, close) => {
        const type = ov.querySelector('#arType');
        type.onchange = () => {
          ov.querySelector('#arGrid').style.display = type.value === 'grid' ? '' : 'none';
          ov.querySelector('#arCirc').style.display = type.value === 'circle' ? '' : 'none';
        };
        ov.querySelector('#arCancel').onclick = close;
        ov.querySelector('#arOk').onclick = () => {
          const V = (id) => parseFloat(ov.querySelector(id).value) || 0;
          const copies = [];
          snapshot();
          if (type.value === 'grid') {
            const nc = Math.max(1, Math.round(V('#arC'))), nr = Math.max(1, Math.round(V('#arR')));
            const dx = V('#arDX'), dy = V('#arDY');
            if (nc * nr > 500) { toast('That would make over 500 copies'); return; }
            for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
              if (!r && !c) continue;
              for (const sh of shs) copies.push({ ...JSON.parse(JSON.stringify(sh)), id: job.nextId++, x: sh.x + c * dx, y: sh.y + r * dy });
            }
            LOG.action(`Array: ${nc}×${nr} grid at ${dx} × ${dy} in`);
          } else {
            const n = Math.max(2, Math.round(V('#arN'))), R = V('#arBD') / 2;
            const cx = V('#arCX'), cy = V('#arCY'), a0 = V('#arA0') * Math.PI / 180;
            const doRot = ov.querySelector('#arRot').checked;
            if (n > 500) { toast('That would make over 500 copies'); return; }
            // the selection's own centre is placed on the circle, then stepped round
            const c0 = { x: bb.x0 + bb.w / 2, y: bb.y0 + bb.h / 2 };
            for (let i = 0; i < n; i++) {
              const a = a0 + i * 2 * Math.PI / n;
              const tx = cx + R * Math.cos(a), ty = cy + R * Math.sin(a);
              for (const sh of shs) {
                const cp = { ...JSON.parse(JSON.stringify(sh)), id: job.nextId++ };
                cp.x = sh.x + (tx - c0.x); cp.y = sh.y + (ty - c0.y);
                if (doRot) cp.rot = ((sh.rot || 0) + a * 180 / Math.PI) % 360;
                if (i === 0 && !doRot) continue;   // first slot is the original
                copies.push(cp);
              }
            }
            LOG.action(`Array: ${n} copies on a ${V('#arBD')} in bolt circle`);
          }
          copies.forEach(c => { c.name = c.name.replace(/ #\d+$/, '') + ` #${++arrayCounter}`; delete c.startPt; job.shapes.push(c); });
          sel.clear(); copies.forEach(c => sel.add(c.id));
          close(); refresh();
        };
      });
  }
  let arrayCounter = 0;
  $('#btnArray').onclick = openArray;

  // ---------- chamfer / fillet ----------
  function openCorner(kind) {
    const shs = selInOrder().filter(s => (s.kind === 'poly' && !s.open) || s.kind === 'rect');
    if (!shs.length) return toast('Select a rectangle or polygon');
    const isCh = kind === 'chamfer';
    modal(`<h3>${isCh ? 'Chamfer' : 'Fillet'} corners</h3>
      <div class="row"><label>${isCh ? 'Leg length' : 'Radius'}</label><input type="number" step="0.0625" id="cnD" value="0.25"> in</div>
      <div class="row"><label>Apply to</label><select id="cnWhich"><option value="all">All corners</option><option value="sharp">Only square-ish corners (60–120°)</option></select></div>
      <p class="muted" style="font-size:11px">${isCh
        ? 'A chamfer replaces the corner point with two points, so the cut is a straight bevel. It becomes part of the outline and can be edited point by point afterwards.'
        : 'A fillet sets the corner radius, which stays editable in the points table.'}</p>
      <div class="row" style="margin-top:10px"><button class="primary" id="cnOk">Apply</button><button id="cnCancel">Cancel</button></div>`,
      (ov, close) => {
        ov.querySelector('#cnCancel').onclick = close;
        ov.querySelector('#cnOk').onclick = () => {
          const d = parseFloat(ov.querySelector('#cnD').value);
          if (!isFinite(d) || d <= 0) return toast('Enter a positive value');
          const only = ov.querySelector('#cnWhich').value === 'sharp';
          snapshot();
          let n = 0;
          for (const sh of shs) {
            if (sh.kind === 'rect') convertRectToPoly(sh);
            n += isCh ? chamferAll(sh, d, only) : filletAll(sh, d, only);
          }
          LOG.action(`${isCh ? 'Chamfered' : 'Filleted'} ${n} corner(s) at ${d} in`);
          close(); refresh();
        };
      });
  }
  const cornerAngle = (pts, i) => {
    const n = pts.length, p = pts[i], a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const d1 = G.norm(G.sub(a, p)), d2 = G.norm(G.sub(b, p));
    return Math.acos(Math.max(-1, Math.min(1, G.dot(d1, d2)))) * 180 / Math.PI;
  };
  function filletAll(sh, r, onlySquare) {
    let n = 0;
    sh.pts.forEach((p, i) => {
      if (onlySquare) { const a = cornerAngle(sh.pts, i); if (a < 60 || a > 120) return; }
      p.r = r; n++;
    });
    delete sh.startPt;
    return n;
  }
  /* Chamfer: replace each corner with two points set back along its two edges.
     Built from the ORIGINAL point list so that setbacks are measured against
     the un-chamfered geometry - otherwise each corner would be cut using
     coordinates already moved by the previous one. */
  function chamferAll(sh, d, onlySquare) {
    const src = sh.pts, n = src.length;
    if (n < 3) return 0;
    const out = []; let count = 0;
    for (let i = 0; i < n; i++) {
      const p = src[i], a = src[(i - 1 + n) % n], b = src[(i + 1) % n];
      const ang = cornerAngle(src, i);
      const skip = (onlySquare && (ang < 60 || ang > 120)) || (p.arcR || src[(i - 1 + n) % n].arcR);
      if (skip || ang < 1 || ang > 179) { out.push({ ...p }); continue; }
      const L1 = G.dist(a, p), L2 = G.dist(b, p);
      const t = Math.min(d, L1 / 2, L2 / 2);
      if (t < 1e-6) { out.push({ ...p }); continue; }
      const d1 = G.norm(G.sub(a, p)), d2 = G.norm(G.sub(b, p));
      out.push({ x: p.x + d1.x * t, y: p.y + d1.y * t, r: 0, arcR: 0 });
      out.push({ x: p.x + d2.x * t, y: p.y + d2.y * t, r: 0, arcR: p.arcR || 0 });
      count++;
    }
    sh.pts = out;
    normalizePoly(sh);
    delete sh.startPt;
    return count;
  }
  $('#btnChamfer').onclick = () => openCorner('chamfer');
  $('#btnFillet').onclick = () => openCorner('fillet');

  // ---------- trim / extend / join ----------
  function trimTol() { return S.snap.trimTol || 0.125; }
  function openTrimJoin() {
    const shs = selInOrder();
    const opens = shs.filter(s => s.open);
    modal(`<h3>Trim, extend &amp; join</h3>
      <p class="muted">Selected: ${shs.length} part${shs.length === 1 ? '' : 's'} (${opens.length} open path${opens.length === 1 ? '' : 's'}).</p>
      <div class="row"><button class="small" id="tjErase">Delete an edge</button><span class="muted">then click a side to remove it — e.g. drop one side of a rectangle to leave a C</span></div>
      <div class="row"><button class="small" id="tjJoin">Join open paths</button><span class="muted">chain touching <b>ends</b> into one path; closes it if the ends meet</span></div>
      <div class="row"><button class="small" id="tjSplit">Split at intersections</button><span class="muted">turn every crossing into a vertex, so each piece is its own selectable side</span></div>
      <div class="row"><button class="small" id="tjMerge">Merge into one part (J)</button><span class="muted">works on open <i>and</i> closed parts; also handles a line landing <b>partway along</b> another side: splits it there so the new line becomes a numbered side</span></div>
      <div class="row"><button class="small" id="tjClose">Force close</button><span class="muted">connect the two ends of one open path with a straight segment</span></div>
      <div class="row"><button class="small" id="tjTrim">Trim tool</button><span class="muted">then click the piece of an open path to remove, between its crossings</span></div>
      <div class="row"><button class="small" id="tjExtend">Extend tool</button><span class="muted">then click near the end of an open path to run it out to the next shape it meets</span></div>
      <div class="row"><button class="small" id="tjHeal">Snap loose ends to edges</button><span class="muted">pull endpoints that stop just short onto the line they should meet</span></div>
      <div class="row"><label>Tolerance</label><input type="number" step="0.001" id="tjTol" value="${fmtIn(trimTol())}"> in</div>
      <p class="muted" style="font-size:11px">Used for joining, healing and trimming. Drawn or imported paths often stop a few thousandths short of the line they were meant to meet — geometrically that is not a crossing, so trim would have nothing to cut back to. Anything within this distance is treated as touching.</p>
      <div class="row" style="margin-top:10px"><button id="tjCancel">Close</button></div>`,
      (ov, close) => {
        ov.querySelector('#tjCancel').onclick = close;
        const tol = () => { const v = parseFloat(ov.querySelector('#tjTol').value); return isFinite(v) && v > 0 ? v : 0.125; };
        ov.querySelector('#tjTol').addEventListener('change', () => { S.snap.trimTol = tol(); saveSettings(); });
        ov.querySelector('#tjHeal').onclick = () => { S.snap.trimTol = tol(); saveSettings(); healSelection(tol()); close(); };
        ov.querySelector('#tjErase').onclick = () => { setTool('trim'); close(); toast('Click the edge you want to remove'); };
        ov.querySelector('#tjJoin').onclick = () => { joinSelected(tol()); close(); };
        ov.querySelector('#tjSplit').onclick = () => { S.snap.trimTol = tol(); saveSettings(); splitAtIntersectionsCmd(); close(); };
        ov.querySelector('#tjMerge').onclick = () => { S.snap.trimTol = tol(); saveSettings(); mergeSelected(tol()); close(); };
        ov.querySelector('#tjClose').onclick = () => { forceClose(); close(); };
        ov.querySelector('#tjTrim').onclick = () => { setTool('trim'); close(); toast('Click the part of a path to remove'); };
        ov.querySelector('#tjExtend').onclick = () => { setTool('extend'); close(); toast('Click near the end of a path to extend it'); };
      });
  }
  $('#btnTrim').onclick = openTrimJoin;


  // ================= edge sub-selection =================
  /* Click a part once to select it, click one of its sides again to select
     just that side. The selected edge can be deleted on its own, or have its
     length and angle typed or dragged. */
  let selEdges = [];    // [{id, i}] - a box-select can cover several sides at once

  function clearEdge() { if (selEdges.length) { selEdges = []; return true; } return false; }
  const isEdgeSel = (id, i) => selEdges.some(e => e.id === id && e.i === i);
  function addEdge(id, i) { if (!isEdgeSel(id, i)) selEdges.push({ id, i }); }
  function toggleEdge(id, i) { const k = selEdges.findIndex(e => e.id === id && e.i === i); if (k >= 0) selEdges.splice(k, 1); else selEdges.push({ id, i }); }
  // the single selected side, when there is exactly one (the editable case)
  function soleEdge() { return selEdges.length === 1 ? selEdges[0] : null; }
  function selEdgeShape() { const e = soleEdge(); return e ? job.shapes.find(s => s.id === e.id) : null; }

  /* Does any part of this segment fall inside the box?
     Sampling alone is not enough: a straight segment samples to just its two
     endpoints, so a line crossing the box with both ends outside would be
     missed. Test the endpoints, then the segment against the four box sides. */
  function segTouchesBox(sg, box) {
    const inBox = (q) => q.x >= box.x0 && q.x <= box.x1 && q.y >= box.y0 && q.y <= box.y1;
    if (inBox(sg.a) || inBox(sg.b)) return true;
    if (sg.type === 'arc') {
      for (const q of G.samplePts(sg, Math.max(0.02, Math.min(box.x1 - box.x0, box.y1 - box.y0) / 8))) if (inBox(q)) return true;
    }
    const c = [
      G.line(G.P(box.x0, box.y0), G.P(box.x1, box.y0)),
      G.line(G.P(box.x1, box.y0), G.P(box.x1, box.y1)),
      G.line(G.P(box.x1, box.y1), G.P(box.x0, box.y1)),
      G.line(G.P(box.x0, box.y1), G.P(box.x0, box.y0)),
    ];
    for (const side of c) if (SNAP.segSegPoints(sg, side).length) return true;
    return false;
  }

  /* Box-select. A part entirely inside the box is selected whole. A part the
     box only crosses has its individual sides picked instead - so dragging
     from the corner of a square to its centre selects the two sides running
     through the box, rather than selecting nothing at all. */
  function doMarquee(x0, y0, x1, y1) {
    if (x1 - x0 <= 0.01 && y1 - y0 <= 0.01) return;
    const box = { x0, x1, y0, y1 };
    for (const sh of job.shapes.slice()) {
      const bb = shapeBBox(sh);
      if (bb.x0 >= x0 && bb.x1 <= x1 && bb.y0 >= y0 && bb.y1 <= y1) { sel.add(sh.id); continue; }
      if (bb.x1 < x0 || bb.x0 > x1 || bb.y1 < y0 || bb.y0 > y1) continue;
      let loop;
      try { loop = worldLoop(sh); } catch (err) { continue; }
      const hits = [];
      loop.forEach((sg, i) => { if (segTouchesBox(sg, box)) hits.push(i); });
      if (!hits.length) continue;
      const ed = makeEditable(sh) || sh;
      for (const i of hits) addEdge(ed.id, i);
      sel.add(ed.id);
    }
  }

  // index of the edge nearest wp on this shape, or -1
  function edgeIndexAt(sh, wp, tolPx = 8) {
    let loop;
    try { loop = worldLoop(sh); } catch (e) { return -1; }
    const tol = Math.max(tolPx * devicePixelRatio / view.scale, 0.02);
    let bi = -1, bd = Infinity;
    loop.forEach((s, i) => { const d = distToLoopSeg(wp, s); if (d < bd) { bd = d; bi = i; } });
    return bd <= tol ? bi : -1;
  }

  /* Make a shape's individual edges editable. Rectangles become polygons;
     'path' shapes (boolean results, text, imports) become polygons carrying
     the same arcs as per-edge bulges, so nothing is lost in the conversion. */
  function makeEditable(sh) {
    if (sh.kind === 'poly') return sh;
    if (sh.kind === 'rect') { convertRectToPoly(sh); return sh; }
    if (sh.kind === 'path' && sh.loop && sh.loop.length) {
      let loop = sh.loop;
      /* A closed shape needs at least 3 points to survive as a polygon - a
         circle is stored as just two semicircles, which would collapse to a
         2-point polygon with no area. Halve each segment first. */
      if (loop.length < 3 && G.same(loop[loop.length - 1].b, loop[0].a, 1e-6)) {
        const split = [];
        for (const sg of loop) { const h1 = subSeg(sg, 0, 0.5), h2 = subSeg(sg, 0.5, 1); if (h1) split.push(h1); if (h2) split.push(h2); }
        if (split.length >= 3) loop = split;
      }
      const pts = loop.map(s => {
        const p = { x: s.a.x, y: s.a.y, r: 0, arcR: 0 };
        if (s.type === 'arc') {
          const chord = G.dist(s.a, s.b);
          const sag = G.cross(G.norm(G.sub(s.b, s.a)), G.sub(G.pointAt(s, 0.5), s.a));
          p.arcR = arcRFromGeometry(chord, sag);
        }
        return p;
      });
      const closed = G.same(loop[loop.length - 1].b, loop[0].a, 1e-6);
      if (!closed) pts.push({ x: loop[loop.length - 1].b.x, y: loop[loop.length - 1].b.y, r: 0, arcR: 0 });
      const x0 = Math.min(...pts.map(p => p.x)), y0 = Math.min(...pts.map(p => p.y));
      sh.kind = 'poly';
      sh.pts = pts.map(p => ({ ...p, x: p.x - x0, y: p.y - y0 }));
      sh.x = x0; sh.y = y0; sh.rot = 0;
      sh.open = !closed;
      delete sh.loop;
      LOG.info(`"${sh.name}" converted to an editable polygon (${sh.pts.length} points)`);
      return sh;
    }
    return null;
  }

  // ---- delete just the selected edge
  /* Delete every selected side. Removing several from one part can break it
     into more than one piece, so the surviving segments are regrouped into
     contiguous runs and each run becomes its own open path. */
  function deleteSelectedEdge() {
    if (!selEdges.length) return false;
    const byShape = new Map();
    for (const e of selEdges) { if (!byShape.has(e.id)) byShape.set(e.id, new Set()); byShape.get(e.id).add(e.i); }
    snapshot();
    let removed = 0;
    for (const [id, idx] of byShape) {
      const sh = job.shapes.find(x => x.id === id);
      if (!sh) continue;
      let loop;
      try { loop = worldLoop(sh); } catch (err) { continue; }
      const keep = loop.map((sg, i) => idx.has(i) ? null : sg);
      removed += idx.size;
      const n = keep.length;
      const runs = [];
      let cur = [];
      // a closed part re-opens at the first gap, so start walking just after one
      let startAt = 0;
      if (!sh.open) { const g = keep.findIndex(x => !x); if (g >= 0) startAt = (g + 1) % n; }
      for (let k = 0; k < n; k++) {
        const sg = keep[(startAt + k) % n];
        if (sg) cur.push(sg);
        else { if (cur.length) runs.push(cur); cur = []; }
      }
      if (cur.length) runs.push(cur);
      job.shapes = job.shapes.filter(x => x.id !== id);
      for (const segs of runs) {
        const ns = pathShape(segs, { name: sh.name, open: true, op: 'on', toolId: sh.toolId, climb: sh.climb, group: sh.group });
        job.shapes.push(ns);
      }
      LOG.action('Deleted ' + idx.size + ' side(s) from "' + sh.name + '" - ' + runs.length + ' piece(s) left');
    }
    clearEdge(); sel.clear();
    invalidateLoops(); refresh();
    return removed > 0;
  }

  // ---- highlight + point numbers
  function drawEdgeSelection() {
    const dpr = devicePixelRatio;
    if (hoverEdge && !isEdgeSel(hoverEdge.id, hoverEdge.i)) {
      const hs = job.shapes.find(x => x.id === hoverEdge.id);
      if (hs) {
        let hl = null;
        try { hl = worldLoop(hs); } catch (err) { hl = null; }
        if (hl && hl[hoverEdge.i]) {
          ctx.save();
          ctx.strokeStyle = 'rgba(255,184,77,.45)'; ctx.lineWidth = 3.2 * dpr; ctx.setLineDash([]); ctx.lineCap = 'round';
          tracePath([hl[hoverEdge.i]], true); ctx.stroke();
          ctx.restore();
        }
      }
    }
    if (selEdges.length) {
      ctx.save();
      ctx.strokeStyle = '#ffb84d'; ctx.lineWidth = 3.2 * dpr; ctx.setLineDash([]); ctx.lineCap = 'round';
      const cache = new Map();
      for (const e of selEdges) {
        let loop = cache.get(e.id);
        if (!loop) {
          const sh0 = job.shapes.find(x => x.id === e.id);
          if (!sh0) continue;
          try { loop = worldLoop(sh0); } catch (err) { continue; }
          cache.set(e.id, loop);
        }
        if (loop[e.i]) { tracePath([loop[e.i]], true); ctx.stroke(); }
      }
      ctx.restore();
    }
    // number the points of a singly-selected part, matching the table on the right
    if (sel.size === 1) {
      const s0 = job.shapes.find(x => sel.has(x.id));
      if (s0 && (s0.kind === 'poly' || s0.kind === 'rect') && $('#chkPtNums') && $('#chkPtNums').checked) {
        const pts = gripPts(s0);
        ctx.save();
        ctx.font = `${11 * dpr}px ui-monospace, monospace`;
        pts.forEach((p, i) => {
          const w = localToWorld(s0, p), q = W2S(w);
          const label = 'P' + (i + 1);
          const tw = ctx.measureText(label).width;
          ctx.fillStyle = 'rgba(20,22,26,.85)';
          ctx.fillRect(q.x + 7, q.y - 17 * dpr, tw + 6, 14 * dpr);
          ctx.fillStyle = '#8cc4ff';
          ctx.fillText(label, q.x + 10, q.y - 6 * dpr);
        });
        ctx.restore();
      }
    }
  }

  // ---- right-hand panel for the selected edge
  function edgePanel(sh) {
    if (selEdges.length > 1) {
      const parts = new Set(selEdges.map(e => e.id)).size;
      return '<h3>' + selEdges.length + ' sides selected <span class="muted">' + (parts > 1 ? 'on ' + parts + ' parts' : '') + '</span></h3>'
        + '<div class="row"><button class="small" id="btnDelEdge">Delete these sides</button><span class="muted">or press Delete</span></div>'
        + '<p class="muted" style="font-size:11px">Select a single side to edit its length and angle. Shift-click a side to add or remove it.</p>';
    }
    const e0 = soleEdge();
    if (!e0 || e0.id !== sh.id) return '';
    const pts = sh.pts;
    if (!pts) return '';
    const n = pts.length, i = e0.i;
    if (i < 0 || i >= (sh.open ? n - 1 : n)) return '';
    const a = pts[i], b = pts[(i + 1) % n];
    const L = G.dist(a, b);
    const A = ((Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI) % 360 + 360) % 360;
    const sag = edgeSagitta(sh, i);
    const maxL = Math.max(1, Math.ceil(L * 2));
    return `<h3>Side ${i + 1} <span class="muted">P${i + 1} → P${(i + 1) % n + 1}</span></h3>
      <div class="row"><label>Length</label><input type="number" step="0.001" data-ev="len" value="${fmtIn(L)}"> in</div>
      <div class="row"><input type="range" class="slider" data-es="len" min="0.01" max="${maxL}" step="0.001" value="${L}"></div>
      <div class="row"><label>Angle</label><input type="number" step="1" data-ev="ang" value="${(+A.toFixed(3))}"> °</div>
      <div class="row"><input type="range" class="slider" data-es="ang" min="0" max="360" step="0.1" value="${A}"></div>
      <div class="row"><label>Bulge</label><input type="number" step="0.0625" data-ev="sag" value="${sag ? fmtIn(sag) : ''}" placeholder="0"> in</div>
      <div class="row"><input type="range" class="slider" data-es="sag" min="${-(L / 2).toFixed(4)}" max="${(L / 2).toFixed(4)}" step="0.001" value="${sag || 0}"></div>
      <div class="row"><button class="small" id="btnDelEdge">Delete this side</button><span class="muted">or press Delete</span></div>
      <p class="muted" style="font-size:11px">Changing the length or angle moves P${(i + 1) % n + 1}; the rest of the part follows. Drag a slider to feel it out, or type an exact value.</p>`;
  }
  function wireEdgePanel(el, sh) {
    const delAll = el.querySelector('#btnDelEdge');
    if (delAll) delAll.onclick = () => deleteSelectedEdge();
    const e0 = soleEdge();
    if (!e0 || e0.id !== sh.id) return;
    const apply = (k, v, live) => {
      if (!isFinite(v)) return;
      if (!live) snapshot();
      polyEdit(sh, k, e0.i, v);
      delete sh.startPt;
      invalidateLoops();
      if (live) { updateStats(); draw(); } else refresh();
    };
    el.querySelectorAll('[data-ev]').forEach(inp => inp.addEventListener('change', () => apply(inp.dataset.ev, parseFloat(inp.value), false)));
    el.querySelectorAll('[data-es]').forEach(sl => {
      sl.addEventListener('pointerdown', () => { snapshot(); });
      sl.addEventListener('input', () => {
        apply(sl.dataset.es, parseFloat(sl.value), true);
        const num = el.querySelector(`[data-ev="${sl.dataset.es}"]`);
        if (num) num.value = sl.dataset.es === 'ang' ? (+parseFloat(sl.value).toFixed(3)) : fmtIn(parseFloat(sl.value));
      });
      sl.addEventListener('change', () => { updateStats(); refreshList(); });
    });
  }

  // ---------- centre marks ----------
  /* Permanent centre crosses on anything round, so a centre is visible without
     having to hover it. The snap marker is a hover hint; this is a drawing aid. */
  function centresOf(sh) {
    const out = [];
    if (sh.kind === 'circle' || sh.kind === 'ellipse') {
      out.push({ p: { x: sh.x, y: sh.y }, r: sh.kind === 'circle' ? sh.r : Math.max(sh.rx, sh.ry), kind: 'arc' });
      return out;
    }
    let loop;
    try { loop = worldLoop(sh); } catch (e) { return out; }
    // every distinct arc centre (fillets, bowed edges, holes)
    for (const s of loop) {
      if (s.type !== 'arc') continue;
      if (out.some(o => G.same(o.p, s.c, 1e-7))) continue;
      out.push({ p: { x: s.c.x, y: s.c.y }, r: G.radius(s), kind: 'arc' });
    }
    // plus the part's own centre, so a rectangle or polygon has one too
    if (!sh.open && loop.length) {
      const b = G.bbox(loop);
      const c = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
      if (!out.some(o => G.same(o.p, c, 1e-7))) out.push({ p: c, r: Math.max(b.w, b.h) / 2, kind: 'part' });
    }
    return out;
  }
  function drawCentreMarks() {
    const el = $('#chkCentres');
    if (el && !el.checked) return;
    const dpr = devicePixelRatio;
    ctx.save();
    ctx.lineWidth = 1.1 * dpr;
    for (const sh of job.shapes) {
      for (const c of centresOf(sh)) {
        const p = W2S(c.p);
        // cross scaled to the feature, clamped so it stays readable at any zoom
        const k = Math.max(4 * dpr, Math.min(11 * dpr, (c.r || 0.25) * view.scale * 0.28));
        // arc centres solid green; a part's own centre dashed, so they read apart
        ctx.strokeStyle = c.kind === 'part' ? '#5f9e78' : '#7fd8a0';
        ctx.setLineDash(c.kind === 'part' ? [2 * dpr, 2 * dpr] : []);
        ctx.beginPath();
        ctx.moveTo(p.x - k, p.y); ctx.lineTo(p.x + k, p.y);
        ctx.moveTo(p.x, p.y - k); ctx.lineTo(p.x, p.y + k);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.restore();
  }
  const chkC = $('#chkCentres'); if (chkC) chkC.addEventListener('change', draw);

  // ---------- distance between two parts ----------
  /* Extent of a shape along a direction: how far its geometry reaches from its
     own reference point, forward and back along u. For a circle that is
     exactly +/- r; for anything else it is the real silhouette, sampled from
     the loop, so "edge" means the actual edge and not a bounding box. */
  function extentAlong(sh, u) {
    const c = refPoint(sh);
    let lo = 0, hi = 0, got = false;
    let loop;
    try { loop = worldLoop(sh); } catch (e) { return { lo: 0, hi: 0 }; }
    for (const s of loop) {
      for (const q of G.samplePts(s, 0.02)) {
        const d = (q.x - c.x) * u.x + (q.y - c.y) * u.y;
        if (!got) { lo = hi = d; got = true; }
        else { if (d < lo) lo = d; if (d > hi) hi = d; }
      }
    }
    return { lo, hi };
  }
  // the point a distance is measured from: a circle's true centre, else the bbox centre
  function refPoint(sh) {
    if (sh.kind === 'circle' || sh.kind === 'ellipse') return { x: sh.x, y: sh.y };
    const b = shapeBBox(sh);
    return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
  }
  function openDistance() {
    const shs = selInOrder();
    if (shs.length !== 2) return toast('Select exactly two parts — the first stays put, the second moves');
    const [A, B] = shs;
    const cA = refPoint(A), cB = refPoint(B);
    const dx0 = cB.x - cA.x, dy0 = cB.y - cA.y;
    const curAng = Math.atan2(dy0, dx0) * 180 / Math.PI;
    const isRound = (s) => s.kind === 'circle' || s.kind === 'ellipse';
    const rTxt = (s) => s.kind === 'circle' ? ` (r ${fmtIn(s.r)})` : '';

    modal(`<h3>Distance between two parts</h3>
      <p class="muted"><b>${esc(A.name)}</b>${rTxt(A)} stays put · <b>${esc(B.name)}</b>${rTxt(B)} moves</p>
      <div class="row"><label>Measure</label><select id="dsMode" style="flex:1">
        <option value="cc">Centre to centre</option>
        <option value="gap">Gap between edges</option>
        <option value="ce">First centre to second edge</option>
        <option value="ec">First edge to second centre</option>
        <option value="ff">Far edge to far edge (overall)</option>
      </select></div>
      <div class="row"><label>Distance</label><input type="number" step="0.125" id="dsD" value="1"> in</div>
      <div class="row"><label>Direction</label><select id="dsDir" style="flex:1">
        <option value="x">Horizontal — second part to the right</option>
        <option value="x-">Horizontal — second part to the left</option>
        <option value="y">Vertical — second part above</option>
        <option value="y-">Vertical — second part below</option>
        <option value="keep">Keep the current direction (${curAng.toFixed(1)}°)</option>
        <option value="ang">Custom angle…</option>
      </select></div>
      <div class="row" id="dsAngRow" style="display:none"><label>Angle</label><input type="number" step="15" id="dsAng" value="${(+curAng.toFixed(2))}"> °</div>
      <div class="row"><label><input type="checkbox" id="dsAlign" checked> Line the centres up across that direction</label></div>
      <p class="muted" id="dsNote" style="font-size:11px"></p>
      <div class="row" style="margin-top:10px"><button class="primary" id="dsOk">Apply</button><button id="dsCancel">Cancel</button></div>`,
      (ov, close) => {
        const MODE = ov.querySelector('#dsMode'), DIR = ov.querySelector('#dsDir'), NOTE = ov.querySelector('#dsNote');
        const dirVec = () => {
          const v = DIR.value;
          if (v === 'x') return { x: 1, y: 0 };
          if (v === 'x-') return { x: -1, y: 0 };
          if (v === 'y') return { x: 0, y: 1 };
          if (v === 'y-') return { x: 0, y: -1 };
          if (v === 'ang') { const a = (parseFloat(ov.querySelector('#dsAng').value) || 0) * Math.PI / 180; return { x: Math.cos(a), y: Math.sin(a) }; }
          const L = Math.hypot(dx0, dy0) || 1;
          return { x: dx0 / L, y: dy0 / L };
        };
        const describe = () => {
          const u = dirVec();
          const eA = extentAlong(A, u), eB = extentAlong(B, u);
          const m = MODE.value;
          const txt = {
            cc: 'Distance between the two centres.',
            gap: `Clear space between the facing edges — a ${fmtIn(0)} gap means they touch. Uses the real silhouette, so it is exact for circles.`,
            ce: 'From the first part’s centre to the near edge of the second.',
            ec: 'From the first part’s near edge to the second part’s centre.',
            ff: 'Overall size across both parts, outside edge to outside edge.',
          }[m];
          // show what the equivalent centre-to-centre works out to
          const d = parseFloat(ov.querySelector('#dsD').value);
          let cc = null;
          if (isFinite(d)) cc = ccFor(m, d, eA, eB);
          NOTE.innerHTML = txt + (cc != null ? `<br>That puts the centres <b>${fmtIn(cc)}"</b> apart.` : '');
          ov.querySelector('#dsAngRow').style.display = DIR.value === 'ang' ? '' : 'none';
        };
        // convert the chosen measurement into a centre-to-centre distance along u
        const ccFor = (mode, d, eA, eB) => {
          if (mode === 'cc') return d;
          if (mode === 'gap') return eA.hi + d - eB.lo;
          if (mode === 'ce') return d - eB.lo;
          if (mode === 'ec') return eA.hi + d;
          if (mode === 'ff') return d + eA.lo - eB.hi;
          return d;
        };
        MODE.onchange = describe; DIR.onchange = describe;
        ov.querySelector('#dsD').addEventListener('input', describe);
        ov.querySelector('#dsAng').addEventListener('input', describe);
        describe();
        ov.querySelector('#dsCancel').onclick = close;
        ov.querySelector('#dsOk').onclick = () => {
          const d = parseFloat(ov.querySelector('#dsD').value);
          if (!isFinite(d)) return toast('Enter a distance');
          const u = dirVec();
          const eA = extentAlong(A, u), eB = extentAlong(B, u);
          const cc = ccFor(MODE.value, d, eA, eB);
          if (MODE.value === 'gap' && cc < eA.hi - eB.lo - 1e-9 && d < 0) toast('Negative gap — the parts will overlap');
          // target centre for B
          const perp = { x: -u.y, y: u.x };
          const align = ov.querySelector('#dsAlign').checked;
          const perpNow = (cB.x - cA.x) * perp.x + (cB.y - cA.y) * perp.y;
          const keepPerp = align ? 0 : perpNow;
          const target = {
            x: cA.x + u.x * cc + perp.x * keepPerp,
            y: cA.y + u.y * cc + perp.y * keepPerp,
          };
          snapshot();
          const move = { x: target.x - cB.x, y: target.y - cB.y };
          const grp = B.group ? job.shapes.filter(s => s.group === B.group) : [B];
          for (const s of grp) { s.x += move.x; s.y += move.y; }
          const label = { cc: 'centre to centre', gap: 'edge gap', ce: 'centre to edge', ec: 'edge to centre', ff: 'overall' }[MODE.value];
          LOG.action(`Set ${label} = ${fmtIn(d)} in between "${A.name}" and "${B.name}" (centres ${fmtIn(cc)} in apart)`);
          close(); refresh();
        };
      });
  }
  $('#btnDist').onclick = openDistance;

  // ---------- tool hints ----------
  /* Several tools need a second action to finish (Enter, double-click). With
     no prompt, a line drawn with two clicks simply never appears and the tool
     looks broken. Show what finishes the current tool, on screen. */
  const TOOL_HINTS = {
    select: 'Click a <b>line</b> to select it (then <span class="k">Del</span>) · double-click for the whole part · <span class="k">Alt</span>+click to skip lines',
    rect: 'Drag a rectangle, or type the <b>width</b>, <span class="k">Tab</span>, the <b>height</b>, <span class="k">Enter</span>',
    circle: 'Drag from the centre, then type the <b>radius</b> or <span class="k">Tab</span> to the <b>diameter</b> \u00b7 <span class="k">Enter</span>',
    ellipse: 'Drag from the centre, or type <b>radius X</b>, <span class="k">Tab</span>, <b>radius Y</b>, <span class="k">Enter</span>',
    arc: 'Click <b>start</b>, then <b>end</b>, then a point <b>on the curve</b>',
    poly: 'Click corners · type a <b>length</b> then <span class="k">Tab</span> for the angle · <span class="k">Enter</span> or double-click to close',
    pline: 'Click points · type a <b>length</b> then <span class="k">Tab</span> for the angle · <span class="k">Enter</span>, double-click or right-click to finish',
    spline: 'Click points · <span class="k">Enter</span> to finish · click the first point to close',
    measure: 'Click two points · snaps square within 10° · hold <span class="k">Alt</span> for a true diagonal',
    dim: 'Click two points, then a third to place the line',
    trim: 'Click an <b>edge to delete it</b> — or, where paths cross, the span to trim away',
    extend: 'Click near the end of a path to extend it',
  };
  function updateHint() {
    const el = $('#toolHint');
    if (!el) return;
    const h = TOOL_HINTS[tool] || '';
    el.innerHTML = h;
    el.style.display = h ? 'block' : 'none';
  }

  // ---------- dynamic length / angle entry ----------
  /* Type an exact length and angle for the next point instead of clicking and
     hoping. This is how a corner at a known angle actually gets drawn. */
  const dynEl = () => $('#dynIn');
  let dynLastEditedRef = () => 'len';   // set up by wireDyn
  let dynActive = false;
  /* After a rect/circle/ellipse is drawn, the entry box stays open next to the
     cursor holding the size just drawn, so it can be corrected to exact numbers
     without going near the panel. It used to vanish on mouse-up, which left no
     moment in which it could be typed into at all. */
  let dynTarget = null;      // id of the shape the box is currently editing
  function dynAnchor() { return drawAnchor(); }
  function showDyn(show) {
    const el = dynEl(); if (!el) return;
    if (!show) { el.style.display = 'none'; dynActive = false; return; }
    el.style.display = 'flex';
  }
  function placeDyn() {
    const el = dynEl();
    if (!el) return;
    // while editing a drawn part, sit just above-right of the cursor
    if (dynTarget && !drawing) {
      el.style.left = Math.round(mouse.x / devicePixelRatio + 18) + 'px';
      el.style.top = Math.round(mouse.y / devicePixelRatio - 34) + 'px';
      return;
    }
    const a = dynAnchor() || (drawing && drawing.a);
    if (!a) return;
    const p = W2S(a);
    el.style.left = Math.round(p.x / devicePixelRatio + 18) + 'px';
    el.style.top = Math.round(p.y / devicePixelRatio - 34) + 'px';
  }
  function refreshDynValues(mode) {
    if (dynActive) return;                    // don't fight the operator's typing
    mode = mode || dynMode(); if (!mode) return;
    if (mode.kind === 'polar') {
      const a = dynAnchor(); if (!a) return;
      const cur = drawing ? (drawing.cur || drawing.b) : null;
      if (!cur) return;
      $('#dynLen').value = fmtIn(G.dist(a, cur));
      $('#dynAng').value = (+(((Math.atan2(cur.y - a.y, cur.x - a.x) * 180 / Math.PI) % 360 + 360) % 360).toFixed(2)).toString();
      return;
    }
    if (mode.edit) {
      const t = mode.edit;
      if (t.kind === 'rect') { $('#dynLen').value = fmtIn(t.w); $('#dynAng').value = fmtIn(t.h); }
      else if (t.kind === 'circle') { $('#dynLen').value = fmtIn(t.r); $('#dynAng').value = fmtIn(t.r * 2); }
      else { $('#dynLen').value = fmtIn(t.rx); $('#dynAng').value = fmtIn(t.ry); }
      return;
    }
    if (!drawing || !drawing.a || !drawing.b) return;
    const dx = Math.abs(drawing.b.x - drawing.a.x), dy = Math.abs(drawing.b.y - drawing.a.y);
    if (mode.kind === 'circle') {
      const rr = G.dist(drawing.a, drawing.b);
      $('#dynLen').value = fmtIn(rr); $('#dynAng').value = fmtIn(rr * 2);
    }
    else { $('#dynLen').value = fmtIn(dx); $('#dynAng').value = fmtIn(dy); }
  }
  /* What the two boxes mean depends on the tool:
       poly / pline / spline / arc -> length + angle from the last point
       rect                        -> width + height
       circle                      -> radius (second box hidden)
       ellipse                     -> radius X + radius Y
     "7 rectangles 6.5 x 7" is the common job, so a rectangle should not have
     to be dragged to an exact size. */
  function dynMode() {
    if (drawing && drawing.kind === 'rect') return { kind: 'rect', l1: 'w', l2: 'h' };
    if (drawing && drawing.kind === 'circle') return { kind: 'circle', l1: 'R', l2: 'dia' };
    if (drawing && drawing.kind === 'ellipse') return { kind: 'ellipse', l1: 'rX', l2: 'rY' };
    if (dynAnchor() && ['poly', 'pline', 'spline', 'arc'].includes(tool)) return { kind: 'polar', l1: 'len', l2: 'ang' };
    // no drag in progress, but a freshly drawn part is still on the hook
    const t = dynTargetShape();
    if (t) {
      if (t.kind === 'rect') return { kind: 'rect', l1: 'w', l2: 'h', edit: t };
      if (t.kind === 'circle') return { kind: 'circle', l1: 'R', l2: 'dia', edit: t };
      if (t.kind === 'ellipse') return { kind: 'ellipse', l1: 'rX', l2: 'rY', edit: t };
    }
    return null;
  }
  function dynTargetShape() { return dynTarget ? job.shapes.find(x => x.id === dynTarget) : null; }
  function clearDynTarget() { if (dynTarget) { dynTarget = null; showDyn(false); return true; } return false; }
  function syncDyn() {
    const mode = dynMode();
    if (!mode) { showDyn(false); return; }
    showDyn(true);
    const el = dynEl();
    const labs = el.querySelectorAll('label');
    if (labs[0]) labs[0].textContent = mode.l1;
    if (labs[1]) { labs[1].textContent = mode.l2 || ''; labs[1].style.display = mode.l2 ? '' : 'none'; }
    $('#dynAng').style.display = mode.l2 ? '' : 'none';
    const deg = el.querySelector('.deg');
    if (deg) deg.style.display = mode.kind === 'polar' ? '' : 'none';
    placeDyn(); refreshDynValues(mode);
  }
  function commitDyn() {
    const mode = dynMode(); if (!mode) return;
    const v1 = parseFloat($('#dynLen').value);
    const v2 = parseFloat($('#dynAng').value);
    dynActive = false;
    $('#dynLen').blur(); $('#dynAng').blur();

    if (mode.kind === 'polar') {
      const a = dynAnchor(); if (!a) return;
      if (!isFinite(v1) || !isFinite(v2)) { toast('Enter a length and an angle'); return; }
      const rad = v2 * Math.PI / 180;
      commitPoint({ x: a.x + v1 * Math.cos(rad), y: a.y + v1 * Math.sin(rad) });
      draw(); syncDyn();
      return;
    }
    if (mode.edit) {
      const t = mode.edit;
      snapshot();
      if (t.kind === 'rect') {
        if (v1 > 0) t.w = v1;
        if (v2 > 0) t.h = v2;
        LOG.action('Resized "' + t.name + '" to ' + fmtIn(t.w) + ' x ' + fmtIn(t.h) + ' in');
      } else if (t.kind === 'circle') {
        const rNew = dynLastEditedRef() === 'ang' ? (v2 > 0 ? v2 / 2 : NaN) : v1;
        if (!(rNew > 0)) { toast('Enter a radius or a diameter'); return; }
        t.r = rNew;
        LOG.action('Resized "' + t.name + '" to R ' + fmtIn(rNew) + ' in (dia ' + fmtIn(rNew * 2) + ')');
      } else {
        if (v1 > 0) t.rx = v1;
        if (v2 > 0) t.ry = v2;
        LOG.action('Resized "' + t.name + '" to ' + fmtIn(t.rx * 2) + ' x ' + fmtIn(t.ry * 2) + ' in');
      }
      delete t.startPt;
      clearDynTarget();
      invalidateLoops(); refresh();
      return;
    }
    // drag tools: the typed numbers ARE the finished size, measured from the
    // point that was clicked (a corner for a rectangle, the centre otherwise)
    const origin = drawing && drawing.a;
    if (!origin) return;
    if (mode.kind === 'rect') {
      if (!(v1 > 0) || !(v2 > 0)) { toast('Enter a width and a height'); return; }
      drawing = null; showDyn(false);
      addShape(makeShape('rect', { x: origin.x, y: origin.y, w: v1, h: v2, r: 0 }));
      LOG.action('Rectangle ' + fmtIn(v1) + ' x ' + fmtIn(v2) + ' in entered by size');
    } else if (mode.kind === 'circle') {
      const rNew = dynLastEditedRef() === 'ang' ? (v2 > 0 ? v2 / 2 : NaN) : v1;
      if (!(rNew > 0)) { toast('Enter a radius or a diameter'); return; }
      drawing = null; showDyn(false);
      addShape(makeShape('circle', { x: origin.x, y: origin.y, r: rNew }));
      LOG.action('Circle R ' + fmtIn(rNew) + ' in entered by size');
    } else {
      if (!(v1 > 0) || !(v2 > 0)) { toast('Enter both radii'); return; }
      drawing = null; showDyn(false);
      addShape(makeShape('ellipse', { name: 'ellipse', x: origin.x, y: origin.y, rx: v1, ry: v2 }));
      LOG.action('Ellipse ' + fmtIn(v1 * 2) + ' x ' + fmtIn(v2 * 2) + ' in entered by size');
    }
    draw();
  }
  // route a placed point to whichever click-sequence tool is active
  function commitPoint(ws) {
    if (tool === 'arc') {
      if (!drawing) drawing = { kind: 'arc', stage: 1, a: ws, b: null, cur: ws };
      else if (drawing.stage === 1) { drawing.b = ws; drawing.stage = 2; drawing.cur = ws; }
      else finishArc(ws);
      return;
    }
    if (tool === 'poly' || tool === 'pline' || tool === 'spline') {
      if (!drawing) drawing = { kind: tool, pts: [ws], cur: ws };
      else drawing.pts.push(ws);
      if (drawing) drawing.cur = ws;
      return;
    }
  }
  (function wireDyn() {
    const len = $('#dynLen'), ang = $('#dynAng');
    if (!len || !ang) return;
    /* On a circle the two boxes are the same number twice over, so editing
       either one updates the other. Whichever was touched last is the one the
       operator meant, and that is what Enter uses. */
    let dynLastEdited = 'len';
    const mirrorCircle = (from) => {
      const m = dynMode();
      if (!m || m.kind !== 'circle') return;
      dynLastEdited = from;
      const v = parseFloat(from === 'len' ? len.value : ang.value);
      if (!isFinite(v) || v <= 0) return;
      if (from === 'len') ang.value = fmtIn(v * 2); else len.value = fmtIn(v / 2);
    };
    len.addEventListener('input', () => mirrorCircle('len'));
    ang.addEventListener('input', () => mirrorCircle('ang'));
    dynLastEditedRef = () => dynLastEdited;
    for (const el of [len, ang]) {
      el.addEventListener('focus', () => { dynActive = true; });
      el.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== len && document.activeElement !== ang) dynActive = false; }, 0); });
      el.addEventListener('keydown', (e) => {
        e.stopPropagation();                       // keep global shortcuts out of the box
        if (e.key === 'Enter') { e.preventDefault(); commitDyn(); }
        else if (e.key === 'Escape') { e.preventDefault(); dynActive = false; el.blur(); cv.focus(); }
        else if (e.key === 'Tab') { e.preventDefault(); (el === len ? ang : len).focus(); (el === len ? ang : len).select(); }
      });
    }
  })();



  // ================= PUSH 3: text, groups, curves =================

  // ---------- groups ----------
  let nextGroup = 1;
  function groupSel() {
    const shs = selInOrder();
    if (shs.length < 2) return toast('Select two or more parts to group');
    snapshot();
    const gid = 'g' + (nextGroup++);
    shs.forEach(s => s.group = gid);
    LOG.action(`Grouped ${shs.length} parts as ${gid}`);
    refresh();
  }
  function ungroupSel() {
    const shs = selInOrder().filter(s => s.group);
    if (!shs.length) return toast('Nothing grouped in the selection');
    snapshot();
    const gids = new Set(shs.map(s => s.group));
    job.shapes.forEach(s => { if (gids.has(s.group)) delete s.group; });
    LOG.action(`Ungrouped ${gids.size} group(s)`);
    refresh();
  }
  // expand a selection to whole groups, so a plate and its holes move together
  function expandGroups() {
    const gids = new Set();
    for (const sh of job.shapes) if (sel.has(sh.id) && sh.group) gids.add(sh.group);
    if (!gids.size) return false;
    let added = false;
    for (const sh of job.shapes) if (sh.group && gids.has(sh.group) && !sel.has(sh.id)) { sel.add(sh.id); added = true; }
    return added;
  }
  $('#btnGroup').onclick = groupSel;
  $('#btnUngroup').onclick = ungroupSel;

  // ---------- fonts ----------
  const loadedFonts = {};       // name -> parsed font
  let lastFontName = '';
  function fontOptions() {
    return `<option value="">Single-line engraving (built in)</option>` +
      Object.keys(loadedFonts).map(n => `<option value="${esc(n)}" ${n === lastFontName ? 'selected' : ''}>${esc(n)} (outline)</option>`).join('');
  }
  function loadFontFile(file, then) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const f = FONT.parse(fr.result);
        const name = file.name.replace(/\.(ttf|ttc)$/i, '');
        loadedFonts[name] = f;
        lastFontName = name;
        LOG.action(`Font loaded: ${name} (${f.numGlyphs} glyphs, ${f.unitsPerEm} units/em)`);
        toast(`Loaded ${name}`);
        then && then(name);
      } catch (err) {
        LOG.error(`Could not read font "${file.name}"`, err);
        toast(err.message);
      }
    };
    fr.onerror = () => { LOG.error(`Could not read font file "${file.name}"`); toast('Could not read that file'); };
    fr.readAsArrayBuffer(file);
  }

  // ---------- text ----------
  function openText(existing) {
    const m = S.machine;
    modal(`<h3>${existing ? 'Edit' : 'Add'} text</h3>
      <div class="row"><label>Text</label><textarea id="txT" style="flex:1;min-height:52px">${existing ? esc(existing.text) : ''}</textarea></div>
      <div class="row"><label>Font</label><select id="txFont" style="flex:1">${fontOptions()}</select>
        <button class="small" id="txLoad">Load .ttf…</button><input type="file" id="txFile" accept=".ttf,.ttc" style="display:none"></div>
      <div class="row"><label>Cap height</label><input type="number" step="0.125" id="txH" value="${existing ? fmtIn(existing.height) : '1'}"> in</div>
      <div class="row"><label>Letter gap</label><input type="number" step="0.01" id="txTr" value="${existing ? fmtIn(existing.tracking || 0) : '0'}"> in</div>
      <div class="row"><label>Align</label><select id="txAl">
        <option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option></select></div>
      <div class="row"><label>Cut as</label><select id="txOp">
        <option value="on">Engrave along the line (V-bit / small endmill)</option>
        <option value="inside">Pocket the letters out</option>
        <option value="outside">Cut the letters free</option></select></div>
      <p class="muted" id="txNote" style="font-size:11px"></p>
      <div class="row" style="margin-top:10px"><button class="primary" id="txOk">${existing ? 'Update' : 'Add text'}</button><button id="txCancel">Cancel</button></div>`,
      (ov, close) => {
        const F = ov.querySelector('#txFont'), OP = ov.querySelector('#txOp'), NOTE = ov.querySelector('#txNote');
        if (existing) { ov.querySelector('#txAl').value = existing.align || 'left'; OP.value = existing.op || 'on'; if (existing.font) F.value = existing.font; }
        const syncNote = () => {
          const single = !F.value;
          NOTE.innerHTML = single
            ? 'The built-in font is a <b>single-line</b> font: each letter is one open stroke that the tool follows down the middle. That is what you want for engraving a part number. It cannot be pocketed or cut free, so those options are disabled.'
            : 'A normal font gives <b>closed outlines</b>. Engraving along the line traces around each letter rather than drawing it — pick "pocket" or "cut free" unless you actually want the outline traced.';
          for (const o of OP.options) o.disabled = single && o.value !== 'on';
          if (single) OP.value = 'on';
        };
        F.onchange = syncNote; syncNote();
        ov.querySelector('#txLoad').onclick = () => ov.querySelector('#txFile').click();
        ov.querySelector('#txFile').onchange = (e) => {
          const f = e.target.files && e.target.files[0];
          if (f) loadFontFile(f, (name) => { F.innerHTML = fontOptions(); F.value = name; syncNote(); });
        };
        ov.querySelector('#txCancel').onclick = close;
        ov.querySelector('#txOk').onclick = () => {
          const spec = {
            text: ov.querySelector('#txT').value,
            font: F.value,
            height: parseFloat(ov.querySelector('#txH').value) || 1,
            tracking: parseFloat(ov.querySelector('#txTr').value) || 0,
            align: ov.querySelector('#txAl').value,
            op: OP.value,
          };
          if (!spec.text.trim()) { toast('Type some text first'); return; }
          if (spec.height <= 0) { toast('Cap height must be positive'); return; }
          const at = existing ? { x: existing.x, y: existing.y } : { x: S.nest.margin, y: Math.min(m.bedH / 2, 12) };
          if (existing) removeTextGroup(existing.group);
          const made = buildText(spec, at);
          if (!made) return;
          close(); refresh();
        };
      });
  }
  function removeTextGroup(gid) {
    if (!gid) return;
    job.shapes = job.shapes.filter(s => s.group !== gid);
  }
  /* Turn a text spec into shapes. Every letter becomes its own part, all tied
     into one group so the block moves as a unit and can be re-opened later. */
  function buildText(spec, at) {
    let res;
    try {
      res = spec.font && loadedFonts[spec.font]
        ? FONT.outlineText(loadedFonts[spec.font], spec.text, spec)
        : FONT.strokeText(spec.text, spec);
    } catch (err) { LOG.error('Text layout failed', err); toast('Could not lay out that text'); return 0; }

    if (!res.paths.length) { toast('That text produced nothing to cut'); return 0; }
    if (res.missing.length) {
      const list = res.missing.join(' ');
      LOG.warn(`Text: ${res.missing.length} character(s) not in this font were skipped: ${list}`);
      toast(`Skipped unsupported character(s): ${list}`);
    }
    snapshot();
    const gid = 'g' + (nextGroup++);
    const loops = res.paths.map(p => ({ loop: FONT.toLoop(p.pts, p.closed), closed: p.closed }));
    // for outline fonts, a contour inside an odd number of others is a counter
    const depth = loops.map((L, i) => {
      if (!L.closed) return 0;
      const pt = G.pointAt(L.loop[0], 0.5);
      let d = 0;
      loops.forEach((O, j) => { if (i !== j && O.closed && G.pointInLoop(pt, O.loop)) d++; });
      return d;
    });
    let n = 0;
    loops.forEach((L, i) => {
      if (!L.loop.length) return;
      const isHole = L.closed && (depth[i] % 2 === 1);
      const op = !L.closed ? 'on' : (spec.op === 'on' ? 'on' : (isHole ? (spec.op === 'inside' ? 'outside' : 'inside') : spec.op));
      const sh = pathShape(L.loop.map(s => G.line(G.P(s.a.x + at.x, s.a.y + at.y), G.P(s.b.x + at.x, s.b.y + at.y))), {
        name: 'text', open: !L.closed, op, group: gid,
        text: i === 0 ? spec.text : undefined,
      });
      // Keep the spec on the first shape so the block can be re-opened.
      // The anchor is stored separately, NOT as sh.x/sh.y: the loop points
      // are already offset by `at`, and worldLoop would add it a second time.
      if (i === 0) Object.assign(sh, { textSpec: { ...spec }, textAt: { x: at.x, y: at.y } });
      job.shapes.push(sh); n++;
    });
    sel.clear();
    job.shapes.forEach(s => { if (s.group === gid) sel.add(s.id); });
    LOG.action(`Text added: "${spec.text.replace(/\n/g, ' ')}" — ${n} part(s), ${spec.font || 'single-line'} at ${spec.height} in`);
    return n;
  }
  $('#btnText').onclick = () => {
    // re-open the dialog on an existing text block if one is selected
    const cur = selInOrder().find(s => s.textSpec);
    openText(cur ? { ...cur.textSpec, x: (cur.textAt || cur).x, y: (cur.textAt || cur).y, group: cur.group } : null);
  };

  // ---------- ellipse / spline ----------
  function finishEllipse(d) {
    const rx = Math.abs(d.b.x - d.a.x), ry = Math.abs(d.b.y - d.a.y);
    if (rx < 0.01 || ry < 0.01) { draw(); return; }
    const sh = makeShape('ellipse', { name: 'ellipse', x: d.a.x, y: d.a.y, rx, ry });
    addShape(sh); dynTarget = sh.id;
    LOG.action(`Ellipse added: ${fmtIn(rx * 2)} × ${fmtIn(ry * 2)} in`);
  }
  function finishSpline() {
    const d = drawing; drawing = null; showDyn(false);
    if (!d || d.pts.length < 3) { draw(); return; }
    const x0 = Math.min(...d.pts.map(p => p.x)), y0 = Math.min(...d.pts.map(p => p.y));
    const closed = !!d.closeIt;
    addShape(makeShape('spline', {
      name: 'spline', x: x0, y: y0, open: !closed, op: closed ? 'outside' : 'on',
      pts: d.pts.map(p => ({ x: p.x - x0, y: p.y - y0 })),
    }));
    LOG.action(`Spline added through ${d.pts.length} points${closed ? ' (closed)' : ''}`);
  }



  /* ---------- T-junction merge ----------
     Draw a line from the corner of a C to a point partway along one of its
     other sides and the two are geometrically touching, but they are still two
     separate objects and the touched side is still one long segment. Splitting
     that segment at the contact point and merging everything into one part
     makes the new line a numbered side of that part, selectable and deletable
     like any other. */
  function splitAtTouches(entries, tol) {
    // entries: [{id, segs}] - split each segment where another path's END lands on it
    const ends = [];
    for (const e of entries) {
      if (!e.segs.length) continue;
      ends.push({ id: e.id, p: e.segs[0].a });
      ends.push({ id: e.id, p: e.segs[e.segs.length - 1].b });
    }
    let splits = 0;
    for (const e of entries) {
      const out = [];
      for (const sg of e.segs) {
        // parameters along this segment where a foreign endpoint touches it
        const ts = [];
        for (const en of ends) {
          if (en.id === e.id) continue;
          const q = SNAP.nearestOnSeg(sg, en.p);
          if (G.dist(q, en.p) > tol) continue;
          const u = paramOn(sg, q);
          if (u > 1e-4 && u < 1 - 1e-4) ts.push(u);
        }
        if (!ts.length) { out.push(sg); continue; }
        ts.sort((a, b) => a - b);
        let from = 0;
        for (const u of ts) {
          if (u - from < 1e-6) continue;
          const piece = subSeg(sg, from, u);
          if (piece) out.push(piece);
          from = u;
          splits++;
        }
        const tail = subSeg(sg, from, 1);
        if (tail) out.push(tail);
      }
      e.segs = out;
    }
    return splits;
  }

  // order a bag of segments into a continuous-as-possible run
  function orderSegs(segs, tol) {
    if (!segs.length) return [];
    const left = segs.slice();
    const out = [left.shift()];
    while (left.length) {
      const end = out[out.length - 1].b;
      let k = left.findIndex(sg => G.dist(sg.a, end) <= tol);
      if (k >= 0) { out.push(left.splice(k, 1)[0]); continue; }
      k = left.findIndex(sg => G.dist(sg.b, end) <= tol);
      if (k >= 0) { const sg = left.splice(k, 1)[0]; out.push(G.reverseLoop([sg])[0]); continue; }
      // nothing continues from here: start a new run from whatever is left
      out.push(left.shift());
    }
    return out;
  }

  /* Split every path where it meets another, so each crossing becomes a real
     vertex and each piece is its own selectable side. This is what makes a
     junction behave like two lines instead of one long one. */
  function splitAtIntersections(shapes, tol) {
    const targets = shapes.length ? shapes : job.shapes.slice();
    if (!targets.length) return 0;
    const all = job.shapes.map(sh => { try { return { id: sh.id, loop: worldLoop(sh) }; } catch (e) { return { id: sh.id, loop: [] }; } });
    let total = 0;
    for (const sh of targets) {
      let loop;
      try { loop = worldLoop(sh); } catch (e) { continue; }
      if (!loop.length) continue;
      const out = [];
      let splits = 0;
      loop.forEach((sg) => {
        const ts = [];
        for (const other of all) {
          if (other.id === sh.id) continue;
          for (const t of other.loop) {
            // real crossings
            for (const q of SNAP.segSegPoints(sg, t)) {
              const u = paramOn(sg, q);
              if (u > 1e-4 && u < 1 - 1e-4) ts.push(u);
            }
            // and touching ends, which are not crossings but should still split
            for (const endPt of [t.a, t.b]) {
              const q = SNAP.nearestOnSeg(sg, endPt);
              if (G.dist(q, endPt) > tol) continue;
              const u = paramOn(sg, q);
              if (u > 1e-4 && u < 1 - 1e-4) ts.push(u);
            }
          }
        }
        if (!ts.length) { out.push(sg); return; }
        ts.sort((a, b) => a - b);
        let from = 0;
        for (const u of ts) {
          if (u - from < 1e-6) continue;
          const piece = subSeg(sg, from, u);
          if (piece) { out.push(piece); splits++; }
          from = u;
        }
        const tail = subSeg(sg, from, 1);
        if (tail) out.push(tail);
      });
      if (!splits) continue;
      total += splits;
      const ns = pathShape(out, { name: sh.name, open: sh.open, op: sh.op, toolId: sh.toolId, climb: sh.climb, group: sh.group });
      // reuse the original id so selection, grouping and undo stay attached
      ns.id = sh.id;
      if (sh.startPt) ns.startPt = sh.startPt;
      const k = job.shapes.findIndex(x => x.id === sh.id);
      if (k >= 0) job.shapes.splice(k, 1, ns); else job.shapes.push(ns);
      makeEditable(ns);
    }
    return total;
  }
  function splitAtIntersectionsCmd() {
    const shs = selInOrder();
    snapshot();
    const n = splitAtIntersections(shs, trimTol());
    if (!n) { toast('Nothing crosses anything here'); LOG.info('Split at intersections: no crossings found'); refresh(); return; }
    LOG.action('Split ' + n + ' side(s) at crossings' + (shs.length ? ' on ' + shs.length + ' selected part(s)' : ' across the job'));
    toast('Split into ' + n + ' extra side(s) at the crossings');
    clearEdge(); invalidateLoops(); refresh();
  }

  function mergeSelected(tol) {
    /* Any shapes, open or closed. Restricting this to open paths meant a
       leftover closed outline sitting next to an open piece could never be
       welded into one part - which is the usual state after trimming. A closed
       shape simply contributes its ring of segments; splitAtTouches then puts
       a vertex wherever the other path meets it. */
    const shs = selInOrder();
    if (shs.length < 2) return toast('Select two or more parts to merge');
    const entries = shs.map(sh => { let segs = []; try { segs = worldLoop(sh); } catch (e) { } return { id: sh.id, segs }; })
      .filter(e => e.segs.length);
    if (entries.length < 2) return toast('Those paths have no geometry to merge');
    const splits = splitAtTouches(entries, tol);
    const all = entries.flatMap(e => e.segs);
    // are they actually connected? every segment must share a point with the rest
    const pts = [];
    const key = (q) => Math.round(q.x / tol) + '|' + Math.round(q.y / tol);
    for (const sg of all) { pts.push(key(sg.a)); pts.push(key(sg.b)); }
    const touching = all.filter(sg => {
      const ka = key(sg.a), kb = key(sg.b);
      return pts.filter(k => k === ka).length > 1 || pts.filter(k => k === kb).length > 1;
    }).length;
    if (!touching) return toast('Those paths do not touch — nothing to merge');
    snapshot();
    const ids = new Set(shs.map(x => x.id));
    const first = shs[0];
    job.shapes = job.shapes.filter(x => !ids.has(x.id));
    const ordered = orderSegs(all, tol);
    const closed = G.dist(ordered[ordered.length - 1].b, ordered[0].a) <= tol && ordered.length > 2;
    // pull the ends exactly together so the outline is genuinely closed, not nearly
    if (closed) { const f = ordered[0], l = ordered[ordered.length - 1]; if (l.type === 'line') l.b = f.a; else if (f.type === 'line') f.a = l.b; }
    const ns = pathShape(ordered, {
      name: first.name, open: !closed, op: closed ? 'outside' : 'on',
      toolId: first.toolId, climb: first.climb, group: first.group,
    });
    job.shapes.push(ns);
    sel.clear(); sel.add(ns.id); clearEdge();
    makeEditable(ns);
    LOG.action('Merged ' + shs.length + ' parts into one ' + (closed ? 'closed' : 'open') + ' part with ' + ordered.length + ' sides'
      + (splits ? ' (' + splits + ' side(s) split where a line landed partway along)' : ''));
    toast(closed
      ? 'Merged into one closed part - ' + ordered.length + ' sides, cutting outside'
      : 'Merged into one open part - ' + ordered.length + ' sides (ends do not meet, so it cuts on the line)');
    refresh();
  }

  function joinSelected(tol) {
    const shs = selInOrder().filter(s => s.open);
    if (shs.length < 2) return toast('Select two or more open paths to join');
    const loops = shs.map(s => worldLoop(s));
    const chained = G.chainOpen(loops);
    if (chained.length >= loops.length) return toast('Those paths do not meet end to end');
    snapshot();
    const ids = new Set(shs.map(s => s.id));
    job.shapes = job.shapes.filter(s => !ids.has(s.id));
    sel.clear();
    let closedCount = 0;
    for (const ch of chained) {
      // pull near-misses together, then decide open vs closed
      const segs = ch.segs;
      const gap = G.dist(segs[segs.length - 1].b, segs[0].a);
      const isClosed = ch.closed || gap <= tol;
      if (isClosed && !ch.closed) { if (segs[0].type === 'line') segs[0].a = segs[segs.length - 1].b; else segs[segs.length - 1].b = segs[0].a; }
      if (isClosed) closedCount++;
      const sh = pathShape(segs, { name: isClosed ? 'joined part' : 'joined path', open: !isClosed, op: isClosed ? 'outside' : 'on' });
      job.shapes.push(sh); sel.add(sh.id);
    }
    LOG.action(`Joined ${shs.length} paths into ${chained.length} (${closedCount} closed)`);
    refresh();
  }
  function forceClose() {
    const shs = selInOrder().filter(s => s.open);
    if (shs.length !== 1) return toast('Select exactly one open path');
    const sh = shs[0];
    const loop = worldLoop(sh);
    if (loop.length < 2) return toast('That path is too short to close');
    const segs = loop.concat([G.line(loop[loop.length - 1].b, loop[0].a)]);
    snapshot();
    job.shapes = job.shapes.filter(s => s.id !== sh.id);
    const ns = pathShape(segs, { name: sh.name + ' closed', open: false, op: 'outside', toolId: sh.toolId });
    job.shapes.push(ns); sel.clear(); sel.add(ns.id);
    LOG.action(`Closed "${sh.name}" with a ${fmtIn(G.dist(loop[loop.length - 1].b, loop[0].a))} in segment`);
    refresh();
  }

  /* Trim: split the clicked open path at every crossing with other geometry
     and drop the span the user clicked on. */

  /* ---------- heal endpoints ----------
     Drawn or imported paths often stop a few thousandths short of the line
     they were meant to meet. Geometrically that is not a crossing, so trim has
     nothing to cut back to and joins refuse to chain. Pull any endpoint that
     lands within `tol` of another shape's edge onto that edge. */
  function healEndsOf(sh, tol, exclude) {
    if (!sh.open) return null;
    let loop;
    try { loop = worldLoop(sh); } catch (e) { return null; }
    if (!loop.length) return null;
    const others = job.shapes.filter(o => o.id !== sh.id && !(exclude && exclude.has(o.id)));
    let moved = 0;
    const pull = (pt) => {
      let best = null;
      for (const o of others) {
        let ol;
        try { ol = worldLoop(o); } catch (e) { continue; }
        for (const t of ol) {
          const q = SNAP.nearestOnSeg(t, pt);
          const d = G.dist(q, pt);
          if (d > 1e-9 && d <= tol && (!best || d < best.d)) best = { q, d };
        }
      }
      return best;
    };
    const first = loop[0], last = loop[loop.length - 1];
    const a = pull(first.a);
    if (a) { if (first.type === 'line') first.a = a.q; else { first.a = a.q; } moved++; }
    const b = pull(last.b);
    if (b) { if (last.type === 'line') last.b = b.q; else { last.b = b.q; } moved++; }
    if (!moved) return null;
    return { loop, moved, da: a && a.d, db: b && b.d };
  }
  // replace a shape in place with a healed version, keeping its cut settings
  function replaceWithLoop(sh, loop, nameSuffix) {
    const idx = job.shapes.findIndex(s => s.id === sh.id);
    const ns = pathShape(loop, {
      name: sh.name + (nameSuffix || ''), open: sh.open, op: sh.op,
      toolId: sh.toolId, climb: sh.climb, group: sh.group,
    });
    if (idx >= 0) job.shapes.splice(idx, 1, ns); else job.shapes.push(ns);
    return ns;
  }
  function healSelection(tol) {
    const shs = selInOrder().filter(s => s.open);
    const targets = shs.length ? shs : job.shapes.filter(s => s.open);
    if (!targets.length) return toast('No open paths to heal');
    snapshot();
    let n = 0, worst = 0;
    for (const sh of targets.slice()) {
      const r = healEndsOf(sh, tol);
      if (!r) continue;
      worst = Math.max(worst, r.da || 0, r.db || 0);
      replaceWithLoop(sh, r.loop);
      n += r.moved;
    }
    if (!n) { toast(`No loose ends within ${fmtIn(tol)} in`); LOG.info(`Heal ends: nothing within ${tol} in`); refresh(); return; }
    LOG.action(`Healed ${n} loose end(s) onto nearby edges (largest move ${fmtIn(worst)} in)`);
    toast(`Pulled ${n} end${n > 1 ? 's' : ''} onto the nearest edge`);
    refresh();
  }

  // every point where this shape crosses any other, as {segment index, param}
  function crossingsOf(target, loop) {
    const others = job.shapes.filter(s => s.id !== target.id).map(s => { try { return worldLoop(s); } catch (e) { return []; } });
    const cuts = [];
    loop.forEach((s, i) => {
      for (const o of others) for (const t of o) {
        for (const p of SNAP.segSegPoints(s, t)) {
          const u = paramOn(s, p);
          if (u > 1e-6 && u < 1 - 1e-6) cuts.push({ i, u, p });
        }
      }
    });
    cuts.sort((a, b) => (a.i - b.i) || (a.u - b.u));
    return cuts;
  }

  /* Delete the one segment under the cursor.
     A closed shape becomes an open path that simply stops short of the gap -
     drop one side of a rectangle and you get a C. An open path splits in two
     (or loses an end). Fillet arcs count as their own segments, so clicking a
     straight side of a rounded rectangle removes only that side. */
  function eraseEdgeAt(target, loop, wp) {
    let bi = -1, bd = Infinity;
    loop.forEach((s, i) => { const d = distToLoopSeg(wp, s); if (d < bd) { bd = d; bi = i; } });
    if (bi < 0) return toast('Click closer to the edge you want to remove');
    const n = loop.length;
    const wasClosed = !target.open;
    const pieces = [];
    if (wasClosed) {
      // reopen the loop starting just after the deleted edge
      const rest = [];
      for (let k = 1; k < n; k++) rest.push(loop[(bi + k) % n]);
      if (rest.length) pieces.push(rest);
    } else {
      const before = loop.slice(0, bi), after = loop.slice(bi + 1);
      if (before.length) pieces.push(before);
      if (after.length) pieces.push(after);
    }
    snapshot();
    job.shapes = job.shapes.filter(s => s.id !== target.id);
    sel.clear();
    if (!pieces.length) {
      LOG.action(`Deleted the last edge of "${target.name}", removing the part`);
      refresh();
      return;
    }
    for (const segs of pieces) {
      const ns = pathShape(segs, { name: target.name, open: true, op: 'on', toolId: target.toolId, climb: target.climb, group: target.group });
      job.shapes.push(ns); sel.add(ns.id);
    }
    const kind = loop[bi].type === 'arc' ? 'arc' : 'edge';
    LOG.action(`Removed one ${kind} from "${target.name}"`
      + (wasClosed ? ' — the part is now an open path, cut on the line' : ` — split into ${pieces.length} path(s)`));
    if (wasClosed) toast('Edge removed — the part is now an open path (cut "on" the line)');
    refresh();
  }

  function trimAt(wp, forced) {
    const target = forced || hitShape(wp);
    if (!target) return toast('Click the edge you want to remove');
    const loop = worldLoop(target);
    if (!loop.length) return;
    /* No crossings to trim back to? Then the operator means "delete this
       edge" - e.g. dropping one side of a rectangle to leave a C. That is far
       less work than rebuilding the shape as a 3-sided polyline. */
    if (!crossingsOf(target, loop).length) {
      /* Nearly-touching counts. Pull a loose end onto the edge it was meant to
         meet (within the trim tolerance) and look again before falling back to
         deleting the clicked edge. */
      const tol = trimTol();
      const healed = healEndsOf(target, tol);
      if (healed && crossingsOf(target, healed.loop).length) {
        snapshot();
        const ns = replaceWithLoop(target, healed.loop);
        LOG.action(`Trim: pulled a loose end ${fmtIn(Math.max(healed.da || 0, healed.db || 0))} in onto the crossing edge first`);
        toast('Pulled the loose end onto the line, then trimmed');
        invalidateLoops();
        return trimAt(wp, ns);
      }
      return eraseEdgeAt(target, loop, wp);
    }
    const cuts = crossingsOf(target, loop);
    cuts.sort((a, b) => (a.i - b.i) || (a.u - b.u));
    // build spans between consecutive cuts
    const spans = [];
    let cur = [];
    let ci = 0;
    for (let i = 0; i < loop.length; i++) {
      let s = loop[i];
      const here = cuts.filter(c => c.i === i);
      let from = 0;
      for (const c of here) {
        cur.push(subSeg(s, from, c.u));
        spans.push(cur); cur = [];
        from = c.u;
      }
      cur.push(subSeg(s, from, 1));
    }
    if (cur.length) spans.push(cur);
    const valid = spans.filter(sp => sp.length && sp.reduce((n, x) => n + G.segLen(x), 0) > 1e-6);
    if (valid.length < 2) return toast('Nothing to trim there');
    // which span did they click?
    let best = -1, bd = Infinity;
    valid.forEach((sp, k) => { for (const s of sp) { const d = distToLoopSeg(wp, s); if (d < bd) { bd = d; best = k; } } });
    if (best < 0) return;
    snapshot();
    job.shapes = job.shapes.filter(s => s.id !== target.id);
    sel.clear();
    valid.forEach((sp, k) => {
      if (k === best) return;
      const ns = pathShape(sp, { name: target.name, open: true, op: 'on', toolId: target.toolId });
      job.shapes.push(ns); sel.add(ns.id);
    });
    LOG.action(`Trimmed "${target.name}" — removed 1 of ${valid.length} spans`);
    refresh();
  }
  function paramOn(s, p) {
    if (s.type === 'line') { const d = G.sub(s.b, s.a), L2 = G.dot(d, d) || 1; return G.dot(G.sub(p, s.a), d) / L2; }
    const a0 = Math.atan2(s.a.y - s.c.y, s.a.x - s.c.x), sw = G.sweep(s);
    let da = Math.atan2(p.y - s.c.y, p.x - s.c.x) - a0;
    if (sw > 0) { while (da < 0) da += 2 * Math.PI; } else { while (da > 0) da -= 2 * Math.PI; }
    return sw === 0 ? 0 : da / sw;
  }
  function subSeg(s, u0, u1) {
    if (u1 - u0 < 1e-9) return null;
    if (s.type === 'line') return G.line(G.pointAt(s, u0), G.pointAt(s, u1));
    return G.arc(G.pointAt(s, u0), G.pointAt(s, u1), s.c, s.ccw);
  }
  function distToLoopSeg(p, s) {
    const pts = G.samplePts(s, 0.05);
    let d = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, distToSeg(p, pts[i], pts[i + 1]));
    return d;
  }

  /* Extend: run the nearer end of an open path forward along its own tangent
     until it meets another shape. */
  function extendAt(wp) {
    const target = hitShape(wp);
    if (!target || !target.open) return toast('Click near the end of an open path');
    const loop = worldLoop(target);
    const atStart = G.dist(wp, loop[0].a) < G.dist(wp, loop[loop.length - 1].b);
    const seg = atStart ? loop[0] : loop[loop.length - 1];
    const from = atStart ? seg.a : seg.b;
    let dir = G.tangentAt(seg, atStart);
    if (atStart) dir = G.mul(dir, -1);
    const ray = G.line(from, G.add(from, G.mul(dir, 1e4)));
    let best = null;
    for (const sh of job.shapes) {
      if (sh.id === target.id) continue;
      for (const t of worldLoop(sh)) for (const p of SNAP.segSegPoints(ray, t)) {
        const d = G.dist(from, p);
        if (d > 1e-6 && (!best || d < best.d)) best = { p, d };
      }
    }
    if (!best) return toast('Nothing ahead of that end to extend to');
    snapshot();
    const segs = atStart ? [G.line(best.p, from)].concat(loop) : loop.concat([G.line(from, best.p)]);
    job.shapes = job.shapes.filter(s => s.id !== target.id);
    const ns = pathShape(segs, { name: target.name, open: true, op: 'on', toolId: target.toolId });
    job.shapes.push(ns); sel.clear(); sel.add(ns.id);
    LOG.action(`Extended "${target.name}" by ${fmtIn(best.d)} in`);
    refresh();
  }

  // ---------- on-canvas dimensions ----------
  // dims live on the job but are annotation only: never posted, never cut
  function ensureDims() { if (!job.dims) job.dims = []; return job.dims; }
  /* One dimension line: witness lines up from a and b, the measured line
     between them offset by `off`, arrow ticks, and a boxed label. Shared by
     placed dimensions and the automatic size labels on a selected part. */
  function drawDimLine(a, b, off, label, colour) {
    const dpr = devicePixelRatio;
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
    if (L < 1e-9) return;
    const nx = -dy / L, ny = dx / L;
    const A = { x: a.x + nx * off, y: a.y + ny * off }, B = { x: b.x + nx * off, y: b.y + ny * off };
    const pa = W2S(A), pb = W2S(B), qa = W2S(a), qb = W2S(b);
    const span = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    /* Too short to draw arrows into without a mess - but still label it. A
       small circle's radius line is barely any length on screen, and dropping
       the label entirely would leave no way to click and retype it. */
    if (span < 24 * dpr) {
      const m0 = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
      const tw = ctx.measureText(label).width;
      const b0 = { x: m0.x - tw / 2 - 4, y: m0.y - 9 * dpr, w: tw + 8, h: 16 * dpr };
      ctx.fillStyle = 'rgba(20,22,26,.85)'; ctx.fillRect(b0.x, b0.y, b0.w, b0.h);
      ctx.fillStyle = colour; ctx.fillText(label, m0.x - tw / 2, m0.y + 4 * dpr);
      return b0;
    }
    ctx.strokeStyle = colour; ctx.lineWidth = 1.2 * dpr; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(qa.x, qa.y); ctx.lineTo(pa.x, pa.y); ctx.moveTo(qb.x, qb.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    const ux = (pb.x - pa.x) / span, uy = (pb.y - pa.y) / span, t = 5 * dpr;
    ctx.beginPath();
    ctx.moveTo(pa.x + ux * t - uy * t, pa.y + uy * t + ux * t); ctx.lineTo(pa.x, pa.y); ctx.lineTo(pa.x + ux * t + uy * t, pa.y + uy * t - ux * t);
    ctx.moveTo(pb.x - ux * t - uy * t, pb.y - uy * t + ux * t); ctx.lineTo(pb.x, pb.y); ctx.lineTo(pb.x - ux * t + uy * t, pb.y - uy * t - ux * t);
    ctx.stroke();
    const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
    const w = ctx.measureText(label).width;
    const box = { x: mid.x - w / 2 - 4, y: mid.y - 9 * dpr, w: w + 8, h: 16 * dpr };
    ctx.fillStyle = 'rgba(20,22,26,.85)'; ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.fillStyle = colour; ctx.fillText(label, mid.x - w / 2, mid.y + 4 * dpr);
    return box;                       // so a size label can be hit-tested and edited
  }

  function drawDims() {
    const dims = job.dims || [];
    const dpr = devicePixelRatio;
    ctx.save();
    ctx.font = `${12 * dpr}px ui-monospace, monospace`;
    for (const d of dims.concat(dimDraft && dimDraft.b ? [dimDraft] : [])) {
      const L = G.dist(d.a, d.b);
      drawDimLine(d.a, d.b, d.off || 0, d.text || fmtIn(L) + '"', '#d38cff');
    }
    ctx.restore();
  }

  /* Size labels on the selected part, so width/height/diameter read off the
     drawing the way an edge length does - without hunting the panel for them. */
  let sizeHits = [];   // clickable dimension labels, in device pixels
  function drawSizeLabels() {
    sizeHits = [];
    const el = $('#chkSizes');
    if (el && !el.checked) return;
    if (!sel.size || sel.size > 3) return;         // a crowd of labels helps nobody
    const dpr = devicePixelRatio;
    const gap = 14 * dpr / view.scale;             // offset the dimension line off the part
    ctx.save();
    ctx.font = `${12 * dpr}px ui-monospace, monospace`;
    for (const sh of job.shapes) {
      if (!sel.has(sh.id)) continue;
      let loop;
      try { loop = worldLoop(sh); } catch (e) { continue; }
      if (!loop.length) continue;
      const b = G.bbox(loop);

      if (sh.kind === 'circle' || (sh.kind === 'ellipse' && Math.abs(sh.rx - sh.ry) < 1e-9)) {
        const r = sh.kind === 'circle' ? sh.r : sh.rx;
        // diameter across the centre, plus the radius value beside it
        // radius, drawn from the centre out - not the diameter
        const rb = drawDimLine({ x: sh.x, y: sh.y }, { x: sh.x + r, y: sh.y }, 0, `R ${fmtIn(r)}"`, '#7fd8a0');
        if (rb) sizeHits.push({ ...rb, id: sh.id, key: 'r', value: r, label: 'Radius' });
        continue;
      }
      if (sh.kind === 'ellipse') {
        const eb1 = drawDimLine({ x: sh.x - sh.rx, y: sh.y }, { x: sh.x + sh.rx, y: sh.y }, 0, `${fmtIn(sh.rx * 2)}"`, '#7fd8a0');
        if (eb1) sizeHits.push({ ...eb1, id: sh.id, key: 'dx', value: sh.rx * 2, label: 'Width' });
        const eb2 = drawDimLine({ x: sh.x, y: sh.y - sh.ry }, { x: sh.x, y: sh.y + sh.ry }, 0, `${fmtIn(sh.ry * 2)}"`, '#7fd8a0');
        if (eb2) sizeHits.push({ ...eb2, id: sh.id, key: 'dy', value: sh.ry * 2, label: 'Height' });
        continue;
      }
      // everything else: overall width and height across the bounding box
      const wLabel = (sh.kind === 'rect' && !sh.rot) ? fmtIn(sh.w) + '"' : fmtIn(b.w) + '"';
      const hLabel = (sh.kind === 'rect' && !sh.rot) ? fmtIn(sh.h) + '"' : fmtIn(b.h) + '"';
      const wb = drawDimLine({ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, -gap, wLabel, '#7fd8a0');
      if (wb) sizeHits.push({ ...wb, id: sh.id, key: 'w', value: (sh.kind === 'rect' && !sh.rot) ? sh.w : b.w, label: 'Width' });
      const hb = drawDimLine({ x: b.x0, y: b.y1 }, { x: b.x0, y: b.y0 }, -gap, hLabel, '#7fd8a0');
      if (hb) sizeHits.push({ ...hb, id: sh.id, key: 'h', value: (sh.kind === 'rect' && !sh.rot) ? sh.h : b.h, label: 'Height' });
      // corner radius, when there is one and it is uniform
      if (sh.kind === 'rect' && sh.r > 0 && !(sh.rc || []).some(v => v != null)) {
        const p = W2S({ x: b.x0 + sh.r * 0.3, y: b.y1 - sh.r * 0.3 });
        const rl = `R ${fmtIn(sh.r)}"`;
        const w = ctx.measureText(rl).width;
        ctx.fillStyle = 'rgba(20,22,26,.85)'; ctx.fillRect(p.x + 6, p.y - 8 * dpr, w + 8, 16 * dpr);
        ctx.fillStyle = '#7fd8a0'; ctx.fillText(rl, p.x + 10, p.y + 5 * dpr);
      }
    }
    ctx.restore();
  }
  let dimDraft = null;   // {a, b, off} while placing
  function dimClick(ws) {
    if (!dimDraft) { dimDraft = { a: ws, b: null, off: 0 }; return; }
    if (!dimDraft.b) { dimDraft.b = ws; return; }
    // third click sets the offset distance
    const d = dimDraft, dx = d.b.x - d.a.x, dy = d.b.y - d.a.y, L = Math.hypot(dx, dy) || 1;
    d.off = ((ws.x - d.a.x) * (-dy / L)) + ((ws.y - d.a.y) * (dx / L));
    snapshot();
    ensureDims().push({ a: d.a, b: d.b, off: d.off });
    LOG.action(`Dimension added: ${fmtIn(L)} in`);
    dimDraft = null;
    refresh();
  }
  function deleteDimNear(wp) {
    const dims = job.dims || [];
    for (let i = dims.length - 1; i >= 0; i--) {
      const d = dims[i], dx = d.b.x - d.a.x, dy = d.b.y - d.a.y, L = Math.hypot(dx, dy) || 1;
      const nx = -dy / L, ny = dx / L;
      const A = { x: d.a.x + nx * d.off, y: d.a.y + ny * d.off }, B = { x: d.b.x + nx * d.off, y: d.b.y + ny * d.off };
      if (distToSeg(wp, A, B) < 6 / view.scale) { snapshot(); dims.splice(i, 1); LOG.action('Dimension removed'); refresh(); return true; }
    }
    return false;
  }


  // ---------- object snap settings ----------
  function syncSnapUI() {
    $('#btnSnapMenu').classList.toggle('active', !!S.snap.on);
    $('#btnOrtho').classList.toggle('active', !!S.snap.ortho);
  }
  $('#btnOrtho').onclick = () => { S.snap.ortho = !S.snap.ortho; saveSettings(); syncSnapUI(); draw(); };
  $('#btnSnapMenu').onclick = (e) => {
    const existing = document.querySelector('.popover');
    if (existing) { existing.remove(); return; }
    const pop = document.createElement('div'); pop.className = 'popover';
    const r = e.currentTarget.getBoundingClientRect();
    pop.style.left = r.left + 'px'; pop.style.top = (r.bottom + 4) + 'px';
    const T = S.snap.types;
    pop.innerHTML = `<h4>Object snap <span class="muted">(F3)</span></h4>
      <label><input type="checkbox" data-s="on" ${S.snap.on ? 'checked' : ''}> <b>Snapping on</b></label>
      <hr style="border:none;border-top:1px solid var(--border);margin:6px 0">
      ${[['endpoint', 'Endpoint'], ['midpoint', 'Midpoint'], ['center', 'Centre'], ['quadrant', 'Quadrant'], ['intersection', 'Intersection'], ['on', 'Nearest on edge'], ['grid', 'Grid']]
        .map(([k, l]) => `<label><input type="checkbox" data-t="${k}" ${T[k] ? 'checked' : ''}> ${l}</label>`).join('')}
      <hr style="border:none;border-top:1px solid var(--border);margin:6px 0">
      <label><input type="checkbox" data-s="ortho" ${S.snap.ortho ? 'checked' : ''}> Ortho lock <span class="muted">(F8)</span></label>
      <hr style="border:none;border-top:1px solid var(--border);margin:6px 0">
      <label><input type="checkbox" data-s="autoSplit" ${S.snap.autoSplit !== false ? 'checked' : ''}> Split at crossings when drawing</label>
      <p class="muted" style="font-size:11px;margin:2px 0 6px">Puts a point in wherever a new line meets existing geometry, so each piece can be picked separately.</p>
      <label style="display:flex;gap:6px;align-items:center">Snap within
        <input type="number" step="0.0625" id="snapRadius" value="${fmtIn(S.snap.radius != null ? S.snap.radius : 0.125)}" style="width:74px"> in</label>
      <p class="muted" style="font-size:11px;margin:2px 0 0">How close a point has to get before it jumps onto existing geometry. Applies while drawing and while dragging.</p>
      <p class="muted" style="font-size:11px;margin:6px 0 0">Hold <b>Shift</b> for a temporary ortho lock, <b>Alt</b> for 45° polar.</p>`;
    document.body.appendChild(pop);
    pop.querySelectorAll('[data-t]').forEach(i => i.onchange = () => { S.snap.types[i.dataset.t] = i.checked; saveSettings(); });
    pop.querySelectorAll('[data-s]').forEach(i => i.onchange = () => { S.snap[i.dataset.s] = i.checked; saveSettings(); syncSnapUI(); draw(); });
    const rIn = pop.querySelector('#snapRadius');
    if (rIn) rIn.onchange = () => { const v = parseFloat(rIn.value); if (isFinite(v) && v >= 0) { S.snap.radius = v; saveSettings(); draw(); } };
    const off = (ev) => { if (!pop.contains(ev.target) && ev.target !== e.currentTarget) { pop.remove(); document.removeEventListener('mousedown', off); } };
    setTimeout(() => document.addEventListener('mousedown', off), 0);
  };

  // ---------- activity log panel ----------
  function renderLog() {
    const body = $('#logBody'); if (!body) return;
    const tb = body.querySelector('tbody');
    const want = new Set(Array.from(document.querySelectorAll('.logFilter')).filter(c => c.checked).map(c => c.value));
    const rows = LOG.entries().filter(e => want.has(e.level)).slice(-400).reverse();
    tb.innerHTML = rows.map(e => {
      const t = new Date(e.t);
      const hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') + ':' + String(t.getSeconds()).padStart(2, '0');
      return `<tr class="${e.level}"><td class="ts">${hh}</td><td class="lv">${e.level}</td><td>${esc(e.msg)}${e.detail ? `<span class="detail">${esc(e.detail)}</span>` : ''}</td></tr>`;
    }).join('') || '<tr><td class="muted" style="padding:8px">Nothing logged yet.</td></tr>';
    const c = LOG.counts();
    const badge = (n, cls) => n ? `<span class="badge ${cls}">${n}</span>` : '';
    $('#logCounts').innerHTML = `${badge(c.error, 'err')} ${badge(c.warn, 'warn')} <span class="badge">${LOG.entries().length}</span>`;
  }
  document.querySelectorAll('.logFilter').forEach(c => c.addEventListener('change', renderLog));
  $('#logClear').onclick = () => { LOG.clear(); LOG.info('Log cleared'); renderLog(); };
  $('#logCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(LOG.toText()); toast('Log copied'); }
    catch (err) { toast('Could not copy: ' + err.message); }
  };
  $('#logSave').onclick = () => download(`cncstudio-${new Date().toISOString().slice(0, 10)}.log`, LOG.toText());
  // live-update the panel, but only while it is actually visible
  LOG.subscribe(() => { if ($('#pageSettings').classList.contains('active')) renderLog(); });

  // ---------- job stats / gcode ----------
  function buildJob() {
    return {
      shapes: job.shapes.filter(s => s.op !== 'none').map(s => ({ loop: worldLoop(s), op: s.op, open: s.open, toolId: s.toolId, startHint: s.startPt, climb: s.climb })),
      tools: S.tools, material: { thickness: job.material.thickness }, cutThrough: job.cutThrough, machine: machineForPost(),
    };
  }
  function machineForPost() { const m = { ...S.machine }; m.lineEnding = S.machine.eol === 'lf' ? '\n' : '\r\n'; return m; }
  let lastGcode = null;
  let lastStats = null;   // last post stats, quoted in the PDF title block
  function updateStats() {
    const el = $('#jobStats');
    const m = S.machine; const bad = job.shapes.filter(s => { const bb = shapeBBox(s); return bb.x0 < -1e-6 || bb.y0 < -1e-6 || bb.x1 > m.bedW + 1e-6 || bb.y1 > m.bedH + 1e-6; });
    if (!job.shapes.length) { el.textContent = '—'; lastGcode = null; lastStats = null; return; }
    try {
      const out = PO.generate(buildJob()); lastGcode = out.gcode;
      const st = out.stats; lastStats = st;
      el.innerHTML = `${job.shapes.length} parts · ${st.passes} passes · ${st.tools.map(esc).join(', ')}<br>Cut length ${st.length.toFixed(1)} in · est. ${st.timeMin.toFixed(1)} min<br>Material ${esc(job.material.name)} (${job.material.thickness}")` + (bad.length ? `<br><span class="warnbox">⚠ ${bad.length} part(s) outside the bed</span>` : '');
    } catch (e) { el.innerHTML = `<span class="warnbox">Toolpath error: ${esc(e.message)}</span>`; console.error(e); }
  }

  /* ---------- dialogs ----------
     Electron's renderer has no window.prompt() - calling it throws
     "prompt() is not supported", which is what was killing the TAP export
     before it produced anything. confirm() and alert() survive but block the
     renderer and look nothing like the rest of the app, so all three are
     replaced with the same modal used everywhere else. */
  function askText(title, label, value, okLabel) {
    return new Promise(resolve => {
      let done = false;
      modal(`<h3>${esc(title)}</h3>
        <div class="row"><label>${esc(label)}</label><input type="text" id="akVal" value="${esc(value || '')}" style="flex:1"></div>
        <div class="row" style="margin-top:10px"><button class="primary" id="akOk">${esc(okLabel || 'OK')}</button><button id="akCancel">Cancel</button></div>`,
        (ov, close) => {
          const inp = ov.querySelector('#akVal');
          const finish = (v) => { if (done) return; done = true; close(); resolve(v); };
          ov.querySelector('#akOk').onclick = () => finish(inp.value);
          ov.querySelector('#akCancel').onclick = () => finish(null);
          inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(inp.value); } });
          ov.addEventListener('mousedown', e => { if (e.target === ov) finish(null); });
        });
    });
  }
  function askConfirm(title, message, okLabel) {
    return new Promise(resolve => {
      let done = false;
      modal(`<h3>${esc(title)}</h3>
        <p style="white-space:pre-wrap">${esc(message)}</p>
        <div class="row" style="margin-top:10px"><button class="primary" id="acOk">${esc(okLabel || 'OK')}</button><button id="acCancel">Cancel</button></div>`,
        (ov, close) => {
          const finish = (v) => { if (done) return; done = true; close(); resolve(v); };
          ov.querySelector('#acOk').onclick = () => finish(true);
          ov.querySelector('#acCancel').onclick = () => finish(false);
          ov.addEventListener('mousedown', e => { if (e.target === ov) finish(false); });
        });
    });
  }

  // ---------- file I/O ----------
  function download(name, text, mime = 'text/plain') {
    const blob = new Blob([text], { type: mime }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function jobName() { return (job.name || 'job').replace(/[^\w\- ]+/g, '_'); }
  $('#btnTap').onclick = async () => {
    if (!job.shapes.length) return toast('Nothing to cut');
    updateStats();
    if (!lastGcode) { toast('Nothing to post — check the parts have a cut operation set'); LOG.warn('Export TAP: no G-code was generated'); return; }
    const name = await askText('Export TAP', 'File name', jobName());
    if (name === null) return;
    const file = (name.trim() || jobName()).replace(/\.tap$/i, '') + '.tap';
    job.name = name.trim() || jobName();
    try {
      download(file, lastGcode);
      const lines = lastGcode.split(/\r?\n/).length;
      LOG.action(`Exported ${file} — ${lines} lines, ${job.shapes.length} part(s)`);
      toast('TAP exported: ' + file);
    } catch (err) {
      LOG.error('TAP export failed', err);
      toast('Could not save the TAP file: ' + err.message);
    }
    $('#gcodePreview').style.display = 'block'; $('#gcodePreview').textContent = lastGcode;
  };
  $('#btnDxf').onclick = () => {
    if (!job.shapes.length) return toast('Nothing to export');
    const loops = [], opens = [];
    for (const s of job.shapes) (s.open ? opens : loops).push(worldLoop(s));
    download(jobName() + '.dxf', G.writeDXF(loops, opens), 'application/dxf'); toast('DXF exported');
  };
  $('#btnSave').onclick = saveProject;
  async function saveProject() {
    const name = await askText('Save project', 'Project name', jobName());
    if (name === null) return;
    job.name = name.trim() || jobName();
    const file = job.name.replace(/\.cncjob$/i, '') + '.cncjob';
    try {
      download(file, JSON.stringify({ version: 1, job, settingsSnapshot: { material: job.material, machine: S.machine, tools: S.tools } }, null, 1), 'application/json');
      LOG.action(`Saved project ${file} — ${job.shapes.length} part(s)`);
      toast('Project saved: ' + file);
    } catch (err) { LOG.error('Project save failed', err); toast('Could not save: ' + err.message); }
  }
  $('#btnNew').onclick = async () => {
    if (job.shapes.length && !(await askConfirm('New job', `Clear the current job? ${job.shapes.length} part(s) will be discarded.`, 'Clear'))) return;
    job = newJob(); sel.clear(); clearEdge(); undoStack = []; syncMaterialUI(); refresh();
    LOG.action('New job started');
  };
  $('#btnOpen').onclick = () => $('#fileIn').click();
  $('#fileIn').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return; e.target.value = '';
    const text = await f.text(); const ext = f.name.split('.').pop().toLowerCase();
    if (ext === 'cncjob' || ext === 'json') { try { const j = JSON.parse(text); snapshot(); job = j.job || j; sel.clear(); syncMaterialUI(); refresh(); toast('Project loaded'); } catch (err) { toast('Bad project file'); } }
    else if (ext === 'dxf') importDXF(text, f.name);
    else importTAP(text, f.name);
  });
  function importDXF(text, name) {
    let res; try { res = G.parseDXF(text); } catch (err) { console.error(err); return toast('Could not read DXF'); }
    if (!res.loops.length && !res.opens.length) return toast('No usable geometry in DXF');
    snapshot();
    const all = res.loops.concat(res.opens); let gx0 = Infinity, gy0 = Infinity; for (const l of all) { const b = G.bbox(l); gx0 = Math.min(gx0, b.x0); gy0 = Math.min(gy0, b.y0); }
    const shift = (gx0 < 0 || gy0 < 0) ? { x: S.nest.margin - gx0, y: S.nest.margin - gy0 } : { x: 0, y: 0 };
    const added = [];
    // holes: a closed loop fully inside another → inside cut
    const loops = res.loops.map(l => ({ l, bb: G.bbox(l), area: Math.abs(G.signedArea(l)) }));
    loops.forEach((L, i) => {
      const inner = loops.some((M, j) => j !== i && M.area > L.area && G.pointInLoop(L.l[0].a, M.l));
      const bb = L.bb; const local = G.translateLoop(L.l, -bb.x0, -bb.y0);
      const sh = makeShape('path', { name: `${name.replace(/\.dxf$/i, '')} ${i + 1}`, x: bb.x0 + shift.x, y: bb.y0 + shift.y, loop: local, op: inner ? 'inside' : 'outside' }); added.push(sh);
    });
    res.opens.forEach((l, i) => { const bb = G.bbox(l); const sh = makeShape('path', { name: `line ${i + 1}`, x: bb.x0 + shift.x, y: bb.y0 + shift.y, loop: G.translateLoop(l, -bb.x0, -bb.y0), open: true, op: 'on' }); added.push(sh); });
    job.shapes.push(...added); sel = new Set(added.map(a => a.id)); refresh(); toast(`Imported ${added.length} objects from DXF`);
  }
  function importTAP(text, name) {
    // show existing TAP in simulator
    showPage('sim'); simLoadText(text, name);
  }
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2200); }


  // ---------- PDF drawing ----------
  /* A shop drawing, not a screenshot: vector output that prints to a true
     scale, with the parts, their sizes, part names and a title block giving
     material, tool and cut time. */
  function openPdf() {
    if (!job.shapes.length) return toast('Nothing to draw');
    modal(`<h3>Export drawing as PDF</h3>
      <div class="row"><label>Page</label><select id="pdPage" style="flex:1">
        <option value="letter">Letter 8.5 x 11</option>
        <option value="legal">Legal 8.5 x 14</option>
        <option value="tabloid">Tabloid 11 x 17</option>
        <option value="a4">A4</option>
        <option value="a3">A3</option>
      </select>
      <label style="min-width:0"><input type="checkbox" id="pdLand" checked> Landscape</label></div>
      <div class="row"><label>Scale</label><select id="pdScale" style="flex:1">
        <option value="fit">Fit to page</option>
        <option value="1">Full size (1:1)</option>
        <option value="0.5">Half size (1:2)</option>
        <option value="0.25">Quarter size (1:4)</option>
      </select></div>
      <div class="row"><label>Include</label>
        <label style="min-width:0"><input type="checkbox" id="pdSizes" checked> Sizes</label>
        <label style="min-width:0"><input type="checkbox" id="pdNames" checked> Part names</label>
        <label style="min-width:0"><input type="checkbox" id="pdBed"> Bed outline</label>
        <label style="min-width:0"><input type="checkbox" id="pdPaths"> Toolpaths</label></div>
      <p class="muted" id="pdNote" style="font-size:11px"></p>
      <div class="row" style="margin-top:10px"><button class="primary" id="pdOk">Export PDF</button><button id="pdCancel">Cancel</button></div>`,
      (ov, close) => {
        const note = () => {
          const sc = ov.querySelector('#pdScale').value;
          ov.querySelector('#pdNote').innerHTML = sc === 'fit'
            ? 'Scaled to fill the page. The scale actually used is printed in the title block, so a print can still be measured knowingly.'
            : 'Fixed scale. If the job does not fit the page at this scale the export will say so rather than silently shrinking it.';
        };
        ov.querySelector('#pdScale').onchange = note; note();
        ov.querySelector('#pdCancel').onclick = close;
        ov.querySelector('#pdOk').onclick = async () => {
          const opts = {
            page: ov.querySelector('#pdPage').value,
            landscape: ov.querySelector('#pdLand').checked,
            scale: ov.querySelector('#pdScale').value,
            sizes: ov.querySelector('#pdSizes').checked,
            names: ov.querySelector('#pdNames').checked,
            bed: ov.querySelector('#pdBed').checked,
            paths: ov.querySelector('#pdPaths').checked,
          };
          close();
          const name = await askText('Export PDF', 'File name', jobName());
          if (name === null) return;
          buildPdf(opts, (name.trim() || jobName()).replace(/\.pdf$/i, '') + '.pdf');
        };
      });
  }

  function buildPdf(opts, filename) {
    try {
      const d = PDFDOC.doc({ page: opts.page, landscape: opts.landscape });
      // what has to fit: the parts, or the whole bed if it is being drawn
      let box;
      if (opts.bed) box = { x0: 0, y0: 0, x1: S.machine.bedW, y1: S.machine.bedH, w: S.machine.bedW, h: S.machine.bedH };
      else {
        const shs = job.shapes;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const sh of shs) { const b = shapeBBox(sh); x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); }
        if (!isFinite(x0)) return toast('Nothing to draw');
        const pad = Math.max(0.5, (x1 - x0) * 0.04);
        box = { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad, w: (x1 - x0) + pad * 2, h: (y1 - y0) + pad * 2 };
      }
      let used;
      if (opts.scale === 'fit') used = d.fit(box, 0.6);
      else {
        used = d.setScale(parseFloat(opts.scale), box, 0.6);
        const needW = box.w * used * PDFDOC.PT + 1.2 * PDFDOC.PT;
        const needH = box.h * used * PDFDOC.PT + 1.2 * PDFDOC.PT;
        if (needW > d.W + 1 || needH > d.H + 1) {
          toast(`Job is ${fmtIn(box.w)} x ${fmtIn(box.h)} in — too big for this page at that scale`);
          LOG.warn(`PDF export: ${fmtIn(box.w)}x${fmtIn(box.h)} in does not fit ${opts.page} at ${opts.scale}`);
          return;
        }
      }

      if (opts.bed) {
        d.gray(0.6).width(0.8).dash(0);
        d.rect(0, S.machine.bedH, S.machine.bedW, S.machine.bedH); d.stroke();
      }

      for (const sh of job.shapes) {
        let loop;
        try { loop = worldLoop(sh); } catch (e) { continue; }
        if (!loop.length) continue;
        if (opts.paths) {
          const tp = toolpathOf(sh);
          if (tp && tp.length) {
            d.gray(0.65).width(0.5).dash(3, 2);
            PDFDOC.tracePath(d, tp, G, !sh.open); d.stroke(); d.dash(0);
          }
        }
        d.gray(0).width(sh.open ? 0.9 : 1.2).dash(0);
        PDFDOC.tracePath(d, loop, G, !sh.open);
        d.stroke();

        const b = G.bbox(loop);
        if (opts.names) d.text((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, sh.name, 8, 'center', 0, -3);
        if (opts.sizes) {
          if (sh.kind === 'circle') d.text(sh.x, sh.y, 'R ' + fmtIn(sh.r) + '"', 8, 'center', 0, 8);
          else d.text((b.x0 + b.x1) / 2, b.y0, fmtIn(b.w) + '" x ' + fmtIn(b.h) + '"', 8, 'center', 0, -11);
        }
      }

      // title block along the bottom
      const st = lastStats || {};
      const line1 = `${job.name || 'Untitled job'}  ·  ${job.shapes.length} part(s)  ·  ${S.materials.find(m => m.name === job.material.name) ? job.material.name : 'material'} ${fmtIn(job.material.thickness)}"`;
      const line2 = `Scale ${used >= 0.999 ? '1:1 (full size)' : '1:' + (1 / used).toFixed(2)}  ·  ${fmtIn(box.w)} x ${fmtIn(box.h)} in  ·  ${new Date().toLocaleString()}`;
      const line3 = st.tools ? `Tools: ${st.tools.join(', ')}  ·  cut ${st.length ? fmtIn(st.length) : '?'} in  ·  est ${st.timeMin ? st.timeMin.toFixed(1) : '?'} min` : '';
      d.gray(0.35);
      d.textPt(36, 40, line1, 10);
      d.textPt(36, 27, line2, 8);
      if (line3) d.textPt(36, 16, line3, 8);

      const out = d.build(job.name || 'CNC Studio drawing');
      download(filename, out, 'application/pdf');
      LOG.action(`Exported ${filename} — ${job.shapes.length} part(s), scale 1:${(1 / used).toFixed(2)}`);
      toast('PDF exported: ' + filename);
    } catch (err) {
      LOG.error('PDF export failed', err);
      toast('Could not build the PDF: ' + err.message);
    }
  }
  $('#btnPdf').onclick = openPdf;

  // ---------- nesting ----------
  $('#btnNest').onclick = () => nestAll();
  function nestAll() {
    if (!job.shapes.length) return;
    snapshot();
    const items = job.shapes.filter(s => s.op !== 'inside').map(s => { const bb = shapeBBox(s); const t = toolOf(s); const k = s.op === 'outside' ? t.dia : 0; return { id: s.id, w: bb.w + k, h: bb.h + k, bb, k }; });
    const res = NE.nest(items, S.machine.bedW, S.machine.bedH, S.nest.gap, S.nest.margin, S.nest.rotate);
    let fails = 0;
    for (const r of res) {
      const sh = job.shapes.find(s => s.id === r.id); const it = items.find(i => i.id === r.id);
      if (r.fail) { fails++; continue; }
      // children (inside cuts) that were inside this shape move with it
      const before = shapeBBox(sh); const kids = job.shapes.filter(k => k.op === 'inside' && k !== sh && (() => { const kb = shapeBBox(k); return kb.x0 >= before.x0 - 1e-6 && kb.x1 <= before.x1 + 1e-6 && kb.y0 >= before.y0 - 1e-6 && kb.y1 <= before.y1 + 1e-6; })());
      if (r.rotated) { sh.rot = (sh.rot || 0) + 90; delete sh.startPt; }
      const nb = shapeBBox(sh); const dx = r.x + it.k / 2 - nb.x0, dy = r.y + it.k / 2 - nb.y0;
      sh.x += dx; sh.y += dy;
      for (const k of kids) { if (r.rotated) { const c = { x: (before.x0 + before.x1) / 2, y: (before.y0 + before.y1) / 2 }; const p = G.add(c, G.rot(G.sub({ x: k.x, y: k.y }, c), Math.PI / 2)); k.x = p.x; k.y = p.y; k.rot = (k.rot || 0) + 90; } k.x += dx; k.y += dy; }
    }
    refresh(); toast(fails ? `${fails} part(s) do not fit on the bed` : 'Parts arranged from bottom-left');
  }

  // ---------- pages ----------
  $$('.tab').forEach(t => t.addEventListener('click', () => showPage(t.dataset.page)));
  function showPage(p) {
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.page === p));
    $('#pageSim').classList.toggle('active', p === 'sim'); $('#pageAi').classList.toggle('active', p === 'ai'); $('#pageSettings').classList.toggle('active', p === 'settings');
    if (p === 'settings') { renderSettings(); renderLog(); } if (p === 'sim') simResize();
  }

  // ---------- settings UI ----------
  function renderSettings() {
    const m = S.machine;
    $('#mBedW').value = m.bedW; $('#mBedH').value = m.bedH; $('#mSafeZ').value = m.safeZ; $('#mDec').value = m.decimals; $('#mEol').value = m.eol || 'crlf';
    $('#mHeader').value = m.header; $('#mToolChange').value = m.toolChange; $('#mFooter').value = m.footer;
    $('#nGap').value = S.nest.gap; $('#nMargin').value = S.nest.margin; $('#nRotate').checked = !!S.nest.rotate;
    $('#aiKey').value = S.ai.key || ''; $('#aiModel').value = S.ai.model || '';
    const tb = $('#toolTable tbody'); tb.innerHTML = '';
    S.tools.forEach((t, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><input type="number" step="1" value="${t.slot}" data-f="slot"></td><td><input type="text" value="${esc(t.name)}" data-f="name"></td><td><select data-f="type"><option ${t.type === 'endmill' ? 'selected' : ''}>endmill</option><option ${t.type === 'drill' ? 'selected' : ''}>drill</option><option ${t.type === 'vbit' ? 'selected' : ''}>vbit</option></select></td><td><input type="number" step="0.0625" value="${t.dia}" data-f="dia"></td><td><input type="number" step="500" value="${t.rpm}" data-f="rpm"></td><td><input type="number" step="10" value="${t.feed}" data-f="feed"></td><td><input type="number" step="5" value="${t.plunge}" data-f="plunge"></td><td><input type="number" step="0.03125" value="${t.passDepth}" data-f="passDepth"></td><td><button class="small" data-del="${i}">✕</button></td>`;
      tr.querySelectorAll('[data-f]').forEach(inp => inp.addEventListener('change', () => { const f = inp.dataset.f; t[f] = inp.type === 'number' ? parseFloat(inp.value) : inp.value; saveSettings(); refresh(); }));
      tr.querySelector('[data-del]').onclick = () => { if (S.tools.length <= 1) return; S.tools.splice(i, 1); saveSettings(); renderSettings(); refresh(); };
      tb.appendChild(tr);
    });
    const mb = $('#matTable tbody'); mb.innerHTML = '';
    S.materials.forEach((mt, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><input type="text" value="${esc(mt.name)}" data-f="name"></td><td><input type="number" step="0.0625" value="${mt.thickness}" data-f="thickness"></td><td><button class="small" data-del="${i}">✕</button></td>`;
      tr.querySelectorAll('[data-f]').forEach(inp => inp.addEventListener('change', () => { const f = inp.dataset.f; mt[f] = inp.type === 'number' ? parseFloat(inp.value) : inp.value; saveSettings(); syncMaterialUI(); }));
      tr.querySelector('[data-del]').onclick = () => { if (S.materials.length <= 1) return; S.materials.splice(i, 1); saveSettings(); renderSettings(); syncMaterialUI(); };
      mb.appendChild(tr);
    });
  }
  const bindSetting = (id, fn) => $(id).addEventListener('change', () => { fn($(id)); saveSettings(); refresh(); });
  bindSetting('#mBedW', el => S.machine.bedW = parseFloat(el.value)); bindSetting('#mBedH', el => S.machine.bedH = parseFloat(el.value));
  bindSetting('#mSafeZ', el => S.machine.safeZ = parseFloat(el.value)); bindSetting('#mDec', el => S.machine.decimals = parseInt(el.value, 10)); bindSetting('#mEol', el => S.machine.eol = el.value);
  bindSetting('#mZLift', el => S.machine.zLift = el.value === '' ? null : parseFloat(el.value));
  bindSetting('#mLeadIn', el => S.machine.leadIn = parseFloat(el.value) || 0);
  bindSetting('#mCreationDate', el => S.machine.creationDate = el.checked);
  bindSetting('#mSpindleTC', el => S.machine.spindleInToolChange = el.checked);
  $('#mApplyPreset').onclick = () => {
    const which = $('#mPreset').value;
    const src = which === 'enroute' ? PO.ENROUTE_CURRENT : PO.DEFAULT_MACHINE;
    // keep bed size and line ending; the preset owns the program format
    const { bedW, bedH, eol } = S.machine;
    S.machine = { ...src, bedW, bedH, eol };
    saveSettings(); renderSettings(); updateStats();
    LOG.action('Machine preset applied: ' + src.name);
    toast('Applied preset: ' + src.name);
  };
  bindSetting('#mHeader', el => S.machine.header = el.value); bindSetting('#mToolChange', el => S.machine.toolChange = el.value); bindSetting('#mFooter', el => S.machine.footer = el.value);
  bindSetting('#nGap', el => S.nest.gap = parseFloat(el.value)); bindSetting('#nMargin', el => S.nest.margin = parseFloat(el.value)); bindSetting('#nRotate', el => S.nest.rotate = el.checked);
  bindSetting('#aiKey', el => S.ai.key = el.value.trim()); bindSetting('#aiModel', el => S.ai.model = el.value.trim());
  $('#toolAdd').onclick = () => { const id = Math.max(0, ...S.tools.map(t => t.id)) + 1; S.tools.push({ id, slot: id, name: 'New tool', type: 'endmill', dia: 0.25, rpm: 18000, feed: 120, plunge: 20, passDepth: 0.125 }); saveSettings(); renderSettings(); };
  $('#matAdd').onclick = () => { S.materials.push({ name: 'New material', thickness: 0.25 }); saveSettings(); renderSettings(); syncMaterialUI(); };
  $('#setExport').onclick = () => download('cncstudio-settings.json', JSON.stringify(S, null, 1), 'application/json');
  $('#setImport').onclick = () => $('#fileSet').click();
  $('#fileSet').addEventListener('change', async e => { const f = e.target.files[0]; if (!f) return; try { S = { ...DEFAULT_SETTINGS, ...JSON.parse(await f.text()) }; saveSettings(); renderSettings(); syncMaterialUI(); refresh(); toast('Settings imported'); } catch (err) { toast('Bad settings file'); } e.target.value = ''; });
  $('#setReset').onclick = async () => { if (!(await askConfirm('Reset settings', 'Reset machine, tools, materials and nesting back to defaults?', 'Reset'))) return; S = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); saveSettings(); renderSettings(); syncMaterialUI(); refresh(); };

  // material UI (left panel)
  function syncMaterialUI() {
    const sel = $('#selMaterial'); sel.innerHTML = S.materials.map((m, i) => `<option value="${i}" ${m.name === job.material.name ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
    $('#inThick').value = job.material.thickness; $('#inCutThrough').value = job.cutThrough || 0;
  }
  $('#selMaterial').addEventListener('change', e => { const m = S.materials[parseInt(e.target.value, 10)]; job.material = { name: m.name, thickness: m.thickness }; $('#inThick').value = m.thickness; updateStats(); });
  $('#inThick').addEventListener('change', e => { job.material.thickness = parseFloat(e.target.value); updateStats(); });
  $('#inCutThrough').addEventListener('change', e => { job.cutThrough = parseFloat(e.target.value) || 0; updateStats(); });
  $('#chkPaths').addEventListener('change', draw); $('#chkKerf').addEventListener('change', draw); $('#selSnap').addEventListener('change', draw);

  // ---------- simulation ----------
  const sc = $('#simCanvas'), sctx = sc.getContext('2d');
  let sim = { moves: [], total: 0, t: 1, playing: false, name: '' };
  function simResize() { const r = sc.getBoundingClientRect(); sc.width = Math.floor(r.width * devicePixelRatio); sc.height = Math.floor(r.height * devicePixelRatio); simDraw(); }
  window.addEventListener('resize', simResize);
  $('#simGen').onclick = () => { updateStats(); if (!lastGcode) return toast('Nothing to simulate'); simLoadText(lastGcode, 'current job'); };
  $('#simLoad').onclick = () => $('#fileSim').click();
  $('#fileSim').addEventListener('change', async e => { const f = e.target.files[0]; if (!f) return; simLoadText(await f.text(), f.name); e.target.value = ''; });
  function simLoadText(text, name) {
    const moves = PO.parseGcode(text); let total = 0;
    const toolDia = (nm) => { const t = S.tools.find(t => t.name === nm); if (t) return t.dia; const m = (nm || '').match(/(\d+)\s*\/\s*(\d+)/); if (m) return parseInt(m[1]) / parseInt(m[2]); const m2 = (nm || '').match(/([\d.]+)/); return m2 ? parseFloat(m2[1]) : 0.25; };
    for (const mv of moves) { mv.dia = toolDia(mv.tool); mv.len = mv.g >= 2 ? arcLen(mv) : G.dist(mv.from, mv.to); mv.t0 = total; const rate = mv.g === 0 ? 600 : (mv.feed || 100); mv.dt = (mv.len + Math.abs(mv.to.z - mv.from.z)) / rate; total += mv.dt; }
    sim = { moves, total, t: 1, playing: false, name };
    $('#simSlider').value = 1000; simResize(); showPage('sim');
    $('#simInfo').textContent = `${name}: ${moves.length} moves · est. ${total.toFixed(1)} min`;
  }
  function arcLen(mv) { const r = G.dist(mv.from, mv.c); if (r < 1e-9) return 0; const s = G.arc(mv.from, mv.to, mv.c, mv.g === 3); return Math.abs(G.sweep(s)) * r; }
  function simDraw() {
    const m = S.machine; const W = sc.width, H = sc.height; const pad = 30;
    const scale = Math.min((W - pad * 2) / m.bedW, (H - pad * 2) / m.bedH); const ox = (W - m.bedW * scale) / 2, oy = (H - m.bedH * scale) / 2;
    const T = (p) => ({ x: ox + p.x * scale, y: H - oy - p.y * scale });
    sctx.setTransform(1, 0, 0, 1, 0, 0); sctx.fillStyle = '#15171b'; sctx.fillRect(0, 0, W, H);
    const a = T({ x: 0, y: 0 }), b = T({ x: m.bedW, y: m.bedH }); sctx.fillStyle = '#e8e2d0'; sctx.fillRect(a.x, b.y, b.x - a.x, a.y - b.y);
    sctx.strokeStyle = '#5a6473'; sctx.strokeRect(a.x, b.y, b.x - a.x, a.y - b.y);
    // part outlines (current job) faint
    for (const sh of job.shapes) { const l = worldLoop(sh); sctx.strokeStyle = 'rgba(0,0,0,.15)'; sctx.lineWidth = 1; sctx.beginPath(); l.forEach((s, i) => { const pts = G.samplePts(s, 0.1); pts.forEach((p, k) => { const q = T(p); (i === 0 && k === 0) ? sctx.moveTo(q.x, q.y) : sctx.lineTo(q.x, q.y); }); }); if (!sh.open) sctx.closePath(); sctx.stroke(); }
    const tcut = sim.t * sim.total; let cur = null;
    sctx.lineCap = 'round'; sctx.lineJoin = 'round';
    for (const mv of sim.moves) {
      if (mv.t0 > tcut) break;
      const frac = mv.dt > 0 ? Math.min(1, (tcut - mv.t0) / mv.dt) : 1;
      const cutting = mv.g !== 0 && (mv.to.z <= job.material.thickness + 1e-6 || mv.from.z <= job.material.thickness + 1e-6) && mv.len > 1e-9;
      if (cutting) {
        const depthFrac = Math.max(0, Math.min(1, 1 - Math.max(mv.to.z, 0) / Math.max(job.material.thickness, 1e-6)));
        sctx.strokeStyle = `rgba(${40 + 60 * (1 - depthFrac)},${40 + 40 * (1 - depthFrac)},${40 + 30 * (1 - depthFrac)},1)`; sctx.lineWidth = Math.max(1, mv.dia * scale);
        sctx.beginPath(); const p0 = T(mv.from);
        if (mv.g >= 2) { const s = G.arc(mv.from, mv.to, mv.c, mv.g === 3); const n = Math.max(2, Math.ceil(mv.len / 0.05)); sctx.moveTo(p0.x, p0.y); for (let i = 1; i <= n * frac; i++) { const q = T(G.pointAt(s, i / n)); sctx.lineTo(q.x, q.y); } }
        else { const q = T({ x: mv.from.x + (mv.to.x - mv.from.x) * frac, y: mv.from.y + (mv.to.y - mv.from.y) * frac }); sctx.moveTo(p0.x, p0.y); sctx.lineTo(q.x, q.y); }
        sctx.stroke();
      } else if (mv.g === 0 && sim.t < 1) { sctx.strokeStyle = 'rgba(255,92,92,.35)'; sctx.lineWidth = 1; sctx.setLineDash([4, 4]); sctx.beginPath(); const p0 = T(mv.from), p1 = T(mv.to); sctx.moveTo(p0.x, p0.y); sctx.lineTo(p1.x, p1.y); sctx.stroke(); sctx.setLineDash([]); }
      cur = { mv, frac };
    }
    if (cur && sim.t < 1) { const mv = cur.mv; let p; if (mv.g >= 2) p = G.pointAt(G.arc(mv.from, mv.to, mv.c, mv.g === 3), cur.frac); else p = { x: mv.from.x + (mv.to.x - mv.from.x) * cur.frac, y: mv.from.y + (mv.to.y - mv.from.y) * cur.frac }; const q = T(p); sctx.fillStyle = '#ff5c5c'; sctx.beginPath(); sctx.arc(q.x, q.y, Math.max(3, mv.dia * scale / 2), 0, Math.PI * 2); sctx.fill(); $('#simInfo').textContent = `${sim.name}: ${(sim.t * sim.total).toFixed(1)} / ${sim.total.toFixed(1)} min · X${p.x.toFixed(3)} Y${p.y.toFixed(3)} Z${(mv.from.z + (mv.to.z - mv.from.z) * cur.frac).toFixed(3)} · ${mv.tool || ''}`; }
  }
  $('#simSlider').addEventListener('input', e => { sim.t = e.target.value / 1000; sim.playing = false; $('#simPlay').textContent = '▶ Play'; simDraw(); });
  $('#simPlay').onclick = () => { sim.playing = !sim.playing; if (sim.playing && sim.t >= 1) sim.t = 0; $('#simPlay').textContent = sim.playing ? '⏸ Pause' : '▶ Play'; if (sim.playing) requestAnimationFrame(simTick); };
  let lastTick = 0;
  function simTick(ts) { if (!sim.playing) return; const dt = lastTick ? (ts - lastTick) / 1000 : 0; lastTick = ts; const sp = parseFloat($('#simSpeed').value); sim.t = Math.min(1, sim.t + (dt / 60) * sp / Math.max(sim.total, 1e-6)); $('#simSlider').value = Math.round(sim.t * 1000); simDraw(); if (sim.t >= 1) { sim.playing = false; $('#simPlay').textContent = '▶ Play'; lastTick = 0; return; } requestAnimationFrame(simTick); }

  // ---------- AI design ----------
  $('#aiGo').onclick = async () => {
    const prompt = $('#aiPrompt').value.trim(); if (!prompt) return;
    if (!S.ai.key) { toast('Add your Claude API key in Settings'); showPage('settings'); return; }
    const st = $('#aiStatus'); st.textContent = 'Thinking…'; $('#aiOut').style.display = 'none';
    const tools = S.tools.map(t => `id ${t.id}: ${t.name} (${t.dia}" dia)`).join('; ');
    const system = `You convert a CNC operator's text request into 2D parts for a flat-sheet CNC router. Units: inches. Bed: ${S.machine.bedW} x ${S.machine.bedH} in, origin bottom-left. Material thickness ${job.material.thickness} in.
Respond with ONLY a JSON object, no prose, no markdown: {"parts":[...]} where each part is one of:
{"kind":"rect","name":str,"w":num,"h":num,"r":num(corner radius, default 0),"qty":int,"op":"outside"|"inside","toolId":int,"holes":[{"kind":"circle","cx":num,"cy":num,"d":num}|{"kind":"rect","x":num,"y":num,"w":num,"h":num,"r":num}]}
{"kind":"circle","name":str,"d":num,"qty":int,"op":"outside"|"inside","toolId":int}
{"kind":"poly","name":str,"pts":[{"x":num,"y":num,"r":num}],"qty":int,"op":"outside","toolId":int}
Holes are positioned relative to the part's bottom-left corner. "outside" = cut the part out; "inside" = pocket/hole. Available tools: ${tools}. Default toolId ${S.tools[0].id}. Interpret fractions (6 1/2 = 6.5) and quotes as inches. Do not position parts; they will be nested automatically.`;
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': S.ai.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify({ model: S.ai.model || 'claude-sonnet-4-5', max_tokens: 4000, system, messages: [{ role: 'user', content: prompt }] }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || r.statusText);
      const text = (j.content || []).map(c => c.text || '').join('');
      const jm = text.match(/\{[\s\S]*\}/); if (!jm) throw new Error('No JSON in response');
      const data = JSON.parse(jm[0]);
      $('#aiOut').style.display = 'block'; $('#aiOut').textContent = JSON.stringify(data, null, 1);
      snapshot(); if ($('#aiReplace').checked) job.shapes = [];
      const added = [];
      for (const p of data.parts || []) {
        const qty = Math.max(1, Math.min(200, parseInt(p.qty || 1, 10)));
        for (let q = 0; q < qty; q++) {
          const toolId = S.tools.some(t => t.id === p.toolId) ? p.toolId : S.tools[0].id; const op = p.op === 'inside' ? 'inside' : 'outside';
          let sh;
          if (p.kind === 'rect') sh = makeShape('rect', { name: p.name || 'rect', w: +p.w, h: +p.h, r: +(p.r || 0), op, toolId });
          else if (p.kind === 'circle') sh = makeShape('circle', { name: p.name || 'circle', r: +p.d / 2, op, toolId });
          else if (p.kind === 'poly' && Array.isArray(p.pts) && p.pts.length >= 3) { const x0 = Math.min(...p.pts.map(v => +v.x)), y0 = Math.min(...p.pts.map(v => +v.y)); sh = makeShape('poly', { name: p.name || 'poly', pts: p.pts.map(v => ({ x: +v.x - x0, y: +v.y - y0, r: +(v.r || 0) })), op, toolId }); }
          if (!sh) continue;
          if (qty > 1) sh.name += ` #${q + 1}`;
          job.shapes.push(sh); added.push(sh);
          for (const h of p.holes || []) {
            let hs;
            if (h.kind === 'circle') hs = makeShape('circle', { name: sh.name + ' hole', r: +h.d / 2, x: sh.x + (+h.cx), y: sh.y + (+h.cy), op: 'inside', toolId });
            else if (h.kind === 'rect') hs = makeShape('rect', { name: sh.name + ' pocket', w: +h.w, h: +h.h, r: +(h.r || 0), x: sh.x + (+h.x), y: sh.y + (+h.y), op: 'inside', toolId });
            if (hs) { job.shapes.push(hs); added.push(hs); }
          }
        }
      }
      st.textContent = `Added ${added.length} objects.`; sel = new Set(added.map(a => a.id));
      nestAll(); showPage('design');
    } catch (err) { st.textContent = 'Error: ' + err.message; console.error(err); }
  };

  // ---------- init ----------
  ICONS.apply(document);
  updateHint();
  syncMaterialUI(); syncSnapUI(); resize(); refresh(); renderLog();
  LOG.info(`CNC Studio ready — bed ${S.machine.bedW}×${S.machine.bedH} in, ${S.tools.length} tools`);
  window.CNC = { get job() { return job; }, view, S, G, PO, NE, SNAP, LOG, BOOL, ICONS, FONT, worldLoop, importDXF, refresh, W2S, S2W, resolvePoint, snapTol, makeEditable, edgeIndexAt, deleteSelectedEdge, setSelEdge: (id,i) => { const sh = job.shapes.find(x=>x.id===id); if (sh) makeEditable(sh); sel.clear(); sel.add(id); selEdges = [{ id, i }]; refresh(); }, getSelEdges: () => selEdges.slice(), doMarquee, mergeSelected, dynTargetInfo: () => dynTarget, hitSizeLabel, applySize, sizeHitsInfo: () => sizeHits, buildPdf, openPdf, dynMode, commitDyn2: commitDyn, drawSizeLabels, selectShape: (id) => { sel.clear(); sel.add(id); clearEdge(); refresh(); }, axisLock, askText, askConfirm, buildFromOffsets, openOffsetTrace, autoSplitAround, hoverEdgeInfo: () => hoverEdge, splitAtIntersections, segTouchesBox, splitAtTouches, orderSegs, lastSnapInfo: () => lastSnap, healEndsOf, healSelection, replaceWithLoop, eraseEdgeAt, crossingsOf, gripsOf, buildText, commitPoint, commitDyn, extentAlong, refPoint, centresOf, groupSel, ungroupSel, loadedFonts, sagitta, arcThrough, sagittaToArcR, arcRFromGeometry, scaleShape, groupBBox };
})();
