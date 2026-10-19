/* Unit tests for the smart guides (edge/centre alignment, equal spacing).
   Run: node test/align_test.js   (exits non-zero on failure) */
const ALIGN = require('../src/align.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}
const near = (a, b, t = 1e-9) => Math.abs(a - b) < t;
const box = (x0, y0, w, h) => ({ x0, y0, x1: x0 + w, y1: y0 + h });

console.log('alignment');
{
  const others = [box(0, 0, 1, 1)];
  const r = ALIGN.guides(box(3, 0.03, 1, 1), others, 0.1);
  ok(near(r.dy, -0.03), 'bottom edge pulled onto the other part\'s bottom edge', `dy=${r.dy}`);
  ok(r.lines.some(l => l.axis === 'y' && near(l.at, 0) && l.kind === 'edge'), 'edge line drawn at y=0');
  ok(r.lines.some(l => l.axis === 'y' && near(l.at, 0.5) && l.kind === 'centre'), 'centres line up too, and say so');
  const line = r.lines.find(l => l.axis === 'y' && near(l.at, 0));
  ok(near(line.from, 0) && near(line.to, 4), 'line runs across both parts', `${line.from}..${line.to}`);
}
{
  // 0.3 keeps every edge and centre at least 0.2 from the other part's (0.5 would sit on its centre)
  const r = ALIGN.guides(box(3, 0.3, 1, 1), [box(0, 0, 1, 1)], 0.1);
  ok(near(r.dy, 0) && !r.lines.some(l => l.axis === 'y'), 'out of reach: no pull, no line');
}
{
  // a hole on a plate's centre line, nudged off by 0.01
  const plate = box(0, 0, 10, 4), hole = box(4.51, 1, 1, 1);
  const r = ALIGN.guides(hole, [plate], 0.05);
  ok(near(r.dx, -0.01), 'hole centre pulled onto the plate centre', `dx=${r.dx}`);
}

console.log('equal spacing');
{
  // two parts 1 apart; the third dragged to roughly the same gap
  const a = box(0, 0, 1, 1), b = box(2, 0, 1, 1);
  const r = ALIGN.guides(box(4.04, 0, 1, 1), [a, b], 0.1);
  ok(near(r.dx, -0.04), 'gap matched to the existing 1.0 gap', `dx=${r.dx}`);
  ok(r.gaps.filter(g => g.axis === 'x').length === 2, 'both equal gaps are marked', JSON.stringify(r.gaps.map(g => g.g)));
  ok(r.gaps.every(g => near(g.g, 1)), 'marked gaps read 1.0');
}
{
  // centred between two neighbours
  const L = box(0, 0, 1, 1), R = box(4, 0, 1, 1);
  const r = ALIGN.guides(box(2.06, 0, 1, 1), [L, R], 0.1);
  ok(near(r.dx, -0.06), 'centred between neighbours', `dx=${r.dx}`);
  ok(r.gaps.length === 2 && near(r.gaps[0].g, 1) && near(r.gaps[1].g, 1), 'two equal 1.0 gaps either side');
}
{
  // a plate the part sits inside is not its neighbour
  const plate = box(0, 0, 20, 5), a = box(2, 2, 1, 1), b = box(4, 2, 1, 1);
  const r = ALIGN.guides(box(6, 2, 1, 1), [plate, a, b], 0);
  ok(r.gaps.length === 2 && r.gaps.every(g => near(g.g, 1)), 'gaps found between holes inside a plate', JSON.stringify(r.gaps.map(g => g.g)));
}

console.log('check only (no drag)');
{
  const r = ALIGN.guides(box(3, 0.0003, 1, 1), [box(0, 0, 1, 1)], 0);
  ok(r.dx === 0 && r.dy === 0, 'tol 0 never moves anything');
  ok(!r.lines.some(l => l.axis === 'y'), '0.0003 off is not shown as in line');
  const r2 = ALIGN.guides(box(3, 0, 1, 1), [box(0, 0, 1, 1)], 0);
  ok(r2.lines.some(l => l.axis === 'y' && near(l.at, 0)), 'exactly in line is shown');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
