/* Runs the ten test-sheet designs through the real bundle, headless.
   Each one is built the way the app builds it, then checked for: console or
   activity-log errors, non-finite geometry, area and size sanity, arc survival,
   and whether it still posts to TAP. A PNG of each is written for eyeballing.

   Run: cd electron && npm run scenarios
   Out: test/shots/NN-name.png, test/shots/report.txt  (both gitignored)      */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const LINES = [];
const say = (...a) => { const l = a.join(' '); LINES.push(l); console.log(l); };
const FINDINGS = [];
const flag = (scenario, sev, msg) => { FINDINGS.push({ scenario, sev, msg }); say(`   ${sev === 'high' ? '!!' : '!'} ${msg}`); };

app.disableHardwareAcceleration();
let done = false;
setTimeout(() => { if (!done) { say('!! watchdog: still running after 240s'); finish(3); } }, 240000);
function finish(code) {
  done = true;
  say('');
  if (FINDINGS.length) {
    say('=== findings ===');
    for (const f of FINDINGS) say(`  [${f.sev}] ${f.scenario}: ${f.msg}`);
  } else say('=== no findings ===');
  fs.writeFileSync(path.join(OUT, 'report.txt'), LINES.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'findings.json'), JSON.stringify(FINDINGS, null, 1));
  app.exit(code);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1500, height: 950, webPreferences: { contextIsolation: true, offscreen: true } });
  win.webContents.on('console-message', (_e, l, m) => { if (l >= 3) flag('(console)', 'high', 'console error: ' + m); });
  await win.loadFile(path.join(__dirname, '..', 'electron', 'app', 'CNCStudio.html'));
  await new Promise(r => setTimeout(r, 900));
  const run = (c) => win.webContents.executeJavaScript(c, true);

  let ttf = null;
  for (const f of ['arial.ttf', 'segoeui.ttf', 'verdana.ttf']) {
    const fp = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', f);
    if (fs.existsSync(fp)) { ttf = fs.readFileSync(fp).toString('base64'); say('using font: ' + f); break; }
  }

  await run(`(() => {
    window.__reset = () => { CNC.job.shapes.length = 0; CNC.job.dims = []; CNC.job.nextId = 1;
      CNC.selectShape(-1); CNC.refresh(); return true; };   // clear selection too: ids restart, so a stale one would re-attach
    window.__add = (o) => { const sh = Object.assign({ x:0, y:0, rot:0, op:'outside', toolId:2, climb:false, open:false }, o);
      sh.id = CNC.job.nextId++; CNC.job.shapes.push(sh); return sh.id; };
    window.__path = (loop, o) => __add(Object.assign({ kind:'path', name:'path', loop }, o||{}));
    window.__at = (wx, wy, type, mods) => { const cv = document.querySelector('#cv'), r = cv.getBoundingClientRect();
      const sp = CNC.W2S({x:wx,y:wy});
      const ev = new MouseEvent(type, Object.assign({ clientX: r.left + sp.x/devicePixelRatio,
        clientY: r.top + sp.y/devicePixelRatio, bubbles:true, button:0 }, mods||{}));
      cv.dispatchEvent(ev); if (type === 'mouseup') window.dispatchEvent(ev); return true; };
    window.__key = (k, mods) => { window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({key:k, bubbles:true}, mods||{}))); return true; };
    window.__tool = (t) => { const b = document.querySelector('button.tool[data-tool="'+t+'"]'); if (b) b.click(); return !!b; };
    window.__toggles = (o) => { for (const k in o) { const el = document.querySelector('#'+k); if (el) el.checked = !!o[k]; } CNC.refresh(); return true; };
    window.__frame = (pad) => { const cv = document.querySelector('#cv'); pad = pad==null?1.5:pad;
      let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
      for (const s of CNC.job.shapes) { try { const b=CNC.G.bbox(CNC.worldLoop(s)); x0=Math.min(x0,b.x0);y0=Math.min(y0,b.y0);x1=Math.max(x1,b.x1);y1=Math.max(y1,b.y1); } catch(e){} }
      for (const d of (CNC.job.dims||[])) for (const p of [d.a,d.b]) { x0=Math.min(x0,p.x);y0=Math.min(y0,p.y);x1=Math.max(x1,p.x);y1=Math.max(y1,p.y); }
      if (!isFinite(x0)) return false;
      x0-=pad;y0-=pad;x1+=pad;y1+=pad;
      const sc = Math.min(cv.width/(x1-x0), cv.height/(y1-y0));
      CNC.view.scale = sc; CNC.view.ox = (cv.width-(x1-x0)*sc)/2 - x0*sc; CNC.view.oy = (cv.height-(y1-y0)*sc)/2 - y0*sc;
      CNC.refresh(); return true; };
    window.__mark = () => CNC.LOG.entries().length;
    window.__since = (n) => JSON.stringify(CNC.LOG.entries().slice(n).filter(e=>e.level==='error'||e.level==='warn').map(e=>e.level+': '+e.msg));
    window.__check = () => {
      let bad = 0, segs = 0, arcs = 0, tiny = 0;
      const parts = [];
      for (const s of CNC.job.shapes) {
        let l; try { l = CNC.worldLoop(s); } catch(e) { bad++; parts.push({n:s.name, err:e.message}); continue; }
        let a = 0;
        for (const g of l) { segs++; if (g.type==='arc') arcs++;
          const L = CNC.G.segLen(g); if (L < 1e-4) tiny++;
          for (const p of [g.a,g.b,g.c].filter(Boolean)) if (!isFinite(p.x)||!isFinite(p.y)) bad++; }
        try { a = Math.abs(CNC.G.signedArea(l)); } catch(e) {}
        const b = CNC.G.bbox(l);
        parts.push({ n:s.name, k:s.kind, segs:l.length, area:+a.toFixed(4), w:+b.w.toFixed(4), h:+b.h.toFixed(4), op:s.op });
      }
      let tap = null, tapErr = null;
      try {
        const j = { shapes: CNC.job.shapes.filter(s=>s.op!=='none').map(s=>({loop:CNC.worldLoop(s), op:s.op, toolId:s.toolId, open:s.open, climb:s.climb, startHint:s.startPt})),
          tools: CNC.S.tools, material:{ name:'test', thickness:0.1875 }, cutThrough:0, machine: CNC.S.machine };
        const out = CNC.PO.generate(j);
        const g = out.gcode;
        tap = { lines:g.split(/\\r?\\n/).length, passes:out.stats.passes, len:+out.stats.length.toFixed(1),
          g2:(g.match(/^G2 /gm)||[]).length, g3:(g.match(/^G3 /gm)||[]).length,
          nan:/NaN|Infinity|undefined/.test(g) };
      } catch(e) { tapErr = e.message; }
      return JSON.stringify({ parts, segs, arcs, tiny, nonFinite:bad, tap, tapErr });
    };
    window.__shot = () => document.querySelector('#cv').toDataURL('image/png');
    return true;
  })()`);

  if (ttf) {
    const r = await run(`(() => { const b=atob('${ttf}'); const u=new Uint8Array(b.length);
      for (let i=0;i<b.length;i++) u[i]=b.charCodeAt(i);
      try { CNC.loadedFonts['TestFont'] = CNC.FONT.parse(u.buffer); return 'font ok, ' + CNC.loadedFonts['TestFont'].numGlyphs + ' glyphs'; }
      catch(e) { return 'FONT PARSE FAILED: ' + e.message; } })()`);
    say('  ' + r);
    if (/FAILED/.test(r)) flag('(setup)', 'high', r);
  }

  const S = [];
  const add = (name, title, code, verify) => S.push({ name, title, code, verify });

  add('01-plate-holes', 'Plate with holes: even-odd fill, kerf, centre marks, inside cuts', `
    __reset(); __toggles({chkPaths:true, chkKerf:true, chkCentres:true, chkSizes:true, chkPtNums:false});
    const plate = __add({name:'plate', kind:'rect', x:4, y:4, w:20, h:12, r:0.5, toolId:1});
    for (const [x,y] of [[6,6],[22,6],[6,14],[22,14]]) __add({name:'mount', kind:'circle', x, y, r:0.375, op:'inside'});
    __add({name:'window', kind:'circle', x:14, y:10, r:3, op:'inside'});
    __add({name:'slot', kind:'rect', x:10, y:5, w:8, h:1.25, r:0.625, op:'inside'});
    CNC.selectShape(plate); __frame(); return true;`,
    (c) => {
      const plate = c.parts.find(p => p.n === 'plate');
      if (!plate || Math.abs(plate.area - (20*12 - (4-Math.PI)*0.25)) > 1) return `plate area ${plate && plate.area} not ~240`;
      const slot = c.parts.find(p => p.n === 'slot');
      if (slot && Math.abs(slot.h - 1.25) > 1e-6) return `slot height ${slot.h} != 1.25 (fully-rounded ends)`;
      if (c.tap && c.tap.g2 === 0) return 'no G2 in output - inside cuts should run clockwise';
      return null;
    });

  add('02-corners', 'Per-corner radii, fillets, chamfers', `
    __reset(); __toggles({chkPaths:false, chkKerf:false, chkCentres:true, chkSizes:true, chkPtNums:true});
    __add({name:'per-corner', kind:'rect', x:2, y:2, w:10, h:6, r:0, rc:[0,0.5,1.5,1]});
    const f = __add({name:'filleted', kind:'poly', x:15, y:2, pts:[{x:0,y:0,r:1},{x:8,y:0,r:0.25},{x:8,y:6,r:1.5},{x:0,y:6,r:0.5}]});
    const ch = __add({name:'chamfered', kind:'rect', x:26, y:2, w:8, h:7, r:0});
    CNC.selectShape(ch); CNC.job.shapes.find(s=>s.id===ch);
    const shp = CNC.job.shapes.find(s=>s.id===ch); CNC.makeEditable(shp);
    __add({name:'hex', kind:'poly', x:37, y:1, pts:Array.from({length:6},(_,i)=>({x:4+3.5*Math.cos(i*Math.PI/3), y:4+3.5*Math.sin(i*Math.PI/3), r:0.4}))});
    CNC.selectShape(f); __frame(); return true;`,
    (c) => {
      const pc = c.parts.find(p => p.n === 'per-corner');
      if (!pc || Math.abs(pc.w - 10) > 1e-4 || Math.abs(pc.h - 6) > 1e-4) return `per-corner rect is ${pc && pc.w}x${pc && pc.h}, expected 10x6`;
      const hex = c.parts.find(p => p.n === 'hex');
      const trueHex = 3 * Math.sqrt(3) / 2 * 3.5 * 3.5;
      if (hex && hex.area > trueHex) return `hex area ${hex.area} exceeds an unfilleted hex ${trueHex.toFixed(3)} - fillets should remove area`;
      return null;
    });

  add('03-bowed', 'Bowed edges: bulge in and out, arc preservation', `
    __reset(); __toggles({chkPaths:true, chkKerf:false, chkCentres:true, chkSizes:true, chkPtNums:true});
    const id = __add({name:'bowed', kind:'poly', x:2, y:2, pts:[
      {x:0,y:0,r:0,arcR:CNC.sagittaToArcR(12,1.5)}, {x:12,y:0,r:0.75,arcR:0},
      {x:12,y:8,r:0,arcR:-CNC.sagittaToArcR(12,1.0)}, {x:0,y:8,r:0.75,arcR:0}]});
    __add({name:'lens', kind:'poly', x:17, y:3, pts:[
      {x:0,y:0,r:0,arcR:CNC.sagittaToArcR(10,2.5)}, {x:10,y:0,r:0,arcR:CNC.sagittaToArcR(10,2.5)}]});
    CNC.setSelEdge(id, 0); __frame(); return true;`,
    (c) => {
      const b = c.parts.find(p => p.n === 'bowed');
      if (!b) return 'bowed part missing';
      // 12x8 = 96, +1.5 bulge out on the bottom adds, -1.0 in on top removes; net must exceed 96
      if (b.area < 96) return `bowed area ${b.area} < 96: a net-outward bulge should add area (sign inversion?)`;
      const lens = c.parts.find(p => p.n === 'lens');
      if (lens && lens.area < 10) return `lens area ${lens.area} too small - both edges should bow outward`;
      if (c.arcs < 4) return `only ${c.arcs} arc segments; bowed edges should stay arcs`;
      return null;
    });

  add('04-booleans', 'Union, subtract (notch + hole), intersect', `
    __reset(); __toggles({chkPaths:false, chkKerf:false, chkCentres:false, chkSizes:false, chkPtNums:false});
    const G = CNC.G, B = CNC.BOOL;
    let r = B.operate('union', G.rectLoop(0,0,10,6), G.rectLoop(6,3,8,6));
    if (r.loops) r.loops.forEach(l => __path(l, {name:'union'})); else __add({name:'union FAILED:'+r.error, kind:'rect', x:0,y:0,w:1,h:1});
    r = B.operate('subtract', G.rectLoop(18,0,12,8), G.circleLoop(30,4,2.5));
    if (r.loops) r.loops.forEach(l => __path(l, {name:'notched'})); else __add({name:'notch FAILED:'+r.error, kind:'rect', x:18,y:0,w:1,h:1});
    r = B.operate('subtract', G.rectLoop(34,0,10,8), G.circleLoop(39,4,2));
    if (r.loops) r.loops.forEach(l => __path(l, {name:'holed'}));
    if (r.hole) __path(r.hole, {name:'the hole', op:'inside'});
    r = B.operate('intersect', G.circleLoop(52,4,4), G.circleLoop(57,4,4));
    if (r.loops) r.loops.forEach(l => __path(l, {name:'lens'})); else __add({name:'lens FAILED:'+r.error, kind:'rect', x:52,y:0,w:1,h:1});
    r = B.operate('union', G.rectLoop(62,0,5,5), G.rectLoop(67,0,5,5));
    if (r.loops) r.loops.forEach(l => __path(l, {name:'butted'})); else __add({name:'butted FAILED:'+r.error, kind:'rect', x:62,y:0,w:1,h:1});
    __frame(); return true;`,
    (c) => {
      const fail = c.parts.find(p => /FAILED/.test(p.n));
      if (fail) return fail.n;
      const u = c.parts.find(p => p.n === 'union');
      // 10x6 (60) + 8x6 (48) overlapping 4x3 (12) = 96
      if (!u || Math.abs(u.area - 96) > 0.05) return `union area ${u && u.area}, expected 96`;
      const n = c.parts.find(p => p.n === 'notched');
      if (!n || Math.abs(n.area - (96 - Math.PI*2.5*2.5/2)) > 0.1) return `notch area ${n && n.area}, expected ~86.2`;
      if (!c.parts.find(p => p.n === 'the hole')) return 'contained subtract did not return a hole';
      const l = c.parts.find(p => p.n === 'lens');
      if (l && l.area < 5) return `lens area ${l.area} too small`;
      const b = c.parts.find(p => p.n === 'butted');
      if (!b || Math.abs(b.area - 50) > 0.1) return `butted-squares union area ${b && b.area}, expected 50`;
      return null;
    });

  add('05-offset-array', 'Offset border, hole grid, bolt circle', `
    __reset(); __toggles({chkPaths:true, chkKerf:false, chkCentres:true, chkSizes:false, chkPtNums:false});
    const G = CNC.G;
    __add({name:'plate', kind:'rect', x:2, y:2, w:16, h:10, toolId:1});
    __path(G.offsetLoop(G.rectLoop(2,2,16,10), -0.5), {name:'border', op:'on'});
    for (let i=0;i<4;i++) for (let j=0;j<3;j++) __add({name:'grid', kind:'circle', x:4.5+i*3.6, y:4.5+j*2.5, r:0.1875, op:'inside'});
    __add({name:'flange', kind:'circle', x:30, y:7, r:5, toolId:1});
    __add({name:'bore', kind:'circle', x:30, y:7, r:1.25, op:'inside'});
    for (let k=0;k<8;k++){ const a=k*Math.PI/4; __add({name:'bolt', kind:'circle', x:30+3.5*Math.cos(a), y:7+3.5*Math.sin(a), r:0.25, op:'inside'}); }
    __frame(); return true;`,
    (c) => {
      const b = c.parts.find(p => p.n === 'border');
      if (!b) return 'offset border missing';
      if (Math.abs(b.w - 15) > 0.01 || Math.abs(b.h - 9) > 0.01) return `offset border is ${b.w}x${b.h}, expected 15x9`;
      const bolts = c.parts.filter(p => p.n === 'bolt');
      if (bolts.length !== 8) return `${bolts.length} bolt holes, expected 8`;
      return null;
    });

  add('06-text', 'Single-line engraving + outline text from a real TTF', `
    __reset(); __toggles({chkPaths:true, chkKerf:false, chkCentres:false, chkSizes:false, chkPtNums:false});
    __add({name:'tag', kind:'rect', x:1, y:1, w:30, h:4.5, r:0.5, toolId:1});
    CNC.buildText({text:'PART 12-A 3/16 ACRYLIC', font:'', height:1.25, tracking:0, align:'left', op:'on'}, {x:2.5, y:2.6});
    if (CNC.loadedFonts['TestFont'])
      CNC.buildText({text:'Ab7&', font:'TestFont', height:5, tracking:0, align:'left', op:'outside'}, {x:1, y:8});
    __frame(); return true;`,
    (c) => {
      const eng = c.parts.filter(p => p.op === 'on' && p.n === 'text');
      if (!eng.length) return 'single-line engraving produced no parts';
      const outline = c.parts.filter(p => p.n === 'text' && p.op !== 'on');
      if (outline.length) {
        const holes = outline.filter(p => p.op === 'inside');
        if (!holes.length) return 'outline text has no inside cuts - counters of A and b should be holes';
      }
      if (c.tap && c.tap.nan) return 'TAP contains NaN/Infinity from text';
      return null;
    });

  add('07-traced', 'Traced template from measured offsets + placed dimensions', `
    __reset(); __toggles({chkPaths:true, chkKerf:false, chkCentres:false, chkSizes:true, chkPtNums:false});
    const o = [9.000,9.329,9.629,9.901,10.146,10.363,10.554,10.719,10.858,10.971,11.059,11.121,11.159,11.171,11.159,11.121,11.059,10.971,10.858,10.719,10.554,10.363,9.726,9.061,8.369,7.649,6.900,6.121,5.312,4.472,3.599];
    CNC.buildFromOffsets(o.map((v,i)=>({s:i, o:v})), {alongY:false, closeIt:true, fitArcs:true, tol:0.01});
    CNC.job.dims.push({a:{x:0,y:0}, b:{x:30,y:0}, off:-1.2});
    CNC.job.dims.push({a:{x:0,y:0}, b:{x:0,y:9}, off:1.2});
    CNC.selectShape(CNC.job.shapes[0].id); __frame(2.5); return true;`,
    (c) => {
      const t = c.parts[0];
      if (!t) return 'traced template missing';
      if (Math.abs(t.w - 30) > 0.01) return `template width ${t.w}, expected 30`;
      if (Math.abs(t.h - 11.171) > 0.02) return `template height ${t.h}, expected 11.171`;
      if (c.tap && c.tap.nan) return 'TAP from traced template contains NaN';
      return null;
    });

  add('08-curves', 'Ellipse, splines, 3-point arc, circle', `
    __reset(); __toggles({chkPaths:true, chkKerf:false, chkCentres:true, chkSizes:true, chkPtNums:true});
    __add({name:'ellipse', kind:'ellipse', x:6, y:5, rx:5, ry:3});
    __add({name:'blob', kind:'spline', x:14, y:1, pts:[{x:0,y:2},{x:3,y:0},{x:7,y:1},{x:8,y:5},{x:4,y:7},{x:1,y:5}]});
    __add({name:'wave', kind:'spline', x:25, y:1, open:true, op:'on', pts:[{x:0,y:0},{x:2,y:3},{x:4,y:0},{x:6,y:3},{x:8,y:0}]});
    __add({name:'arc', kind:'poly', x:36, y:1, open:true, op:'on', pts:[{x:0,y:0,arcR:CNC.arcRFromGeometry(8,2.5)},{x:8,y:0}]});
    __add({name:'circle', kind:'circle', x:48, y:4, r:3.5});
    CNC.selectShape(CNC.job.shapes[0].id); __frame(); return true;`,
    (c) => {
      const e = c.parts.find(p => p.n === 'ellipse');
      if (!e || Math.abs(e.area - Math.PI*15) > 0.2) return `ellipse area ${e && e.area}, expected ~47.12`;
      if (e && (Math.abs(e.w-10) > 0.01 || Math.abs(e.h-6) > 0.01)) return `ellipse is ${e.w}x${e.h}, expected 10x6`;
      const cir = c.parts.find(p => p.n === 'circle');
      if (!cir || Math.abs(cir.area - Math.PI*12.25) > 0.01) return `circle area ${cir && cir.area}, expected 38.48`;
      const arc = c.parts.find(p => p.n === 'arc');
      if (arc && Math.abs(arc.h - 2.5) > 0.02) return `3-point arc bulge is ${arc && arc.h}, expected 2.5 (mirrored?)`;
      return null;
    });

  add('09-segmentation', 'Auto-split at crossings, delete a side, merge, box-select', `
    __reset(); __toggles({chkPaths:false, chkKerf:false, chkCentres:false, chkSizes:false, chkPtNums:true});
    const sq = __add({name:'square', kind:'poly', x:2, y:2, pts:[{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}]});
    const cut = __add({name:'cut', kind:'poly', x:0, y:5, open:true, op:'on', pts:[{x:0,y:0},{x:14,y:0}]});
    CNC.autoSplitAround(CNC.job.shapes.find(s=>s.id===cut));
    const c1 = __add({name:'C', kind:'poly', x:18, y:2, open:true, op:'on', pts:[{x:0,y:0},{x:0,y:10},{x:10,y:10},{x:10,y:0}]});
    const tie = __add({name:'tie', kind:'poly', x:18, y:2, open:true, op:'on', pts:[{x:0,y:0},{x:4,y:10}]});
    CNC.doMarquee(17, 1, 29, 13); CNC.mergeSelected(0.125);
    const h = __add({name:'h', kind:'poly', x:32, y:7, open:true, op:'on', pts:[{x:0,y:0},{x:10,y:0}]});
    const v = __add({name:'v', kind:'poly', x:37, y:2, open:true, op:'on', pts:[{x:0,y:0},{x:0,y:10}]});
    CNC.autoSplitAround(CNC.job.shapes.find(s=>s.id===v));
    __frame(); return true;`,
    (c) => {
      const sq = c.parts.find(p => p.n === 'square');
      if (!sq || sq.segs !== 6) return `square has ${sq && sq.segs} sides after a line crossed it, expected 6`;
      if (sq && Math.abs(sq.area - 100) > 0.01) return `square area ${sq.area} changed when split, expected 100`;
      const merged = c.parts.filter(p => p.n === 'C');
      if (merged.length !== 1) return `C + tie merged into ${merged.length} parts, expected 1`;
      if (merged[0] && merged[0].segs !== 5) return `merged part has ${merged[0].segs} sides, expected 5`;
      const hh = c.parts.find(p => p.n === 'h');
      if (hh && hh.segs !== 2) return `crossed line has ${hh.segs} pieces, expected 2`;
      return null;
    });

  add('10-full-job', 'Nested job, off-bed part, groups, three tools', `
    __reset(); __toggles({chkPaths:true, chkKerf:false, chkCentres:false, chkSizes:false, chkPtNums:false});
    for (let i=0;i<7;i++) __add({name:'panel '+(i+1), kind:'rect', x:0, y:0, w:6.5, h:7, r:0.25, toolId:1});
    for (let i=0;i<3;i++) __add({name:'disc '+(i+1), kind:'circle', x:0, y:0, r:2, toolId:2});
    __add({name:'bracket', kind:'poly', x:0, y:0, toolId:3, pts:[{x:0,y:0},{x:9,y:0},{x:9,y:3},{x:3,y:3},{x:3,y:9},{x:0,y:9}]});
    document.querySelector('#btnNest').click();
    __add({name:'off the bed', kind:'rect', x:54, y:30, w:10, h:6, toolId:1});
    const p = CNC.job.shapes[0];
    __add({name:'panel hole', kind:'circle', x:p.x+3.25, y:p.y+3.5, r:0.5, op:'inside', toolId:2});
    CNC.doMarquee(p.x-0.1, p.y-0.1, p.x+6.6, p.y+7.1); CNC.groupSel();
    __key('f'); return true;`,
    (c) => {
      if (!c.tap) return 'full job failed to post: ' + c.tapErr;
      const tools = new Set(c.parts.map(p => p.op));
      const off = c.parts.find(p => p.n === 'off the bed');
      if (!off) return 'off-bed part missing';
      if (c.tap.passes < 20) return `only ${c.tap.passes} passes for 12 parts - something was dropped`;
      return null;
    });

  let problems = 0;
  for (const sc of S) {
    say('');
    say('== ' + sc.name + ' ==');
    say('   ' + sc.title);
    const mark = await run('__mark()');
    let setupErr = null;
    try { await run(`(() => { ${sc.code} })()`); } catch (e) { setupErr = String(e.message || e).slice(0, 300); }
    await new Promise(r => setTimeout(r, 200));
    const chk = JSON.parse(await run('__check()'));
    const logged = JSON.parse(await run(`__since(${mark})`));
    try {
      const url = await run('__shot()');
      fs.writeFileSync(path.join(OUT, sc.name + '.png'), Buffer.from(url.split(',')[1], 'base64'));
    } catch (e) { say('   (screenshot failed: ' + e.message + ')'); }

    say(`   parts ${chk.parts.length}, segments ${chk.segs}, arcs ${chk.arcs}`);
    if (chk.tap) say(`   TAP ${chk.tap.lines} lines, ${chk.tap.passes} passes, cut ${chk.tap.len} in, G2 ${chk.tap.g2} / G3 ${chk.tap.g3}`);
    for (const p of chk.parts.slice(0, 14)) say(`     ${String(p.n).padEnd(14)} ${p.k || 'path'} segs ${String(p.segs).padStart(3)} area ${String(p.area).padStart(9)} ${p.w}x${p.h} ${p.op}`);
    if (chk.parts.length > 14) say(`     ... ${chk.parts.length - 14} more`);

    if (setupErr) { flag(sc.name, 'high', 'setup threw: ' + setupErr); problems++; }
    if (chk.nonFinite) { flag(sc.name, 'high', `${chk.nonFinite} non-finite coordinate(s)`); problems++; }
    if (chk.tapErr) { flag(sc.name, 'high', 'post failed: ' + chk.tapErr); problems++; }
    if (chk.tap && chk.tap.nan) { flag(sc.name, 'high', 'TAP contains NaN/Infinity/undefined'); problems++; }
    if (chk.tiny) { flag(sc.name, 'low', `${chk.tiny} segment(s) shorter than 0.0001 in`); }
    for (const l of logged) { if (l.startsWith('error')) { flag(sc.name, 'high', 'logged ' + l); problems++; } else say('   note: ' + l); }
    const v = sc.verify ? sc.verify(chk) : null;
    if (v) { flag(sc.name, 'high', v); problems++; }
    if (!setupErr && !v && !chk.nonFinite && !chk.tapErr) say('   ok');
  }

  say('');
  say(problems ? `${problems} problem(s) across ${S.length} scenarios` : `all ${S.length} scenarios clean`);
  win.destroy();
  finish(problems ? 1 : 0);
});
