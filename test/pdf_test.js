/* PDF output. A file that "downloads" but will not open is worse than no
   feature, so these check the structure a reader actually needs: the header,
   the xref offsets pointing at real objects, the trailer, and that geometry
   and text made it into the content stream.
   Run: node test/pdf_test.js */
const G = require('../src/geom.js');
const PDFDOC = require('../src/pdf.js');

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + x : '')); } };

console.log('document structure');
const d = PDFDOC.doc({ page: 'letter', landscape: true });
ok(Math.abs(d.W - 11 * 72) < 0.01 && Math.abs(d.H - 8.5 * 72) < 0.01, 'landscape letter is 792 x 612 pt', `${d.W} x ${d.H}`);

const box = { x0: 0, y0: 0, x1: 20, y1: 10, w: 20, h: 10 };
const used = d.fit(box, 0.6);
ok(used > 0 && used < 1, 'a 20 x 10 in job scales down to fit', String(used));

// draw a rectangle and a circle
PDFDOC.tracePath(d, G.rectLoop(1, 1, 8, 5, 0.5), G, true);
d.stroke();
PDFDOC.tracePath(d, G.circleLoop(14, 5, 3), G, true);
d.stroke();
d.text(10, 5, 'part one', 8, 'center');
d.textPt(36, 40, 'Title block (with parens) and a slash \\', 10);

const out = d.build('Test drawing');

console.log('a reader can parse it');
ok(out.startsWith('%PDF-1.4'), 'starts with the PDF header');
ok(/%%EOF\s*$/.test(out), 'ends with %%EOF');
ok(/\/Type\s*\/Catalog/.test(out), 'has a document catalog');
ok(/\/Type\s*\/Page\b/.test(out), 'has a page object');
ok(/\/MediaBox \[0 0 792 612\]/.test(out), 'page box matches landscape letter');
ok(/\/BaseFont\s*\/Helvetica/.test(out), 'declares the Helvetica font it uses');

// the xref table must point at the actual byte offsets, or readers reject it
const startxref = parseInt((/startxref\s+(\d+)/.exec(out) || [])[1], 10);
// what a reader actually does: seek to that byte offset and expect "xref"
ok(out.slice(startxref, startxref + 4) === 'xref', 'seeking to startxref lands on the xref table',
  JSON.stringify(out.slice(startxref, startxref + 12)));
const offsets = [...out.matchAll(/^(\d{10}) 00000 n $/gm)].map(m => parseInt(m[1], 10));
ok(offsets.length === 6, 'six objects in the xref table', String(offsets.length));
let offsetsGood = true;
offsets.forEach((off, i) => {
  const expect = `${i + 1} 0 obj`;
  if (out.slice(off, off + expect.length) !== expect) offsetsGood = false;
});
ok(offsetsGood, 'every xref offset lands exactly on its object header');

console.log('content stream');
const stream = /stream\n([\s\S]*?)\nendstream/.exec(out);
ok(!!stream, 'the content stream is present');
const body = stream ? stream[1] : '';
const declared = parseInt((/\/Length (\d+)/.exec(out) || [])[1], 10);
ok(declared === body.length, 'the declared /Length matches the real stream length', `${declared} vs ${body.length}`);
ok(/\bm\b/.test(body) && /\bl\b/.test(body), 'contains moveto and lineto operators');
ok(/\bc\b/.test(body), 'the circle produced Bezier curves');
ok(/\bS\b/.test(body), 'paths are stroked');
ok(/\(part one\) Tj/.test(body), 'text made it into the stream');

console.log('text escaping');
ok(/\\\(with parens\\\)/.test(body), 'parentheses in text are escaped, which would otherwise corrupt the file');
ok(/\\\\/.test(body), 'a backslash in text is escaped');

console.log('geometry lands in the right place');
// with fit(), the 20x10 box centred on the page: x=0 maps to the left margin area
const d2 = PDFDOC.doc({ page: 'letter', landscape: false });
d2.setScale(1, { x0: 0, y0: 0, w: 4, h: 4 }, 1);   // 1:1, 1in margin
ok(Math.abs(d2.X(0) - 72) < 0.01, 'at 1:1 with a 1in margin, x=0 sits at 72pt', String(d2.X(0)));
ok(Math.abs(d2.X(2) - 216) < 0.01, 'and 2in along sits at 216pt (72 + 2*72)', String(d2.X(2)));
ok(Math.abs(d2.Y(1) - 144) < 0.01, 'Y increases upward like the app, no flip needed', String(d2.Y(1)));

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
