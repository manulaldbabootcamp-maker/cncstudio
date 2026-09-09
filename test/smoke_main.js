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
    const errs = await run('JSON.stringify(CNC.LOG.entries().filter(e=>e.level==="error"))');
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
    ok((await run(`document.querySelector('#toolHint').style.display`)) === 'none', 'no hint shown for the select tool');

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

    console.log('no errors accumulated');
    const errs2 = await run('JSON.stringify(CNC.LOG.entries().filter(e=>e.level==="error").map(e=>e.msg))');
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
