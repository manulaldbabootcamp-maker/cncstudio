/* DXF import: what a CAD export can hold that a flat cut cannot use.
   A 3D lid exported to DXF came in as a drawing - arcs mirrored across X = 0,
   vertical edges as zero-length lines, three faces stacked, fifty ellipses
   missing - and nothing said so. These pin the corrections and the report.
   Run: node test/dxf_test.js */
const fs = require('fs');
const path = require('path');
const G = require('../src/geom.js');

let pass = 0, fail = 0;
function ok(c, name, extra) { if (c) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); } }
const near = (a, b, t = 1e-6) => Math.abs(a - b) < t;
const nearP = (p, x, y, t = 1e-6) => near(p.x, x, t) && near(p.y, y, t);

// a DXF from entity bodies: each entity is [type, {code: value}] in file order
function dxf(ents, insunits = 1) {
  let o = `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n${insunits}\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n`;
  for (const [type, kv] of ents) {
    o += `0\n${type}\n8\n0\n`;
    for (const [c, v] of kv) o += `${c}\n${v}\n`;
  }
  return o + '0\nENDSEC\n0\nEOF\n';
}
const LINE = (x1, y1, x2, y2, z1 = 0, z2 = z1) => ['LINE', [[10, x1], [20, y1], [30, z1], [11, x2], [21, y2], [31, z2]]];
const ARC = (cx, cy, r, a0, a1, nz = 1, z = 0) => ['ARC', [[10, cx], [20, cy], [30, z], [40, r], [210, 0], [220, 0], [230, nz], [50, a0], [51, a1]]];
const CIRCLE = (cx, cy, r, nz = 1) => ['CIRCLE', [[10, cx], [20, cy], [30, 0], [40, r], [210, 0], [220, 0], [230, nz]]];
const empty = (rep) => !rep.flipped && !rep.tilted && !rep.vertical && !rep.slanted && rep.zLevels.length <= 1 && !Object.keys(rep.skipped).length;

console.log('a flat 2D drawing reads as before, with nothing to report');
{
  const r = G.parseDXF(dxf([LINE(0, 0, 4, 0), LINE(4, 0, 4, 3), LINE(4, 3, 0, 3), LINE(0, 3, 0, 0), CIRCLE(2, 1.5, 0.5), ['POINT', [[10, 1], [20, 1]]]]));
  ok(r.loops.length === 2 && r.opens.length === 0, 'four lines close into one loop, plus the circle', `${r.loops.length} loops ${r.opens.length} opens`);
  ok(empty(r.report), 'nothing reported - a POINT is not worth a warning', JSON.stringify(r.report));
}
{
  const f = path.join(__dirname, 'sides_full.dxf');
  if (fs.existsSync(f)) {
    const r = G.parseDXF(fs.readFileSync(f, 'utf8'));
    ok(empty(r.report), 'the 30-part sample job reports nothing', JSON.stringify(r.report));
  }
}

console.log('a circle drawn from below lands where it is, not mirrored across X = 0');
{
  // the lid's hole: stored as -2.25 with normal 0,0,-1, which is X +2.25 in the world
  const r = G.parseDXF(dxf([CIRCLE(-2.25, 4.71, 0.115, -1)]));
  const bb = G.bbox(r.loops[0]);
  ok(near(bb.x0 + bb.w / 2, 2.25) && near(bb.y0 + bb.h / 2, 4.71), 'centre at 2.25, 4.71', JSON.stringify(bb));
  ok(near(bb.w, 0.23), 'same size');
  ok(r.report.flipped === 1, 'and the flip is counted');
}

console.log('an arc drawn from below: right place, right way round');
{
  // OCS centre -4.125,0, 0..90 deg, normal down: in the world the centre is +4.125
  // and the arc runs clockwise from 180 deg to 90 deg - through 135 deg
  const r = G.parseDXF(dxf([ARC(-4.125, 0, 0.1, 0, 90, -1)]));
  const s = r.opens[0][0];
  ok(s.type === 'arc' && nearP(s.c, 4.125, 0), 'centre at 4.125, 0', JSON.stringify(s.c));
  const ends = [s.a, s.b];
  ok(ends.some(p => nearP(p, 4.025, 0)) && ends.some(p => nearP(p, 4.125, 0.1)), 'ends at 4.025,0 and 4.125,0.1', JSON.stringify(ends));
  const m = G.pointAt(s, 0.5);
  ok(nearP(m, 4.125 - 0.1 * Math.SQRT1_2, 0.1 * Math.SQRT1_2, 1e-6), 'the quarter between them, not the other three quarters', JSON.stringify(m));
}

console.log('a rounded rectangle with one corner drawn from below still closes');
{
  // 4 x 3 with R0.5 corners; the top-right corner arc is stored flipped
  const ents = [
    LINE(0.5, 0, 3.5, 0), ARC(3.5, 0.5, 0.5, 270, 360),
    LINE(4, 0.5, 4, 2.5), ARC(-3.5, 2.5, 0.5, 90, 180, -1),   // world centre 3.5,2.5, 0..90
    LINE(3.5, 3, 0.5, 3), ARC(0.5, 2.5, 0.5, 90, 180),
    LINE(0, 2.5, 0, 0.5), ARC(0.5, 0.5, 0.5, 180, 270),
  ];
  const r = G.parseDXF(dxf(ents));
  ok(r.loops.length === 1 && r.opens.length === 0, 'one closed outline', `${r.loops.length} loops ${r.opens.length} opens`);
  const area = r.loops.length ? Math.abs(G.signedArea(r.loops[0])) : 0;
  ok(near(area, 12 - (4 - Math.PI) * 0.25, 1e-4), 'with the area of a 4 x 3 rounded R0.5', area.toFixed(5));
}

console.log('a polyline drawn from below: mirrored, and its bulge turns with it');
{
  // OCS 0,0 -> 2,0 bulging -1 deep; seen from below that is 0,0 -> -2,0 bulging the same way down
  const r = G.parseDXF(dxf([['LWPOLYLINE', [[90, 2], [70, 0], [210, 0], [220, 0], [230, -1], [10, 0], [20, 0], [42, 1], [10, 2], [20, 0]]]]));
  const s = r.opens[0][0];
  const m = G.pointAt(s, 0.5);
  ok(nearP(m, -1, -1, 1e-6), 'the semicircle bottoms out at -1, -1', JSON.stringify(m));
}

console.log('a 3D file is reported, not silently flattened');
{
  const ents = [
    LINE(0, 0, 4, 0, 0.118), LINE(0, 0, 4, 0, -0.118),   // top and bottom face
    LINE(0, 0, 0, 0, -0.118, 0.118),                      // vertical edge
    LINE(4, 0, 4, 0, -0.118, 0.118),
    LINE(0, 1, 4, 1, 0, 0.5),                             // sloping
    ['ARC', [[10, 0], [20, 0], [30, 0], [40, 1], [210, 0], [220, 1], [230, 0], [50, 0], [51, 90]]],   // on a wall
  ];
  const r = G.parseDXF(dxf(ents));
  ok(r.report.vertical === 2, 'two edges straight up in Z counted', r.report.vertical);
  ok(r.report.slanted === 1, 'one sloping line counted', r.report.slanted);
  ok(r.report.tilted === 1, 'an arc on a tilted plane counted', r.report.tilted);
  ok(r.report.zLevels.length >= 3 && r.report.zLevels.includes(0.118) && r.report.zLevels.includes(-0.118), 'the heights are listed', JSON.stringify(r.report.zLevels));
  const zeroLen = r.opens.concat(r.loops).flat().filter(s => G.dist(s.a, s.b) < 1e-9 && s.type === 'line').length;
  ok(zeroLen === 0, 'no zero-length line comes in');
}

console.log('what cannot be read is named');
{
  const r = G.parseDXF(dxf([LINE(0, 0, 1, 0), ['ELLIPSE', [[10, 0], [20, 0], [11, 1], [21, 0], [40, 0.375]]], ['ELLIPSE', [[10, 5], [20, 0], [11, 1], [21, 0], [40, 0.375]]], ['INSERT', [[2, 'BLK'], [10, 0], [20, 0]]]]));
  ok(r.report.skipped.ELLIPSE === 2 && r.report.skipped.INSERT === 1, '2 ELLIPSE and 1 INSERT reported as skipped', JSON.stringify(r.report.skipped));
}

console.log('the same edge twice comes in once - a laser would cut it twice');
{
  // a hole three times over, as a 3D part's faces flatten
  const r = G.parseDXF(dxf([CIRCLE(2.625, 0.943, 0.115), CIRCLE(2.625, 0.943, 0.115), CIRCLE(2.625, 0.943, 0.115)]));
  ok(r.loops.length === 1 && r.report.duplicates === 2, 'a circle three times is one circle, two removed', `${r.loops.length} loops, ${r.report.duplicates} removed`);
}
{
  // top and bottom face of a 4 x 3 plate, the bottom one drawn the other way round
  const top = [LINE(0, 0, 4, 0, 0.118), LINE(4, 0, 4, 3, 0.118), LINE(4, 3, 0, 3, 0.118), LINE(0, 3, 0, 0, 0.118)];
  const bot = [LINE(4, 0, 0, 0), LINE(4, 3, 4, 0), LINE(0, 3, 4, 3), LINE(0, 0, 0, 3)];
  const r = G.parseDXF(dxf(top.concat(bot)));
  ok(r.loops.length === 1 && r.opens.length === 0 && r.report.duplicates === 4, 'two stacked outlines, either direction, make one closed outline', `${r.loops.length} loops ${r.opens.length} opens ${r.report.duplicates} removed`);
  ok(r.loops.length === 1 && near(Math.abs(G.signedArea(r.loops[0])), 12), 'of 12 sq in - not an outline that runs there and back');
}
{
  // a corner arc and its copy: chained, they made a "closed" shape that retraced itself
  const r = G.parseDXF(dxf([ARC(0.5, 0.5, 0.5, 180, 270), ARC(0.5, 0.5, 0.5, 180, 270, 1, 0.118)]));
  ok(r.loops.length === 0 && r.opens.length === 1 && r.report.duplicates === 1, 'an arc and its copy are one open arc, not a closed loop', `${r.loops.length} loops ${r.opens.length} opens`);
}
{
  // one closed polyline that runs 0,0 -> 3,0 -> 3,1 and straight back: no area, every edge twice
  const r = G.parseDXF(dxf([['LWPOLYLINE', [[90, 4], [70, 1], [10, 0], [20, 0], [10, 3], [20, 0], [10, 3], [20, 1], [10, 3], [20, 0]]]]));
  const len = r.opens.concat(r.loops).flat().reduce((s, q) => s + G.dist(q.a, q.b), 0);
  ok(r.loops.length === 0 && r.opens.length === 1 && near(len, 4), 'a polyline that retraces itself becomes one open 4 in path', `${r.loops.length} loops ${r.opens.length} opens ${len} in`);
}
{
  // two parts drawn sharing an edge are the operator's design - both stay closed
  const sq = (x) => ['LWPOLYLINE', [[90, 4], [70, 1], [10, x], [20, 0], [10, x + 1], [20, 0], [10, x + 1], [20, 1], [10, x], [20, 1]]];
  const r = G.parseDXF(dxf([sq(0), sq(1)]));
  ok(r.loops.length === 2 && r.report.duplicates === 0, 'two squares side by side stay two closed squares', `${r.loops.length} loops ${r.report.duplicates} removed`);
}
{
  // the other half of a circle is a different arc, not a duplicate
  const r = G.parseDXF(dxf([ARC(0, 0, 1, 0, 180), ARC(0, 0, 1, 180, 360)]));
  ok(r.report.duplicates === 0 && r.loops.length === 1, 'two halves of a circle are both kept, and close', `${r.report.duplicates} removed`);
}
{
  // an open polyline that runs over an edge already drawn keeps the rest of itself
  const r = G.parseDXF(dxf([LINE(1, 0, 2, 0), ['LWPOLYLINE', [[90, 4], [70, 0], [10, 0], [20, 0], [10, 1], [20, 0], [10, 2], [20, 0], [10, 3], [20, 0]]]]));
  const len = r.opens.concat(r.loops).flat().reduce((s, q) => s + G.dist(q.a, q.b), 0);
  ok(r.report.duplicates === 1 && near(len, 3), 'the shared edge goes, the 3 in of line stays', `${r.report.duplicates} removed, ${len} in`);
}

console.log('millimetres still convert');
{
  const r = G.parseDXF(dxf([CIRCLE(-25.4, 0, 12.7, -1)], 4));
  const bb = G.bbox(r.loops[0]);
  ok(near(bb.x0 + bb.w / 2, 1) && near(bb.w, 1), 'a flipped 25.4 mm circle is 1 in across at X 1', JSON.stringify(bb));
}

console.log('export: a line two parts share is written once');
{
  const total = (r) => r.loops.concat(r.opens).flat().reduce((s, q) => s + G.segLen(q), 0);
  const plain = (r) => r.loops.length + ' loops ' + r.opens.length + ' opens ' + r.removed + ' removed ' + total(r).toFixed(4) + ' in';
  {
    const r = G.dedupeOverlaps([G.rectLoop(0, 0, 2, 1), G.rectLoop(5, 0, 2, 1)], []);
    ok(r.loops.length === 2 && r.opens.length === 0 && r.removed === 0, 'parts apart come out as they went in', plain(r));
  }
  {
    // two 2 x 1 squares touching along x = 2: 12 in of outline, 1 in shared
    const r = G.dedupeOverlaps([G.rectLoop(0, 0, 2, 1), G.rectLoop(2, 0, 2, 1)], []);
    ok(r.loops.length === 1 && r.opens.length === 1 && near(total(r), 11, 1e-9) && near(r.removedLen, 1, 1e-9), 'side by side: the first stays closed, the second is an open U, 11 in cut', plain(r));
    const u = r.opens[0];
    ok(nearP(u[0].a, 2, 1) && nearP(u[u.length - 1].b, 2, 0) || nearP(u[0].a, 2, 0) && nearP(u[u.length - 1].b, 2, 1), 'the U ends on the shared line, round the far side', JSON.stringify([u[0].a, u[u.length - 1].b]));
  }
  {
    // a short part against a long one: only the touching 1 in of the long edge goes
    const r = G.dedupeOverlaps([G.rectLoop(0, 0, 4, 1), G.rectLoop(1, 1, 1, 1)], []);
    ok(near(total(r), 10 + 3, 1e-9), 'partial overlap: 10 in plate + 3 in of the small part', plain(r));
  }
  {
    // a stack: the same rectangle twice is cut once
    const r = G.dedupeOverlaps([G.rectLoop(0, 0, 2, 1), G.rectLoop(0, 0, 2, 1)], []);
    ok(r.loops.length === 1 && r.opens.length === 0 && near(total(r), 6, 1e-9), 'a rectangle on top of itself is one rectangle', plain(r));
  }
  {
    const r = G.dedupeOverlaps([G.circleLoop(1, 1, 0.5), G.circleLoop(1, 1, 0.5), G.circleLoop(3, 1, 0.5)], []);
    ok(r.loops.length === 2 && near(total(r), 2 * Math.PI, 1e-9), 'a circle twice is one circle; a different circle stays', plain(r));
  }
  {
    // a quarter arc drawn over half of a circle is taken off the second part only where they meet
    const c = G.P(0, 0);
    const half = [G.arc(G.P(1, 0), G.P(-1, 0), c, true)];
    const quarterCw = [G.arc(G.P(0, 1), G.P(1, 0), c, false)];
    const r = G.dedupeOverlaps([], [half, quarterCw]);
    ok(near(total(r), Math.PI, 1e-9) && r.removed === 1, 'an arc lying on a kept arc, drawn the other way, is dropped', plain(r));
  }
  {
    // an open line half on a plate edge keeps its other half
    const r = G.dedupeOverlaps([G.rectLoop(0, 0, 2, 1)], [[G.line(G.P(1, 0), G.P(3, 0))]]);
    ok(r.opens.length === 1 && near(total(r), 6 + 1, 1e-9), 'a line along an edge keeps the part past the corner', plain(r));
  }
  {
    // the written file has one fewer edge to cut
    const r = G.dedupeOverlaps([G.rectLoop(0, 0, 2, 1), G.rectLoop(2, 0, 2, 1)], []);
    const back = G.parseDXF(G.writeDXF(r.loops, r.opens));
    ok(near(total(back), 11, 1e-6), 'round trip through DXF: 11 in, not 12', total(back));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
