/* Fourth golden test: EnRoute's holding bridge.

   Reference: "Path file with bridge .5_.08h.tap", posted from EnRoute on
   17 Nov 2026. A 24 x 36 rectangle, lower-left at X0.25 Y0.25, cut outside
   with the 1/4" upspiral in slot 2, 0.125 stock in ONE pass to Z0 (safe Z
   0.225 = 0.125 + the 0.1 Z Lift), four bridges 0.5 long and 0.08 tall placed
   by hand, S17000, F217 cut / F20 plunge, no ramp-on.

   What it settles. The bridge is a SQUARE STEP:

       G1 X9.7232        cutting at full depth
       G1 Z0.08F217      straight up, at the CONTOUR feed, no X or Y
       G1 X8.9732        across the bridge at that height
       G1 Z0.            straight back down

   Not a ramp, and not the cubic smoothstep I had read out of the pre-2025
   archive - those older programs used a different bridge style on the old
   spindle config. Three things fall out of it:

     * the raised span is the bridge length PLUS the tool diameter (0.75 for a
       0.5 bridge with a 0.25 cutter), so the material left is 0.5 long;
     * the height is absolute Z, which is the material left standing;
     * the first raised move carries the feed word and the rest do not, because
       the last Z move before it was the plunge at F20. Z moves carry their own
       feed, separate from the contour feed.

   Run: node test/bridge_test.js       (exits non-zero on failure)  */
const fs = require('fs');
const path = require('path');
const G = require('../src/geom.js');
const POST = require('../src/post.js');

const REF = path.join(__dirname, 'ref', 'bridge_0.5x0.08.TAP');
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + x : '')); } };

if (!fs.existsSync(REF)) { console.log('  skip: reference file not present at test/ref/'); process.exit(0); }
const ref = fs.readFileSync(REF, 'latin1');

const TOOL = { id: 2, slot: 2, name: '1/4" Upspiral', dia: 0.25, rpm: 17000,
               feed: 217, plunge: 20, passDepth: 0.125, type: 'endmill' };
/* The four bridges sit a quarter of the path apart, 8.239 in along it from the
   seam. Evenly spaced, but not from the seam - the operator chose where the
   first one went, which is why the app takes a list of placements. */
const STEP = (2 * (24 + 36) + 2 * Math.PI * 0.125) / 4;
const AT = [0, 1, 2, 3].map(k => 8.239 + k * STEP);

const job = (tabs) => ({
  shapes: [{ name: 'plate', op: 'outside', toolId: 2, open: false,
             loop: G.rectLoop(0.25, 0.25, 24, 36, 0),
             startHint: { x: 17.5872, y: 36.375 } }],
  tools: [TOOL], material: { thickness: 0.125 }, cutThrough: 0,
  tabs: { on: true, count: 4, len: 0.5, height: 0.08, at: AT, ...(tabs || {}) },
  machine: { ...POST.ENROUTE_CURRENT, leadIn: 0 },
  now: new Date(2026, 10, 17, 10, 9, 37),
});

console.log('byte-for-byte against EnRoute');
{
  const g = POST.generate(job()).gcode;
  ok(g === ref, 'the whole program is the reference file exactly', g === ref ? '' : firstDiff(ref, g));
}

console.log('the step is square');
{
  const L = POST.generate(job()).gcode.split('\r\n');
  const up = L.filter(l => /^G1 Z0\.08(F[\d.]+)?$/.test(l));
  const down = L.filter(l => /^G1 Z0\.$/.test(l));
  ok(up.length === 4, 'four bridges, four moves up', String(up.length));
  ok(down.length === 4, 'and four back down - the first plunge says "G1 Z0.F20" instead', String(down.length));
  ok(!L.some(l => /^G[123] .*[XY].*Z/.test(l)), 'no cutting move carries a Z, so nothing ramps');
}

console.log('the feed word appears once');
{
  const L = POST.generate(job()).gcode.split('\r\n');
  ok(L.filter(l => /^G1 Z0\.08F217$/.test(l)).length === 1,
    'the first move up states the contour feed, because the plunge left F20 behind');
  ok(L.filter(l => /^G1 Z0\.08$/.test(l)).length === 3,
    'the other three do not, because the Z feed has not changed since');
}

console.log('the span is the bridge plus the cutter');
{
  const L = POST.generate(job()).gcode.split('\r\n');
  // the first bridge runs along the top edge, backwards in X
  const i = L.findIndex(l => /^G1 Z0\.08F217$/.test(l));
  const x0 = parseFloat(/X(-?[\d.]+)/.exec(L[i - 1])[1]);
  const x1 = parseFloat(/X(-?[\d.]+)/.exec(L[i + 1])[1]);
  ok(Math.abs(Math.abs(x1 - x0) - 0.75) < 1e-9,
    'a 0.5 bridge raises a 0.25 cutter for 0.75, leaving 0.5 of material',
    String(Math.abs(x1 - x0)));
}

console.log('a bridge as tall as the stock is refused, not posted');
{
  /* 0.5 bridge on 0.125 stock: the tool would ride over the material for the
     whole span and the part would come out still attached all the way round. */
  const r = POST.generate(job({ height: 0.5 }));
  ok(!/Z0\.5/.test(r.gcode), 'it never appears in the program');
  ok(/nothing would be cut there/.test(r.stats.issues.join(' ')),
    'and the operator is told why', JSON.stringify(r.stats.issues));
}

function firstDiff(a, b) {
  const x = a.split('\r\n'), y = b.split('\r\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if (x[i] !== y[i]) return `line ${i + 1}: ref ${JSON.stringify(x[i])} vs ours ${JSON.stringify(y[i])}`;
  return 'lengths differ only';
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
