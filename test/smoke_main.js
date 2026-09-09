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
