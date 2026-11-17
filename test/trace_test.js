/* Unit tests for tracing outlines out of a picture.
   Run: node test/trace_test.js   (exits non-zero on failure) */
const RASTER = require('../src/trace.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}

/* A w×h RGBA picture painted by inkAt(x,y) -> 0..1, 4×4 supersampled so the
   edges are anti-aliased the way a real exported logo is. */
function picture(w, h, inkAt, opts = {}) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0; for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) s += inkAt(x + (i + 0.5) / 4, y + (j + 0.5) / 4) ? 1 : 0;
    const ink = s / 16, p = (y * w + x) * 4;
    if (opts.clear) { px[p] = px[p + 1] = px[p + 2] = 0; px[p + 3] = Math.round(ink * 255); }
    else { const g = Math.round(255 * (opts.white ? ink : 1 - ink)); px[p] = px[p + 1] = px[p + 2] = g; px[p + 3] = 255; }
  }
  return px;
}
const disc = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) <= r;

console.log('trace');
{
  const { rings } = RASTER.trace(picture(64, 64, disc(32, 32, 20)), 64, 64);
  ok(rings.length === 1, 'a black disc is one outline', `got ${rings.length}`);
  const a = Math.abs(RASTER.area(rings[0].pts));
  ok(Math.abs(a - Math.PI * 400) / (Math.PI * 400) < 0.01, 'its area is the disc\'s within 1%', `area=${a.toFixed(1)}`);
  ok(rings[0].pts.length < 80, 'simplified rather than one point per pixel', `${rings[0].pts.length} points`);
  ok(rings[0].depth === 0, 'and it is an outline, not a hole');
}
{
  const ring = (x, y) => { const d = Math.hypot(x - 40, y - 40); return d <= 30 && d >= 15; };
  const { rings } = RASTER.trace(picture(80, 80, ring), 80, 80);
  ok(rings.length === 2, 'a washer gives two outlines', `got ${rings.length}`);
  ok(rings.some(r => r.depth === 0) && rings.some(r => r.depth === 1), 'the inner one is marked as a hole');
}
{
  // island in a hole: washer with a dot in the middle
  const f = (x, y) => { const d = Math.hypot(x - 40, y - 40); return (d <= 30 && d >= 15) || d <= 6; };
  const { rings } = RASTER.trace(picture(80, 80, f), 80, 80);
  ok(rings.length === 3 && rings.some(r => r.depth === 2), 'a dot inside the hole is an outline again (depth 2)', rings.map(r => r.depth).join(','));
}
{
  const { rings } = RASTER.trace(picture(64, 64, disc(32, 32, 20), { clear: true }), 64, 64);
  ok(rings.length === 1, 'black ink on a clear PNG: traces the ink, not the clear frame', `got ${rings.length}`);
}
{
  const px = picture(64, 64, disc(32, 32, 20), { white: true });
  ok(RASTER.trace(px, 64, 64, { invert: true }).rings.length === 1, 'white on black traces with "light shapes"');
}
{
  const f = (x, y) => Math.hypot(x - 32, y - 32) <= 20 || Math.hypot(x - 5, y - 5) <= 1;
  const { rings } = RASTER.trace(picture(64, 64, f), 64, 64, { minArea: 20 });
  ok(rings.length === 1, 'a speck smaller than the limit is dropped', `got ${rings.length}`);
}
{
  // ink running off the edge of the picture still closes
  const { rings } = RASTER.trace(picture(40, 40, (x, y) => x < 20), 40, 40);
  ok(rings.length === 1 && Math.abs(Math.abs(RASTER.area(rings[0].pts)) - 800) < 40, 'ink touching the border closes along it', rings.length ? Math.abs(RASTER.area(rings[0].pts)).toFixed(0) : '');
}
{
  const blank = picture(20, 20, () => false);
  ok(RASTER.trace(blank, 20, 20).rings.length === 0, 'a blank page traces nothing');
}

console.log('centre lines');
// distance from p to segment ab, for drawing strokes
const segD = (px, py, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy))); return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy); };
const stroke = (segs, half) => (x, y) => segs.some(([a, b]) => segD(x, y, a, b) <= half);
const len = (p) => { let s = 0; for (let i = 1; i < p.length; i++) s += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y); return s; };
{
  const { paths, rings } = RASTER.trace(picture(200, 100, stroke([[[20, 50], [180, 50]]], 4)), 200, 100, { centre: true });
  ok(rings.length === 0 && paths.length === 1 && !paths[0].closed, 'a thick straight stroke is ONE open line, not two outlines', JSON.stringify(paths.map(p => [p.pts.length, p.closed])));
  const p = paths[0] && paths[0].pts;
  ok(p && p.length === 2 && p.every(q => Math.abs(q.y - 49.5) <= 1) && len(p) > 145, 'running down the middle of it, nearly end to end', JSON.stringify(p));
}
{
  const ring = (x, y) => Math.abs(Math.hypot(x - 60, y - 60) - 40) <= 4;
  const { paths } = RASTER.trace(picture(120, 120, ring), 120, 120, { centre: true });
  ok(paths.length === 1 && paths[0].closed, 'a drawn circle is one closed line', JSON.stringify(paths.map(p => [p.pts.length, p.closed])));
  const r = paths[0] ? paths[0].pts.map(q => Math.hypot(q.x - 59.5, q.y - 59.5)) : [0];
  ok(r.every(v => Math.abs(v - 40) < 1.5), 'on the stroke\'s middle radius', Math.min(...r).toFixed(2) + '..' + Math.max(...r).toFixed(2));
}
{
  const { paths } = RASTER.trace(picture(120, 120, stroke([[[20, 20], [20, 100]], [[20, 100], [100, 100]]], 3)), 120, 120, { centre: true });
  // a thinned corner may keep a one-pixel diagonal step; within 1.5 px of the true corner is the corner
  ok(paths.length === 1 && paths[0].pts.length <= 4 && paths[0].pts.some(q => Math.hypot(q.x - 19.5, q.y - 99.5) < 1.5), 'an L is one line with its corner kept', JSON.stringify(paths.map(p => p.pts)));
}
{
  const { paths } = RASTER.trace(picture(120, 120, stroke([[[10, 30], [110, 30]], [[60, 30], [60, 110]]], 3)), 120, 120, { centre: true });
  ok(paths.length === 3, 'a T stays three lines meeting at the junction', String(paths.length));
}
{
  const broken = stroke([[[10, 50], [95, 50]], [[103, 50], [190, 50]]], 3);
  const a = RASTER.trace(picture(200, 100, broken), 200, 100, { centre: true }).paths.length;
  const b = RASTER.trace(picture(200, 100, broken), 200, 100, { centre: true, gap: 12 }).paths.length;
  ok(a === 2 && b === 1, 'a gap in a line stays open, or is bridged when asked', a + ' -> ' + b);
}

console.log('uneven light and noise');
{
  // a dark line on paper that fades from white to grey across the page - a phone photo
  const w = 200, h = 100, px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const paper = 255 - x * 0.7, onLine = Math.abs(y - 50) <= 2 && x > 10 && x < 190;
    const v = onLine ? paper * 0.45 : paper, p = (y * w + x) * 4; px[p] = px[p + 1] = px[p + 2] = v; px[p + 3] = 255;
  }
  const plain = RASTER.trace(px, w, h, { centre: true }).paths;
  const adapt = RASTER.trace(px, w, h, { centre: true, adaptive: true }).paths;
  ok(adapt.length === 1 && len(adapt[0].pts) > 160, 'compared with the paper around it, the line comes out whole', adapt.length + ' paths');
  ok(plain.length !== 1 || len(plain[0].pts) < 160, 'one level for the whole page does not manage it (why the option exists)', plain.length + ' paths');
}
{
  // salt noise on a disc
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const px = picture(100, 100, disc(50, 50, 30));
  for (let i = 0; i < px.length; i += 4) if (rnd() < 0.06) px[i] = px[i + 1] = px[i + 2] = rnd() < 0.5 ? 0 : 255;
  const raw = RASTER.trace(px, 100, 100, { minArea: 1 }).rings.length, sm = RASTER.trace(px, 100, 100, { minArea: 1, smooth: true }).rings.length;
  ok(sm < raw && sm <= 3, 'smoothing removes the grain', raw + ' -> ' + sm);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
