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

console.log('');
console.log(`${pass} passed, ${fail} failed${skip ? ', ' + skip + ' skipped' : ''}`);
if (fail) process.exit(1);
