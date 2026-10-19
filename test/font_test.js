/* Stroke font + TrueType parser. The TTF half runs against a real font from
   the Windows font folder; it skips (without failing) if none is found.
   Run: node test/font_test.js */
const fs = require('fs');
const path = require('path');
const G = require('../src/geom.js');
const FONT = require('../src/font.js');

let pass = 0, fail = 0, skip = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + x : '')); } };
const near = (a, b, t = 1e-6) => Math.abs(a - b) < t;

console.log('stroke font');
const g = FONT.strokeGlyphs();
ok(Object.keys(g).length > 60, 'stroke font has a usable glyph set', Object.keys(g).length);
for (const ch of 'ABCXYZabcxyz0189.,-') ok(!!g[ch], `glyph exists: ${ch}`);

const st = FONT.strokeText('AB', { height: 1 });
ok(st.single === true, 'stroke text reports itself as single-line');
ok(st.paths.length > 0, 'stroke text produced paths');
ok(st.paths.every(p => p.closed === false), 'every stroke path is OPEN (centreline, not an outline)');
ok(st.missing.length === 0, 'no missing glyphs for "AB"');

// cap height must come out exactly as requested - this is the number an
// operator sets when the engraving has to fit a label area
const ys = st.paths.flatMap(p => p.pts.map(q => q.y));
ok(near(Math.max(...ys), 1, 1e-9), 'cap height of "AB" at height=1 is exactly 1.0 in', Math.max(...ys));
ok(near(Math.min(...ys), 0, 1e-9), 'baseline sits at y=0', Math.min(...ys));

const st2 = FONT.strokeText('A', { height: 2 });
const ys2 = st2.paths.flatMap(p => p.pts.map(q => q.y));
ok(near(Math.max(...ys2), 2, 1e-9), 'height scales linearly (height=2 -> 2.0 in)');

console.log('stroke layout');
const two = FONT.strokeText('AA', { height: 1 });
const xs = two.paths.flatMap(p => p.pts.map(q => q.x));
ok(Math.max(...xs) > 1.4, 'two letters advance horizontally', Math.max(...xs));
const multi = FONT.strokeText('A\nA', { height: 1 });
const my = multi.paths.flatMap(p => p.pts.map(q => q.y));
ok(Math.min(...my) < -0.5, 'a second line drops below the baseline', Math.min(...my));
const ctr = FONT.strokeText('AAAA', { height: 1, align: 'center' });
const cx = ctr.paths.flatMap(p => p.pts.map(q => q.x));
ok(Math.min(...cx) < 0 && Math.max(...cx) > 0, 'centre alignment straddles x=0');
const miss = FONT.strokeText('A\u2603', { height: 1 });
ok(miss.missing.length === 1, 'an unsupported character is reported, not silently dropped', JSON.stringify(miss.missing));

console.log('loops');
const loop = FONT.toLoop(st.paths[0].pts, false);
ok(loop.length > 0 && loop.every(s => s.type === 'line'), 'stroke path converts to line segments');

console.log('truetype');
const candidates = ['arial.ttf', 'segoeui.ttf', 'tahoma.ttf', 'verdana.ttf', 'calibri.ttf', 'consola.ttf']
  .map(f => path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', f))
  .filter(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });

if (!candidates.length) {
  skip++; console.log('  skip TrueType tests (no .ttf found in the Windows font folder)');
} else {
  const file = candidates[0];
  console.log('  using ' + path.basename(file));
  let font = null;
  try { font = FONT.parse(fs.readFileSync(file)); } catch (e) { console.log('  parse threw: ' + e.message); }
  ok(!!font, 'parsed a real .ttf');
  if (font) {
    ok(font.unitsPerEm >= 16 && font.unitsPerEm <= 16384, 'unitsPerEm is sane', font.unitsPerEm);
    ok(font.numGlyphs > 50, 'font reports a real glyph count', font.numGlyphs);
    ok(font.glyphFor('A') > 0, 'cmap resolves "A" to a glyph id', font.glyphFor('A'));
    ok(font.glyphFor('A') !== font.glyphFor('B'), '"A" and "B" are different glyphs');

    const out = FONT.outlineText(font, 'A', { height: 1 });
    ok(out.single === false, 'outline text reports itself as NOT single-line');
    ok(out.paths.length >= 1, 'letter A produced at least one contour', out.paths.length);
    ok(out.paths.every(p => p.closed === true), 'every outline contour is CLOSED');
    // 'A' has a counter (the triangular hole), so a good parse gives 2 contours
    ok(out.paths.length === 2, 'letter A has an outer contour plus its counter', out.paths.length);

    const oy = out.paths.flatMap(p => p.pts.map(q => q.y));
    ok(Math.min(...oy) > -0.05, 'A sits on the baseline (no descender)', Math.min(...oy));
    ok(Math.max(...oy) > 0.5 && Math.max(...oy) < 1.6, 'A is roughly the requested height', Math.max(...oy));

    // contours must be real polygons with area, and the counter must be smaller
    const areas = out.paths.map(p => Math.abs(G.signedArea(FONT.toLoop(p.pts, true))));
    ok(areas.every(a => a > 1e-5), 'contours enclose real area', JSON.stringify(areas.map(a => +a.toFixed(4))));
    ok(Math.max(...areas) > Math.min(...areas) * 1.5, 'the counter is clearly smaller than the outer contour');

    const word = FONT.outlineText(font, 'AB', { height: 1 });
    const wx = word.paths.flatMap(p => p.pts.map(q => q.x));
    ok(Math.max(...wx) > 0.9, 'two letters advance horizontally in outline mode', Math.max(...wx));

    const o = FONT.outlineText(font, 'O', { height: 1 });
    ok(o.paths.length === 2, 'letter O gives two concentric contours', o.paths.length);

    // curve flattening must be fine enough that a round letter is not a polygon
    ok(o.paths[0].pts.length > 20, 'curves are flattened finely, not blocky', o.paths[0].pts.length);
  }
}

/* Cursive joins and stencil bridges, against the fonts shipped in fonts/.
   The check is the ink itself: sampled on a grid, the result must be filled
   exactly where the font is (minus the bridges) - a plausible-looking but
   wrong outline shows up as mismatches. */
{
  const RG = require('../src/region.js');
  const load = (n) => { const f = path.join(__dirname, '..', 'fonts', n); if (!fs.existsSync(f)) return null;
    const b = fs.readFileSync(f); return FONT.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };
  const loopsOf = (font, t) => FONT.outlineText(font, t, { height: 1 }).paths.map(p => FONT.toLoop(p.pts, true));
  const wn = (L, p) => { let w = 0; for (const l of L) for (const s of l) { const a = s.a, b = s.b, c = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
    if (a.y <= p.y) { if (b.y > p.y && c > 0) w++; } else if (b.y <= p.y && c < 0) w--; } return w; };
  const eo = (L, p) => { let k = 0; for (const l of L) for (const s of l) { const a = s.a, b = s.b;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y)) k ^= 1; } return k; };
  const mismatches = (L, U, gaps) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const l of L) for (const s of l) { x0 = Math.min(x0, s.a.x); x1 = Math.max(x1, s.a.x); y0 = Math.min(y0, s.a.y); y1 = Math.max(y1, s.a.y); }
    let mis = 0;
    for (let i = 0; i < 200; i++) for (let j = 0; j < 60; j++) {
      const p = { x: x0 + (x1 - x0) * (i + 0.37) / 200, y: y0 + (y1 - y0) * (j + 0.41) / 60 };
      const ink = wn(L, p) !== 0 && !gaps.some(g => p.x > g.x0 && p.x < g.x1 && p.y > g.y0 && p.y < g.y1);
      if (ink !== (eo(U, p) === 1)) mis++;
    }
    return mis;
  };
  const holes = (L) => L.filter((l, i) => { const p = G.pointAt(l[0], 0.5); return L.filter((o, j) => j !== i && G.pointInLoop(p, o)).length % 2 === 1; }).length;
  const crossings = (L) => { let n = 0; const all = L.flatMap((l, li) => l.map(s => ({ s, li })));
    const X = (p, q, r, s) => { const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); return d(p, q, r) * d(p, q, s) < 0 && d(r, s, p) * d(r, s, q) < 0; };
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (all[i].li !== all[j].li && X(all[i].s.a, all[i].s.b, all[j].s.a, all[j].s.b)) n++; return n; };

  console.log('cursive: overlapping letters fused into one outline');
  const brush = load('Brush-Script.ttf');
  if (!brush) { skip++; console.log('  skip (fonts/Brush-Script.ttf not found)'); }
  else {
    const L = loopsOf(brush, 'Hello Manav');
    ok(crossings(L) > 0, 'the joins overlap as the font draws them');
    const U = RG.fillOutline(L, 1e-5);
    ok(U && crossings(U) === 0, 'fused: nothing crosses, so no line through a join');
    ok(U && mismatches(L, U, []) === 0, 'fused outline is exactly the ink');
  }
  const arial = load('Arial-Bold.ttf');
  if (arial) {
    const L = loopsOf(arial, 'ABRO');
    ok(RG.fillOutline(L, 1e-5) === null, 'a block font with nothing crossing is left exactly as it was');

    console.log('stencil bridges hold the middle of A, B, R, O');
    ok(holes(L) === 5, 'ABRO has 5 loose middles', holes(L));
    const gaps = RG.bridgeGaps(L, 0.05);
    const U = RG.fillOutline(L, 1e-5, undefined, gaps);
    ok(U && holes(U) === 0, 'bridged: no middle is left loose', U && holes(U));
    ok(U && mismatches(L, U, gaps) === 0, 'bridged outline is the ink less the bridges, exactly');
    ok(gaps.every(g => Math.abs(g.x1 - g.x0 - 0.05) < 1e-9), 'each bridge is the width asked for');
  }
}

console.log('');
console.log(`${pass} passed, ${fail} failed${skip ? ', ' + skip + ' skipped' : ''}`);
if (fail) process.exit(1);
