/* Post-processor safety. These are the cases that scrap material rather than
   merely look wrong: a feature the cutter cannot fit into, an offset that folds
   over itself, a depth setting that reaches past the stock. Each must be
   reported, and a job with none of them must stay silent.
   Run: node test/post_test.js */
const G = require('../src/geom.js');
const POST = require('../src/post.js');

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + x : '')); } };

const tool = (dia, passDepth = 0.125) => ({ id: 1, slot: 1, name: `${dia}in cutter`, dia, rpm: 17000, feed: 200, plunge: 20, passDepth, type: 'endmill' });
const gen = (shapes, t, thickness = 0.1875, cutThrough = 0) =>
  POST.generate({ shapes, tools: [t], material: { name: 'test', thickness }, cutThrough });
const issuesOf = (r) => (r.stats.issues || []).join(' | ');

console.log('a feature smaller than the cutter is refused, not silently skipped');
{
  const r = gen([{ loop: G.circleLoop(5, 5, 0.10), op: 'inside', toolId: 1, name: 'small hole' }], tool(0.25));
  ok(r.stats.passes === 0, 'a 0.20 hole is not cut with a 0.25 cutter');
  ok(/too small to cut inside/.test(issuesOf(r)), 'and says so', issuesOf(r));
  ok(/small hole/.test(issuesOf(r)), 'naming the part, so it can be found on the drawing', issuesOf(r));
}
{
  // the dangerous one: this used to emit a collapsed sliver, which would have
  // cut the slot to the tool's width instead of the drawing's
  const r = gen([{ loop: G.rectLoop(2, 2, 6, 0.20, 0), op: 'inside', toolId: 1, name: 'narrow slot' }], tool(0.25));
  ok(r.stats.passes === 0, 'a 0.20-wide slot is not cut with a 0.25 cutter');
  ok(/too small to cut inside/.test(issuesOf(r)), 'and says so rather than cutting it oversize', issuesOf(r));
}

console.log('an offset that folds the outline over is refused');
{
  // L-shape with 4-wide legs; a 5in cutter cannot fit inside it at all
  const L = G.polyLoop([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 6, y: 10 }, { x: 6, y: 4 }, { x: 0, y: 4 }]);
  const r = gen([{ loop: L, op: 'inside', toolId: 1, name: 'bracket' }], tool(5));
  ok(r.stats.passes === 0, 'an inside cut narrower than the cutter produces no path');
  ok(/inside out|folds over/.test(issuesOf(r)), 'and explains why', issuesOf(r));
}
{
  const path = G.offsetLoop(G.polyLoop([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 6, y: 10 }, { x: 6, y: 4 }, { x: 0, y: 4 }]), -2.5);
  ok(G.signedArea(path) < 0, 'the raw offset really does invert (the bug being guarded)', String(G.signedArea(path).toFixed(3)));
}

console.log('self-intersection detection');
{
  // a square path crossed into a bow tie
  const bow = [G.line({ x: 0, y: 0 }, { x: 10, y: 10 }), G.line({ x: 10, y: 10 }, { x: 10, y: 0 }),
               G.line({ x: 10, y: 0 }, { x: 0, y: 10 }), G.line({ x: 0, y: 10 }, { x: 0, y: 0 })];
  ok(POST.selfIntersects(bow) === true, 'a self-crossing path is detected');
  ok(POST.selfIntersects(G.rectLoop(0, 0, 10, 6)) === false, 'a plain rectangle is not');
  ok(POST.selfIntersects(G.circleLoop(0, 0, 4)) === false, 'nor is a circle');
}

console.log('depth settings that reach past the stock');
{
  const r = gen([{ loop: G.rectLoop(0, 0, 4, 4), op: 'outside', toolId: 1, name: 'plate' }], tool(0.25), 0.1875, 0.5);
  ok(/deeper than/.test(issuesOf(r)), 'cut-through deeper than the material is reported', issuesOf(r));
  ok(r.stats.passes > 0, 'but it is still cut - the operator may mean it');
}
{
  const r = gen([{ loop: G.rectLoop(0, 0, 4, 4), op: 'outside', toolId: 1, name: 'plate' }], tool(0.25, 0));
  ok(/one full-depth pass/.test(issuesOf(r)), 'a zero pass depth is reported', issuesOf(r));
  ok(r.stats.passes === 1, 'and still cuts, in a single pass');
}

console.log('a sound job stays silent');
{
  const r = gen([
    { loop: G.rectLoop(0, 0, 10, 6), op: 'outside', toolId: 1, name: 'plate' },
    { loop: G.circleLoop(5, 3, 1), op: 'inside', toolId: 1, name: 'hole' },
  ], tool(0.25));
  ok((r.stats.issues || []).length === 0, 'no issues raised on a normal job', issuesOf(r));
  ok(r.stats.passes === 4, 'and both parts are cut', String(r.stats.passes));
}
{
  // a hole exactly the tool diameter cannot be cut either - it leaves nothing to remove
  const r = gen([{ loop: G.circleLoop(5, 5, 0.125), op: 'inside', toolId: 1, name: 'exact' }], tool(0.25));
  ok(r.stats.passes === 0, 'a hole exactly the cutter diameter is refused');
  const r2 = gen([{ loop: G.circleLoop(5, 5, 0.2), op: 'inside', toolId: 1, name: 'ok hole' }], tool(0.25));
  ok(r2.stats.passes > 0 && (r2.stats.issues || []).length === 0, 'a hole comfortably larger is cut without complaint', issuesOf(r2));
}

console.log('outside cuts are not restricted by tool size');
{
  // a tiny part can still be cut FREE by a big tool - only inside cuts are limited
  const r = gen([{ loop: G.circleLoop(5, 5, 0.15), op: 'outside', toolId: 1, name: 'tiny disc' }], tool(0.25));
  ok(r.stats.passes > 0, 'a small part can still be profiled from the outside', issuesOf(r));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
