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

console.log('what cannot be read is named; text and dimensions are notes, not losses');
{
  const r = G.parseDXF(dxf([LINE(0, 0, 1, 0), ['INSERT', [[2, 'BLK'], [10, 0], [20, 0]]], ['TEXT', [[10, 0], [20, 0], [1, 'A']]], ['DIMENSION', [[10, 0], [20, 0]]]]));
  ok(r.report.skipped.INSERT === 1 && Object.keys(r.report.skipped).length === 1, 'the INSERT is reported as skipped, nothing else', JSON.stringify(r.report.skipped));
  ok(r.report.notes.TEXT === 1 && r.report.notes.DIMENSION === 1, 'TEXT and DIMENSION counted as notes', JSON.stringify(r.report.notes));
}

/* A panel sent from another shop came in with nothing to cut and a message to
   re-export it - its outlines were old-style POLYLINEs and its curves SPLINEs,
   which nobody there could re-export for us. */
console.log('an old-style POLYLINE (POLYLINE, VERTEX..., SEQEND) is read');
{
  const V = (x, y, b = 0) => ['VERTEX', [[10, x], [20, y], [30, 0], [42, b]]];
  // 4 x 2 with the top edge bulged into a half circle of radius 2 (bulge 1)
  const r = G.parseDXF(dxf([['POLYLINE', [[66, 1], [10, 0], [20, 0], [30, 0], [70, 1]]], V(0, 0), V(4, 0), V(4, 2, 1), V(0, 2), ['SEQEND', []], LINE(9, 9, 10, 9)]));
  ok(r.loops.length === 1 && r.opens.length === 1, 'one closed outline, and the LINE after SEQEND still reads', `${r.loops.length} loops ${r.opens.length} opens`);
  const area = r.loops.length ? Math.abs(G.signedArea(r.loops[0])) : 0;
  ok(near(area, 8 + Math.PI * 2, 1e-3), 'area 8 + half of a R2 circle - the bulge is kept', area);
  ok(empty(r.report), 'nothing reported', JSON.stringify(r.report));
  const m = G.parseDXF(dxf([['POLYLINE', [[66, 1], [70, 64]]], V(0, 0), ['SEQEND', []]]));
  ok(m.report.skipped['3D mesh'] === 1, 'a polyface mesh is named, not read as an outline', JSON.stringify(m.report.skipped));
}

console.log('a SPLINE follows its curve, not the frame of its control points');
{
  // a quarter of a unit circle as a rational quadratic NURBS: exact in theory
  const w = Math.SQRT1_2;
  const r = G.parseDXF(dxf([['SPLINE', [[70, 8], [71, 2], [72, 6], [73, 3], [40, 0], [40, 0], [40, 0], [40, 1], [40, 1], [40, 1], [41, 1], [10, 1], [20, 0], [30, 0], [41, w], [10, 1], [20, 1], [30, 0], [41, 1], [10, 0], [20, 1], [30, 0]]]]));
  const segs = r.opens[0] || [];
  const worst = Math.max(...segs.map(s => Math.max(Math.abs(Math.hypot(s.a.x, s.a.y) - 1), Math.abs(Math.hypot((s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2) - 1))));
  ok(segs.length > 4 && worst < 0.0006, 'every point and chord within 0.0006 in of the true arc', `${segs.length} lines, worst ${worst}`);
  ok(segs.length && nearP(segs[0].a, 1, 0) && nearP(segs[segs.length - 1].b, 0, 1), 'starts at 1,0 and ends at 0,1');
  // the old reading went straight to the corner control point 1,1
  ok(!segs.some(s => Math.hypot(s.b.x - 1, s.b.y - 1) < 0.2), 'nowhere near the 1,1 control point');
}

console.log('an ELLIPSE is read');
{
  const r = G.parseDXF(dxf([['ELLIPSE', [[10, 5], [20, 3], [30, 0], [11, 2], [21, 0], [31, 0], [40, 0.5], [41, 0], [42, Math.PI * 2]]]]));
  ok(r.loops.length === 1, 'a full ellipse is one closed outline', `${r.loops.length} loops`);
  const bb = r.loops.length ? G.bbox(r.loops[0]) : {};
  ok(near(bb.x0, 3, 1e-3) && near(bb.x1, 7, 1e-3) && near(bb.y0, 2, 1e-3) && near(bb.y1, 4, 1e-3), '4 x 2, centred on 5,3', JSON.stringify(bb));
  const area = r.loops.length ? Math.abs(G.signedArea(r.loops[0])) : 0;
  ok(near(area, Math.PI * 2 * 1, 0.01), 'area within 0.01 of pi a b', area);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
