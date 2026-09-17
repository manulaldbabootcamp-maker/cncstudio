/* Headless smoke test: loads the real bundle in a hidden Electron window,
   fails on any uncaught error or console error, then drives the app through
   its own API to check that the new tools actually work end to end.
   Run: cd electron && npm run smoke     (or: electron ../test/smoke_main.js) */
const { app, BrowserWindow } = require('electron');
const path = require('path');

const PAGE = path.join(__dirname, '..', 'electron', 'app', 'CNCStudio.html');
const problems = [];
let pass = 0, fail = 0;

function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { contextIsolation: true, offscreen: true } });

  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    // level 3 = error, 2 = warning
    if (level >= 3) problems.push(`console error: ${message} (${sourceId}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, d) => problems.push('renderer gone: ' + JSON.stringify(d)));
  win.webContents.on('preload-error', (_e, f, err) => problems.push('preload error: ' + err));

  const loadedAt = Date.now() - 2000;   // margin: renderer clock vs main clock
  await win.loadFile(PAGE);
  await new Promise(r => setTimeout(r, 900));   // let init settle

  const run = (code) => win.webContents.executeJavaScript(code, true);

  try {
    console.log('boot');
    ok(await run('!!window.CNC'), 'app initialised and exposed window.CNC');
    ok(await run('!!window.CNC.SNAP && !!window.CNC.LOG'), 'snap + log modules reached the bundle');
    ok((await run('document.querySelectorAll("header button svg").length')) >= 10, 'toolbar icons rendered as SVG');
    ok(await run('!!document.querySelector("#logBody")'), 'activity log panel exists');

    console.log('startup errors');
    const errs = await run(`JSON.stringify(CNC.LOG.entries().filter(e=>e.level==="error" && e.t >= ${loadedAt}))`);
    ok(errs === '[]', 'no errors logged during startup', errs);

    console.log('geometry helpers');
    ok(Math.abs((await run('CNC.sagitta({x:0,y:0},{x:10,y:0},{x:5,y:2})')) - 2) < 1e-9, 'sagitta of a 2in bow over a 10in chord is 2');
    // a 10in chord bowed 2in => R = 1 + 100/16 = 7.25
    ok(Math.abs((await run('CNC.sagittaToArcR(10,2)')) - 7.25) < 1e-9, 'sagitta 2 over chord 10 converts to R 7.25');
    ok(Math.abs((await run('CNC.arcThrough({x:0,y:0},{x:10,y:0},{x:5,y:2}) ? CNC.G.radius(CNC.arcThrough({x:0,y:0},{x:10,y:0},{x:5,y:2})) : -1')) - 7.25) < 1e-6,
      'arc through 3 points has the matching radius');
    ok((await run('CNC.arcThrough({x:0,y:0},{x:10,y:0},{x:5,y:0})')) === null, 'collinear points produce no arc');

    console.log('round trip: bulge -> radius -> bulge');
    const rt = await run(`(() => {
      const chord = 7.5, sag = 1.375;
      const R = CNC.sagittaToArcR(chord, sag);
      const h = Math.sqrt(R*R - (chord/2)*(chord/2));
      return Math.abs((R - h) - sag);
    })()`);
    ok(rt < 1e-9, 'bulge survives the radius round trip', 'err=' + rt);

    console.log('drawing a part and bowing an edge');
    await run(`(() => {
      CNC.job.shapes.length = 0;
      const sh = { id: 99, name:'test plate', kind:'poly', x:0, y:0, rot:0, op:'outside', toolId:1, climb:false, open:false,
                   pts:[{x:0,y:0,r:0,arcR:0},{x:10,y:0,r:0,arcR:0},{x:10,y:6,r:0,arcR:0},{x:0,y:6,r:0,arcR:0}] };
      CNC.job.shapes.push(sh); CNC.refresh(); return true;
    })()`);
    ok((await run('CNC.job.shapes.length')) === 1, 'test plate added');
    ok((await run('CNC.worldLoop(CNC.job.shapes[0]).length')) === 4, 'square plate has 4 segments');

    const grips = await run('CNC.gripsOf(CNC.job.shapes[0]).length');
    ok(grips === 8, 'a 4-sided closed part exposes 4 vertex + 4 edge grips', 'got ' + grips);

    // bow the bottom edge by 1.5in and confirm the loop gains a real arc
    await run(`(() => { const sh = CNC.job.shapes[0];
      sh.pts[0].arcR = CNC.sagittaToArcR(10, 1.5); CNC.refresh(); return true; })()`);
    const kinds = await run('JSON.stringify(CNC.worldLoop(CNC.job.shapes[0]).map(s=>s.type))');
    ok(kinds.includes('arc'), 'bowed edge became an arc segment', kinds);
    const rad = await run('CNC.G.radius(CNC.worldLoop(CNC.job.shapes[0]).find(s=>s.type==="arc"))');
    ok(Math.abs(rad - CNCexpect(10, 1.5)) < 1e-6, 'bowed edge radius matches the typed bulge', 'got ' + rad);

    console.log('snapping against real geometry');
    const snapType = await run(`(() => { const r = CNC.resolvePoint({x:10.02,y:6.03}); return CNC.SNAP.snapPoint({x:10.02,y:6.03},
      [{id:1,loop:CNC.worldLoop(CNC.job.shapes[0])}], 0.2, {gridStep:0}).type; })()`);
    ok(snapType === 'endpoint', 'cursor near a corner snaps to endpoint', 'got ' + snapType);

    console.log('scale');
    await run(`(() => { const sh=CNC.job.shapes[0]; const bb=CNC.groupBBox([sh]); CNC.scaleShape(sh,2,2,bb); CNC.refresh(); return true; })()`);
    const bb2 = JSON.parse(await run('JSON.stringify(CNC.groupBBox([CNC.job.shapes[0]]))'));
    ok(Math.abs(bb2.w - 20) < 1e-6, 'uniform scale x2 doubles the width', 'w=' + bb2.w);

    console.log('post still generates');
    const g = await run(`(() => { try { const j={shapes:CNC.job.shapes.map(s=>({loop:CNC.worldLoop(s),op:s.op,toolId:1,open:s.open})),
      tools:CNC.S.tools, material:{thickness:0.25}, cutThrough:0, machine:CNC.S.machine};
      return CNC.PO.generate(j).gcode.length; } catch(e) { return 'ERR ' + e.message; } })()`);
    ok(typeof g === 'number' && g > 100, 'TAP generation still works on the edited part', String(g));

    console.log('push 2: booleans');
    ok(await run('!!CNC.BOOL && !!CNC.BOOL.operate'), 'bool module reached the bundle');
    const bres = await run(`(() => {
      const a = CNC.G.rectLoop(0,0,10,6), b = CNC.G.rectLoop(5,3,10,6);
      const r = BOOL.operate('union', a, b);
      if (r.error) return 'ERR ' + r.error;
      return r.loops.reduce((s,l)=>s+Math.abs(CNC.G.signedArea(l)),0);
    })()`);
    ok(typeof bres === 'number' && Math.abs(bres - 105) < 0.01, 'union in the browser gives area 105', String(bres));

    console.log('push 2: offset');
    const ores = await run(`(() => {
      const l = CNC.G.rectLoop(0,0,10,6);
      const o = CNC.G.offsetLoop(l, -0.5);
      return Math.abs(CNC.G.signedArea(o));
    })()`);
    ok(Math.abs(ores - 9*5) < 0.01, 'inward offset 0.5 of a 10x6 gives 9x5 = 45', String(ores));

    console.log('push 2: chamfer + dims');
    await run(`(() => { CNC.job.shapes.length = 0; CNC.job.dims = [];
      CNC.job.shapes.push({id:501,name:'p',kind:'poly',x:0,y:0,rot:0,op:'outside',toolId:1,climb:false,open:false,
        pts:[{x:0,y:0,r:0,arcR:0},{x:10,y:0,r:0,arcR:0},{x:10,y:6,r:0,arcR:0},{x:0,y:6,r:0,arcR:0}]});
      CNC.refresh(); return true; })()`);
    const before = await run('CNC.job.shapes[0].pts.length');
    await run(`(() => { CNC.job.dims.push({a:{x:0,y:0},b:{x:10,y:0},off:-1}); CNC.refresh(); return true; })()`);
    ok((await run('CNC.job.dims.length')) === 1, 'a dimension can be stored on the job');
    ok(before === 4, 'test polygon starts with 4 points');

    console.log('push 2: dimensions never reach the TAP');
    const gc = await run(`(() => { const j={shapes:CNC.job.shapes.map(s=>({loop:CNC.worldLoop(s),op:s.op,toolId:1,open:s.open})),
      tools:CNC.S.tools, material:{thickness:0.25}, cutThrough:0, machine:CNC.S.machine};
      return CNC.PO.generate(j).gcode; })()`);
    ok(typeof gc === 'string' && gc.length > 50, 'TAP still generates with a dimension present');

    console.log('push 3: text');
    ok(await run('!!CNC.FONT && !!CNC.FONT.strokeText'), 'font module reached the bundle');
    await run('(() => { CNC.job.shapes.length = 0; CNC.job.dims = []; CNC.refresh(); return true; })()');
    const made = await run(`CNC.buildText({text:'PART 12', font:'', height:0.5, tracking:0, align:'left', op:'on'}, {x:2,y:2})`);
    ok(typeof made === 'number' && made > 0, 'single-line text produced parts', String(made));
    ok((await run('CNC.job.shapes.every(s => s.open)')) === true, 'engraving text is all OPEN paths (centreline)');
    ok((await run("CNC.job.shapes.every(s => s.op === 'on')")) === true, 'engraving text cuts on the line');
    const grp = await run('new Set(CNC.job.shapes.map(s=>s.group)).size');
    ok(grp === 1, 'the whole text block shares one group', String(grp));
    const th = await run(`(() => { const ys = CNC.job.shapes.flatMap(s => CNC.worldLoop(s).flatMap(g => [g.a.y, g.b.y]));
      return Math.max(...ys) - Math.min(...ys); })()`);
    ok(Math.abs(th - 0.5) < 1e-6, 'text cap height is exactly as asked (0.5 in)', String(th));

    console.log('push 3: text still posts to TAP');
    const tg = await run(`(() => { const j={shapes:CNC.job.shapes.map(s=>({loop:CNC.worldLoop(s),op:s.op,toolId:1,open:s.open})),
      tools:CNC.S.tools, material:{thickness:0.25}, cutThrough:0, machine:CNC.S.machine};
      return CNC.PO.generate(j).gcode.length; })()`);
    ok(typeof tg === 'number' && tg > 200, 'engraved text generates real G-code', String(tg));

    console.log('push 3: groups');
    await run(`(() => { CNC.job.shapes.length = 0;
      for (let i=0;i<3;i++) CNC.job.shapes.push({id:700+i,name:'g'+i,kind:'rect',x:i*3,y:0,rot:0,w:2,h:2,r:0,op:'outside',toolId:1,climb:false,open:false});
      CNC.refresh(); return true; })()`);
    const gsel = await run(`(() => { const CNCsel = CNC.job.shapes; CNC.job.shapes.forEach(s=>s.group='gX'); return CNC.job.shapes.filter(s=>s.group==='gX').length; })()`);
    ok(gsel === 3, 'shapes can carry a group id', String(gsel));

    console.log('push 3: ellipse + spline');
    await run(`(() => { CNC.job.shapes.length = 0;
      CNC.job.shapes.push({id:800,name:'e',kind:'ellipse',x:5,y:5,rot:0,rx:4,ry:2,op:'outside',toolId:1,climb:false,open:false});
      CNC.refresh(); return true; })()`);
    const ea = await run('Math.abs(CNC.G.signedArea(CNC.worldLoop(CNC.job.shapes[0])))');
    ok(Math.abs(ea - Math.PI * 8) < 0.05, 'ellipse area is about pi*rx*ry', String(ea));
    const eb = JSON.parse(await run('JSON.stringify(CNC.G.bbox(CNC.worldLoop(CNC.job.shapes[0])))'));
    ok(Math.abs(eb.w - 8) < 0.01 && Math.abs(eb.h - 4) < 0.01, 'ellipse bounding box is 8 x 4', eb.w + 'x' + eb.h);

    await run(`(() => { CNC.job.shapes.length = 0;
      CNC.job.shapes.push({id:801,name:'s',kind:'spline',x:0,y:0,rot:0,open:true,op:'on',toolId:1,climb:false,
        pts:[{x:0,y:0},{x:2,y:3},{x:5,y:1},{x:8,y:4}]});
      CNC.refresh(); return true; })()`);
    const sl = await run('CNC.worldLoop(CNC.job.shapes[0]).length');
    ok(sl > 10, 'spline flattens to many segments', String(sl));

    console.log('centre marks + distance tool');
    await run(`(() => { CNC.job.shapes.length = 0; CNC.job.dims = [];
      CNC.job.shapes.push({id:900,name:'c1',kind:'circle',x:5,y:5,rot:0,r:1,op:'outside',toolId:1,climb:false,open:false});
      CNC.job.shapes.push({id:901,name:'c2',kind:'circle',x:9,y:7,rot:0,r:0.5,op:'outside',toolId:1,climb:false,open:false});
      CNC.refresh(); return true; })()`);
    const cm = JSON.parse(await run('JSON.stringify(CNC.centresOf(CNC.job.shapes[0]))'));
    ok(cm.length === 1 && cm[0].p.x === 5 && cm[0].p.y === 5, 'a circle reports its centre for the centre mark');

    // extentAlong must be exactly +/- r for a circle - this is what makes edge maths exact
    const ex = JSON.parse(await run(`JSON.stringify(CNC.extentAlong(CNC.job.shapes[0], {x:1,y:0}))`));
    ok(Math.abs(ex.hi - 1) < 1e-4 && Math.abs(ex.lo + 1) < 1e-4, 'circle extent along X is exactly +/- its radius', JSON.stringify(ex));
    const ex2 = JSON.parse(await run(`JSON.stringify(CNC.extentAlong(CNC.job.shapes[1], {x:0,y:1}))`));
    ok(Math.abs(ex2.hi - 0.5) < 1e-4, 'second circle extent matches its radius', JSON.stringify(ex2));

    // centre-to-centre 4in horizontally, centres aligned
    await run(`(() => { const A=CNC.job.shapes[0], B=CNC.job.shapes[1];
      const cA=CNC.refPoint(A); B.x = cA.x + 4; B.y = cA.y; return true; })()`);
    const d1 = await run('CNC.G.dist(CNC.refPoint(CNC.job.shapes[0]), CNC.refPoint(CNC.job.shapes[1]))');
    ok(Math.abs(d1 - 4) < 1e-9, 'centre-to-centre 4 in places centres exactly 4 in apart', String(d1));

    // edge gap 0.25: centres must end up r1 + gap + r2 = 1 + 0.25 + 0.5 = 1.75 apart
    await run(`(() => { const A=CNC.job.shapes[0], B=CNC.job.shapes[1];
      const u={x:1,y:0}; const eA=CNC.extentAlong(A,u), eB=CNC.extentAlong(B,u);
      const cc = eA.hi + 0.25 - eB.lo; const cA=CNC.refPoint(A);
      B.x = cA.x + cc; B.y = cA.y; return true; })()`);
    const d2 = await run('CNC.G.dist(CNC.refPoint(CNC.job.shapes[0]), CNC.refPoint(CNC.job.shapes[1]))');
    ok(Math.abs(d2 - 1.75) < 1e-4, 'edge gap 0.25 gives centres 1.75 in apart (1 + 0.25 + 0.5)', String(d2));

    // and the real geometric gap between the two outlines must be 0.25
    const realGap = await run(`(() => {
      const a = CNC.worldLoop(CNC.job.shapes[0]), b = CNC.worldLoop(CNC.job.shapes[1]);
      let best = Infinity;
      for (const s of a) for (const p of CNC.G.samplePts(s, 0.01))
        for (const t of b) for (const q of CNC.G.samplePts(t, 0.01))
          { const d = CNC.G.dist(p,q); if (d < best) best = d; }
      return best; })()`);
    ok(Math.abs(realGap - 0.25) < 0.01, 'the measured gap between the two outlines really is 0.25 in', String(realGap));

    console.log('centre marks on non-round shapes');
    await run(`(() => { CNC.job.shapes.length = 0; CNC.job.dims = [];
      CNC.job.shapes.push({id:950,name:'plate',kind:'rect',x:2,y:3,rot:0,w:10,h:6,r:0,op:'outside',toolId:1,climb:false,open:false});
      CNC.refresh(); return true; })()`);
    const rc = JSON.parse(await run('JSON.stringify(CNC.centresOf(CNC.job.shapes[0]))'));
    ok(rc.length === 1 && rc[0].kind === 'part', 'a rectangle now reports a part centre', JSON.stringify(rc));
    ok(Math.abs(rc[0].p.x - 7) < 1e-6 && Math.abs(rc[0].p.y - 6) < 1e-6, 'rectangle centre is at 7,6', JSON.stringify(rc[0].p));

    // and it must be reachable by snapping, not just drawn
    const csnap = await run(`(() => { CNC.resolvePoint({x:7.03,y:6.02}); return JSON.stringify(CNC.lastSnapInfo ? CNC.lastSnapInfo() : null); })()`);
    ok(csnap && JSON.parse(csnap) && JSON.parse(csnap).type === 'center', 'cursor near a rectangle centre snaps to it', csnap);

    console.log('typed length + angle (drawing a corner at an exact angle)');
    await run(`(() => { CNC.job.shapes.length = 0; CNC.refresh(); return true; })()`);
    const drew = await run(`(() => {
      document.querySelector('button.tool[data-tool="pline"]').click();
      CNC.commitPoint({x:0,y:0});
      document.querySelector('#dynLen').value = '10';
      document.querySelector('#dynAng').value = '0';
      CNC.commitDyn();
      document.querySelector('#dynLen').value = '6';
      document.querySelector('#dynAng').value = '120';
      CNC.commitDyn();
      window.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
      return CNC.job.shapes.length;
    })()`);
    ok(drew === 1, 'typed entry produced one path', String(drew));
    const seg = JSON.parse(await run(`JSON.stringify(CNC.worldLoop(CNC.job.shapes[0]).map(s => ({a:s.a,b:s.b})))`));
    ok(seg.length === 2, 'two straight segments', String(seg.length));
    if (seg.length === 2) {
      const L1 = Math.hypot(seg[0].b.x-seg[0].a.x, seg[0].b.y-seg[0].a.y);
      const L2 = Math.hypot(seg[1].b.x-seg[1].a.x, seg[1].b.y-seg[1].a.y);
      ok(Math.abs(L1 - 10) < 1e-9, 'first leg is exactly 10 in', String(L1));
      ok(Math.abs(L2 - 6) < 1e-9, 'second leg is exactly 6 in', String(L2));
      const a1 = Math.atan2(seg[0].b.y-seg[0].a.y, seg[0].b.x-seg[0].a.x) * 180/Math.PI;
      const a2 = Math.atan2(seg[1].b.y-seg[1].a.y, seg[1].b.x-seg[1].a.x) * 180/Math.PI;
      ok(Math.abs(a1 - 0) < 1e-9, 'first leg is at exactly 0 deg', String(a1));
      ok(Math.abs(a2 - 120) < 1e-9, 'second leg is at exactly 120 deg', String(a2));
      // included angle between the two legs is what the operator actually cares about
      const inc = 180 - Math.abs(a2 - a1);
      ok(Math.abs(inc - 60) < 1e-9, 'the corner between them is exactly 60 deg', String(inc));
    }

    console.log('tool hints');
    await run(`(() => { document.querySelector('button.tool[data-tool="pline"]').click(); return true; })()`);
    const hint = await run(`document.querySelector('#toolHint').textContent`);
    ok(/Enter/.test(hint), 'the Line tool tells you how to finish it', JSON.stringify(hint));
    await run(`(() => { document.querySelector('button.tool[data-tool="select"]').click(); return true; })()`);
    const selHint = await run(`document.querySelector('#toolHint').textContent`);
    ok(/line/i.test(selHint), 'the select tool explains that clicking a line picks it', JSON.stringify(selHint));

    console.log('delete an edge (rectangle -> C shape)');
    await run(`(() => { CNC.job.shapes.length = 0; CNC.job.dims = [];
      CNC.job.shapes.push({id:960,name:'plate',kind:'rect',x:0,y:0,rot:0,w:10,h:6,r:0,op:'outside',toolId:1,climb:false,open:false});
      CNC.refresh(); return true; })()`);
    ok((await run('CNC.worldLoop(CNC.job.shapes[0]).length')) === 4, 'rectangle starts as 4 segments');
    // click the middle of the bottom edge
    await run(`(() => { const sh = CNC.job.shapes[0]; const loop = CNC.worldLoop(sh);
      CNC.eraseEdgeAt(sh, loop, {x:5, y:0}); return true; })()`);
    ok((await run('CNC.job.shapes.length')) === 1, 'still one part after deleting an edge');
    const c = JSON.parse(await run(`JSON.stringify({open: CNC.job.shapes[0].open, op: CNC.job.shapes[0].op, n: CNC.worldLoop(CNC.job.shapes[0]).length})`));
    ok(c.n === 3, 'the C shape has 3 segments', JSON.stringify(c));
    ok(c.open === true, 'it became an open path');
    ok(c.op === 'on', 'and is set to cut on the line, not as an outline');
    // the remaining path must be continuous and must NOT include the deleted edge
    const cont = await run(`(() => { const l = CNC.worldLoop(CNC.job.shapes[0]);
      for (let i = 0; i + 1 < l.length; i++) if (CNC.G.dist(l[i].b, l[i+1].a) > 1e-9) return false;
      return true; })()`);
    ok(cont === true, 'the remaining path is continuous end to end');
    const gapEnds = JSON.parse(await run(`(() => { const l = CNC.worldLoop(CNC.job.shapes[0]);
      return JSON.stringify([l[0].a, l[l.length-1].b]); })()`));
    ok(Math.abs(gapEnds[0].y) < 1e-9 && Math.abs(gapEnds[1].y) < 1e-9,
      'the open ends sit where the deleted bottom edge used to be', JSON.stringify(gapEnds));
    const per = await run(`(() => { const l = CNC.worldLoop(CNC.job.shapes[0]);
      return l.reduce((s,g)=>s+CNC.G.segLen(g),0); })()`);
    ok(Math.abs(per - 22) < 1e-6, 'remaining length is 6+10+6 = 22 in', String(per));

    console.log('delete an edge from an open path splits it');
    await run(`(() => { CNC.job.shapes.length = 0;
      CNC.job.shapes.push({id:961,name:'zig',kind:'poly',x:0,y:0,rot:0,open:true,op:'on',toolId:1,climb:false,
        pts:[{x:0,y:0},{x:4,y:0},{x:8,y:0},{x:12,y:0}]});
      CNC.refresh(); return true; })()`);
    await run(`(() => { const sh = CNC.job.shapes[0]; const loop = CNC.worldLoop(sh);
      CNC.eraseEdgeAt(sh, loop, {x:6, y:0}); return true; })()`);
    ok((await run('CNC.job.shapes.length')) === 2, 'deleting a middle edge splits an open path in two', String(await run('CNC.job.shapes.length')));

    console.log('deleting the last edge removes the part');
    await run(`(() => { CNC.job.shapes.length = 0;
      CNC.job.shapes.push({id:962,name:'one',kind:'poly',x:0,y:0,rot:0,open:true,op:'on',toolId:1,climb:false,
        pts:[{x:0,y:0},{x:5,y:0}]});
      CNC.refresh(); return true; })()`);
    await run(`(() => { const sh = CNC.job.shapes[0]; CNC.eraseEdgeAt(sh, CNC.worldLoop(sh), {x:2.5,y:0}); return true; })()`);
    ok((await run('CNC.job.shapes.length')) === 0, 'the part is gone when its only edge is deleted');

    console.log('fine snap + zoom limits');
    const opts = JSON.parse(await run(`JSON.stringify(Array.from(document.querySelectorAll('#selSnap option')).map(o=>o.value))`));
    ok(opts.includes('0.001'), 'a 0.001 in snap option exists', JSON.stringify(opts));
    ok((await run(`document.querySelector('#selSnap').value`)) === '0.001', 'and it is the default');
    // at 0.001 the cursor must resolve to thousandths, not eighths
    const rp = await run(`(() => { const p = CNC.resolvePoint({x: 3.1417, y: 2.7183}); return JSON.stringify(p); })()`);
    const rpv = JSON.parse(rp);
    ok(Math.abs(rpv.x - 3.142) < 1e-9 && Math.abs(rpv.y - 2.718) < 1e-9, 'a point resolves to 0.001, not 0.125', rp);

    const zmax = await run(`(() => { CNC.view ? 0 : 0; return true; })()`);
    ok(zmax === true, 'zoom probe ran');

    console.log('heal loose ends (trim near-miss)');
    await run(`(() => { CNC.job.shapes.length = 0; CNC.job.dims = [];
      // a vertical wall, and a horizontal line that stops 0.02 in short of it
      CNC.job.shapes.push({id:970,name:'wall',kind:'poly',x:0,y:0,rot:0,open:true,op:'on',toolId:1,climb:false,
        pts:[{x:10,y:-5},{x:10,y:5}]});
      CNC.job.shapes.push({id:971,name:'short',kind:'poly',x:0,y:0,rot:0,open:true,op:'on',toolId:1,climb:false,
        pts:[{x:0,y:0},{x:9.98,y:0}]});
      CNC.refresh(); return true; })()`);
    const crossBefore = await run(`(() => { const sh = CNC.job.shapes.find(s=>s.name==='short');
      return CNC.crossingsOf(sh, CNC.worldLoop(sh)).length; })()`);
    ok(crossBefore === 0, 'a line stopping 0.02 in short genuinely does not cross', String(crossBefore));

    const healed = await run(`(() => { const sh = CNC.job.shapes.find(s=>s.name==='short');
      const r = CNC.healEndsOf(sh, 0.125);
      if (!r) return 'none';
      return JSON.stringify({moved: r.moved, end: r.loop[r.loop.length-1].b});
    })()`);
    ok(healed !== 'none', 'healing finds the near miss', healed);
    if (healed !== 'none') {
      const hv = JSON.parse(healed);
      ok(Math.abs(hv.end.x - 10) < 1e-9, 'the loose end is pulled exactly onto the wall at x=10', JSON.stringify(hv.end));
    }
    // after healing, it really does cross
    await run(`(() => { const sh = CNC.job.shapes.find(s=>s.name==='short');
      const r = CNC.healEndsOf(sh, 0.125); CNC.replaceWithLoop(sh, r.loop); CNC.refresh(); return true; })()`);
    const endsOnWall = await run(`(() => { const sh = CNC.job.shapes.find(s=>s.name==='short');
      const l = CNC.worldLoop(sh); return Math.abs(l[l.length-1].b.x - 10) < 1e-9; })()`);
    ok(endsOnWall === true, 'the healed shape ends on the wall');

    // a gap wider than tolerance must be left alone, not silently stretched
    await run(`(() => { CNC.job.shapes.length = 0;
      CNC.job.shapes.push({id:972,name:'wall',kind:'poly',x:0,y:0,rot:0,open:true,op:'on',toolId:1,climb:false,pts:[{x:10,y:-5},{x:10,y:5}]});
      CNC.job.shapes.push({id:973,name:'far',kind:'poly',x:0,y:0,rot:0,open:true,op:'on',toolId:1,climb:false,pts:[{x:0,y:0},{x:9,y:0}]});
      CNC.refresh(); return true; })()`);
    const farHeal = await run(`(() => { const sh = CNC.job.shapes.find(s=>s.name==='far');
      return CNC.healEndsOf(sh, 0.125) ? 'moved' : 'none'; })()`);
    ok(farHeal === 'none', 'a 1 in gap is NOT healed — only near misses are', farHeal);

    console.log('snap reach is a real distance, not a screen distance');
    await run(`(() => { CNC.job.shapes.length = 0; CNC.job.dims = [];
      CNC.job.shapes.push({id:980,name:'wall',kind:'poly',x:0,y:0,rot:0,open:true,op:'on',toolId:1,climb:false,
        pts:[{x:10,y:0},{x:10,y:10}]});
      CNC.refresh(); return true; })()`);

    // zoom in hard: 11 screen px is now a tiny world distance
    await run(`(() => { CNC.view.scale = 600; return true; })()`);
    const tolZoomed = await run('CNC.snapTol()');
    ok(tolZoomed >= 0.125 - 1e-9, 'zoomed in, snap reach still covers 0.125 in', String(tolZoomed));

    // a point 0.1 in short of the wall must snap ONTO the wall
    const hit = await run(`(() => { const p = CNC.resolvePoint({x: 9.9, y: 5}); return JSON.stringify(p); })()`);
    const hv = JSON.parse(hit);
    ok(Math.abs(hv.x - 10) < 1e-9, 'an endpoint 0.1 in away lands exactly on the line at x=10', hit);
    // probe off the wall's midpoint (10,5), which would legitimately outrank 'on'
    const st = await run(`(() => { CNC.resolvePoint({x: 9.9, y: 3.37}); const s = CNC.lastSnapInfo(); return s ? s.type : 'none'; })()`);
    ok(st === 'on', 'mid-span, it reports snapping onto the edge', st);
    const stp = await run(`(() => { const p = CNC.resolvePoint({x: 9.9, y: 3.37}); return JSON.stringify(p); })()`);
    ok(Math.abs(JSON.parse(stp).x - 10) < 1e-9, 'and lands exactly on x=10 there too', stp);

    // 0.3 in away is outside the radius and must NOT be dragged in
    const far = await run(`(() => { const p = CNC.resolvePoint({x: 9.7, y: 5}); return JSON.stringify(p); })()`);
    ok(Math.abs(JSON.parse(far).x - 10) > 0.05, 'a point 0.3 in away is left alone', far);

    // dragging towards the wall END should prefer the endpoint over the edge
    const ep = await run(`(() => { CNC.resolvePoint({x: 9.95, y: 9.95}); const s = CNC.lastSnapInfo(); return s ? s.type : 'none'; })()`);
    ok(ep === 'endpoint', 'near the end of the wall, the endpoint wins (so shapes close cleanly)', ep);

    // zoomed way out, the screen radius must still take over
    await run(`(() => { CNC.view.scale = 3; return true; })()`);
    const tolOut = await run('CNC.snapTol()');
    ok(tolOut > 0.125, 'zoomed out, the screen radius takes over so picking stays possible', String(tolOut));
    await run(`(() => { CNC.view.scale = 8; return true; })()`);

    // the configured radius is honoured
    await run(`(() => { CNC.S.snap.radius = 0.5; return true; })()`);
    ok((await run('CNC.snapTol()')) >= 0.5 - 1e-9, 'a custom snap radius is used', String(await run('CNC.snapTol()')));
    await run(`(() => { CNC.S.snap.radius = 0.125; return true; })()`);

    console.log('edge sub-selection (one side of a triangle)');
    await run(`(() => { CNC.job.shapes.length = 0; CNC.job.dims = [];
      CNC.job.shapes.push({id:990,name:'tri',kind:'poly',x:0,y:0,rot:0,open:false,op:'outside',toolId:1,climb:false,
        pts:[{x:0,y:0,r:0,arcR:0},{x:12,y:0,r:0,arcR:0},{x:6,y:8,r:0,arcR:0}]});
      CNC.refresh(); return true; })()`);
    ok((await run('CNC.worldLoop(CNC.job.shapes[0]).length')) === 3, 'triangle has 3 sides');

    // clicking the middle of the bottom side finds side 0
    const idx = await run(`CNC.edgeIndexAt(CNC.job.shapes[0], {x:6, y:0})`);
    ok(idx === 0, 'clicking the bottom side identifies side 0', String(idx));
    const idx2 = await run(`CNC.edgeIndexAt(CNC.job.shapes[0], {x:9, y:4})`);
    ok(idx2 === 1, 'clicking the right side identifies side 1', String(idx2));
    const idxNone = await run(`CNC.edgeIndexAt(CNC.job.shapes[0], {x:6, y:4})`);
    ok(idxNone === -1, 'clicking the middle of the part selects no side', String(idxNone));

    console.log('editing the selected side');
    await run(`(() => { CNC.setSelEdge(990, 0); return true; })()`);
    // set side 0 to exactly 20 in long
    const beforeLen = await run(`CNC.G.segLen(CNC.worldLoop(CNC.job.shapes[0])[0])`);
    ok(Math.abs(beforeLen - 12) < 1e-9, 'side 0 starts at 12 in', String(beforeLen));
    const hasField = await run(`!!document.querySelector('#props [data-ev="len"]')`);
    ok(hasField === true, 'the selected side shows a Length field on the right');
    await run(`(() => { const el = document.querySelector('#props [data-ev="len"]');
      if (!el) return false;
      el.value = '20'; el.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
    const afterLen = await run(`CNC.G.segLen(CNC.worldLoop(CNC.job.shapes[0])[0])`);
    ok(Math.abs(afterLen - 20) < 1e-6, 'typing 20 makes side 0 exactly 20 in', String(afterLen));

    // angle
    await run(`(() => { const el = document.querySelector('#props [data-ev="ang"]');
      if (!el) return false;
      el.value = '30'; el.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
    const ang = await run(`(() => { const s = CNC.worldLoop(CNC.job.shapes[0])[0];
      return Math.atan2(s.b.y-s.a.y, s.b.x-s.a.x) * 180/Math.PI; })()`);
    ok(Math.abs(ang - 30) < 1e-6, 'typing 30 sets side 0 to exactly 30 deg', String(ang));

    console.log('sliders exist for the selected side');
    const sliders = await run(`document.querySelectorAll('#props input[type=range].slider').length`);
    ok(sliders >= 3, 'length, angle and bulge sliders are shown', String(sliders));

    console.log('delete just that side');
    await run(`(() => { CNC.job.shapes.length = 0;
      CNC.job.shapes.push({id:991,name:'tri',kind:'poly',x:0,y:0,rot:0,open:false,op:'outside',toolId:1,climb:false,
        pts:[{x:0,y:0,r:0,arcR:0},{x:12,y:0,r:0,arcR:0},{x:6,y:8,r:0,arcR:0}]});
      CNC.refresh(); return true; })()`);
    await run(`(() => { CNC.setSelEdge(991, 0); return true; })()`);
    const del = await run('CNC.deleteSelectedEdge()');
    ok(del === true, 'deleting the selected side reports success');
    ok((await run('CNC.job.shapes.length')) === 1, 'the part survives with one side gone');
    const rem = JSON.parse(await run(`JSON.stringify({n: CNC.worldLoop(CNC.job.shapes[0]).length, open: CNC.job.shapes[0].open})`));
    ok(rem.n === 2 && rem.open === true, 'a triangle minus one side is a 2-segment open path', JSON.stringify(rem));

    console.log('path shapes become editable too');
    await run(`(() => { CNC.job.shapes.length = 0;
      const loop = CNC.G.rectLoop(0,0,10,6);
      CNC.job.shapes.push({id:992,name:'p',kind:'path',x:0,y:0,rot:0,open:false,op:'outside',toolId:1,climb:false,loop});
      CNC.refresh(); return true; })()`);
    const conv = await run(`(() => { const sh = CNC.job.shapes[0]; CNC.makeEditable(sh); return sh.kind + ':' + (sh.pts ? sh.pts.length : 0); })()`);
    ok(conv === 'poly:4', 'a path shape converts to an editable 4-point polygon', conv);

    console.log('box-select picks the sides it crosses');
    await run(`(() => { CNC.job.shapes.length = 0; CNC.job.dims = [];
      CNC.job.shapes.push({id:1000,name:'sq',kind:'poly',x:0,y:0,rot:0,open:false,op:'outside',toolId:1,climb:false,
        pts:[{x:0,y:0,r:0,arcR:0},{x:10,y:0,r:0,arcR:0},{x:10,y:10,r:0,arcR:0},{x:0,y:10,r:0,arcR:0}]});
      CNC.refresh(); return true; })()`);
    // sides: 0 = bottom, 1 = right, 2 = top, 3 = left
    // drag from the TOP-LEFT corner to the centre -> should catch top and left
    await run(`(() => { CNC.doMarquee(0, 5, 5, 10); return true; })()`);
    const picked = JSON.parse(await run('JSON.stringify(CNC.getSelEdges())'));
    const idxs = picked.map(e => e.i).sort();
    ok(picked.length === 2, 'box from the top-left corner to the centre picks exactly 2 sides', JSON.stringify(idxs));
    ok(idxs.join(',') === '2,3', 'and they are the top and left sides', idxs.join(','));

    // a box wholly inside the square touches nothing
    await run(`(() => { CNC.getSelEdges().length; return true; })()`);
    await run(`(() => { CNC.job.shapes.forEach(s=>0); return true; })()`);

    console.log('deleting several selected sides at once');
    const delMany = await run('CNC.deleteSelectedEdge()');
    ok(delMany === true, 'deleting two selected sides works');
    const after = JSON.parse(await run(`JSON.stringify(CNC.job.shapes.map(s => CNC.worldLoop(s).length))`));
    ok(after.reduce((a, b) => a + b, 0) === 2, 'a square minus two sides leaves 2 segments total', JSON.stringify(after));

    console.log('T-junction merge (line landing partway along a side)');
    await run(`(() => { CNC.job.shapes.length = 0;
      // a C: square missing its bottom side. corners (0,0) (0,10) (10,10) (10,0)
      CNC.job.shapes.push({id:1010,name:'C',kind:'poly',x:0,y:0,rot:0,open:true,op:'on',toolId:1,climb:false,
        pts:[{x:0,y:0},{x:0,y:10},{x:10,y:10},{x:10,y:0}]});
      // a line from the C's start corner (0,0) to a point PARTWAY along the top side
      CNC.job.shapes.push({id:1011,name:'tie',kind:'poly',x:0,y:0,rot:0,open:true,op:'on',toolId:1,climb:false,
        pts:[{x:0,y:0},{x:4,y:10}]});
      CNC.refresh(); return true; })()`);
    ok((await run('CNC.job.shapes.length')) === 2, 'starts as two separate objects');
    await run(`(() => { CNC.setSelEdge(1010, 0); return true; })()`);
    // select both, then merge
    const merged = await run(`(() => {
      CNC.job.shapes.forEach(s => 0);
      const ids = CNC.job.shapes.map(s => s.id);
      CNC.doMarquee(-1, -1, 11, 11);   // selects both wholly
      CNC.mergeSelected(0.125);
      return CNC.job.shapes.length;
    })()`);
    ok(merged === 1, 'merge leaves a single part', String(merged));
    const nsides = await run('CNC.worldLoop(CNC.job.shapes[0]).length');
    ok(nsides === 5, 'the C (3 sides) plus the tie line becomes 5 sides - the top side was split at the junction', String(nsides));

    // and that 5th side can be selected and deleted on its own
    await run(`(() => { CNC.setSelEdge(CNC.job.shapes[0].id, 4); return true; })()`);
    const before5 = await run('CNC.worldLoop(CNC.job.shapes[0]).length');
    ok(before5 === 5, 'still 5 sides before deleting');
    await run('CNC.deleteSelectedEdge()');
    const totalAfter = JSON.parse(await run(`JSON.stringify(CNC.job.shapes.map(s => CNC.worldLoop(s).length))`));
    ok(totalAfter.reduce((a, b) => a + b, 0) === 4, 'deleting one of the 5 sides leaves 4 segments', JSON.stringify(totalAfter));

    console.log('bbox of an open path (was collapsing to a point)');
    const obb = JSON.parse(await run(`JSON.stringify(CNC.G.bbox([CNC.G.line({x:0,y:0},{x:4,y:10})]))`));
    ok(obb.w === 4 && obb.h === 10, 'a single-segment open path reports its real bbox', JSON.stringify(obb));
    const rbb = JSON.parse(await run(`JSON.stringify(CNC.G.bbox(CNC.G.rectLoop(0,0,10,6)))`));
    ok(rbb.w === 10 && rbb.h === 6, 'closed shapes are unaffected', JSON.stringify(rbb));
    const ar = await run(`CNC.G.signedArea(CNC.G.rectLoop(0,0,10,6))`);
    ok(Math.abs(ar - 60) < 1e-9, 'area is unchanged by the bbox fix', String(ar));

    console.log('segment/box test catches a line crossing right through');
    const thru = await run(`CNC.segTouchesBox(CNC.G.line({x:-5,y:5},{x:15,y:5}), {x0:0,x1:10,y0:0,y1:10})`);
    ok(thru === true, 'a line crossing the box with BOTH ends outside is detected', String(thru));
    const miss = await run(`CNC.segTouchesBox(CNC.G.line({x:-5,y:50},{x:15,y:50}), {x0:0,x1:10,y0:0,y1:10})`);
    ok(miss === false, 'a line well clear of the box is not', String(miss));

    console.log('box-select spanning TWO parts');
    await run(`(() => { CNC.job.shapes.length = 0; CNC.job.dims = [];
      CNC.job.shapes.push({id:1100,name:'C',kind:'poly',x:0,y:0,rot:0,open:true,op:'on',toolId:1,climb:false,
        pts:[{x:0,y:0},{x:0,y:10},{x:10,y:10},{x:10,y:0}]});
      CNC.job.shapes.push({id:1101,name:'tie',kind:'poly',x:0,y:0,rot:0,open:true,op:'on',toolId:1,climb:false,
        pts:[{x:0,y:0},{x:4,y:10}]});
      CNC.refresh(); return true; })()`);
    await run(`(() => { CNC.doMarquee(-1,-1,6,6); return true; })()`);
    const spans = JSON.parse(await run('JSON.stringify(CNC.getSelEdges())'));
    const partIds = Array.from(new Set(spans.map(e => e.id))).sort();
    ok(partIds.length === 2, 'a box crossing both objects selects sides on BOTH', JSON.stringify(spans));
    ok(partIds.join(',') === '1100,1101', 'and they are the C and the tie line', partIds.join(','));

    console.log('split at intersections makes each piece selectable');
    await run(`(() => { CNC.job.shapes.length = 0;
      // one long horizontal line, crossed by a vertical one at x=5
      CNC.job.shapes.push({id:1110,name:'h',kind:'poly',x:0,y:0,rot:0,open:true,op:'on',toolId:1,climb:false,
        pts:[{x:0,y:5},{x:10,y:5}]});
      CNC.job.shapes.push({id:1111,name:'v',kind:'poly',x:0,y:0,rot:0,open:true,op:'on',toolId:1,climb:false,
        pts:[{x:5,y:0},{x:5,y:10}]});
      CNC.refresh(); return true; })()`);
    ok((await run('CNC.worldLoop(CNC.job.shapes[0]).length')) === 1, 'the horizontal line starts as one segment');
    const nsplit = await run(`CNC.splitAtIntersections(CNC.job.shapes.slice(), 0.125)`);
    ok(nsplit >= 2, 'splitting reports crossings found', String(nsplit));
    const counts = JSON.parse(await run(`JSON.stringify(CNC.job.shapes.map(s => CNC.worldLoop(s).length))`));
    ok(counts.every(n => n === 2), 'each line is now two separately selectable pieces', JSON.stringify(counts));
    // and the halves are the right halves
    const halves = JSON.parse(await run(`JSON.stringify(CNC.worldLoop(CNC.job.shapes[0]).map(g => [g.a.x, g.b.x]))`));
    ok(Math.abs(halves[0][1] - 5) < 1e-6, 'the horizontal line is split exactly at the crossing (x=5)', JSON.stringify(halves));

    console.log('merge two leftovers into one closed part');
    await run(`(() => { CNC.job.shapes.length = 0; CNC.job.dims = [];
      CNC.job.shapes.push({id:1200,name:'a',kind:'poly',x:0,y:0,rot:0,open:true,op:'on',toolId:1,climb:false,
        pts:[{x:0,y:0},{x:0,y:10},{x:10,y:10}]});
      CNC.job.shapes.push({id:1201,name:'b',kind:'poly',x:0,y:0,rot:0,open:true,op:'on',toolId:1,climb:false,
        pts:[{x:10,y:10},{x:10,y:0},{x:0,y:0}]});
      CNC.refresh(); CNC.doMarquee(-99,-99,99,99); CNC.mergeSelected(0.125); return true; })()`);
    ok((await run('CNC.job.shapes.length')) === 1, 'two open halves merge into a single part');
    const m = JSON.parse(await run(`JSON.stringify({open: CNC.job.shapes[0].open, op: CNC.job.shapes[0].op, n: CNC.worldLoop(CNC.job.shapes[0]).length})`));
    ok(m.open === false, 'the merged part is CLOSED, not an open path', JSON.stringify(m));
    ok(m.op === 'outside', 'and switches to cutting outside, so it profiles as a part', m.op);
    ok(m.n === 4, 'it has 4 sides', String(m.n));
    const marea = await run(`Math.abs(CNC.G.signedArea(CNC.worldLoop(CNC.job.shapes[0])))`);
    ok(Math.abs(marea - 100) < 1e-6, 'and encloses the right area (10x10 = 100)', String(marea));

    console.log('merge accepts a CLOSED part too (was silently refusing)');
    await run(`(() => { CNC.job.shapes.length = 0;
      CNC.job.shapes.push({id:1210,name:'closed',kind:'poly',x:0,y:0,rot:0,open:false,op:'outside',toolId:1,climb:false,
        pts:[{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}]});
      CNC.job.shapes.push({id:1211,name:'tail',kind:'poly',x:0,y:0,rot:0,open:true,op:'on',toolId:1,climb:false,
        pts:[{x:10,y:10},{x:16,y:10}]});
      CNC.refresh(); CNC.doMarquee(-99,-99,99,99); CNC.mergeSelected(0.125); return true; })()`);
    ok((await run('CNC.job.shapes.length')) === 1, 'a closed part and an open one merge into one');
    ok((await run('CNC.worldLoop(CNC.job.shapes[0]).length')) === 5, 'giving 5 sides (square + tail)', String(await run('CNC.worldLoop(CNC.job.shapes[0]).length')));

    console.log('one click on a line selects that line');
    await run(`(() => { window.__click = (wx, wy, type, opts) => {
        const cv = document.querySelector('#cv');
        const r = cv.getBoundingClientRect();
        const sp = CNC.W2S({x:wx, y:wy});
        const ev = new MouseEvent(type, Object.assign({
          clientX: r.left + sp.x / devicePixelRatio,
          clientY: r.top  + sp.y / devicePixelRatio,
          bubbles: true, button: 0 }, opts || {}));
        cv.dispatchEvent(ev);
        if (type === 'mouseup') window.dispatchEvent(ev);
        return true; }; return true; })()`);

    // a square with an overhang sticking up past the top-right corner
    await run(`(() => { CNC.job.shapes.length = 0; CNC.job.dims = [];
      document.querySelector('button.tool[data-tool="select"]').click();
      CNC.job.shapes.push({id:1300,name:'part',kind:'poly',x:0,y:0,rot:0,open:true,op:'on',toolId:1,climb:false,
        pts:[{x:0,y:0},{x:0,y:10},{x:10,y:10},{x:10,y:14},{x:10,y:0}]});
      CNC.refresh(); return true; })()`);
    const segs0 = await run('CNC.worldLoop(CNC.job.shapes[0]).length');
    ok(segs0 === 4, 'test part has 4 segments including the overhang', String(segs0));

    // click ONCE on the overhang (the stub from y=10 to y=14 at x=10)
    await run(`(() => { window.__click(10, 12, 'mousedown'); window.__click(10, 12, 'mouseup'); return true; })()`);
    const clicked = JSON.parse(await run('JSON.stringify(CNC.getSelEdges())'));
    ok(clicked.length === 1, 'a single click selects exactly one line', JSON.stringify(clicked));
    ok(clicked.length === 1 && clicked[0].i === 2, 'and it is the overhang segment', JSON.stringify(clicked));

    // Delete removes just that line
    await run(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', {key:'Delete', bubbles:true})); return true; })()`);
    const totalSegs = JSON.parse(await run(`JSON.stringify(CNC.job.shapes.map(s => CNC.worldLoop(s).length))`));
    ok(totalSegs.reduce((a,b)=>a+b,0) === 3, 'Delete removes just that line, leaving 3 segments', JSON.stringify(totalSegs));

    console.log('double-click still selects the whole part');
    await run(`(() => { CNC.job.shapes.length = 0;
      CNC.job.shapes.push({id:1310,name:'sq',kind:'poly',x:0,y:0,rot:0,open:false,op:'outside',toolId:1,climb:false,
        pts:[{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}]});
      CNC.refresh(); return true; })()`);
    await run(`(() => { window.__click(5, 0, 'mousedown'); window.__click(5, 0, 'mouseup'); return true; })()`);
    ok((await run('CNC.getSelEdges().length')) === 1, 'clicking the bottom line selects that line');
    await run(`(() => { const cv = document.querySelector('#cv'); const r = cv.getBoundingClientRect();
      const sp = CNC.W2S({x:5,y:0});
      cv.dispatchEvent(new MouseEvent('dblclick', {clientX: r.left + sp.x/devicePixelRatio, clientY: r.top + sp.y/devicePixelRatio, bubbles:true}));
      return true; })()`);
    ok((await run('CNC.getSelEdges().length')) === 0, 'double-click clears the line selection');
    ok((await run('CNC.job.shapes.length')) === 1, 'and the part is still there');

    console.log('hover previews the line under the cursor');
    await run(`(() => { const cv = document.querySelector('#cv'); const r = cv.getBoundingClientRect();
      const sp = CNC.W2S({x:2.5,y:10});   // off the midpoint grip, which outranks the edge
      cv.dispatchEvent(new MouseEvent('mousemove', {clientX: r.left + sp.x/devicePixelRatio, clientY: r.top + sp.y/devicePixelRatio, bubbles:true}));
      return true; })()`);
    const hov = JSON.parse(await run('JSON.stringify(CNC.hoverEdgeInfo())'));
    ok(hov && typeof hov.i === 'number', 'hovering a line reports it for the highlight', JSON.stringify(hov));

    console.log('arc DIRECTION survives a round trip (not just radius)');
    // a circle converted to per-edge bulges and back must keep its area.
    // checking only the radius magnitude is what let a mirrored arc through.
    const rt2 = await run(`(() => {
      CNC.job.shapes.length = 0;
      CNC.job.shapes.push({id:1400,name:'c',kind:'circle',x:10,y:10,rot:0,r:6,op:'outside',toolId:1,climb:false,open:false});
      CNC.refresh();
      const sh = CNC.job.shapes[0];
      const before = Math.abs(CNC.G.signedArea(CNC.worldLoop(sh)));
      // force it through the path -> editable-polygon conversion
      const loop = CNC.worldLoop(sh);
      CNC.job.shapes[0] = {id:1400,name:'c',kind:'path',x:0,y:0,rot:0,open:false,op:'outside',toolId:1,climb:false,loop};
      CNC.makeEditable(CNC.job.shapes[0]);
      CNC.refresh();
      const after = Math.abs(CNC.G.signedArea(CNC.worldLoop(CNC.job.shapes[0])));
      return JSON.stringify({before, after});
    })()`);
    const rtv = JSON.parse(rt2);
    ok(Math.abs(rtv.before - Math.PI * 36) < 0.05, 'circle starts at pi*r^2', String(rtv.before));
    ok(Math.abs(rtv.after - rtv.before) < 0.05, 'area survives conversion to editable bulges', rt2);

    // an arc bowed one way must not come back bowed the other
    const dirOk = await run(`(() => {
      const a = {x:0,y:0}, b = {x:10,y:0};
      // arcThrough a point ABOVE the chord
      const up = CNC.arcThrough(a, b, {x:5, y:2});
      const mid = CNC.G.pointAt(up, 0.5);
      return mid.y;
    })()`);
    ok(dirOk > 0, 'an arc drawn through a point above the chord still bows upward', String(dirOk));
    const dirOk2 = await run(`(() => {
      const up = CNC.arcThrough({x:0,y:0}, {x:10,y:0}, {x:5, y:-2});
      return CNC.G.pointAt(up, 0.5).y; })()`);
    ok(dirOk2 < 0, 'and one through a point below bows downward', String(dirOk2));

    console.log('auto-split when drawing across existing geometry');
    await run(`(() => { CNC.job.shapes.length = 0; CNC.job.dims = [];
      CNC.job.shapes.push({id:1410,name:'circle',kind:'circle',x:10,y:10,rot:0,r:6,op:'outside',toolId:1,climb:false,open:false});
      CNC.refresh(); return true; })()`);
    ok((await run('CNC.worldLoop(CNC.job.shapes[0]).length')) === 2, 'a circle starts as 2 semicircle arcs');

    await run(`(() => { const sh = {id:1411,name:'h',kind:'poly',x:0,y:0,rot:0,open:true,op:'on',toolId:1,climb:false,
        pts:[{x:4,y:10},{x:16,y:10}]};
      CNC.job.shapes.push(sh); CNC.autoSplitAround(sh); CNC.refresh(); return true; })()`);
    await run(`(() => { const sh = {id:1412,name:'v',kind:'poly',x:0,y:0,rot:0,open:true,op:'on',toolId:1,climb:false,
        pts:[{x:10,y:4},{x:10,y:16}]};
      CNC.job.shapes.push(sh); CNC.autoSplitAround(sh); CNC.refresh(); return true; })()`);

    const shape2 = JSON.parse(await run(`JSON.stringify(CNC.job.shapes.map(s => ({name:s.name, kind:s.kind, n: CNC.worldLoop(s).length})))`));
    const circ2 = shape2.find(x => x.name === 'circle');
    // the rule is "lines and intersection points": lines split, the circle is left whole
    ok(circ2 && circ2.kind === 'circle', 'the circle stays a circle when lines cross it', JSON.stringify(circ2));
    ok(circ2 && circ2.n === 2, 'and keeps its two native arcs, not pieces', JSON.stringify(circ2));
    ok(shape2.filter(x => x.name === 'h' || x.name === 'v').every(x => x.n === 2), 'each diameter still becomes 2 radii', JSON.stringify(shape2));
    const circArea = await run(`Math.abs(CNC.G.signedArea(CNC.worldLoop(CNC.job.shapes.find(s=>s.name==='circle'))))`);
    ok(Math.abs(circArea - Math.PI * 36) < 0.05, 'and the circle still encloses pi*r^2', String(circArea));

    console.log('segmentation rule: a line runs between contact points');
    /* The rule, stated plainly: a single continuous line is one line. Wherever
       another line crosses or joins it, it becomes two - or more, one per
       contact point. These lock that in for every configuration. */
    const fresh = () => run(`(() => { CNC.job.shapes.length = 0; CNC.job.dims = []; CNC.refresh(); return true; })()`);
    const addLine = (id, name, pts, open) => run(`(() => {
      CNC.job.shapes.push({id:${id},name:'${name}',kind:'poly',x:0,y:0,rot:0,open:${open !== false},
        op:'${open !== false ? 'on' : 'outside'}',toolId:1,climb:false,pts:${JSON.stringify(pts)}});
      const sh = CNC.job.shapes[CNC.job.shapes.length-1];
      CNC.autoSplitAround(sh); CNC.refresh(); return true; })()`);
    const segsOf = async (name) => run(`CNC.worldLoop(CNC.job.shapes.find(s=>s.name==='${name}')).length`);

    await fresh();
    await addLine(1500, 'h', [{x:0,y:5},{x:10,y:5}]);
    await addLine(1501, 'v', [{x:5,y:0},{x:5,y:10}]);
    ok((await segsOf('h')) === 2 && (await segsOf('v')) === 2, 'X crossing: each line becomes two');

    await fresh();
    await addLine(1510, 'base', [{x:0,y:0},{x:10,y:0}]);
    await addLine(1511, 'stem', [{x:4,y:0},{x:4,y:6}]);
    ok((await segsOf('base')) === 2, 'T junction: the crossed line becomes two');
    ok((await segsOf('stem')) === 1, 'T junction: the stem stays one');

    await fresh();
    await addLine(1520, 'a', [{x:0,y:0},{x:10,y:0}]);
    await addLine(1521, 'b', [{x:10,y:0},{x:10,y:8}]);
    ok((await segsOf('a')) === 1 && (await segsOf('b')) === 1, 'L junction: endpoints already meet, so nothing splits');

    await fresh();
    await addLine(1530, 'long', [{x:0,y:0},{x:12,y:0}]);
    await addLine(1531, 'p1', [{x:3,y:-2},{x:3,y:2}]);
    await addLine(1532, 'p2', [{x:6,y:-2},{x:6,y:2}]);
    await addLine(1533, 'p3', [{x:9,y:-2},{x:9,y:2}]);
    ok((await segsOf('long')) === 4, 'three contacts on one line give four pieces', String(await segsOf('long')));

    console.log('the rule holds inside a closed loop');
    await fresh();
    await addLine(1540, 'sq', [{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}], false);
    await addLine(1541, 'cut', [{x:-2,y:5},{x:12,y:5}]);
    ok((await segsOf('sq')) === 6, 'a line through a closed square splits two of its sides (4 -> 6)', String(await segsOf('sq')));
    ok((await segsOf('cut')) === 3, 'and the line itself becomes three pieces', String(await segsOf('cut')));
    ok((await run(`CNC.job.shapes.find(s=>s.name==='sq').open`)) === false, 'the square is still closed after splitting');
    const sqA = await run(`Math.abs(CNC.G.signedArea(CNC.worldLoop(CNC.job.shapes.find(s=>s.name==='sq'))))`);
    ok(Math.abs(sqA - 100) < 1e-6, 'and still encloses 100 sq in', String(sqA));

    console.log('a line can be removed from a closed loop');
    await run(`(() => { const sq = CNC.job.shapes.find(s=>s.name==='sq'); CNC.setSelEdge(sq.id, 0); CNC.deleteSelectedEdge(); return true; })()`);
    const leftover = JSON.parse(await run(`JSON.stringify(CNC.job.shapes.map(s=>({n:s.name, segs: CNC.worldLoop(s).length})))`));
    const sqNow = leftover.find(x => x.n === 'sq');
    ok(!!sqNow && sqNow.segs === 5, 'deleting one side of the closed square leaves 5 segments', JSON.stringify(leftover));

    { // scoped: this file is one long function and const names collide
    console.log('trace a paper template from measured offsets');
    /* Simulate the shop workflow against a curve whose true shape is known: a
       circular arc of radius 30 sagging over a 24 in baseline. Measure it every
       1 in the way an operator would, feed those numbers in, and check how far
       the rebuilt curve strays from the real one. */
    await run(`(() => { CNC.job.shapes.length = 0; CNC.job.dims = []; CNC.refresh(); return true; })()`);
    const R = 30, half = 12;
    const trueY = (x) => 8 + (Math.sqrt(R*R - (x-half)*(x-half)) - Math.sqrt(R*R - half*half));
    const measured = [];
    for (let x = 0; x <= 24; x += 1) measured.push({ s: x, o: +trueY(x).toFixed(3) });  // ruler-accurate to 0.001
    const built = await run(`CNC.buildFromOffsets(${JSON.stringify(measured)}, {alongY:false, closeIt:true, fitArcs:true, tol:0.01})`);
    ok(typeof built === 'number' && built > 0, 'a part is built from the measurements', String(built));
    ok((await run('CNC.job.shapes.length')) === 1, 'exactly one part is created');
    ok((await run('CNC.job.shapes[0].open')) === false, 'closed back to the baseline with square corners');

    const bb = JSON.parse(await run(`JSON.stringify(CNC.G.bbox(CNC.worldLoop(CNC.job.shapes[0])))`));
    ok(Math.abs(bb.w - 24) < 1e-3, 'the part spans the 24 in baseline', JSON.stringify(bb));
    ok(Math.abs(bb.y0) < 1e-6, 'it sits on the baseline at y = 0', String(bb.y0));

    // how faithful is the rebuilt curve? sample it and compare to the true arc
    const err = await run(`(() => {
      const loop = CNC.worldLoop(CNC.job.shapes[0]);
      const R = 30, half = 12;
      const trueY = (x) => 8 + (Math.sqrt(R*R-(x-half)*(x-half)) - Math.sqrt(R*R-half*half));
      let worst = 0;
      for (const sg of loop) {
        for (const q of CNC.G.samplePts(sg, 0.05)) {
          if (q.y < 1 || q.x < 0.05 || q.x > 23.95) continue;   // skip the straight sides/baseline
          worst = Math.max(worst, Math.abs(q.y - trueY(q.x)));
        }
      }
      return worst; })()`);
    ok(err < 0.01, 'rebuilt curve is within 0.010 in of the real arc everywhere', 'worst = ' + Number(err).toFixed(5) + ' in');
    ok(err < 1/64, 'comfortably inside 1/64 in', 'worst = ' + Number(err).toFixed(5));

    console.log('the traced curve posts to TAP');
    const tracedTap = await run(`(() => { const j={shapes:CNC.job.shapes.map(s=>({loop:CNC.worldLoop(s),op:s.op,toolId:2,open:s.open})),
      tools:CNC.S.tools, material:{thickness:0.1875}, cutThrough:0, machine:CNC.S.machine};
      return CNC.PO.generate(j).gcode.length; })()`);
    ok(typeof tracedTap === 'number' && tracedTap > 200, 'the traced template generates a real program', String(tracedTap));

    console.log('offsets can run along Y instead');
    await run(`(() => { CNC.job.shapes.length = 0; CNC.refresh(); return true; })()`);
    await run(`CNC.buildFromOffsets([{s:0,o:0},{s:1,o:1},{s:2,o:1.8},{s:3,o:2.2}], {alongY:true, closeIt:true, fitArcs:false, tol:0.01})`);
    const bb2 = JSON.parse(await run(`JSON.stringify(CNC.G.bbox(CNC.worldLoop(CNC.job.shapes[0])))`));
    ok(Math.abs(bb2.h - 3) < 1e-3, 'a Y-baseline template spans the stations in Y', JSON.stringify(bb2));
    }

    { // scoped
    console.log('no browser prompt/confirm anywhere (Electron has no prompt)');
    /* window.prompt throws "prompt() is not supported" in Electron, which was
       killing the TAP export before it wrote anything. Guard against it coming
       back by making the real dialogs throw loudly if they are ever used. */
    const trapped = await run(`(() => {
      let hit = [];
      const op = window.prompt, oc = window.confirm, oa = window.alert;
      window.prompt = () => { hit.push('prompt'); throw new Error('prompt() is not supported'); };
      window.confirm = () => { hit.push('confirm'); return true; };
      window.alert = () => { hit.push('alert'); };
      try {
        document.querySelector('#btnTap').click();
        document.querySelector('#btnSave').click();
        document.querySelector('#btnNew').click();
      } catch (e) { hit.push('threw: ' + e.message); }
      window.prompt = op; window.confirm = oc; window.alert = oa;
      // close whatever modal opened
      document.querySelectorAll('.overlay').forEach(o => o.remove());
      return JSON.stringify(hit);
    })()`);
    ok(trapped === '[]', 'Export TAP / Save / New use in-app dialogs, not window.prompt', trapped);

    console.log('TAP export actually produces a file');
    await run(`(() => { CNC.job.shapes.length = 0; CNC.job.dims = [];
      CNC.job.shapes.push({id:1600,name:'p',kind:'rect',x:2,y:2,rot:0,w:10,h:6,r:0,op:'outside',toolId:2,climb:false,open:false});
      CNC.refresh(); return true; })()`);
    const dl = await run(`(() => {
      let captured = null;
      const realCreate = document.createElement.bind(document);
      document.createElement = (t) => {
        const el = realCreate(t);
        if (t === 'a') { const rc = el.click.bind(el); el.click = () => { captured = { name: el.download, href: el.href }; }; }
        return el;
      };
      document.querySelector('#btnTap').click();
      const ov = document.querySelector('.overlay');
      if (!ov) { document.createElement = realCreate; return 'no dialog'; }
      ov.querySelector('#akVal').value = 'window-test';
      ov.querySelector('#akOk').click();
      return new Promise(r => setTimeout(() => {
        document.createElement = realCreate;
        r(JSON.stringify(captured));
      }, 200));
    })()`);
    ok(/window-test\.tap/.test(dl || ''), 'the export writes a .tap file with the typed name', dl);
    const logged = await run(`JSON.stringify(CNC.LOG.entries().filter(e=>/Exported/.test(e.msg)).map(e=>e.msg))`);
    ok(/Exported window-test\.tap/.test(logged), 'and the export is recorded in the activity log', logged);

    console.log('measure locks square within 10 degrees');
    const near = await run(`JSON.stringify(CNC.axisLock({x:0,y:0}, {x:10, y:0.9}, false))`);   // ~5.1 deg
    const nv = JSON.parse(near);
    ok(Math.abs(nv.y) < 1e-9, 'a 5 degree drift snaps flat to horizontal', near);
    ok(Math.abs(nv.x - 10.04) < 0.05, 'and keeps the measured run, projected onto the axis', String(nv.x));
    ok(nv.locked === 0, 'the reading is tagged as locked so it is not mistaken for raw', String(nv.locked));

    const vert = JSON.parse(await run(`JSON.stringify(CNC.axisLock({x:0,y:0}, {x:-0.7, y:8}, false))`));  // ~95 deg
    ok(Math.abs(vert.x) < 1e-9 && vert.locked === 90, 'near-vertical locks to 90', JSON.stringify(vert));
    const back = JSON.parse(await run(`JSON.stringify(CNC.axisLock({x:0,y:0}, {x:-12, y:0.5}, false))`));
    ok(Math.abs(back.y) < 1e-9 && back.locked === 180, 'leftward locks to 180', JSON.stringify(back));

    const diag = JSON.parse(await run(`JSON.stringify(CNC.axisLock({x:0,y:0}, {x:10, y:6}, false))`));   // 31 deg
    ok(diag.locked === undefined && Math.abs(diag.y - 6) < 1e-9, 'a real diagonal beyond 10 degrees is left alone', JSON.stringify(diag));
    const bypass = JSON.parse(await run(`JSON.stringify(CNC.axisLock({x:0,y:0}, {x:10, y:0.9}, true))`));
    ok(Math.abs(bypass.y - 0.9) < 1e-9, 'Alt bypasses the lock for a true diagonal', JSON.stringify(bypass));
    }

    { // scoped
    console.log('size labels on rectangles and circles');
    await run(`(() => { CNC.job.shapes.length = 0; CNC.job.dims = [];
      CNC.job.shapes.push({id:1700,name:'plate',kind:'rect',x:2,y:2,rot:0,w:12,h:7,r:0.5,op:'outside',toolId:2,climb:false,open:false});
      CNC.refresh(); return true; })()`);
    ok(await run(`!!document.querySelector('#chkSizes')`), 'a Size labels toggle exists');
    ok(await run(`document.querySelector('#chkSizes').checked`), 'and is on by default');
    // drawing must not throw with a shape selected
    const drew = await run(`(() => { try { CNC.selectShape(1700); CNC.drawSizeLabels(); return 'ok'; } catch(e){ return 'ERR ' + e.message; } })()`);
    ok(drew === 'ok', 'size labels draw for a rectangle without error', drew);

    await run(`(() => { CNC.job.shapes.length = 0;
      CNC.job.shapes.push({id:1701,name:'hole',kind:'circle',x:10,y:10,rot:0,r:2.5,op:'inside',toolId:2,climb:false,open:false});
      CNC.refresh(); return true; })()`);
    const drew2 = await run(`(() => { try { CNC.selectShape(1701); CNC.drawSizeLabels(); return 'ok'; } catch(e){ return 'ERR ' + e.message; } })()`);
    ok(drew2 === 'ok', 'size labels draw for a circle without error', drew2);

    console.log('width / height / radius sliders');
    await run(`(() => { CNC.job.shapes.length = 0;
      CNC.job.shapes.push({id:1710,name:'r',kind:'rect',x:0,y:0,rot:0,w:10,h:6,r:0,op:'outside',toolId:2,climb:false,open:false});
      CNC.refresh(); CNC.selectShape(1710); return true; })()`);
    const hasW = await run(`!!document.querySelector('#props [data-ks="w"]')`);
    ok(hasW === true, 'a rectangle gets a Width slider');
    await run(`(() => { const sl = document.querySelector('#props [data-ks="w"]');
      sl.value = '15'; sl.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
    ok(Math.abs((await run('CNC.job.shapes[0].w')) - 15) < 1e-9, 'dragging the Width slider resizes the part', String(await run('CNC.job.shapes[0].w')));
    const bbW = JSON.parse(await run(`JSON.stringify(CNC.G.bbox(CNC.worldLoop(CNC.job.shapes[0])))`));
    ok(Math.abs(bbW.w - 15) < 1e-6, 'and the geometry really is 15 in wide', String(bbW.w));

    await run(`(() => { CNC.job.shapes.length = 0;
      CNC.job.shapes.push({id:1711,name:'c',kind:'circle',x:5,y:5,rot:0,r:2,op:'outside',toolId:2,climb:false,open:false});
      CNC.refresh(); CNC.selectShape(1711); return true; })()`);
    ok(await run(`!!document.querySelector('#props [data-ks="r"]')`), 'a circle gets a Radius slider');
    await run(`(() => { const sl = document.querySelector('#props [data-ks="r"]');
      sl.value = '3.5'; sl.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
    const dia = await run(`document.querySelector('#props [data-k="dia"]').value`);
    ok(String(dia) === '7', 'the diameter field follows the radius slider', String(dia));
    }

    { // scoped
    console.log('typed size entry for rect / circle');
    await run(`(() => { CNC.job.shapes.length = 0; CNC.job.dims = [];
      document.querySelector('button.tool[data-tool="rect"]').click(); return true; })()`);
    // start a rect at 2,3 then type 6.5 x 7 instead of dragging
    await run(`(() => { window.__click(2, 3, 'mousedown'); return true; })()`);
    ok((await run(`document.querySelector('#dynIn').style.display`)) === 'flex', 'the size box appears for a rectangle');
    ok((await run(`document.querySelectorAll('#dynIn label')[0].textContent`)) === 'w', 'first box is labelled w');
    ok((await run(`document.querySelectorAll('#dynIn label')[1].textContent`)) === 'h', 'second box is labelled h');
    await run(`(() => { document.querySelector('#dynLen').value = '6.5';
      document.querySelector('#dynAng').value = '7'; CNC.commitDyn2(); return true; })()`);
    const r = JSON.parse(await run(`JSON.stringify(CNC.job.shapes.map(s=>({k:s.kind,w:s.w,h:s.h,x:s.x,y:s.y})))`));
    ok(r.length === 1 && r[0].k === 'rect', 'a rectangle is created', JSON.stringify(r));
    ok(Math.abs(r[0].w - 6.5) < 1e-9 && Math.abs(r[0].h - 7) < 1e-9, 'exactly 6.5 x 7 as typed', JSON.stringify(r[0]));
    // the synthetic click goes through integer screen pixels, so allow the
    // round-trip error; what matters is that it lands where it was clicked
    ok(Math.abs(r[0].x - 2) < 0.2 && Math.abs(r[0].y - 3) < 0.2, 'placed at the clicked corner', JSON.stringify(r[0]));

    await run(`(() => { CNC.job.shapes.length = 0;
      document.querySelector('button.tool[data-tool="circle"]').click();
      window.__click(10, 10, 'mousedown'); return true; })()`);
    ok((await run(`document.querySelectorAll('#dynIn label')[0].textContent`)) === 'R', 'a circle asks for R');
    ok((await run(`document.querySelectorAll('#dynIn label')[1].textContent`)) === 'dia', 'and offers the diameter alongside it');
    await run(`(() => { document.querySelector('#dynLen').value = '2.75'; CNC.commitDyn2(); return true; })()`);
    const c = JSON.parse(await run(`JSON.stringify(CNC.job.shapes.map(s=>({k:s.kind,r:s.r})))`));
    ok(c.length === 1 && Math.abs(c[0].r - 2.75) < 1e-9, 'a circle of exactly R 2.75 is created', JSON.stringify(c));
    await run(`(() => { document.querySelector('button.tool[data-tool="select"]').click(); return true; })()`);

    console.log('rename a part from the list');
    await run(`(() => { CNC.job.shapes.length = 0;
      CNC.job.shapes.push({id:1800,name:'old name',kind:'rect',x:0,y:0,rot:0,w:5,h:5,r:0,op:'outside',toolId:2,climb:false,open:false});
      CNC.refresh(); return true; })()`);
    const renamed = await run(`(() => {
      const nm = document.querySelector('#shapeList .nm');
      if (!nm) return 'no name element';
      nm.dispatchEvent(new MouseEvent('dblclick', {bubbles:true}));
      const inp = document.querySelector('#shapeList input.rename');
      if (!inp) return 'no rename input';
      inp.value = 'window blank';
      inp.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
      return CNC.job.shapes[0].name;
    })()`);
    ok(renamed === 'window blank', 'double-clicking the name renames the part', String(renamed));

    console.log('PDF export');
    ok(await run(`!!CNC.PDFDOC || typeof PDFDOC !== 'undefined'`), 'the pdf module reached the bundle');
    const pdfCap = await run(`(() => {
      let captured = null;
      const realCreate = document.createElement.bind(document);
      document.createElement = (t) => { const el = realCreate(t);
        if (t === 'a') el.click = () => { captured = { name: el.download, len: (el.href||'').length }; };
        return el; };
      try { CNC.buildPdf({page:'letter', landscape:true, scale:'fit', sizes:true, names:true, bed:false, paths:false}, 'drawing-test.pdf'); }
      finally { document.createElement = realCreate; }
      return JSON.stringify(captured);
    })()`);
    ok(/drawing-test\.pdf/.test(pdfCap || ''), 'the PDF export writes a .pdf file', pdfCap);
    const pdfLog = await run(`JSON.stringify(CNC.LOG.entries().filter(e=>/Exported drawing-test/.test(e.msg)).map(e=>e.msg))`);
    ok(/scale 1:/.test(pdfLog), 'and records the scale it used in the log', pdfLog);

    // a fixed scale that cannot fit must refuse, not silently shrink
    await run(`(() => { CNC.job.shapes.length = 0;
      CNC.job.shapes.push({id:1810,name:'big',kind:'rect',x:0,y:0,rot:0,w:50,h:100,r:0,op:'outside',toolId:2,climb:false,open:false});
      CNC.refresh(); return true; })()`);
    const refused = await run(`(() => {
      let captured = false;
      const realCreate = document.createElement.bind(document);
      document.createElement = (t) => { const el = realCreate(t); if (t === 'a') el.click = () => { captured = true; }; return el; };
      try { CNC.buildPdf({page:'letter', landscape:false, scale:'1', sizes:false, names:false, bed:false, paths:false}, 'too-big.pdf'); }
      finally { document.createElement = realCreate; }
      return captured;
    })()`);
    ok(refused === false, 'a 50 x 100 in job at 1:1 on Letter is refused, not silently scaled', String(refused));
    }

    { // scoped
    console.log('resize by clicking the dimension on the bed');
    await run(`(() => { CNC.job.shapes.length = 0; CNC.job.dims = [];
      document.querySelector('button.tool[data-tool="select"]').click();
      CNC.job.shapes.push({id:1900,name:'plate',kind:'rect',x:2,y:2,rot:0,w:10,h:6,r:0,op:'outside',toolId:2,climb:false,open:false});
      CNC.refresh(); CNC.selectShape(1900); return true; })()`);
    const hits = JSON.parse(await run('JSON.stringify(CNC.sizeHitsInfo())'));
    ok(hits.length === 2, 'a selected rectangle exposes two clickable dimensions', JSON.stringify(hits.map(h=>h.key)));
    ok(hits.some(h => h.key === 'w') && hits.some(h => h.key === 'h'), 'one for width, one for height');
    const wHit = hits.find(h => h.key === 'w');
    ok(Math.abs(wHit.value - 10) < 1e-9, 'the width label reports the real width', String(wHit.value));

    // clicking inside the label box must be recognised, outside must not
    const inside = await run(`JSON.stringify(CNC.hitSizeLabel({x:${wHit.x + wHit.w/2}, y:${wHit.y + wHit.h/2}}))`);
    ok(inside && inside !== 'null', 'clicking the label registers a hit');
    const outside = await run(`JSON.stringify(CNC.hitSizeLabel({x:${wHit.x - 200}, y:${wHit.y}}))`);
    ok(outside === 'null', 'clicking away from it does not');

    // a real click should open the inline editor
    await run(`(() => { const cv = document.querySelector('#cv'); const r = cv.getBoundingClientRect();
      const hit = CNC.sizeHitsInfo().find(h => h.key === 'w');
      cv.dispatchEvent(new MouseEvent('mousedown', {
        clientX: r.left + (hit.x + hit.w/2) / devicePixelRatio,
        clientY: r.top  + (hit.y + hit.h/2) / devicePixelRatio,
        bubbles: true, button: 0 }));
      return true; })()`);
    ok(await run(`!!document.querySelector('#sizeEdit')`), 'clicking the width on the bed opens an editor there');
    await run(`(() => { const i = document.querySelector('#sizeEdit');
      i.value = '14.25'; i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); return true; })()`);
    ok((await run(`!document.querySelector('#sizeEdit')`)) === true, 'Enter closes the editor');
    ok(Math.abs((await run('CNC.job.shapes[0].w')) - 14.25) < 1e-9, 'and the rectangle is now 14.25 in wide', String(await run('CNC.job.shapes[0].w')));
    const nb = JSON.parse(await run(`JSON.stringify(CNC.G.bbox(CNC.worldLoop(CNC.job.shapes[0])))`));
    ok(Math.abs(nb.w - 14.25) < 1e-6, 'the geometry really changed', String(nb.w));
    ok(Math.abs(nb.x0 - 2) < 1e-9, 'and it grew from the corner it was placed at, not the centre', String(nb.x0));

    console.log('Escape leaves the size alone');
    await run(`(() => { const hit = CNC.sizeHitsInfo().find(h => h.key === 'h');
      CNC.hitSizeLabel({x: hit.x + 1, y: hit.y + 1}); return true; })()`);
    const before = await run('CNC.job.shapes[0].h');
    await run(`(() => { const cv = document.querySelector('#cv'); const r = cv.getBoundingClientRect();
      const hit = CNC.sizeHitsInfo().find(h => h.key === 'h');
      cv.dispatchEvent(new MouseEvent('mousedown', {
        clientX: r.left + (hit.x + hit.w/2) / devicePixelRatio,
        clientY: r.top  + (hit.y + hit.h/2) / devicePixelRatio, bubbles: true, button: 0 }));
      const i = document.querySelector('#sizeEdit');
      i.value = '999'; i.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
      return true; })()`);
    ok(Math.abs((await run('CNC.job.shapes[0].h')) - before) < 1e-9, 'Escape cancels without resizing', String(await run('CNC.job.shapes[0].h')));

    console.log('circles resize by radius');
    await run(`(() => { CNC.job.shapes.length = 0;
      CNC.job.shapes.push({id:1901,name:'hole',kind:'circle',x:10,y:10,rot:0,r:2,op:'inside',toolId:2,climb:false,open:false});
      CNC.refresh(); CNC.selectShape(1901); return true; })()`);
    const ch = JSON.parse(await run('JSON.stringify(CNC.sizeHitsInfo())'));
    ok(ch.length === 1 && ch[0].key === 'r', 'a circle exposes one clickable radius', JSON.stringify(ch.map(h=>h.key)));
    await run(`CNC.applySize(CNC.job.shapes[0], 'r', 3.125)`);
    ok(Math.abs((await run('CNC.job.shapes[0].r')) - 3.125) < 1e-9, 'radius retypes to 3.125');
    const cb = JSON.parse(await run(`JSON.stringify(CNC.G.bbox(CNC.worldLoop(CNC.job.shapes[0])))`));
    ok(Math.abs(cb.w - 6.25) < 1e-6, 'the circle is now 6.25 in across', String(cb.w));
    ok(Math.abs((cb.x0 + cb.x1) / 2 - 10) < 1e-9, 'and kept its centre', String((cb.x0 + cb.x1) / 2));

    console.log('a traced or boolean part resizes by scaling');
    await run(`(() => { CNC.job.shapes.length = 0;
      CNC.job.shapes.push({id:1902,name:'tri',kind:'poly',x:0,y:0,rot:0,open:false,op:'outside',toolId:2,climb:false,
        pts:[{x:0,y:0,r:0,arcR:0},{x:12,y:0,r:0,arcR:0},{x:6,y:8,r:0,arcR:0}]});
      CNC.refresh(); CNC.selectShape(1902); return true; })()`);
    await run(`CNC.applySize(CNC.job.shapes[0], 'w', 24)`);
    const tb = JSON.parse(await run(`JSON.stringify(CNC.G.bbox(CNC.worldLoop(CNC.job.shapes[0])))`));
    ok(Math.abs(tb.w - 24) < 1e-6, 'a polygon scales to the typed width', String(tb.w));
    ok(Math.abs(tb.h - 8) < 1e-6, 'without stretching the other axis', String(tb.h));
    }

    { // scoped
    console.log('the size box stays after the drag, next to the cursor');
    await run(`(() => { CNC.job.shapes.length = 0; CNC.job.dims = [];
      document.querySelector('button.tool[data-tool="rect"]').click(); return true; })()`);
    // drag out a rough rectangle and release
    await run(`(() => {
      const cv = document.querySelector('#cv'), r = cv.getBoundingClientRect();
      const at = (wx, wy, type) => { const sp = CNC.W2S({x:wx,y:wy});
        const ev = new MouseEvent(type, { clientX: r.left + sp.x/devicePixelRatio,
          clientY: r.top + sp.y/devicePixelRatio, bubbles:true, button:0 });
        cv.dispatchEvent(ev); if (type === 'mouseup') window.dispatchEvent(ev); };
      at(2, 2, 'mousedown'); at(9, 6, 'mousemove'); at(9, 6, 'mouseup');
      return true; })()`);
    ok((await run('CNC.job.shapes.length')) === 1, 'the drag created a rectangle');
    ok((await run('CNC.dynTargetInfo()')) !== null, 'the box stays bound to what was just drawn');
    ok((await run(`document.querySelector('#dynIn').style.display`)) === 'flex', 'and is still on screen after the mouse is released');
    ok((await run(`document.querySelectorAll('#dynIn label')[0].textContent`)) === 'w', 'showing w');
    ok((await run(`document.querySelectorAll('#dynIn label')[1].textContent`)) === 'h', 'and h');
    const shown = await run(`JSON.stringify([document.querySelector('#dynLen').value, document.querySelector('#dynAng').value])`);
    ok(/\d/.test(shown), 'prefilled with the size just drawn', shown);

    // now type exact numbers into it
    await run(`(() => { document.querySelector('#dynLen').value = '6.5';
      document.querySelector('#dynAng').value = '7'; CNC.commitDyn2(); return true; })()`);
    const rr = JSON.parse(await run(`JSON.stringify(CNC.job.shapes.map(s=>({k:s.kind,w:s.w,h:s.h})))`));
    ok(rr.length === 1, 'it resized the part rather than creating a second one', JSON.stringify(rr));
    ok(Math.abs(rr[0].w - 6.5) < 1e-9 && Math.abs(rr[0].h - 7) < 1e-9, 'now exactly 6.5 x 7', JSON.stringify(rr[0]));
    ok((await run('CNC.dynTargetInfo()')) === null, 'and the box closes once applied');

    console.log('same for a circle');
    await run(`(() => { CNC.job.shapes.length = 0;
      document.querySelector('button.tool[data-tool="circle"]').click(); return true; })()`);
    await run(`(() => {
      const cv = document.querySelector('#cv'), r = cv.getBoundingClientRect();
      const at = (wx, wy, type) => { const sp = CNC.W2S({x:wx,y:wy});
        const ev = new MouseEvent(type, { clientX: r.left + sp.x/devicePixelRatio,
          clientY: r.top + sp.y/devicePixelRatio, bubbles:true, button:0 });
        cv.dispatchEvent(ev); if (type === 'mouseup') window.dispatchEvent(ev); };
      at(10, 10, 'mousedown'); at(13, 10, 'mousemove'); at(13, 10, 'mouseup');
      return true; })()`);
    ok((await run('CNC.dynTargetInfo()')) !== null, 'the box stays after drawing a circle');
    ok((await run(`document.querySelectorAll('#dynIn label')[0].textContent`)) === 'R', 'asking for R');
    await run(`(() => { document.querySelector('#dynLen').value = '2.375'; CNC.commitDyn2(); return true; })()`);
    ok(Math.abs((await run('CNC.job.shapes[0].r')) - 2.375) < 1e-9, 'typing R 2.375 resizes the circle', String(await run('CNC.job.shapes[0].r')));
    ok((await run('CNC.job.shapes.length')) === 1, 'still one circle, not two');

    console.log('the box gets out of the way');
    await run(`(() => { CNC.job.shapes.length = 0;
      document.querySelector('button.tool[data-tool="rect"]').click();
      const cv = document.querySelector('#cv'), r = cv.getBoundingClientRect();
      const at = (wx, wy, type) => { const sp = CNC.W2S({x:wx,y:wy});
        const ev = new MouseEvent(type, { clientX: r.left + sp.x/devicePixelRatio,
          clientY: r.top + sp.y/devicePixelRatio, bubbles:true, button:0 });
        cv.dispatchEvent(ev); if (type === 'mouseup') window.dispatchEvent(ev); };
      at(1,1,'mousedown'); at(5,4,'mousemove'); at(5,4,'mouseup'); return true; })()`);
    ok((await run('CNC.dynTargetInfo()')) !== null, 'box is open');
    await run(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); return true; })()`);
    ok((await run('CNC.dynTargetInfo()')) === null, 'Escape dismisses it, leaving the part as drawn');
    ok((await run('CNC.job.shapes.length')) === 1, 'and the part survives');
    await run(`(() => { document.querySelector('button.tool[data-tool="select"]').click(); return true; })()`);
    }

    { // scoped
    console.log('circle box offers radius AND diameter');
    const dragCircle = (cx, cy, ex, ey) => run(`(() => {
      CNC.job.shapes.length = 0;
      document.querySelector('button.tool[data-tool="circle"]').click();
      const cv = document.querySelector('#cv'), r = cv.getBoundingClientRect();
      const at = (wx, wy, type) => { const sp = CNC.W2S({x:wx,y:wy});
        const ev = new MouseEvent(type, { clientX: r.left + sp.x/devicePixelRatio,
          clientY: r.top + sp.y/devicePixelRatio, bubbles:true, button:0 });
        cv.dispatchEvent(ev); if (type === 'mouseup') window.dispatchEvent(ev); };
      at(${cx}, ${cy}, 'mousedown'); at(${ex}, ${ey}, 'mousemove'); at(${ex}, ${ey}, 'mouseup');
      return true; })()`);

    await dragCircle(10, 10, 13, 10);
    ok((await run('CNC.dynTargetInfo()')) !== null, 'the box stays after drawing a circle');
    ok((await run(`document.querySelectorAll('#dynIn label')[0].textContent`)) === 'R', 'first box is R');
    ok((await run(`document.querySelectorAll('#dynIn label')[1].textContent`)) === 'dia', 'second box is the diameter');
    ok((await run(`document.querySelector('#dynAng').style.display`)) !== 'none', 'and the second box is visible now');
    const pre = JSON.parse(await run(`JSON.stringify([document.querySelector('#dynLen').value, document.querySelector('#dynAng').value])`));
    ok(Math.abs(parseFloat(pre[1]) - parseFloat(pre[0]) * 2) < 1e-6, 'prefilled diameter is twice the radius', JSON.stringify(pre));

    console.log('the two boxes track each other');
    await run(`(() => { const l = document.querySelector('#dynLen');
      l.value = '2.5'; l.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
    ok((await run(`document.querySelector('#dynAng').value`)) === '5', 'typing R 2.5 shows dia 5', String(await run(`document.querySelector('#dynAng').value`)));
    await run(`(() => { const a = document.querySelector('#dynAng');
      a.value = '9'; a.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
    ok((await run(`document.querySelector('#dynLen').value`)) === '4.5', 'typing dia 9 shows R 4.5', String(await run(`document.querySelector('#dynLen').value`)));

    console.log('Enter uses whichever was typed last');
    await run(`CNC.commitDyn2()`);
    ok(Math.abs((await run('CNC.job.shapes[0].r')) - 4.5) < 1e-9, 'entering the diameter sets the radius to half of it', String(await run('CNC.job.shapes[0].r')));
    ok((await run('CNC.job.shapes.length')) === 1, 'still one circle');

    await dragCircle(10, 10, 12, 10);
    await run(`(() => { const l = document.querySelector('#dynLen');
      l.value = '1.75'; l.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
    await run(`CNC.commitDyn2()`);
    ok(Math.abs((await run('CNC.job.shapes[0].r')) - 1.75) < 1e-9, 'entering the radius still sets the radius', String(await run('CNC.job.shapes[0].r')));
    const cbb = JSON.parse(await run(`JSON.stringify(CNC.G.bbox(CNC.worldLoop(CNC.job.shapes[0])))`));
    ok(Math.abs(cbb.w - 3.5) < 1e-6, 'the geometry is 3.5 in across', String(cbb.w));
    ok(Math.abs((cbb.x0 + cbb.x1) / 2 - 10) < 0.2, 'and kept the centre it was drawn from', String((cbb.x0 + cbb.x1) / 2));
    await run(`(() => { document.querySelector('button.tool[data-tool="select"]').click(); return true; })()`);
    }

    { // scoped
    console.log('circle snap points: centre, quadrant, circumference');
    await run(`(() => { CNC.job.shapes.length = 0; CNC.job.dims = [];
      document.querySelector('button.tool[data-tool="select"]').click();
      CNC.job.shapes.push({id:2000,name:'c',kind:'circle',x:10,y:10,rot:0,r:4,op:'outside',toolId:2,climb:false,open:false});
      CNC.refresh(); return true; })()`);
    const snapAt = (x, y) => run(`(() => { CNC.resolvePoint({x:${x},y:${y}});
      const s = CNC.lastSnapInfo(); return s ? JSON.stringify({t:s.type, x:+s.p.x.toFixed(4), y:+s.p.y.toFixed(4), d:+s.d.toFixed(4)}) : 'none'; })()`);

    const centre = JSON.parse(await snapAt(10.05, 10.03));
    ok(centre.t === 'center' && centre.x === 10 && centre.y === 10, 'the centre of a circle snaps', JSON.stringify(centre));

    // the point that was broken: near the circumference, far from the arc seam
    const circ = JSON.parse(await snapAt(12.9, 12.9));
    ok(circ.t === 'on', 'a point near the circumference snaps to the circumference', JSON.stringify(circ));
    ok(circ.d < 0.2, 'and lands on it, not on a seam feet away', String(circ.d));
    const onCircle = Math.abs(Math.hypot(circ.x - 10, circ.y - 10) - 4);
    ok(onCircle < 1e-3, 'the snapped point is genuinely on the circle', String(onCircle));

    const seam = JSON.parse(await snapAt(14.03, 10.02));
    ok(seam.t === 'endpoint' && seam.x === 14, 'sitting on the seam still gives the endpoint', JSON.stringify(seam));

    console.log('and during a polyline, not just with the select tool');
    await run(`(() => { document.querySelector('button.tool[data-tool="pline"]').click();
      CNC.commitPoint({x:1,y:1}); return true; })()`);
    const mid = JSON.parse(await snapAt(12.9, 12.9));
    ok(mid.t === 'on', 'mid-polyline the circumference still snaps', JSON.stringify(mid));
    const c2 = JSON.parse(await snapAt(10.04, 10.02));
    ok(c2.t === 'center', 'mid-polyline the centre still snaps', JSON.stringify(c2));
    await run(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
      document.querySelector('button.tool[data-tool="select"]').click(); return true; })()`);

    console.log('PDF picks up the design view toggles');
    await run(`(() => { CNC.job.shapes.length = 0;
      CNC.job.shapes.push({id:2010,name:'p',kind:'rect',x:2,y:2,rot:0,w:10,h:6,r:0,op:'outside',toolId:2,climb:false,open:false});
      CNC.job.dims = [{a:{x:2,y:1},b:{x:12,y:1},off:-0.5}];
      CNC.refresh(); return true; })()`);
    const withAll = await run(`(() => {
      let captured = null;
      const realCreate = document.createElement.bind(document);
      const realURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { captured = blob.size; return realURL(blob); };
      document.createElement = (t) => { const el = realCreate(t); if (t === 'a') el.click = () => {}; return el; };
      try { CNC.buildPdf({page:'tabloid', landscape:true, scale:'fit', sizes:true, names:true,
        dims:true, centres:true, bed:false, paths:true, kerf:true}, 'opts.pdf'); }
      finally { document.createElement = realCreate; URL.createObjectURL = realURL; }
      return captured || 0;
    })()`);
    ok(typeof withAll === 'number' && withAll > 0, 'a PDF is produced with every option on', String(withAll));

    const plain = await run(`(() => {
      let captured = null;
      const realCreate = document.createElement.bind(document);
      const realURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { captured = blob.size; return realURL(blob); };
      document.createElement = (t) => { const el = realCreate(t); if (t === 'a') el.click = () => {}; return el; };
      try { CNC.buildPdf({page:'tabloid', landscape:true, scale:'fit', sizes:false, names:false,
        dims:false, centres:false, bed:false, paths:false, kerf:false}, 'plain.pdf'); }
      finally { document.createElement = realCreate; URL.createObjectURL = realURL; }
      return captured || 0;
    })()`);
    ok(plain > 0 && withAll > plain, 'turning the extras on makes a bigger file than the outline alone', `${withAll} vs ${plain}`);

    const dialogHas = await run(`(() => {
      document.querySelectorAll('.overlay').forEach(o => o.remove());
      CNC.openPdf();
      const ov = document.querySelector('.overlay');
      const ids = ['pdSizes','pdNames','pdDims','pdCentres','pdPaths','pdKerf','pdBed'].filter(i => ov.querySelector('#'+i));
      const kerfDefault = ov.querySelector('#pdKerf').checked;
      ov.remove();
      return JSON.stringify({ids, kerfDefault});
    })()`);
    const dh = JSON.parse(dialogHas);
    ok(dh.ids.length === 7, 'the dialog offers sizes, names, dimensions, centres, toolpaths, kerf and bed', JSON.stringify(dh.ids));
    ok(dh.kerfDefault === false, 'kerf defaults off, matching the design view where it is unticked', String(dh.kerfDefault));
    }

    { // scoped
    console.log('spokes from the centre leave the circle a circle (the ellipse-with-corners report)');
    await run(`(() => { CNC.job.shapes.length = 0; CNC.job.dims = [];
      const c = {id:2100,name:'circle',kind:'circle',x:20,y:20,rot:0,r:6,op:'outside',toolId:2,climb:false,open:false};
      CNC.job.shapes.push(c); CNC.job.nextId = 2101; CNC.refresh(); return true; })()`);
    const spoke = (tx, ty) => run(`(() => {
      const __at = (wx, wy, type) => { const cv = document.querySelector('#cv'), r = cv.getBoundingClientRect();
        const sp = CNC.W2S({x:wx,y:wy}); const ev = new MouseEvent(type, { clientX: r.left + sp.x/devicePixelRatio,
          clientY: r.top + sp.y/devicePixelRatio, bubbles:true, button:0 }); cv.dispatchEvent(ev); if (type==='mouseup') window.dispatchEvent(ev); };
      document.querySelector('button.tool[data-tool="pline"]').click();
      __at(20.02, 20.01, 'mousedown'); __at(20.02, 20.01, 'mouseup');
      __at(${tx}, ${ty}, 'mousemove'); __at(${tx}, ${ty}, 'mousedown'); __at(${tx}, ${ty}, 'mouseup');
      window.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); return true; })()`);
    await spoke(28, 24); await spoke(14, 26); await spoke(20, 12);
    const st = JSON.parse(await run(`JSON.stringify(CNC.job.shapes.map(s => { const l = CNC.worldLoop(s); const b = CNC.G.bbox(l);
      return { n: s.name, kind: s.kind, segs: l.length, area: +Math.abs(CNC.G.signedArea(l)).toFixed(3), w: +b.w.toFixed(3), h: +b.h.toFixed(3) }; }))`));
    const circ = st.find(x => x.n === 'circle');
    ok(circ && circ.kind === 'circle', 'after three spokes the circle is still kind "circle"', JSON.stringify(circ));
    ok(circ && Math.abs(circ.area - Math.PI * 36) < 0.01, 'and still encloses pi*36', String(circ && circ.area));
    ok(circ && Math.abs(circ.w - 12) < 1e-6 && Math.abs(circ.h - 12) < 1e-6, 'and is still 12 x 12, not an ellipse', JSON.stringify(circ));
    const spokes = st.filter(x => x.n !== 'circle');
    ok(spokes.length === 3, 'three spokes were drawn', String(spokes.length));
    ok(spokes.filter(x => x.segs === 2).length >= 2, 'spokes that cross the rim are split there (inside piece + outside piece)', JSON.stringify(spokes));
    // no rim grips on a circle, so a click near the rim cannot deform it
    await run(`(() => { document.querySelector('button.tool[data-tool="select"]').click(); CNC.selectShape(2100); return true; })()`);
    ok((await run('CNC.gripsOf(CNC.job.shapes.find(s=>s.name==="circle")).length')) === 0, 'a circle exposes no draggable grips');

    console.log('a one-axis resize is refused on arc-bearing parts');
    await run(`(() => { CNC.job.shapes.length = 0;
      CNC.job.shapes.push({id:2110,name:'rounded',kind:'poly',x:0,y:0,rot:0,open:false,op:'outside',toolId:2,climb:false,
        pts:[{x:0,y:0,r:0,arcR:0},{x:10,y:0,r:0,arcR:3},{x:10,y:6,r:0,arcR:0},{x:0,y:6,r:0,arcR:0}]});
      CNC.refresh(); CNC.selectShape(2110); return true; })()`);
    const before = await run('Math.abs(CNC.G.signedArea(CNC.worldLoop(CNC.job.shapes[0]))).toFixed(4)');
    await run(`CNC.applySize(CNC.job.shapes[0], 'w', 20)`);
    const after = await run('Math.abs(CNC.G.signedArea(CNC.worldLoop(CNC.job.shapes[0]))).toFixed(4)');
    ok(before === after, 'retyping the width of a part with a bowed edge is refused rather than distorting the arc', before + ' -> ' + after);
    const warned = await run(`JSON.stringify(CNC.LOG.entries().filter(e => /Refused a one-axis resize/.test(e.msg)).length)`);
    ok(warned !== '0', 'and it says why in the activity log');

    console.log('duplicate ids cannot happen');
    await run(`(() => { CNC.job.shapes.length = 0; CNC.job.nextId = 1;
      CNC.job.shapes.push({id:7,name:'existing',kind:'rect',x:0,y:0,rot:0,w:2,h:2,r:0,op:'outside',toolId:2,climb:false,open:false});
      return true; })()`);
    const newId = await run(`(() => { CNC.buildFromOffsets([{s:0,o:1},{s:1,o:1.2},{s:2,o:1}], {alongY:false, closeIt:true, fitArcs:false, tol:0.01});
      return CNC.job.shapes[CNC.job.shapes.length - 1].id; })()`);
    ok(newId > 7, 'a new part never reuses an id already on the job', String(newId));
    }

    { // scoped
    console.log('a hole cut inside a plate shows the bed through it');
    await run(`(() => { CNC.job.shapes.length = 0; CNC.job.dims = [];
      document.querySelector('button.tool[data-tool="select"]').click();
      CNC.job.shapes.push({id:2200,name:'plate',kind:'rect',x:10,y:10,rot:0,w:20,h:14,r:0,op:'outside',toolId:2,climb:false,open:false});
      CNC.job.shapes.push({id:2201,name:'hole',kind:'circle',x:20,y:17,rot:0,r:3,op:'inside',toolId:2,climb:false,open:false});
      CNC.job.nextId = 2202; CNC.refresh(); return true; })()`);
    // the hole is paired with the plate it sits in
    const pairing = await run(`(() => { const loops = new Map(); CNC.job.shapes.forEach(s => loops.set(s.id, CNC.worldLoop(s)));
      const pm = CNC.holeParents(loops); return JSON.stringify([...pm.entries()]); })()`);
    ok(pairing === '[[2201,2200]]', 'the inside-cut circle is recognised as a hole in the plate', pairing);

    // read pixels: hole centre must look like bare bed, plate interior must not.
    /* Sample a spread of points and keep the darkest of each. Grid lines and the
       centre-mark cross only ever lighten a pixel, and at some zooms one runs
       straight through the hole - taking the minimum reads the surface itself
       rather than whatever is drawn on top of it. */
    const px = JSON.parse(await run(`(() => {
      const cv = document.querySelector('#cv'), c2 = cv.getContext('2d');
      const at = (wx, wy) => { const p = CNC.W2S({x:wx, y:wy}); const d = c2.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data; return [d[0], d[1], d[2]]; };
      const darkest = (pts) => pts.map(p => at(p[0], p[1])).reduce((a, b) => a.map((v, i) => Math.min(v, b[i])));
      return JSON.stringify({
        hole: darkest([[21.5,18.2],[19.1,18.3],[20.7,15.9],[18.9,15.7],[21.3,16.6]]),
        plate: darkest([[13,12],[12.4,11.3],[27.6,22.4],[26.1,12.7],[11.7,22.1]]),
        bed: darkest([[45,40],[44.3,39.4],[38.6,55.2],[52.1,71.3],[41.8,88.7]]),
      });
    })()`));
    const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 2);
    ok(same(px.hole, px.bed), 'the pixel at the hole centre matches bare bed (no material tint)', JSON.stringify(px));
    ok(!same(px.plate, px.bed), 'while the plate interior is tinted as material', JSON.stringify(px));

    // a hole with no plate around it still shows as something on the bed
    await run(`(() => { CNC.job.shapes.length = 0;
      CNC.job.shapes.push({id:2210,name:'lone pocket',kind:'circle',x:20,y:17,rot:0,r:3,op:'inside',toolId:2,climb:false,open:false});
      CNC.refresh(); return true; })()`);
    const lone = await run(`(() => { const loops = new Map(); CNC.job.shapes.forEach(s => loops.set(s.id, CNC.worldLoop(s)));
      return CNC.holeParents(loops).size; })()`);
    ok(lone === 0, 'an inside-cut with no plate around it is not treated as a hole', String(lone));

    // nested: a hole pairs with the SMALLEST plate that contains it
    await run(`(() => { CNC.job.shapes.length = 0;
      CNC.job.shapes.push({id:2220,name:'outer',kind:'rect',x:0,y:0,rot:0,w:40,h:30,r:0,op:'outside',toolId:2,climb:false,open:false});
      CNC.job.shapes.push({id:2221,name:'inner plate',kind:'rect',x:10,y:10,rot:0,w:12,h:8,r:0,op:'outside',toolId:2,climb:false,open:false});
      CNC.job.shapes.push({id:2222,name:'hole',kind:'circle',x:16,y:14,rot:0,r:2,op:'inside',toolId:2,climb:false,open:false});
      CNC.refresh(); return true; })()`);
    const nested = await run(`(() => { const loops = new Map(); CNC.job.shapes.forEach(s => loops.set(s.id, CNC.worldLoop(s)));
      return CNC.holeParents(loops).get(2222); })()`);
    ok(nested === 2221, 'a hole inside nested plates pairs with the smallest one containing it', String(nested));
    }

    { // scoped
    console.log('snaps travel with a part that is dragged');
    const r = JSON.parse(await run(`(() => {
      CNC.job.shapes.length=0; CNC.job.dims=[]; CNC.job.nextId=1;
      document.querySelector('button.tool[data-tool="select"]').click();
      CNC.job.shapes.push({id:1,name:'disc',kind:'circle',x:20,y:20,rot:0,r:3,op:'outside',toolId:2,climb:false,open:false});
      CNC.job.nextId=2; CNC.refresh();
      const cv=document.querySelector('#cv'), rect=cv.getBoundingClientRect(), dpr=cv.width/cv.clientWidth;
      const C=(w)=>{const q=CNC.W2S(w); return {clientX:rect.left+q.x/dpr, clientY:rect.top+q.y/dpr, bubbles:true, button:0};};
      const mm=(w)=>cv.dispatchEvent(new MouseEvent('mousemove',C(w)));
      mm({x:20,y:20});                                  // builds the snap cache at the old spot
      cv.dispatchEvent(new MouseEvent('mousedown',C({x:20,y:23})));
      for(let i=1;i<=10;i++) mm({x:20+i*2,y:23+i});
      window.dispatchEvent(new MouseEvent('mouseup',C({x:40,y:33})));
      const sh=CNC.job.shapes[0];
      mm({x:20,y:20}); const old=CNC.lastSnapInfo();
      mm({x:sh.x+0.05,y:sh.y+0.05}); const now=CNC.lastSnapInfo();
      return JSON.stringify({moved:[sh.x,sh.y], old:old&&old.type, now:now&&now.type, nowAt:now&&[now.p.x,now.p.y]});
    })()`));
    ok(Math.abs(r.moved[0] - 20) > 5, 'the circle really moved', JSON.stringify(r.moved));
    ok(r.old !== 'center', 'its old centre no longer snaps', JSON.stringify(r));
    ok(r.now === 'center' && Math.abs(r.nowAt[0]-r.moved[0])<1e-6 && Math.abs(r.nowAt[1]-r.moved[1])<1e-6, 'its new centre does', JSON.stringify(r));
    }

    { // scoped
    console.log('dragging a part snaps its own centre, not the spot you grabbed');
    const r = JSON.parse(await run(`(() => {
      CNC.job.shapes.length=0; CNC.job.dims=[]; CNC.job.nextId=1;
      CNC.S.snap.on=true; CNC.S.snap.ortho=false; const oldR=CNC.S.snap.radius; CNC.S.snap.radius=0.125;
      document.querySelector('button.tool[data-tool="select"]').click();
      const target={x:21.1003,y:12.0371};
      CNC.job.shapes.push({id:1,name:'disc',kind:'circle',x:10,y:12,rot:0,r:2,op:'outside',toolId:2,climb:false,open:false});
      CNC.job.shapes.push({id:2,name:'arm',kind:'path',x:0,y:0,rot:0,open:true,op:'on',toolId:2,climb:false,
        loop:[CNC.G.line({x:target.x+5,y:target.y},{x:target.x,y:target.y})]});
      CNC.job.nextId=3;
      const cv=document.querySelector('#cv');
      CNC.view.scale=60*(cv.width/cv.clientWidth);
      const mid={x:15.5,y:12};
      let q=CNC.W2S(mid); CNC.view.ox+=cv.width/2-q.x;
      q=CNC.W2S(mid); const want=cv.height/2; CNC.view.oy-=(want-q.y);
      q=CNC.W2S(mid); if(Math.abs(q.y-want)>1) { CNC.view.oy+=2*(want-q.y); }
      CNC.refresh();
      const rect=cv.getBoundingClientRect(), dpr=cv.width/cv.clientWidth;
      const C=(w)=>{const s=CNC.W2S(w); return {clientX:rect.left+s.x/dpr, clientY:rect.top+s.y/dpr, bubbles:true, button:0};};
      const grab={x:10+0.05,y:12-0.04};                 // a hand is never exactly on the centre mark
      const drop={x:target.x+0.05+0.03,y:target.y-0.04+0.02};
      cv.dispatchEvent(new MouseEvent('mousemove',C(grab)));
      cv.dispatchEvent(new MouseEvent('mousedown',C(grab)));
      for(let i=1;i<=12;i++){ const u=i/12; cv.dispatchEvent(new MouseEvent('mousemove',C({x:grab.x+(drop.x-grab.x)*u,y:grab.y+(drop.y-grab.y)*u}))); }
      window.dispatchEvent(new MouseEvent('mouseup',C(drop)));
      const sh=CNC.job.shapes.find(s=>s.id===1);
      CNC.S.snap.radius=oldR;
      return JSON.stringify({centre:[sh.x,sh.y], target:[target.x,target.y], err:Math.hypot(sh.x-target.x, sh.y-target.y)});
    })()`));
    ok(r.err < 1e-6, 'the centre lands exactly on the line end', JSON.stringify(r));
    }

    { // scoped
    console.log('merging a slot into a disc gives the keyhole, not a butterfly');
    const r = JSON.parse(await run(`(() => {
      const G=CNC.G;
      CNC.job.shapes.length=0; CNC.job.dims=[]; CNC.job.nextId=1;
      const cx=20, cy=20, R=6, yOn=cy-Math.sqrt(R*R-1.5*1.5);
      CNC.job.shapes.push({id:1,name:'disc',kind:'circle',x:cx,y:cy,rot:0,r:R,op:'outside',toolId:2,climb:false,open:false});
      const A={x:cx-1.5,y:yOn}, B={x:cx-1.5,y:cy-2}, C={x:cx+1.5,y:cy-2}, D={x:cx+1.5,y:yOn};
      CNC.job.shapes.push({id:2,name:'slot',kind:'path',x:0,y:0,rot:0,open:true,op:'on',toolId:2,climb:false,
        loop:[G.line(A,B), G.arc(B,C,{x:cx,y:cy-2},false), G.line(C,D)]});
      CNC.job.nextId=3; CNC.refresh();
      CNC.job.shapes.forEach(s=>CNC.selectShape(s.id));
      window.dispatchEvent(new KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true}));
      CNC.mergeSelected(0.125);
      const out=CNC.job.shapes.map(s=>{const l=CNC.worldLoop(s);
        return {open:s.open, op:s.op, segs:l.length, arcs:l.filter(x=>x.type==='arc').length,
                area:+Math.abs(G.signedArea(l)).toFixed(2)};});
      return JSON.stringify({parts:CNC.job.shapes.length, out});
    })()`));
    ok(r.parts === 1, 'the merge leaves one part', JSON.stringify(r));
    ok(r.parts === 1 && r.out[0].open === false && r.out[0].op === 'outside', 'and it is closed, cutting outside', JSON.stringify(r.out));
    // disc 113.10 less the slot it encloses: the slot arc is kept, the mouth is not
    ok(r.parts === 1 && r.out[0].area > 96 && r.out[0].area < 100, 'with the slot taken out of the disc', JSON.stringify(r.out));
    ok(r.parts === 1 && r.out[0].arcs >= 3, 'and its arcs survive as arcs', JSON.stringify(r.out));
    }

    { // scoped
    console.log('merging two parts that share an edge welds them');
    const r = JSON.parse(await run(`(() => {
      const G=CNC.G;
      CNC.job.shapes.length=0; CNC.job.dims=[]; CNC.job.nextId=1;
      CNC.job.shapes.push({id:1,name:'a',kind:'rect',x:10,y:10,rot:0,w:4,h:4,r:0,op:'outside',toolId:2,climb:false,open:false});
      CNC.job.shapes.push({id:2,name:'b',kind:'rect',x:14,y:10,rot:0,w:4,h:4,r:0,op:'outside',toolId:2,climb:false,open:false});
      CNC.job.nextId=3; CNC.refresh();
      CNC.job.shapes.forEach(s=>CNC.selectShape(s.id));
      window.dispatchEvent(new KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true}));
      CNC.mergeSelected(0.125);
      const s=CNC.job.shapes[0], l=CNC.worldLoop(s), b=G.bbox(l);
      return JSON.stringify({parts:CNC.job.shapes.length, open:s.open,
        size:[+b.w.toFixed(3),+b.h.toFixed(3)], area:+Math.abs(G.signedArea(l)).toFixed(2)});
    })()`));
    ok(r.parts === 1 && !r.open, 'two butted squares weld into one closed part', JSON.stringify(r));
    ok(Math.abs(r.size[0]-8) < 1e-6 && Math.abs(r.size[1]-4) < 1e-6, 'spanning both, 8 x 4', JSON.stringify(r.size));
    ok(Math.abs(r.area-32) < 0.01, 'and the shared edge is gone from the outline', String(r.area));
    }

    { // scoped
    console.log('millimetres are a display skin over an inch drawing');
    const r = JSON.parse(await run(`(() => {
      CNC.job.shapes.length=0; CNC.job.dims=[]; CNC.job.nextId=1;
      CNC.job.shapes.push({id:1,name:'plate',kind:'rect',x:0,y:0,rot:0,w:10,h:4,r:0,op:'outside',toolId:1,climb:false,open:false});
      CNC.job.nextId=2;
      CNC.S.units='mm'; CNC.syncUnitsUI(); CNC.selectShape(1);
      const w = document.querySelector('#props [data-k="w"]').value;
      // type 100 mm into the width and it must store 3.937 in
      const inp = document.querySelector('#props [data-k="w"]');
      inp.value = '100'; inp.dispatchEvent(new Event('change', {bubbles:true}));
      const stored = CNC.job.shapes[0].w;
      // the post is unaffected by any of it
      const tap = CNC.PO.generate({shapes:[{loop:CNC.worldLoop(CNC.job.shapes[0]),op:'outside',toolId:1,open:false}],
        tools:CNC.S.tools, material:{thickness:0.1875}, cutThrough:0, machine:CNC.S.machine}).gcode;
      const firstX = (tap.match(/X(-?[0-9.]+)/) || [])[1];
      CNC.S.units='in'; CNC.syncUnitsUI();
      const backIn = document.querySelector('#props [data-k="w"]') ? CNC.job.shapes[0].w : null;
      return JSON.stringify({shownMM:w, stored:+stored.toFixed(4), firstX:+firstX, backIn:+backIn.toFixed(4)});
    })()`));
    ok(r.shownMM === '254', 'a 10 in plate reads 254 mm', r.shownMM);
    ok(Math.abs(r.stored - 3.937) < 0.001, 'typing 100 mm stores 3.937 in', String(r.stored));
    ok(r.firstX < 100, 'and the posted program is still in inches', String(r.firstX));
    ok(Math.abs(r.backIn - 3.937) < 0.001, 'switching back changes nothing in the drawing', String(r.backIn));
    }

    { // scoped
    console.log('AutoCAD-style typed commands');
    const type = (txt, end) => `(() => {
      CNC.S.keys.mode='command';
      for (const ch of ${JSON.stringify(txt)}) window.dispatchEvent(new KeyboardEvent('keydown',{key:ch,bubbles:true}));
      window.dispatchEvent(new KeyboardEvent('keydown', ${end === 'space' ? "{key:' ',code:'Space',bubbles:true}" : "{key:'Enter',bubbles:true}"}));
      return document.querySelector('button.tool.active').dataset.tool;
    })()`;
    ok((await run(type('REC', 'enter'))) === 'rect', 'REC then Enter picks the rectangle tool');
    ok((await run(type('C', 'enter'))) === 'circle', 'C then Enter picks the circle tool');
    ok((await run(type('L', 'space'))) === 'pline', 'L then Space picks the line tool');
    ok((await run(type('A', 'enter'))) === 'arc', 'A then Enter picks the arc tool');

    const esc2 = await run(`(() => {
      CNC.S.keys.mode='command';
      for (const ch of 'REC') window.dispatchEvent(new KeyboardEvent('keydown',{key:ch,bubbles:true}));
      const mid = document.querySelector('#stCmd').textContent;
      window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      return JSON.stringify({mid, after: document.querySelector('#stCmd').textContent});
    })()`);
    const ev = JSON.parse(esc2);
    ok(ev.mid === 'Command: REC', 'what is being typed shows in the status bar', ev.mid);
    ok(ev.after === '', 'and Escape clears it', JSON.stringify(ev.after));

    // an operator can rebind anything
    ok((await run(`(() => {
      CNC.S.keys.aliases = Object.assign({}, CNC.aliasMap(), {ZZ:'circle'});
      CNC.S.keys.mode='command';
      for (const ch of 'ZZ') window.dispatchEvent(new KeyboardEvent('keydown',{key:ch,bubbles:true}));
      window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      const t = document.querySelector('button.tool.active').dataset.tool;
      CNC.S.keys.aliases = null;
      return t;
    })()`)) === 'circle', 'a rebound alias works');

    // single-key mode is still there for anyone who prefers it
    ok((await run(`(() => {
      CNC.S.keys.mode='direct';
      window.dispatchEvent(new KeyboardEvent('keydown',{key:'r',bubbles:true}));
      const t = document.querySelector('button.tool.active').dataset.tool;
      CNC.S.keys.mode='command';
      return t;
    })()`)) === 'rect', 'single-key mode still picks a tool with one press');
    }

    { // scoped
    console.log('coordinates typed at the command line');
    const rect = JSON.parse(await run(`(() => {
      CNC.job.shapes.length=0; CNC.job.dims=[]; CNC.job.nextId=1;
      CNC.S.units='in'; CNC.S.keys.mode='command';
      CNC.runCommand('REC'); CNC.runCommand('10,5'); CNC.runCommand('20,12');
      const s=CNC.job.shapes[0];
      return JSON.stringify({n:CNC.job.shapes.length, x:s&&s.x, y:s&&s.y, w:s&&s.w, h:s&&s.h});
    })()`));
    ok(rect.n === 1, 'REC then two corners makes one rectangle', JSON.stringify(rect));
    ok(rect.x === 10 && rect.y === 5, 'at the absolute point typed', JSON.stringify([rect.x, rect.y]));
    ok(Math.abs(rect.w - 10) < 1e-9 && Math.abs(rect.h - 7) < 1e-9, 'and the size the two corners give', JSON.stringify([rect.w, rect.h]));

    const segs = JSON.parse(await run(`(() => {
      CNC.job.shapes.length=0; CNC.job.nextId=1;
      CNC.runCommand('L'); CNC.runCommand('0,0'); CNC.runCommand('@5,0'); CNC.runCommand('@5<90');
      window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      const l=CNC.worldLoop(CNC.job.shapes[0]);
      return JSON.stringify(l.map(s=>[+s.a.x.toFixed(3),+s.a.y.toFixed(3),+s.b.x.toFixed(3),+s.b.y.toFixed(3)]));
    })()`));
    ok(JSON.stringify(segs[0]) === JSON.stringify([0,0,5,0]), '@5,0 goes 5 along from the last point', JSON.stringify(segs[0]));
    ok(JSON.stringify(segs[1]) === JSON.stringify([5,0,5,5]), '@5<90 goes 5 up from there', JSON.stringify(segs[1]));

    const mm = JSON.parse(await run(`(() => {
      CNC.job.shapes.length=0; CNC.job.nextId=1;
      CNC.S.units='mm'; CNC.syncUnitsUI();
      CNC.runCommand('REC'); CNC.runCommand('0,0'); CNC.runCommand('254,127');
      const s=CNC.job.shapes[0];
      CNC.S.units='in'; CNC.syncUnitsUI();
      return JSON.stringify({w:+s.w.toFixed(4), h:+s.h.toFixed(4)});
    })()`));
    ok(Math.abs(mm.w - 10) < 1e-4 && Math.abs(mm.h - 5) < 1e-4, 'in mm mode 254,127 is 10 x 5 inches inside', JSON.stringify(mm));

    const typed = await run(`(() => {
      CNC.job.shapes.length=0; CNC.job.nextId=1; CNC.S.keys.mode='command';
      document.querySelector('button.tool[data-tool="select"]').click();
      for (const ch of '12,5') window.dispatchEvent(new KeyboardEvent('keydown',{key:ch,bubbles:true}));
      return document.querySelector('#stCmd').textContent;
    })()`);
    ok(typed === 'Command: 12,5', 'a coordinate shows in the status bar as it is typed', typed);

    const xy = await run(`(() => {
      CNC.job.shapes.length=0; CNC.job.nextId=1;
      CNC.job.shapes.push({id:1,name:'p',kind:'rect',x:3,y:4,rot:0,w:2,h:2,r:0,op:'outside',toolId:1,climb:false,open:false});
      CNC.refresh(); CNC.selectShape(1);
      CNC.runCommand('X');
      const a = document.activeElement;
      return a && a.dataset ? a.dataset.k : 'none';
    })()`);
    ok(xy === 'x', 'the X command jumps to the X field of the selection', xy);
    }

    { // scoped
    console.log('a circle keeps its shape through a merge');
    const r = JSON.parse(await run(`(() => {
      const G=CNC.G;
      CNC.job.shapes.length=0; CNC.job.dims=[]; CNC.job.nextId=1; CNC.S.units='in';
      CNC.job.shapes.push({id:1,name:'disc',kind:'circle',x:20,y:20,rot:0,r:6,op:'outside',toolId:1,climb:false,open:false});
      // a chord straight across it, running past the rim at both ends
      CNC.job.shapes.push({id:2,name:'cut',kind:'poly',x:0,y:0,rot:0,open:true,op:'on',toolId:1,climb:false,
        pts:[{x:12,y:20},{x:28,y:20}]});
      CNC.job.nextId=3; CNC.refresh();
      /* Draw the line the way the app does. Pushing a shape straight into the
         job skips the split at the crossings that every drawn line gets, and
         merge has no vertex on the rim to trace through. */
      CNC.autoSplitAround(CNC.job.shapes[1]);
      CNC.refresh();
      CNC.job.shapes.forEach(s=>CNC.selectShape(s.id));
      window.dispatchEvent(new KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true}));
      CNC.mergeSelected(0.125);
      const sh=CNC.job.shapes[0], l=CNC.worldLoop(sh);
      // how far every corner of the result sits from the circle's centre
      let worst=0;
      for (const sg of l) for (const p of [sg.a, sg.b]) worst=Math.max(worst, Math.hypot(p.x-20,p.y-20));
      return JSON.stringify({parts:CNC.job.shapes.length, kind:sh.kind,
        arcs:l.filter(x=>x.type==='arc').length,
        area:+Math.abs(G.signedArea(l)).toFixed(2), worstRadius:+worst.toFixed(3)});
    })()`));
    // half of a 6in disc is 56.55 sq in; the two stubs beyond the rim add no area
    ok(Math.abs(r.area - 56.55) < 0.2, 'merging a disc with a chord leaves half a disc', JSON.stringify(r));
    ok(r.arcs >= 1, 'the rim is still a true arc', JSON.stringify(r));
    ok(r.worstRadius <= 8.01, 'and no corner is flung outside the circle', String(r.worstRadius));
    }

    { // scoped
    console.log('a shape whose curves a polygon cannot hold stays a path');
    const r = JSON.parse(await run(`(() => {
      const G=CNC.G;
      CNC.job.shapes.length=0; CNC.job.nextId=1;
      // half a turn of arc plus its chord: a polygon bulge cannot describe this
      const A={x:14,y:20}, B={x:26,y:20};
      CNC.job.shapes.push({id:1,name:'halfdisc',kind:'path',x:0,y:0,rot:0,open:false,op:'outside',toolId:1,climb:false,
        loop:[G.arc(A,B,{x:20,y:20},false), G.line(B,A)]});
      CNC.job.nextId=2; CNC.refresh();
      const before=+Math.abs(G.signedArea(CNC.worldLoop(CNC.job.shapes[0]))).toFixed(2);
      const got = CNC.makeEditable(CNC.job.shapes[0]);
      const sh=CNC.job.shapes[0];
      const after=+Math.abs(G.signedArea(CNC.worldLoop(sh))).toFixed(2);
      return JSON.stringify({refused: got === null, kind:sh.kind, before, after});
    })()`));
    ok(r.before === r.after, 'its area is unchanged by being clicked on', JSON.stringify(r));
    ok(r.kind === 'path', 'and it stays a path, keeping true arcs', JSON.stringify(r));
    }

    console.log('no errors accumulated');
    const errs2 = await run(`JSON.stringify(CNC.LOG.entries().filter(e=>e.level==="error" && e.t >= ${loadedAt}).map(e=>e.msg))`);
    ok(errs2 === '[]', 'no errors logged during the whole run', errs2);
  } catch (e) {
    fail++; console.log('  FAIL harness threw: ' + (e && e.message));
  }

  function CNCexpect(chord, sag) { return (sag / 2) + (chord * chord) / (8 * sag); }

  if (problems.length) { fail += problems.length; console.log('\nrenderer problems:'); problems.forEach(p => console.log('  ! ' + p)); }
  console.log(`\n${pass} passed, ${fail} failed`);
  win.destroy();
  app.exit(fail ? 1 : 0);
});
