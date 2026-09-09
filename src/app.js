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
  };
  let S = loadSettings();
  function loadSettings() {
    try { const j = JSON.parse(localStorage.getItem('cncstudio.settings') || 'null'); if (j) return { ...DEFAULT_SETTINGS, ...j, machine: { ...DEFAULT_SETTINGS.machine, ...(j.machine || {}) } }; } catch (e) { }
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
  function saveSettings() { try { localStorage.setItem('cncstudio.settings', JSON.stringify(S)); } catch (e) { } }

  // ---------- job state ----------
  let job = newJob();
  function newJob() { return { shapes: [], material: { name: S.materials[0].name, thickness: S.materials[0].thickness }, cutThrough: 0, nextId: 1 }; }
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
    if (sh.kind === 'path') return sh.loop;
    return [];
  }
  function polyOpen(pts) { const s = []; for (let i = 0; i + 1 < pts.length; i++) s.push(G.line(G.P(pts[i].x, pts[i].y), G.P(pts[i + 1].x, pts[i + 1].y))); return s; }
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
  function snap(p) { const s = snapV(); if (!s) return p; return { x: Math.round(p.x / s) * s, y: Math.round(p.y / s) * s }; }

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
      if (drawing.kind === 'poly' || drawing.kind === 'pline') { ctx.beginPath(); drawing.pts.forEach((p, i) => { const s = W2S(p); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); }); const s = W2S(drawing.cur); ctx.lineTo(s.x, s.y); ctx.stroke(); if (drawing.pts.length) dimLabel(drawing.cur, `${fmtIn(G.dist(drawing.pts[drawing.pts.length - 1], drawing.cur))}`); }
      ctx.setLineDash([]);
    }
    if (drag && drag.kind === 'marquee') { const a = W2S(drag.a), b = W2S(drag.cur); ctx.strokeStyle = '#4da3ff'; ctx.setLineDash([3, 3]); ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); ctx.setLineDash([]); }
  }
  function dimLabel(wp, text) { const p = W2S(wp); ctx.fillStyle = '#4da3ff'; ctx.font = `${12 * devicePixelRatio}px ui-monospace, monospace`; ctx.fillText(text, p.x + 10, p.y - 10); }
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
    const before = S2W({ x: px, y: py }); const f = e.deltaY < 0 ? 1.15 : 1 / 1.15; view.scale *= f;
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
    if (e.button === 1 || e.button === 2 || spaceDown) { drag = { kind: 'pan', sx: s.x, sy: s.y, ox: view.ox, oy: view.oy }; return; }
    const ws = snap(w);
    if (tool === 'select') {
      const hit = hitShape(w);
      if (hit) {
        if (e.shiftKey) { sel.has(hit.id) ? sel.delete(hit.id) : sel.add(hit.id); }
        else if (!sel.has(hit.id)) { sel.clear(); sel.add(hit.id); }
        drag = { kind: 'move', start: w, orig: job.shapes.filter(x => sel.has(x.id)).map(x => ({ id: x.id, x: x.x, y: x.y })), moved: false };
      } else { if (!e.shiftKey) sel.clear(); drag = { kind: 'marquee', a: w, cur: w }; }
      refreshList(); refreshProps(); draw();
    } else if (tool === 'rect' || tool === 'circle') {
      drawing = { kind: tool, a: ws, b: ws };
    } else if (tool === 'poly' || tool === 'pline') {
      if (!drawing) drawing = { kind: tool, pts: [ws], cur: ws };
      else { if (G.dist(ws, drawing.pts[0]) < 4 / view.scale && drawing.pts.length > 2 && tool === 'poly') finishPoly(); else drawing.pts.push(ws); }
      draw();
    }
  });
  cv.addEventListener('dblclick', e => { if (drawing && (drawing.kind === 'poly' || drawing.kind === 'pline')) { drawing.pts.pop(); finishPoly(); } });
  cv.addEventListener('mousemove', e => {
    const { s, w } = evPos(e); mouse = { ...mouse, x: s.x, y: s.y, wx: w.x, wy: w.y };
    const ws = snap(w);
    $('#stX').textContent = ws.x.toFixed(4); $('#stY').textContent = ws.y.toFixed(4);
    const tag = $('#cursorTag'); tag.style.display = 'block'; tag.style.left = (s.x / devicePixelRatio + 16) + 'px'; tag.style.top = (s.y / devicePixelRatio + 16) + 'px'; tag.textContent = `${ws.x.toFixed(3)}, ${ws.y.toFixed(3)}`;
    if (drag) {
      if (drag.kind === 'pan') { view.ox = drag.ox + (s.x - drag.sx); view.oy = drag.oy - (s.y - drag.sy); }
      else if (drag.kind === 'move') {
        if (!drag.moved) { snapshot(); drag.moved = true; }
        let dx = w.x - drag.start.x, dy = w.y - drag.start.y; const sv = snapV(); if (sv) { dx = Math.round(dx / sv) * sv; dy = Math.round(dy / sv) * sv; }
        for (const o of drag.orig) { const sh = job.shapes.find(x => x.id === o.id); sh.x = o.x + dx; sh.y = o.y + dy; }
        refreshProps();
      } else if (drag.kind === 'marquee') drag.cur = w;
      draw(); return;
    }
    if (drawing) { if (drawing.kind === 'rect' || drawing.kind === 'circle') drawing.b = ws; else drawing.cur = ws; draw(); }
  });
  cv.addEventListener('mouseleave', () => { $('#cursorTag').style.display = 'none'; });
  window.addEventListener('mouseup', e => {
    mouse.down = false;
    if (drag) {
      if (drag.kind === 'marquee') { const a = drag.a, b = drag.cur; const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y); if (x1 - x0 > 0.01) for (const sh of job.shapes) { const bb = shapeBBox(sh); if (bb.x0 >= x0 && bb.x1 <= x1 && bb.y0 >= y0 && bb.y1 <= y1) sel.add(sh.id); } }
      if (drag.kind === 'move' && drag.moved) updateStats();
      drag = null; refreshList(); refreshProps(); draw(); return;
    }
    if (drawing && (drawing.kind === 'rect' || drawing.kind === 'circle')) {
      const d = drawing; drawing = null;
      if (d.kind === 'rect') { const w = Math.abs(d.b.x - d.a.x), h = Math.abs(d.b.y - d.a.y); if (w > 0.01 && h > 0.01) addShape(makeShape('rect', { x: Math.min(d.a.x, d.b.x), y: Math.min(d.a.y, d.b.y), w, h, r: 0 })); }
      else { const r = G.dist(d.a, d.b); if (r > 0.01) addShape(makeShape('circle', { x: d.a.x, y: d.a.y, r })); }
      draw();
    }
  });
  function finishPoly() {
    const d = drawing; drawing = null; if (!d || d.pts.length < 2) { draw(); return; }
    const open = d.kind === 'pline'; if (!open && d.pts.length < 3) { draw(); return; }
    const x0 = Math.min(...d.pts.map(p => p.x)), y0 = Math.min(...d.pts.map(p => p.y));
    addShape(makeShape('poly', { x: x0, y: y0, pts: d.pts.map(p => ({ x: p.x - x0, y: p.y - y0, r: 0 })), open, op: open ? 'on' : 'outside' }));
  }
  function addShape(sh) { snapshot(); if (sh.kind === 'poly') normalizePoly(sh); job.shapes.push(sh); sel.clear(); sel.add(sh.id); setTool('select'); refresh(); }
  function normalizePoly(sh) { if (!sh.open && sh.pts && sh.pts.length >= 3) sh.pts = G.normalizePolyPts(sh.pts); }

  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space') { spaceDown = true; e.preventDefault(); }
    if (e.key === 'Escape') { drawing = null; setTool('select'); draw(); }
    if (e.key === 'Enter' && drawing) finishPoly();
    if (e.key === 'Delete' || e.key === 'Backspace') deleteSel();
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
    if (e.key.startsWith('Arrow') && sel.size) { const st = e.shiftKey ? 1 : (snapV() || 0.125); const dx = e.key === 'ArrowRight' ? st : e.key === 'ArrowLeft' ? -st : 0, dy = e.key === 'ArrowUp' ? st : e.key === 'ArrowDown' ? -st : 0; snapshot(); for (const sh of job.shapes) if (sel.has(sh.id)) { sh.x += dx; sh.y += dy; } refresh(); e.preventDefault(); }
  });
  window.addEventListener('keyup', e => { if (e.code === 'Space') spaceDown = false; });
  function setTool(t) { tool = t; $$('button.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t)); $('#stTool').textContent = t === 'select' ? '' : `Tool: ${t}`; }
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
  function refresh() { refreshList(); refreshProps(); updateStats(); draw(); }
  function refreshList() {
    const el = $('#shapeList'); el.innerHTML = '';
    $('#partCount').textContent = job.shapes.length ? `(${job.shapes.length})` : '';
    for (const sh of job.shapes) {
      const d = document.createElement('div'); d.className = 'item' + (sel.has(sh.id) ? ' sel' : '');
      d.innerHTML = `<span>${esc(sh.name)}</span><span class="op">${sh.op}</span>`;
      d.onclick = (e) => { if (e.shiftKey) { sel.has(sh.id) ? sel.delete(sh.id) : sel.add(sh.id); } else { sel.clear(); sel.add(sh.id); } refreshList(); refreshProps(); draw(); };
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
    let h = `<h3>${multi ? shs.length + ' parts' : esc(sh.kind)}</h3>`;
    if (!multi) h += `<div class="row"><label>Name</label><input type="text" data-k="name" value="${esc(sh.name)}" style="flex:1"></div>`;
    h += num('x', 'X') + num('y', 'Y');
    if (!multi && sh.kind === 'rect') {
      h += num('w', 'Width') + num('h', 'Height') + num('r', 'All corners R', 0.0625);
      const rc = sh.rc || [null, null, null, null]; const lab = ['BL', 'BR', 'TR', 'TL'];
      h += `<div class="row"><label>Corner R</label>` + lab.map((l, i) => `<span class="muted">${l}</span><input type="number" step="0.0625" data-rc="${i}" value="${rc[i] != null ? fmtIn(rc[i]) : ''}" placeholder="${fmtIn(sh.r || 0)}" style="width:58px">`).join('') + `</div>`;
    }
    if (!multi && sh.kind === 'circle') h += num('r', 'Radius', 0.0625) + `<div class="row"><label>Diameter</label><input type="number" step="0.125" data-k="dia" value="${fmtIn(sh.r * 2)}"></div>`;
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
    let h = `<h3>Points &amp; edges <span class="muted">(from part origin)</span></h3><div style="overflow:auto;max-height:320px"><table style="font-size:11px"><thead><tr><th>#</th><th>X</th><th>Y</th><th>Fillet R</th><th>Angle</th></tr><tr><th></th><th>edge len</th><th>dir °</th><th>arc R</th><th></th></tr></thead><tbody>`;
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      let ia = '';
      if (closed || (i > 0 && i < n - 1)) { const a = pts[(i - 1 + n) % n]; const d1 = G.norm(G.sub(a, p)), d2 = G.norm(G.sub(q, p)); const ang = deg(Math.acos(Math.max(-1, Math.min(1, G.dot(d1, d2))))); const cr = G.cross(d1, d2); ia = (cr < 0 ? ang : 360 - ang).toFixed(1) + '°'; }
      h += `<tr><td>P${i + 1}</td><td><input type="number" step="0.125" data-pv="x" data-i="${i}" value="${fmtIn(p.x)}"></td><td><input type="number" step="0.125" data-pv="y" data-i="${i}" value="${fmtIn(p.y)}"></td><td>${closed ? `<input type="number" step="0.0625" data-pv="r" data-i="${i}" value="${fmtIn(p.r || 0)}">` : ''}</td><td class="muted">${ia}</td></tr>`;
      if (closed || i < n - 1) { const L = G.dist(p, q), A = deg(Math.atan2(q.y - p.y, q.x - p.x)); h += `<tr style="color:var(--muted)"><td>→P${(i + 1) % n + 1}</td><td><input type="number" step="0.125" data-pv="len" data-i="${i}" value="${fmtIn(L)}"></td><td><input type="number" step="1" data-pv="ang" data-i="${i}" value="${(+A.toFixed(2))}"></td><td><input type="number" step="0.125" data-pv="arcR" data-i="${i}" value="${p.arcR ? fmtIn(p.arcR) : ''}" placeholder="0"></td><td></td></tr>`; }
    }
    h += `</tbody></table></div><div class="row"><button class="small" id="btnPolyBuild">Edit by lengths &amp; angles…</button></div><p class="muted" style="font-size:11px">Edge dir: 0° = right, 90° = up. Arc R: + bulges out, − bulges in. Angle column = inside angle at the point.</p>`;
    return h;
  }
  function polyEdit(sh, k, i, v) {
    const pts = sh.pts, n = pts.length; const p = pts[i], q = pts[(i + 1) % n];
    if (k === 'x') p.x = v; else if (k === 'y') p.y = v; else if (k === 'r') p.r = Math.max(0, v || 0); else if (k === 'arcR') p.arcR = isNaN(v) ? 0 : v;
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

  // ---------- job stats / gcode ----------
  function buildJob() {
    return {
      shapes: job.shapes.filter(s => s.op !== 'none').map(s => ({ loop: worldLoop(s), op: s.op, open: s.open, toolId: s.toolId, startHint: s.startPt, climb: s.climb })),
      tools: S.tools, material: { thickness: job.material.thickness }, cutThrough: job.cutThrough, machine: machineForPost(),
    };
  }
  function machineForPost() { const m = { ...S.machine }; m.lineEnding = S.machine.eol === 'lf' ? '\n' : '\r\n'; return m; }
  let lastGcode = null;
  function updateStats() {
    const el = $('#jobStats');
    const m = S.machine; const bad = job.shapes.filter(s => { const bb = shapeBBox(s); return bb.x0 < -1e-6 || bb.y0 < -1e-6 || bb.x1 > m.bedW + 1e-6 || bb.y1 > m.bedH + 1e-6; });
    if (!job.shapes.length) { el.textContent = '—'; lastGcode = null; return; }
    try {
      const out = PO.generate(buildJob()); lastGcode = out.gcode;
      const st = out.stats;
      el.innerHTML = `${job.shapes.length} parts · ${st.passes} passes · ${st.tools.map(esc).join(', ')}<br>Cut length ${st.length.toFixed(1)} in · est. ${st.timeMin.toFixed(1)} min<br>Material ${esc(job.material.name)} (${job.material.thickness}")` + (bad.length ? `<br><span class="warnbox">⚠ ${bad.length} part(s) outside the bed</span>` : '');
    } catch (e) { el.innerHTML = `<span class="warnbox">Toolpath error: ${esc(e.message)}</span>`; console.error(e); }
  }

  // ---------- file I/O ----------
  function download(name, text, mime = 'text/plain') {
    const blob = new Blob([text], { type: mime }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function jobName() { return (job.name || 'job').replace(/[^\w\- ]+/g, '_'); }
  $('#btnTap').onclick = () => {
    if (!job.shapes.length) return toast('Nothing to cut');
    updateStats(); if (!lastGcode) return;
    const name = prompt('File name for the TAP file:', jobName()); if (name === null) return; job.name = name;
    download(name.replace(/\.tap$/i, '') + '.tap', lastGcode); toast('TAP exported');
    $('#gcodePreview').style.display = 'block'; $('#gcodePreview').textContent = lastGcode;
  };
  $('#btnDxf').onclick = () => {
    if (!job.shapes.length) return toast('Nothing to export');
    const loops = [], opens = [];
    for (const s of job.shapes) (s.open ? opens : loops).push(worldLoop(s));
    download(jobName() + '.dxf', G.writeDXF(loops, opens), 'application/dxf'); toast('DXF exported');
  };
  $('#btnSave').onclick = saveProject;
  function saveProject() { const name = prompt('Project name:', jobName()); if (name === null) return; job.name = name; download(name + '.cncjob', JSON.stringify({ version: 1, job, settingsSnapshot: { material: job.material } }, null, 1), 'application/json'); toast('Project saved'); }
  $('#btnNew').onclick = () => { if (job.shapes.length && !confirm('Clear current job?')) return; job = newJob(); sel.clear(); undoStack = []; syncMaterialUI(); refresh(); };
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
    if (p === 'settings') renderSettings(); if (p === 'sim') simResize();
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
  bindSetting('#mHeader', el => S.machine.header = el.value); bindSetting('#mToolChange', el => S.machine.toolChange = el.value); bindSetting('#mFooter', el => S.machine.footer = el.value);
  bindSetting('#nGap', el => S.nest.gap = parseFloat(el.value)); bindSetting('#nMargin', el => S.nest.margin = parseFloat(el.value)); bindSetting('#nRotate', el => S.nest.rotate = el.checked);
  bindSetting('#aiKey', el => S.ai.key = el.value.trim()); bindSetting('#aiModel', el => S.ai.model = el.value.trim());
  $('#toolAdd').onclick = () => { const id = Math.max(0, ...S.tools.map(t => t.id)) + 1; S.tools.push({ id, slot: id, name: 'New tool', type: 'endmill', dia: 0.25, rpm: 18000, feed: 120, plunge: 20, passDepth: 0.125 }); saveSettings(); renderSettings(); };
  $('#matAdd').onclick = () => { S.materials.push({ name: 'New material', thickness: 0.25 }); saveSettings(); renderSettings(); syncMaterialUI(); };
  $('#setExport').onclick = () => download('cncstudio-settings.json', JSON.stringify(S, null, 1), 'application/json');
  $('#setImport').onclick = () => $('#fileSet').click();
  $('#fileSet').addEventListener('change', async e => { const f = e.target.files[0]; if (!f) return; try { S = { ...DEFAULT_SETTINGS, ...JSON.parse(await f.text()) }; saveSettings(); renderSettings(); syncMaterialUI(); refresh(); toast('Settings imported'); } catch (err) { toast('Bad settings file'); } e.target.value = ''; });
  $('#setReset').onclick = () => { if (!confirm('Reset all settings to defaults?')) return; S = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); saveSettings(); renderSettings(); syncMaterialUI(); refresh(); };

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
  syncMaterialUI(); resize(); refresh();
  window.CNC = { get job() { return job; }, S, G, PO, NE, worldLoop, importDXF, refresh, W2S, S2W };
})();
