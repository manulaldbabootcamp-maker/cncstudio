/* Unit tests for reading SVG drawings.
   Run: node test/svg_test.js   (exits non-zero on failure) */
const SVG = require('../src/svg.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}
const near = (a, b, t = 1e-6) => Math.abs(a - b) < t;
const bb = (pts) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); } return { x0, y0, x1, y1 }; };
const svg = (attrs, body) => `<?xml version="1.0"?><!-- made by hand --><svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

console.log('page size and units');
{
  // the 200-unit drawing made 5.5 in wide, as in the vector-to-DXF notes
  const r = SVG.parse(svg('width="5.5in" height="5.5in" viewBox="0 0 200 200"', '<path d="M0 0 H200 V200 H0 Z"/>'));
  const b = bb(r.loops[0].pts);
  ok(r.loops.length === 1 && near(b.x0, 0) && near(b.x1, 5.5) && near(b.y0, 0) && near(b.y1, 5.5), 'viewBox 200 at 5.5in: a full-page square is 5.5 × 5.5', JSON.stringify(b));
}
{
  const r = SVG.parse(svg('width="96" height="96"', '<rect x="0" y="0" width="96" height="48"/>'));
  const b = bb(r.loops[0].pts);
  ok(near(b.x1 - b.x0, 1) && near(b.y1 - b.y0, 0.5), 'plain numbers are 96 to the inch', JSON.stringify(b));
  ok(near(b.y1, 1) && near(b.y0, 0.5), 'and the page is turned right way up: the top of the page is the top', JSON.stringify(b));
}
{
  const r = SVG.parse(svg('width="100mm" height="50mm" viewBox="0 0 100 50"', '<line x1="0" y1="25" x2="100" y2="25"/>'));
  ok(r.opens.length === 1 && near(r.opens[0].pts[1].x, 100 / 25.4), 'millimetre page: 100 mm line is 3.937 in, and open', JSON.stringify(r.opens[0] && r.opens[0].pts));
}

console.log('shapes and curves');
{
  const r = SVG.parse(svg('width="2in" height="2in" viewBox="0 0 200 200"', '<circle cx="100" cy="100" r="50"/>'));
  const pts = r.loops[0].pts, rr = pts.map(p => Math.hypot(p.x - 1, p.y - 1));
  ok(r.loops.length === 1 && r.loops[0].curved && rr.every(v => Math.abs(v - 0.5) < 0.0006), 'a circle comes in round, within 0.0005 in', Math.min(...rr).toFixed(5) + '..' + Math.max(...rr).toFixed(5));
  const c = r.loops[0].circle;
  ok(c && near(c.x, 1) && near(c.y, 1) && near(c.r, 0.5), 'and is marked as the exact circle it is', JSON.stringify(c));
  const sk = SVG.parse(svg('width="2in" height="2in" viewBox="0 0 200 200"', '<circle cx="100" cy="100" r="50" transform="scale(2 1)"/>'));
  ok(!sk.loops[0].circle, 'a circle stretched one way is not', JSON.stringify(sk.loops[0].circle));
}
{
  // flags with no space after them: large=0 sweep=1, then 10 0
  const r = SVG.parse(svg('width="96" height="96" viewBox="0 0 96 96"', '<path d="M0 50 a5 5 0 0110 0"/>'));
  const p = r.opens[0] && r.opens[0].pts, end = p && p[p.length - 1];
  ok(p && near(end.x, 10 / 96, 1e-9) && near(end.y, 1 - 50 / 96, 1e-9) && p.some(q => q.y > 1 - 50 / 96 + 0.04), 'run-together arc flags read as flags, arc bulges upward on the page', JSON.stringify(end));
}
{
  const r = SVG.parse(svg('width="96" height="96" viewBox="0 0 96 96"', '<path d="m10 10 20 0 0 20 -20 0z m40 0 h10 v10 h-10 z"/>'));
  ok(r.loops.length === 2 && r.loops[0].pts.length === 4 && r.loops[1].pts.length === 4, 'relative moves with implicit line-tos, two closed squares', JSON.stringify(r.loops.map(l => l.pts.length)));
}
{
  const r = SVG.parse(svg('width="96" height="96" viewBox="0 0 96 96"', '<path d="M0 0 C 0 50 96 50 96 0 S 0 -50 0 0Z"/>'));
  ok(r.loops.length === 1 && r.loops[0].pts.length > 20 && r.loops[0].curved, 'cubic and smooth-cubic flattened', String(r.loops[0] && r.loops[0].pts.length));
}
{
  const r = SVG.parse(svg('width="1in" height="1in" viewBox="0 0 100 100"', '<rect x="0" y="0" width="100" height="50" rx="10"/>'));
  const b = bb(r.loops[0].pts);
  ok(near(b.x1 - b.x0, 1, 1e-6) && near(b.y1 - b.y0, 0.5, 1e-6) && r.loops[0].curved, 'a rounded rectangle keeps its size and rounds its corners', JSON.stringify(b));
}

console.log('groups, transforms, things that are not outlines');
{
  const r = SVG.parse(svg('width="1in" height="1in" viewBox="0 0 100 100"', '<g transform="translate(50 0) scale(0.5)"><rect x="0" y="0" width="100" height="100"/></g><rect x="0" y="80" width="10" height="10"/>'));
  const b = bb(r.loops[0].pts);
  ok(near(b.x0, 0.5) && near(b.x1, 1) && near(b.y0, 0.5) && near(b.y1, 1), 'a group transform moves and scales what is inside it', JSON.stringify(b));
  const b2 = bb(r.loops[1].pts);
  ok(near(b2.x0, 0) && near(b2.y0, 0.1), 'and stops at the group\'s end', JSON.stringify(b2));
}
{
  const r = SVG.parse(svg('width="1in" height="1in" viewBox="0 0 100 100"',
    '<defs><circle id="c" cx="5" cy="5" r="5"/></defs><use href="#c"/><text x="0" y="10">Hi</text><rect x="0" y="0" width="10" height="10" style="display:none"/><rect x="20" y="20" width="10" height="10"/>'));
  ok(r.loops.length === 1, 'defs and hidden shapes are not drawn', String(r.loops.length));
  ok(r.notes.text === 1 && r.notes['reused symbol (<use>)'] === 1, 'text and <use> are counted for the message', JSON.stringify(r.notes));
}
{
  const r = SVG.parse(svg('width="1in" height="1in" viewBox="0 0 100 100"', '<path d="M0 0 L10 Q"/><rect x="0" y="0" width="10" height="10"/>'));
  ok(r.loops.length === 1 && r.notes['unreadable path'] === 1, 'a broken path is reported, the rest still read', JSON.stringify(r.notes));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
