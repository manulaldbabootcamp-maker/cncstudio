/* Cutting an open path to one side, and dividing a shape into regions.
   These are the claims worth holding them to: the side does not depend on which
   way the line was drawn, a square drawn as lines keeps square corners, the cut
   edge reaches the ends of the line, and a circle crossed by radii divides into
   the slices an operator would count.
   Run: node test/side_test.js */
const G = require('../src/geom.js');
const POST = require('../src/post.js');
const REGION = require('../src/region.js');

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + x : '')); } };

const tool = (dia = 0.25) => ({ id: 1, slot: 1, name: `${dia}in`, dia, rpm: 18000, feed: 150, plunge: 20, passDepth: 0.125, type: 'endmill' });
const pathOf = (loop, op) => POST.buildToolpathLoop({ loop, open: true, op }, tool(0.25), {});

console.log('the side does not depend on which way the line was drawn');
{
  // the same line, drawn left to right and right to left
  const fwd = [G.line(G.P(5, 10), G.P(15, 10))];
  const rev = [G.line(G.P(15, 10), G.P(5, 10))];
  const a = pathOf(fwd, 'left'), b = pathOf(rev, 'left');
  ok(a.length > 0 && b.length > 0, 'both directions produce a path');
  const ya = a[0].a.y, yb = b[0].a.y;
  ok(Math.abs(ya - yb) < 1e-9, 'left is the same side either way', `${ya} vs ${yb}`);
  ok(ya > 10, 'and left of a line running right is above it', String(ya));

  const r = pathOf(fwd, 'right');
  ok(r[0].a.y < 10, 'right is the other side', String(r[0].a.y));
  ok(Math.abs(Math.abs(r[0].a.y - 10) - 0.125) < 1e-9, 'standing off by the tool radius', String(r[0].a.y));
}
{
  // a vertical line: bottom-to-top is the canonical run, so left is to the west
  const up = [G.line(G.P(10, 5), G.P(10, 15))];
  const down = [G.line(G.P(10, 15), G.P(10, 5))];
  const a = pathOf(up, 'left'), b = pathOf(down, 'left');
  ok(Math.abs(a[0].a.x - b[0].a.x) < 1e-9, 'a vertical line, drawn either way, keeps its left', `${a[0].a.x} vs ${b[0].a.x}`);
  ok(a[0].a.x < 10, 'and left of a line running up is to its left on screen', String(a[0].a.x));
}

console.log('cutting on the line is what it always was');
{
  const l = [G.line(G.P(0, 0), G.P(10, 0))];
  const p = pathOf(l, 'on');
  ok(p.length === 1 && Math.abs(p[0].a.y) < 1e-12 && Math.abs(p[0].b.y) < 1e-12, 'an on-line cut is not offset at all');
}

console.log('a square drawn as lines keeps square corners');
{
  // three sides of a square, drawn as an open path
  const sq = [
    G.line(G.P(0, 0), G.P(10, 0)),
    G.line(G.P(10, 0), G.P(10, 10)),
    G.line(G.P(10, 10), G.P(0, 10)),
  ];
  const p = pathOf(sq, 'right');
  ok(p.every(s => s.type === 'line'), 'the offset path is all straight - no radius dropped into the corners',
    JSON.stringify(p.map(s => s.type)));
  // the mitred corner sits exactly one radius out from the drawn corner
  const corner = p.find(s => Math.abs(s.b.x - 10.125) < 1e-6 && Math.abs(s.b.y + 0.125) < 1e-6)
    || p.find(s => Math.abs(s.a.x - 10.125) < 1e-6);
  ok(!!corner, 'and the corner is mitred out to a point', JSON.stringify(p.map(s => [s.a.x, s.a.y, s.b.x, s.b.y])));
}

console.log('the cut edge reaches the ends of the line');
{
  const l = [G.line(G.P(2, 0), G.P(8, 0))];
  const p = pathOf(l, 'right');
  const x0 = Math.min(p[0].a.x, p[0].b.x), x1 = Math.max(p[0].a.x, p[0].b.x);
  ok(Math.abs(x0 - 1.875) < 1e-9 && Math.abs(x1 - 8.125) < 1e-9,
    'the path runs a radius past each end, so the cut edge reaches 2 and 8', `${x0}..${x1}`);
}

console.log('a path the cutter cannot follow is refused, not cut wrong');
{
  /* A simple hairpin does NOT fold: mitring a two-segment turn-back slides the
     joint along the bisector and the two legs stay parallel. Measured at 170,
     175, 178 and 179 degrees with tools up to 1 in - no crossings. What folds
     is a path with legs closer together than the cutter, so that is what is
     tested here. */
  const comb = (gap) => {
    const segs = [];
    let x = 0, up = true;
    for (let k = 0; k < 5; k++) {
      segs.push(G.line(G.P(x, up ? 0 : 3), G.P(x, up ? 3 : 0)));
      segs.push(G.line(G.P(x, up ? 3 : 0), G.P(x + gap, up ? 3 : 0)));
      x += gap; up = !up;
    }
    return segs;
  };
  /* What matters is whether the cutter FITS BETWEEN the teeth. A 0.5 in cutter
     in a 0.4 in gap does not fit, whichever side is asked for - so both sides
     are refused, and there is no "good side" to be had. Give it a gap wider
     than the cutter and both sides cut. */
  for (const op of ['left', 'right']) {
    const fits = [];
    const p = POST.buildToolpathLoop({ loop: comb(1.2), open: true, op }, tool(0.5), { onIssue: m => fits.push(m) });
    ok(p.length > 0 && fits.length === 0, `a 0.5 in cutter fits a 1.2 in gap, cut ${op}`, JSON.stringify(fits));
  }
  for (const op of ['left', 'right']) {
    const tight = [];
    const p = POST.buildToolpathLoop({ loop: comb(0.4), open: true, op }, tool(0.5), { onIssue: m => tight.push(m) });
    ok(p.length === 0 && /folds over|narrower/.test(tight.join(' ')),
      `a 0.5 in cutter does not fit a 0.4 in gap, cut ${op} - refused, not cut wrong`, JSON.stringify(tight));
  }
}

console.log('an offset that collapses is reported rather than cut down the line');
{
  /* This is the dangerous one. A curve tighter than the cutter radius cannot be
     offset at all, and returning the line unoffset would cut its centre and
     leave the edge a radius out - with nothing said. */
  /* The arc has to run left to right, or canonicalising it reverses the arc and
     flips which side is which - and then the side asked for is the one the
     offset GROWS into, which never collapses. Running (-0.2,0) -> (0.2,0)
     counter-clockwise, the left is the inside of the curve. */
  const smallArc = [G.arc(G.P(-0.2, 0), G.P(0.2, 0), G.P(0, 0), true)];   // r = 0.2, canonical
  const fine = [];
  const okArc = POST.buildToolpathLoop({ loop: smallArc, open: true, op: 'left' }, tool(0.25), { onIssue: m => fine.push(m) });
  ok(okArc.length > 0 && fine.length === 0, 'an r0.2 arc is fine for a 0.25 in cutter (radius 0.125)', JSON.stringify(fine));

  for (const dia of [0.5, 1.0]) {
    const issues = [];
    const p = POST.buildToolpathLoop({ loop: smallArc, open: true, op: 'left' }, tool(dia), { onIssue: m => issues.push(m) });
    ok(p.length === 0, `an r0.2 arc is not cut to one side with a ${dia} in tool`, 'sides=' + p.length);
    ok(/tighter than the cutter/.test(issues.join(' ')), `and says why (${dia} in)`, JSON.stringify(issues));
  }
}

console.log('a pizza divides into slices');
{
  const cx = 20, cy = 20, R = 6;
  const segs = G.circleLoop(cx, cy, R).slice();
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    segs.push(G.line(G.P(cx, cy), G.P(cx + R * Math.cos(a), cy + R * Math.sin(a))));
  }
  const arranged = REGION.arrange(segs, 0.001);
  const faces = REGION.faces(arranged, 0.001);
  ok(faces.length === 8, 'a circle with eight radii gives eight regions', String(faces.length));
  const whole = Math.PI * R * R;
  const each = faces.map(f => f.area);
  ok(each.every(a => Math.abs(a - whole / 8) < 0.05), 'each one an eighth of the circle',
    JSON.stringify(each.map(a => +a.toFixed(2))));
  ok(Math.abs(each.reduce((x, y) => x + y, 0) - whole) < 0.1, 'and together they are the whole circle',
    (each.reduce((x, y) => x + y, 0)).toFixed(2) + ' vs ' + whole.toFixed(2));
}

console.log('and the regions are real outlines, not just areas');
{
  const cx = 0, cy = 0, R = 4;
  const segs = G.circleLoop(cx, cy, R).slice();
  segs.push(G.line(G.P(cx, cy), G.P(cx + R, cy)));
  segs.push(G.line(G.P(cx, cy), G.P(cx - R, cy)));
  const faces = REGION.faces(REGION.arrange(segs, 0.001), 0.001);
  ok(faces.length === 2, 'a circle split by a diameter gives two halves', String(faces.length));
  ok(faces.every(f => f.segs.some(s => s.type === 'arc')), 'each half keeps a true arc for its rim');
  ok(faces.every(f => Math.abs(f.area - Math.PI * R * R / 2) < 0.02), 'and each is half the area',
    JSON.stringify(faces.map(f => +f.area.toFixed(3))));
}

console.log('picking a point inside finds the region, with islands as holes');
{
  const outer = G.circleLoop(0, 0, 10);
  const inner = G.circleLoop(0, 0, 3);
  const segs = outer.concat(inner);
  const arranged = REGION.arrange(segs, 0.001);
  const f = REGION.faceAt(arranged, { x: 6, y: 0 }, 0.001);
  ok(!!f, 'a point in the ring finds a region');
  if (f) {
    ok(Math.abs(Math.abs(f.area) - Math.PI * 100) < 0.5, 'the region is the outer disc', String(f.area.toFixed(2)));
    ok(f.holes.length === 1, 'and the inner circle is an island', String(f.holes.length));
  }
  const g2 = REGION.faceAt(arranged, { x: 0, y: 0 }, 0.001);
  ok(g2 && Math.abs(Math.abs(g2.area) - Math.PI * 9) < 0.2, 'a point in the middle finds the inner circle instead',
    g2 ? String(g2.area.toFixed(2)) : 'none');
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
