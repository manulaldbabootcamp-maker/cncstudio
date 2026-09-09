const fs = require('fs');
const G = require('../src/geom.js');
const POST = require('../src/post.js');

const src = fs.readFileSync(__dirname + '/Sides_manav.tap', 'utf8');
const moves = POST.parseGcode(src);

// split into loops: each starts with G0 XY at safe Z followed by plunge
const loops = []; let cur = null;
for (const m of moves) {
  if (m.g === 0 && (m.to.x !== m.from.x || m.to.y !== m.from.y || m.to.z === m.from.z) && m.to.z === m.from.z) { cur = { start: m.to, z: null, segs: [] }; loops.push(cur); continue; }
  if (!cur) continue;
  if (m.g === 1 && m.to.z !== m.from.z && m.to.x === m.from.x && m.to.y === m.from.y) { cur.z = m.to.z; continue; }
  if (m.g === 0) continue;
  if (m.g === 1) cur.segs.push(G.line(m.from, m.to));
  else cur.segs.push(G.arc(m.from, m.to, m.c, m.g === 3));
}
const finalLoops = loops.filter(l => l.z === 0);
console.log('loops', loops.length, 'final-depth loops', finalLoops.length);

// de-offset: toolpath is CCW with part inside -> offset by -r
const r = 0.1875;
const shapes = finalLoops.map(l => {
  const tp = l.segs.map(s => s.type === 'line' ? G.line({ x: s.a.x, y: s.a.y }, { x: s.b.x, y: s.b.y }) : G.arc({ x: s.a.x, y: s.a.y }, { x: s.b.x, y: s.b.y }, { x: s.c.x, y: s.c.y }, s.ccw));
  const part = G.offsetLoop(tp, -r);
  return { loop: part, op: 'outside', toolId: 1, startHint: l.start };
});
fs.writeFileSync(__dirname + '/parts.json', JSON.stringify(shapes.map(s => s.loop), null, 1));
console.log('part 0 segs:', shapes[0].loop.length, 'area', G.signedArea(shapes[0].loop).toFixed(4));
console.log('part 1 segs:', shapes[1].loop.length, 'area', G.signedArea(shapes[1].loop).toFixed(4));
shapes[0].loop.forEach(s => console.log(s.type, s.a.x.toFixed(4), s.a.y.toFixed(4), '->', s.b.x.toFixed(4), s.b.y.toFixed(4), s.type === 'arc' ? 'R' + G.radius(s).toFixed(4) + (s.ccw ? ' ccw' : ' cw') : ''));

const job = { shapes, tools: POST.DEFAULT_TOOLS, material: { thickness: 0.1875 }, cutThrough: 0 };
const out = POST.generate(job);
fs.writeFileSync(__dirname + '/regen.tap', out.gcode);
const a = src.split('\r\n'), b = out.gcode.split('\r\n');
let diffs = 0;
for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { if (diffs < 15) console.log(`line ${i + 1}: orig="${a[i]}" new="${b[i]}"`); diffs++; }
console.log('total lines', a.length, b.length, 'differing lines:', diffs);
console.log('identical:', src === out.gcode);

// ---- order-independent comparison with tolerance
function blocks(text) { return text.split('\r\n\r\n').slice(1, -1); } // per-pass blocks
const ba = blocks(src), bb = blocks(out.gcode);
console.log('blocks', ba.length, bb.length);
const numsOf = (s) => s.match(/-?\d+\.?\d*/g).map(Number);
const shape = (s) => s.replace(/-?\d+\.?\d*/g, '#');
let matched = 0, maxDev = 0; const used = new Set();
for (const A of ba) {
  let found = false;
  for (let j = 0; j < bb.length; j++) {
    if (used.has(j)) continue; const B = bb[j];
    if (shape(A) !== shape(B)) continue;
    const na = numsOf(A), nb = numsOf(B); let dev = 0;
    for (let k = 0; k < na.length; k++) dev = Math.max(dev, Math.abs(na[k] - nb[k]));
    if (dev <= 3e-4) { used.add(j); matched++; maxDev = Math.max(maxDev, dev); found = true; break; }
  }
  if (!found) console.log('UNMATCHED block:\n' + A.slice(0, 200));
}
console.log(`matched ${matched}/${ba.length} pass-blocks, max coordinate deviation ${maxDev}`);
console.log('header/footer identical:', src.split('\r\n\r\n')[0] === out.gcode.split('\r\n\r\n')[0] && src.split('\r\n\r\n').pop() === out.gcode.split('\r\n\r\n').pop());
