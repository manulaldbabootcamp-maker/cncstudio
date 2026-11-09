/* Third golden test: a plain 24 x 36 plate, and where a contour is seamed.

   Reference: "24x36_rect.TAP", posted from EnRoute on 11/9/2026 specifically
   to settle this. 24 x 36 rectangle, lower-left at X2 Y2, cut outside with the
   1/4" upspiral in slot 2, 0.25 stock (safe Z 0.35 = 0.25 + the 0.1 Z Lift),
   two passes Z0.125 / Z0., S17000, F217 cut / F20 plunge, no ramp-on.

   Why this file exists: both older golden tests pass the seam in by hand
   (`startHint` copied out of the reference), so nothing ever compared our own
   seam rule to EnRoute's. Ours was the midpoint of the longest straight edge -
   something I invented. EnRoute keeps the node the outline was drawn from, and
   where that node is a sharp corner the offset image is the middle of the
   corner arc, which splits that arc into two 45 deg halves.

   Run: node test/seam_test.js       (exits non-zero on failure)  */
const fs = require('fs');
const path = require('path');
const G = require('../src/geom.js');
const POST = require('../src/post.js');

const REF = path.join(__dirname, 'ref', '24x36_rect.TAP');
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + x : '')); } };

if (!fs.existsSync(REF)) { console.log('  skip: reference file not present at test/ref/'); process.exit(0); }
const ref = fs.readFileSync(REF, 'utf8');

const TOOL = { id: 2, slot: 2, name: '1/4" Upspiral', dia: 0.25, rpm: 17000,
               feed: 217, plunge: 20, passDepth: 0.125, type: 'endmill' };
const MACHINE = { ...POST.ENROUTE_CURRENT, leadIn: 0 };   // this export had no ramp-on
const plate = (extra = {}) => ({ name: 'plate', op: 'outside', toolId: 2, open: false,
                                 loop: G.rectLoop(2, 2, 24, 36, 0), ...extra });
const job = (shape) => ({
  shapes: [shape], tools: [TOOL], material: { thickness: 0.25 }, cutThrough: 0,
  machine: MACHINE, now: new Date(2026, 10, 9, 15, 50, 15),
});

console.log('the seam never lands on a corner')
{
  /* The shop sets the start point by hand, part-way along a straight edge:
     plunging and retracting at a corner marks the part. So with no explicit
     start point the seam goes to the middle of the longest straight run, and
     a drawn node that happens to be a corner is skipped. */
  const tp = POST.buildToolpathLoop({ loop: G.rectLoop(2, 2, 24, 36, 0), op: 'outside', open: false }, TOOL, {});
  const s = tp[0].a;
  const r = TOOL.dia / 2, k = r / Math.SQRT2;
  ok(!(Math.abs(s.x - (2 - k)) < 1e-4 && Math.abs(s.y - (2 - k)) < 1e-4),
    'not on the corner the rectangle was drawn from', `${s.x.toFixed(4)},${s.y.toFixed(4)}`);
  // the two 36 in sides tie for longest, so either one is correct
  ok(Math.abs(s.y - 20) < 1e-6 && (Math.abs(s.x - (2 - r)) < 1e-6 || Math.abs(s.x - (26 + r)) < 1e-6),
    'middle of a longest straight run - a 36 in side, one radius out',
    `${s.x.toFixed(4)},${s.y.toFixed(4)}`);
  ok(tp[0].type === 'line', 'and it opens on a straight move, not an arc', tp[0].type);
}

console.log('a drawn start point is honoured exactly, wherever it lands')
{
  // same plate, drawn as a polyline whose first node is mid-way along the bottom
  const loop = G.polyLoop([{ x: 14, y: 2 }, { x: 26, y: 2 }, { x: 26, y: 38 }, { x: 2, y: 38 }, { x: 2, y: 2 }]);
  const tp = POST.buildToolpathLoop({ loop, op: 'outside', open: false }, TOOL, {});
  const s = tp[0].a;
  ok(Math.abs(s.x - 14) < 1e-6 && Math.abs(s.y - 1.875) < 1e-6,
    'a node on an edge seams straight out from it, perpendicular', `${s.x},${s.y}`);

  /* startHint overrides everything, including onto a corner arc - the 24x36
     reference does exactly that, so startLoopAt must be able to split an arc
     at its midpoint rather than snap to the nearer end. */
  const k = (TOOL.dia / 2) / Math.SQRT2;
  const tp2 = POST.buildToolpathLoop({ loop: G.rectLoop(2, 2, 24, 36, 0), op: 'outside', open: false,
                                       startHint: { x: 26 + k, y: 38 + k } }, TOOL, {});
  const s2 = tp2[0].a;
  ok(Math.abs(s2.x - (26 + k)) < 1e-4 && Math.abs(s2.y - (38 + k)) < 1e-4,
    'an explicit start on a corner arc splits that arc at the 45 deg bisector',
    `${s2.x.toFixed(4)},${s2.y.toFixed(4)}`);
  ok(tp2[0].type === 'arc' && tp2[tp2.length - 1].type === 'arc',
    'one half of the corner arc opens the path, the other half closes it');
}

console.log('pass depths on 0.25 stock');
{
  const g = POST.generate(job(plate({ startHint: { x: 26.0884, y: 38.0884 } }))).gcode;
  const zs = g.split('\r\n').filter(l => /^G1 Z/.test(l));
  ok(zs.length === 2 && /^G1 Z0\.125F20$/.test(zs[0]) && /^G1 Z0\.$/.test(zs[1]),
    'two equal bites, Z0.125 then Z0., plunge feed on the first only', JSON.stringify(zs));
  ok(/^G0 Z0\.35$/m.test(g), 'safe Z is the 0.25 stock plus the 0.1 Z Lift', 'no G0 Z0.35');
}

console.log('byte-for-byte');
{
  const g = POST.generate(job(plate({ startHint: { x: 26.0884, y: 38.0884 } }))).gcode;
  ok(g === ref, 'with the seam on EnRoute\'s corner, the program is the reference file exactly',
    g === ref ? '' : firstDiff(ref, g));
}

function firstDiff(a, b) {
  const x = a.split('\r\n'), y = b.split('\r\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if (x[i] !== y[i]) return `line ${i + 1}: ref ${JSON.stringify(x[i])} vs ours ${JSON.stringify(y[i])}`;
  return 'lengths differ only';
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
