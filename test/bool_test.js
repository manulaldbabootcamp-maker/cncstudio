/* Boolean ops + arc refit. Areas are the real check: a union/subtract that
   produces a plausible-looking but wrong outline shows up immediately as a
   wrong area. Run: node test/bool_test.js */
const G = require('../src/geom.js');
const BOOL = require('../src/bool.js');

let pass = 0, fail = 0;
function ok(c, name, extra) { if (c) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); } }
const A = (loops) => loops.reduce((s, l) => s + Math.abs(G.signedArea(l)), 0);
const near = (a, b, t = 0.01) => Math.abs(a - b) < t;

console.log('overlapping rectangles');
// 10x6 at origin, 10x6 at (5,3) -> overlap 5x3 = 15
const r1 = G.rectLoop(0, 0, 10, 6);
const r2 = G.rectLoop(5, 3, 10, 6);
const u = BOOL.operate('union', r1, r2);
ok(!u.error, 'union runs', u.error);
ok(u.loops && near(A(u.loops), 60 + 60 - 15), 'union area = 105', u.loops && A(u.loops));
const it = BOOL.operate('intersect', r1, r2);
ok(it.loops && near(A(it.loops), 15), 'intersection area = 15', it.loops && A(it.loops));
const sb = BOOL.operate('subtract', r1, r2);
ok(sb.loops && near(A(sb.loops), 45), 'subtract area = 45', sb.loops && A(sb.loops));

console.log('notch: subtract a small rect from an edge');
const plate = G.rectLoop(0, 0, 12, 8);
const notch = G.rectLoop(4, -1, 3, 3);        // pokes into the bottom edge, 3x2 inside
const nres = BOOL.operate('subtract', plate, notch);
ok(nres.loops && near(A(nres.loops), 96 - 6), 'notched plate area = 90', nres.loops && A(nres.loops));

console.log('disjoint and containment');
const far = G.rectLoop(50, 50, 4, 4);
const dj = BOOL.operate('union', r1, far);
ok(dj.loops && dj.loops.length === 2, 'disjoint union keeps both shapes');
const dint = BOOL.operate('intersect', r1, far);
ok(!!dint.error, 'disjoint intersect reports nothing in common');
const inner = G.rectLoop(2, 2, 3, 2);
const cont = BOOL.operate('subtract', plate, inner);
ok(cont.loops && cont.hole, 'fully-contained subtract returns a hole');
ok(cont.hole && near(Math.abs(G.signedArea(cont.hole)), 6), 'hole area = 6');
const cu = BOOL.operate('union', plate, inner);
ok(cu.loops && cu.loops.length === 1 && near(A(cu.loops), 96), 'union with a contained shape is just the outer');

console.log('arcs survive: subtract a circle from a plate');
const circ = G.circleLoop(6, 4, 2);
const holed = BOOL.operate('intersect', plate, circ);
ok(holed.loops && near(A(holed.loops), Math.PI * 4, 0.02), 'circle fully inside: intersect area = pi*r^2', holed.loops && A(holed.loops));
ok(holed.loops && holed.loops[0].some(s => s.type === 'arc'), 'result still contains arc segments (refit worked)');
const arcCount = holed.loops[0].filter(s => s.type === 'arc').length;
ok(arcCount <= 8, 'circle refits to a handful of arcs, not hundreds', 'arcs=' + arcCount + ' segs=' + holed.loops[0].length);

console.log('arc refit accuracy');
// a circle flattened then refitted should keep its radius
const flat = BOOL.flatten(G.circleLoop(0, 0, 3), 0.001);
const refitted = BOOL.refit(flat, 0.004);
const arcs = refitted.filter(s => s.type === 'arc');
ok(arcs.length > 0, 'flattened circle refits to arcs');
const maxRerr = arcs.reduce((m, s) => Math.max(m, Math.abs(G.radius(s) - 3)), 0);
ok(maxRerr < 0.01, 'refitted radius within 0.01 of true radius', 'err=' + maxRerr);
ok(near(Math.abs(G.signedArea(refitted)), Math.PI * 9, 0.02), 'refitted circle area preserved', Math.abs(G.signedArea(refitted)));

console.log('refit leaves straight edges alone');
const sq = BOOL.flatten(G.rectLoop(0, 0, 10, 10), 0.001);
const sqr = BOOL.refit(sq, 0.004);
ok(sqr.every(s => s.type === 'line'), 'a square refits to lines only, no phantom arcs', JSON.stringify(sqr.map(s => s.type)));
ok(sqr.length === 4, 'square stays 4 segments', sqr.length);

console.log('degenerate: shared edge (retry path)');
const sh1 = G.rectLoop(0, 0, 5, 5);
const sh2 = G.rectLoop(5, 0, 5, 5);          // touches exactly along x=5
const shr = BOOL.operate('union', sh1, sh2);
ok(!!shr.loops || !!shr.error, 'shared-edge union returns a result or a clear error, never a crash');
if (shr.loops) ok(near(A(shr.loops), 50, 0.05), 'shared-edge union area = 50', A(shr.loops));
else console.log('       (reported: ' + shr.error + ')');

console.log('degenerate placements that used to be refused');
/* A circle centred exactly ON the edge it is subtracted from is the ordinary
   way to make a semicircular notch, and it used to fail outright. The radial
   nudge could not fix it: for a circle centred on the line, its topmost and
   bottommost vertices move PARALLEL to that line and stay on it. */
const edgeNotch = BOOL.operate('subtract', G.rectLoop(18, 0, 12, 8), G.circleLoop(30, 4, 2.5));
ok(!edgeNotch.error, 'a circle centred on an edge can be subtracted', edgeNotch.error);
ok(edgeNotch.loops && near(A(edgeNotch.loops), 96 - Math.PI * 2.5 * 2.5 / 2, 0.02), 'and the notch area is right', edgeNotch.loops && A(edgeNotch.loops));
ok(edgeNotch.loops && edgeNotch.loops[0].some(s => s.type === 'arc'), 'the notch is still a true arc');

const corner = BOOL.operate('subtract', G.rectLoop(0, 0, 10, 8), G.circleLoop(10, 8, 2));
ok(corner.loops && near(A(corner.loops), 80 - Math.PI * 4 / 4, 0.02), 'a circle centred on a corner cuts a quarter round', corner.loops && A(corner.loops));

const inscribed = BOOL.operate('subtract', G.rectLoop(0, 0, 8, 8), G.circleLoop(4, 4, 4));
ok(inscribed.loops && near(A(inscribed.loops), 64 - Math.PI * 16, 0.05), 'a circle touching two edges from inside leaves the four corners', inscribed.loops && A(inscribed.loops));

const same = BOOL.operate('union', G.rectLoop(0, 0, 5, 5), G.rectLoop(0, 0, 5, 5));
ok(same.loops && near(A(same.loops), 25, 0.01), 'union of two identical rectangles is one of them', same.loops && A(same.loops));

console.log('a wrong result must not short-circuit a better strategy');
// every accepted answer has to satisfy the area bounds for its operation
for (const [op, a, b, lo, hi] of [
  ['union', G.rectLoop(0, 0, 10, 6), G.rectLoop(5, 3, 10, 6), 60, 120],
  ['intersect', G.rectLoop(0, 0, 10, 6), G.rectLoop(5, 3, 10, 6), 0, 60],
  ['subtract', G.rectLoop(0, 0, 10, 6), G.rectLoop(5, 3, 10, 6), 0, 60],
]) {
  const r = BOOL.operate(op, a, b);
  const got = r.loops ? A(r.loops) : null;
  ok(r.error || (got >= lo - 0.01 && got <= hi + 0.01), `${op} result stays inside its area bounds`, String(got));
}

console.log('the same shapes must resolve the same anywhere on the bed');
/* Two butted squares unioned correctly at the origin but returned only ONE of
   them further out. Area bounds alone could not catch it: when both inputs have
   the same area, "one of them" satisfies them. The result must also REACH far
   enough to span both inputs. */
for (const x of [0, 20, 62, 100]) {
  const r = BOOL.operate('union', G.rectLoop(x, 0, 5, 5), G.rectLoop(x + 5, 0, 5, 5));
  ok(r.loops && near(A(r.loops), 50, 0.05), `butted squares union to 50 at x=${x}`, r.error || (r.loops && A(r.loops)));
  /* And as ONE outline. Touching shapes have no crossings, only contact, so a
     naive read of "no crossings" returned them unmerged - which would cut the
     shared edge twice. */
  ok(r.loops && r.loops.length === 1, `and as a single merged outline at x=${x}`, r.loops && String(r.loops.length));
  const b = r.loops && G.bbox(r.loops[0]);
  ok(b && near(b.x0, x, 0.01) && near(b.x1, x + 10, 0.01), `spanning ${x}..${x + 10}`, b && `${b.x0}..${b.x1}`);
}
{
  // shapes that genuinely do not touch must still come back separate
  const far = BOOL.operate('union', G.rectLoop(0, 0, 5, 5), G.rectLoop(50, 50, 5, 5));
  ok(far.loops && far.loops.length === 2, 'shapes far apart are still kept as two', far.loops && String(far.loops.length));
}

console.log('orientation');
ok(u.loops.every(l => G.signedArea(l) > 0), 'all result loops come back CCW');

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
