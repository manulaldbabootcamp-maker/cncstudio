const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
const fs = require('fs'); const path = require('path');
(async () => {
  const browser = await chromium.launch({ executablePath: fs.existsSync('/opt/pw-browsers/chromium/chrome') ? '/opt/pw-browsers/chromium/chrome' : undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('file://' + path.resolve(__dirname, '../dist/CNCStudio.html'));
  await page.waitForTimeout(300);
  console.log('early errors:', errors);
  // import DXF through app code
  const dxf = fs.readFileSync(path.join(__dirname, 'sides_full.dxf'), 'utf8');
  await page.evaluate((d) => { window.CNC.importDXF(d, 'sides.dxf'); }, dxf);
  await page.waitForTimeout(300);
  const n = await page.evaluate(() => window.CNC.job.shapes.length);
  console.log('shapes imported:', n);
  // set material and generate via the same code path as Export TAP
  const starts = fs.readFileSync(path.join(__dirname, 'Sides_manav.tap'), 'utf8').split('\r\n').filter(l => /^G0 X/.test(l)).map(l => { const m = l.match(/X([\d.]+) Y([\d.]+)/); return { x: +m[1], y: +m[2] }; });
  const gcode = await page.evaluate((starts) => {
    const C = window.CNC; C.job.material = { name: '3/16" Acrylic', thickness: 0.1875 };
    // assign start points from the original file (nearest start to each part) — emulates the user clicking "Set start point"
    for (const s of C.job.shapes) { const bb = C.G.bbox(C.worldLoop(s)); let best = null, bd = 1e9; for (const st of starts) { if (st.x < bb.x0 - 0.5 || st.x > bb.x1 + 0.5 || st.y < bb.y0 - 0.5 || st.y > bb.y1 + 0.5) continue; const d = Math.min(Math.abs(st.y - bb.y0), Math.abs(st.y - bb.y1), Math.abs(st.x - bb.x0), Math.abs(st.x - bb.x1)); if (d < bd) { bd = d; best = st; } } if (best) s.startPt = best; }
    C.refresh();
    const jobP = { shapes: C.job.shapes.map(s => ({ loop: C.worldLoop(s), op: s.op, open: s.open, toolId: s.toolId, climb: s.climb, startHint: s.startPt })), tools: C.S.tools, material: { thickness: 0.1875 }, cutThrough: 0, machine: C.S.machine };
    return C.PO.generate(jobP).gcode;
  }, starts);
  fs.writeFileSync(path.join(__dirname, 'ui_regen.tap'), gcode);
  const src = fs.readFileSync(path.join(__dirname, 'Sides_manav.tap'), 'utf8');
  const blocks = (t) => t.split('\r\n\r\n').slice(1, -1);
  const ba = blocks(src), bb = blocks(gcode);
  const shape = (s) => s.replace(/-?\d+\.?\d*/g, '#'); const nums = (s) => s.match(/-?\d+\.?\d*/g).map(Number);
  let matched = 0, maxDev = 0; const used = new Set(); const unmatched = [];
  for (const A of ba) { let ok = false; for (let j = 0; j < bb.length; j++) { if (used.has(j) || shape(A) !== shape(bb[j])) continue; const na = nums(A), nb = nums(bb[j]); let dev = 0; for (let k = 0; k < na.length; k++) dev = Math.max(dev, Math.abs(na[k] - nb[k])); if (dev <= 3e-4) { used.add(j); matched++; maxDev = Math.max(maxDev, dev); ok = true; break; } } if (!ok) unmatched.push(A); }
  console.log(`UI path: blocks ${ba.length} vs ${bb.length}, matched ${matched}, maxDev ${maxDev}`);
  if (unmatched.length) console.log('first unmatched:\n' + unmatched[0].split('\r\n').slice(0, 8).join('\n') + '\n---\n' + bb.find(b => !used.has(bb.indexOf(b))).split('\r\n').slice(0, 8).join('\n'));
  await page.screenshot({ path: path.join(__dirname, 'shot_design.png') });
  // nest + AI-less: try nest and simulate page
  await page.click('#btnNest'); await page.waitForTimeout(200);
  await page.click('.tab[data-page="sim"]'); await page.waitForTimeout(200); await page.click('#simGen'); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, 'shot_sim.png') });
  await page.click('.tab[data-page="settings"]'); await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(__dirname, 'shot_settings.png') });
  console.log('errors:', errors);
  await browser.close();
})();
