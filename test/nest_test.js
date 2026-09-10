/* True-shape nesting. The claims worth holding the algorithm to: nothing
   overlaps, nothing crosses the margin, the gap between parts is respected,
   parts that will not fit are reported rather than dropped, and real outlines
   beat bounding boxes on the shapes where it matters.
   Run: node test/nest_test.js */
const G = require('../src/geom.js');
const NEST = require('../src/nest.js');

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + x : '')); } };

const unit = (id, loop, clearance = 0.4, rotations = [0, 90, 180, 270]) => ({ id, loops: [loop], clearance, rotations });
const many = (n, f, cl, rots) => Array.from({ length: n }, (_, i) => unit(i + 1, f(), cl, rots));
const L = () => G.polyLoop([{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 9 }, { x: 0, y: 9 }]);

// where a placed unit's outline ends up
function placedLoops(units, res) {
  const byId = new Map(units.map(u => [u.id, u]));
  const out = [];
  for (const p of res.placed) {
    const u = byId.get(p.id);
    const rad = p.rot * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
    for (const loop of u.loops) {
      const rotated = G.transformLoop(loop, q => G.P(q.x * c - q.y * s, q.x * s + q.y * c));
      const b = G.bbox(rotated);
      out.push({ id: p.id, loop: G.translateLoop(rotated, p.x - b.x0, p.y - b.y0) });
    }
  }
  return out;
}
// closest approach between two outlines, sampled
function clearanceBetween(a, b) {
  let best = Infinity;
  const pa = G.loopPts(a, 0.15), pb = G.loopPts(b, 0.15);
  for (const p of pa) for (const q of pb) {
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < best) best = d;
  }
  return best;
}

console.log('a simple sheet');
{
  const units = many(12, () => G.rectLoop(0, 0, 6.5, 7, 0.25));
  const res = NEST.nestParts(units, { bedW: 60, bedH: 120, margin: 0.5 });
  ok(res.placed.length === 12 && res.failed.length === 0, '12 panels all placed', `${res.placed.length}/12`);
  const loops = placedLoops(units, res);
  let inside = true;
  for (const { loop } of loops) {
    const b = G.bbox(loop);
    if (b.x0 < 0.5 - 1e-6 || b.y0 < 0.5 - 1e-6 || b.x1 > 59.5 + 1e-6 || b.y1 > 119.5 + 1e-6) inside = false;
  }
  ok(inside, 'every part lands inside the margin');
  ok(res.ms < 2000, 'and it finishes quickly', res.ms + ' ms');
}

console.log('nothing overlaps, and the gap is kept');
{
  // few parts, tight bed, so they are forced close together
  const units = many(6, () => G.rectLoop(0, 0, 5, 4, 0), 0.5, [0, 90]);
  const res = NEST.nestParts(units, { bedW: 20, bedH: 20, margin: 0.5 });
  const loops = placedLoops(units, res);
  let worst = Infinity, overlap = false;
  for (let i = 0; i < loops.length; i++) {
    for (let j = i + 1; j < loops.length; j++) {
      const bi = G.bbox(loops[i].loop), bj = G.bbox(loops[j].loop);
      if (!(bi.x1 < bj.x0 || bj.x1 < bi.x0 || bi.y1 < bj.y0 || bj.y1 < bi.y0)) overlap = true;
      worst = Math.min(worst, clearanceBetween(loops[i].loop, loops[j].loop));
    }
  }
  ok(!overlap, 'no two placed parts overlap');
  // each was dilated by 0.5, so outlines should stand off by about 1.0
  ok(worst > 0.6, 'outlines keep a real gap between them', 'closest ' + worst.toFixed(3) + ' in');
}

console.log('true shapes beat bounding boxes');
{
  // an L fills 56% of its box, so box packing wastes the rest
  const units = many(12, L, 0.3);
  const shaped = NEST.nestParts(units, { bedW: 30, bedH: 30, margin: 0.5 });
  const boxed = NEST.nest(units.map(u => ({ id: u.id, w: 9.6, h: 9.6 })), 30, 30, 0.3, 0.5, true);
  const boxedOk = boxed.filter(p => !p.fail).length;
  ok(shaped.placed.length > boxedOk, `true-shape fits more L-brackets than boxes (${shaped.placed.length} vs ${boxedOk})`);
  ok(shaped.placed.length === 12, 'and fits all twelve', String(shaped.placed.length));
}

console.log('parts that will not fit are reported, and the rest still place');
{
  const units = many(200, () => G.rectLoop(0, 0, 6.5, 7, 0.25));
  const res = NEST.nestParts(units, { bedW: 60, bedH: 120, margin: 0.5 });
  ok(res.placed.length > 100, 'a big overflow still packs the sheet', String(res.placed.length));
  ok(res.failed.length === 200 - res.placed.length, 'every part is either placed or reported, none lost',
    `${res.placed.length} + ${res.failed.length}`);
  const ids = new Set([...res.placed.map(p => p.id), ...res.failed]);
  ok(ids.size === 200, 'and each appears exactly once');
  ok(res.used > 0.7, 'the sheet is well filled', (100 * res.used).toFixed(1) + '%');
}
{
  // one part simply too big for the sheet
  // 80x8 would fit a 60x120 bed once turned, so use one too big in both directions
  const units = [unit(1, G.rectLoop(0, 0, 80, 80, 0)), unit(2, G.rectLoop(0, 0, 6, 6, 0))];
  const res = NEST.nestParts(units, { bedW: 60, bedH: 120, margin: 0.5 });
  ok(res.failed.includes(1), 'a part larger than the bed is reported as not fitting');
  ok(res.placed.some(p => p.id === 2), 'while the rest of the job is still nested');
}

console.log('rotation');
{
  // 11 x 30 blanks: upright they do not fit two across a 25 wide bed, turned they do
  const units = many(4, () => G.rectLoop(0, 0, 30, 11, 0), 0.2, [0, 90, 180, 270]);
  const free = NEST.nestParts(units, { bedW: 25, bedH: 60, margin: 0.5 });
  const fixed = NEST.nestParts(many(4, () => G.rectLoop(0, 0, 30, 11, 0), 0.2, [0]), { bedW: 25, bedH: 60, margin: 0.5 });
  ok(free.placed.length > fixed.placed.length,
    `turning parts fits more (${free.placed.length} vs ${fixed.placed.length} without rotation)`);
  ok(fixed.placed.length === 0, 'and a 30 in part genuinely will not fit a 25 in bed unturned', String(fixed.placed.length));
}

console.log('holes are usable space');
{
  // a ring: big disc with a big hole. A small disc should nest inside the hole.
  const ring = { id: 'ring', loops: [G.circleLoop(0, 0, 10), G.circleLoop(0, 0, 7)], clearance: 0.1, rotations: [0] };
  const small = unit('small', G.circleLoop(0, 0, 3), 0.1, [0]);
  const res = NEST.nestParts([ring, small], { bedW: 24, bedH: 24, margin: 0.5 });
  ok(res.placed.length === 2, 'both the ring and the small disc are placed', String(res.placed.length));
  const loops = placedLoops([ring, small], res);
  const ringOuter = loops.find(l => l.id === 'ring');
  const inner = loops.find(l => l.id === 'small');
  if (ringOuter && inner) {
    const rb = G.bbox(ringOuter.loop), ib = G.bbox(inner.loop);
    const within = ib.x0 >= rb.x0 && ib.x1 <= rb.x1 && ib.y0 >= rb.y0 && ib.y1 <= rb.y1;
    ok(within, 'the small disc nests inside the ring rather than beside it', JSON.stringify({ ring: [rb.x0.toFixed(1), rb.x1.toFixed(1)], small: [ib.x0.toFixed(1), ib.x1.toFixed(1)] }));
  }
}

console.log('rasterising');
{
  const m = NEST.rasterize([G.rectLoop(0, 0, 4, 2, 0)], 0.1, 0);
  ok(Math.abs(m.w - 40) <= 1 && Math.abs(m.h - 20) <= 1, 'a 4x2 rectangle rasterises to about 40x20 cells', `${m.w}x${m.h}`);
  let n = 0; for (let i = 0; i < m.data.length; i++) if (m.data[i]) n++;
  ok(Math.abs(n * 0.01 - 8) < 0.4, 'and its filled area is about 8 sq in', (n * 0.01).toFixed(2));

  const rot = NEST.rasterize([G.rectLoop(0, 0, 4, 2, 0)], 0.1, 90);
  ok(Math.abs(rot.w - 20) <= 1 && Math.abs(rot.h - 40) <= 1, 'rotated 90 degrees it is about 20x40', `${rot.w}x${rot.h}`);

  // a hole must leave a gap in the mask
  const ring = NEST.rasterize([G.circleLoop(0, 0, 4), G.circleLoop(0, 0, 2)], 0.1, 0);
  const mid = ring.data[Math.floor(ring.h / 2) * ring.w + Math.floor(ring.w / 2)];
  ok(!mid, 'the middle of a ring is left free, so another part can go there');

  const grown = NEST.dilate(NEST.rasterize([G.rectLoop(0, 0, 4, 2, 0)], 0.1, 0), 5);
  ok(grown.w === m.w + 10 && grown.h === m.h + 10, 'dilating by 5 cells grows the mask by 5 each side', `${grown.w}x${grown.h}`);
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
