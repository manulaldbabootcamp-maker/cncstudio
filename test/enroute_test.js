/* Second golden test, against the machine's CURRENT EnRoute configuration.

   Reference: "17K_3-8in pcs_drop.tap", real production output from 2/9/2026.
   Two 22 x 8 in rectangles cut from 3/8" stock with the 1/4" upspiral in slot
   2, three passes, S17000, F217 cut / F20 plunge, 1 in ramp-on lead-in,
   Z Lift 0.1 (so safe Z = 0.475).

   The part geometry is recovered from the file itself: the toolpath runs
   0.775..23.025 x 0.325..8.575 with 0.125 corner radii, which is a plain
   22 x 8 rectangle offset outward by the 0.125 tool radius.

   Run: node test/enroute_test.js       (exits non-zero on failure)  */
const fs = require('fs');
const path = require('path');
const G = require('../src/geom.js');
const POST = require('../src/post.js');

const REF = path.join(__dirname, 'ref', '17K_3-8in pcs_drop.tap');
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + x : '')); } };

if (!fs.existsSync(REF)) {
  console.log('  skip: reference file not present at test/ref/');
  process.exit(0);
}
const ref = fs.readFileSync(REF, 'utf8');
const refLines = ref.split('\r\n');

// ---- rebuild the job ----
const TOOL = { id: 2, slot: 2, name: '1/4" Upspiral', dia: 0.25, rpm: 17000, feed: 217, plunge: 20, passDepth: 0.125, type: 'endmill' };
const rect = (x, y, w, h) => G.rectLoop(x, y, w, h, 0);
const shapes = [
  { loop: rect(0.9, 0.45, 22, 8), op: 'outside', toolId: 2, startHint: { x: 10.5087, y: 8.575 } },
  { loop: rect(23.4, 0.45, 22, 8), op: 'outside', toolId: 2, startHint: { x: 33.7514, y: 8.575 } },
];
const out = POST.generate({
  shapes, tools: [TOOL],
  machine: POST.ENROUTE_CURRENT,
  material: { thickness: 0.375 },
  cutThrough: 0,
  now: new Date(2026, 8, 2, 10, 48, 38),   // 9/2/2026 10:48:38 AM
});
const gen = out.gcode;
const genLines = gen.split('\r\n');

console.log('program frame');
ok(genLines[0] === '[Creation Date: 9/2/2026 - 10:48:38 AM]', 'creation-date stamp matches EnRoute exactly', JSON.stringify(genLines[0]));
ok(genLines.slice(1, 5).join('|') === 'G90|G53|M61|M5', 'header is G90/G53/M61/M5', genLines.slice(1, 5).join('|'));
ok(genLines.slice(6, 10).join('|') === '[1/4" Upspiral]|T02|S17000|M3', 'tool block is [name]/T##/S/M3', genLines.slice(6, 10).join('|'));
const refTail = refLines.slice(-5).join('|'), genTail = genLines.slice(-5).join('|');
ok(refTail === genTail, 'footer matches byte for byte', genTail);

console.log('safe Z tracks material thickness (Z Lift 0.1)');
ok(gen.includes('G0 Z0.475'), 'safe Z is 0.475 for 0.375 stock', String(/G0 Z[\d.]+/.exec(gen)));
ok(!gen.includes('G0 Z1.1875'), 'the old absolute 1.1875 safe Z is not used');

console.log('ramp-on lead-in');
const rampRe = /^G1 X(-?[\d.]+) Z(-?[\d.]+)$/;
const genRamps = genLines.filter(l => rampRe.test(l));
const refRamps = refLines.filter(l => rampRe.test(l));
ok(genRamps.length === refRamps.length, `same number of ramp moves (${refRamps.length})`, String(genRamps.length));
// every lead-in must be exactly 1.000 in, measured back along the path
const leadDist = (lines) => {
  const d = [];
  for (let i = 0; i < lines.length; i++) {
    const g0 = /^G0 X(-?[\d.]+) Y(-?[\d.]+)$/.exec(lines[i]);
    if (!g0) continue;
    for (let k = i + 1; k < Math.min(i + 6, lines.length); k++) {
      const r = rampRe.exec(lines[k]);
      if (r) { d.push(Math.abs(parseFloat(r[1]) - parseFloat(g0[1]))); break; }
    }
  }
  return d;
};
const gd = leadDist(genLines), rd = leadDist(refLines);
ok(rd.length && rd.every(v => Math.abs(v - 1) < 1e-6), 'reference lead-ins are all exactly 1.000 in', JSON.stringify(rd));
ok(gd.length === rd.length && gd.every(v => Math.abs(v - 1) < 1e-6), 'generated lead-ins are all exactly 1.000 in', JSON.stringify(gd));

console.log('feeds and passes');
ok(/^G1 Z0.375F20$/m.test(gen), 'first plunge carries the plunge feed (F20) on the Z line');
ok((gen.match(/^F20$/gm) || []).length === (ref.match(/^F20$/gm) || []).length, 'same count of standalone F20 lines');
ok((gen.match(/^F217$/gm) || []).length === (ref.match(/^F217$/gm) || []).length, 'same count of F217 cut-feed lines');
const depths = [...new Set((gen.match(/^G1 X[\d.]+ Z(-?[\d.]+)$/gm) || []).map(l => l.split('Z')[1]))].sort();
ok(depths.join(',') === '0.,0.125,0.25', 'three passes at 0.25 / 0.125 / 0.', depths.join(','));

console.log('geometry against the reference');
const nums = (t) => (t.match(/^G[0-3] .*$/gm) || []).join('\n');
const refBlocks = ref.split('\r\n\r\n').slice(2, -1);
const genBlocks = gen.split('\r\n\r\n').slice(2, -1);
ok(genBlocks.length === refBlocks.length, `same number of pass blocks (${refBlocks.length})`, String(genBlocks.length));

// match blocks ignoring order, comparing shape then numbers within tolerance
const shapeOf = (b) => b.replace(/-?\d+\.?\d*/g, '#');
const numsOf = (b) => (b.match(/-?\d+\.?\d*/g) || []).map(Number);
let matched = 0, maxDev = 0;
const used = new Set();
for (const A of refBlocks) {
  for (let j = 0; j < genBlocks.length; j++) {
    if (used.has(j)) continue;
    if (shapeOf(A) !== shapeOf(genBlocks[j])) continue;
    const na = numsOf(A), nb = numsOf(genBlocks[j]);
    if (na.length !== nb.length) continue;
    let dev = 0;
    for (let k = 0; k < na.length; k++) dev = Math.max(dev, Math.abs(na[k] - nb[k]));
    if (dev <= 3e-4) { used.add(j); matched++; maxDev = Math.max(maxDev, dev); break; }
  }
}
ok(matched === refBlocks.length, `all ${refBlocks.length} pass blocks reproduce the reference`, `matched ${matched}, maxDev ${maxDev}`);

console.log('byte-for-byte');
/* The strongest statement available: with the same geometry, tool and machine
   config, the generated program is the reference file, character for
   character - including the date stamp, the ramp moves and every coordinate. */
ok(gen === ref, 'the generated program is byte-identical to the EnRoute reference',
  gen === ref ? '' : `${genLines.length} lines vs ${refLines.length}`);

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nfirst differing block (reference vs generated):');
  for (let i = 0; i < Math.max(refBlocks.length, genBlocks.length); i++) {
    if (refBlocks[i] !== genBlocks[i]) {
      console.log('--- reference ---\n' + (refBlocks[i] || '(none)'));
      console.log('--- generated ---\n' + (genBlocks[i] || '(none)'));
      break;
    }
  }
  process.exit(1);
}
