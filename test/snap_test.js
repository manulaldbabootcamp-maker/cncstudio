/* Unit tests for the snap engine and the geometry it depends on.
   Run: node test/snap_test.js   (exits non-zero on failure) */
const G = require('../src/geom.js');
const SNAP = require('../src/snap.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}
function near(a, b, t = 1e-6) { return Math.abs(a - b) < t; }
function atPoint(r, x, y, t = 1e-6) { return r && near(r.p.x, x, t) && near(r.p.y, y, t); }

const plate = G.rectLoop(0, 0, 10, 6);
const hole = G.circleLoop(5, 3, 2);
const loops = [{ id: 1, loop: plate }, { id: 2, loop: hole }];
const S = (x, y, tol = 0.5, opts = {}) => SNAP.snapPoint({ x, y }, loops, tol, { gridStep: 0, ...opts });

console.log('snap types');
ok(S(0.12, 0.12).type === 'endpoint', 'corner snaps to endpoint');
ok(atPoint(S(0.12, 0.12), 0, 0), 'corner lands exactly on 0,0');
ok(S(5.05, 0.05).type === 'midpoint', 'mid of bottom edge snaps to midpoint');
ok(atPoint(S(5.05, 0.05), 5, 0), 'midpoint lands exactly on 5,0');
ok(S(5.02, 3.02).type === 'center', 'circle centre snaps to center');
ok(atPoint(S(5.02, 3.02), 5, 3), 'centre lands exactly on 5,3');
// A full circle is two half-arcs, so its E/W quadrants are also arc endpoints
// and its N/S quadrants are also arc midpoints - higher-priority types win at
// the same coordinate, which is correct. To exercise 'quadrant' on its own,
// use a 0..135 deg arc: north (90 deg) is neither an endpoint nor the midpoint.
const q135 = [{ id: 6, loop: [G.arc({ x: 2, y: 0 }, { x: 2 * Math.cos(2.356194490192345), y: 2 * Math.sin(2.356194490192345) }, { x: 0, y: 0 }, true)] }];
const qs = SNAP.snapPoint({ x: 0.03, y: 2.02 }, q135, 0.3, { gridStep: 0 });
ok(qs && qs.type === 'quadrant', 'north quadrant of a 135 deg arc snaps to quadrant');
ok(qs && near(qs.p.x, 0) && near(qs.p.y, 2), 'quadrant lands exactly on 0,2');
ok(atPoint(S(7.03, 3.02, 0.3), 7, 3), 'circle E seam still lands exactly on 7,3 (as an endpoint)');
ok(atPoint(S(5.02, 5.03, 0.3), 5, 5), 'circle N point still lands exactly on 5,5 (as a midpoint)');
ok(S(2.5, 6.02, 0.2).type === 'on', 'mid-span of an edge snaps on-edge');
ok(atPoint(S(2.5, 6.02, 0.2), 2.5, 6), 'on-edge projects perpendicular to the edge');

console.log('priority');
// an endpoint sits ON an edge; endpoint must win or it is unreachable
ok(S(0.05, 0.05).type === 'endpoint', 'endpoint beats on-edge at a corner');
ok(S(5.01, 3.01).type === 'center', 'center beats on-edge near a hole centre');

console.log('intersection');
const cross = [{ id: 3, loop: [G.line({ x: -1, y: 3 }, { x: 11, y: 3 })] }];
const ix = SNAP.snapPoint({ x: 0.06, y: 3.05 }, [{ id: 1, loop: plate }].concat(cross), 0.4, { gridStep: 0 });
ok(ix && ix.type === 'intersection', 'line crossing an edge yields an intersection');
ok(ix && near(ix.p.x, 0) && near(ix.p.y, 3), 'intersection is exact at 0,3');
// a line crossing the circle away from the arc seam: real intersection, not an endpoint.
// y=4 cuts the r=2 circle at x = 5 +/- sqrt(3).
const cut = [{ id: 5, loop: [G.line({ x: 0, y: 4 }, { x: 10, y: 4 })] }];
const xr = 5 + Math.sqrt(3);
const ci = SNAP.snapPoint({ x: xr + 0.03, y: 4.02 }, [{ id: 2, loop: hole }].concat(cut), 0.3, { gridStep: 0 });
ok(ci && ci.type === 'intersection', 'line/circle crossing yields an intersection');
ok(ci && near(ci.p.x, xr, 1e-9) && near(ci.p.y, 4, 1e-9), 'line/circle intersection is exact at 5+sqrt(3),4');

console.log('bounded intersection (must NOT extend segments)');
// this line stops short of the plate entirely - no intersection may be reported
const shortLine = [{ id: 4, loop: [G.line({ x: -5, y: 3 }, { x: -2, y: 3 })] }];
const none = SNAP.snapPoint({ x: -2.01, y: 3 }, [{ id: 1, loop: plate }].concat(shortLine), 0.5, { gridStep: 0, enabled: { endpoint: false, midpoint: false, center: false, quadrant: false, on: false, grid: false } });
ok(!none, 'no phantom intersection from extending a segment');

console.log('exclusions and grid');
ok(SNAP.snapPoint({ x: 0.05, y: 0.05 }, loops, 0.5, { gridStep: 0, exclude: new Set([1]) }) === null, 'excluded shape produces no snap');
const gr = SNAP.snapPoint({ x: 20.31, y: 9.9 }, [], 0.5, { gridStep: 0.25 });
ok(gr && gr.type === 'grid' && near(gr.p.x, 20.25) && near(gr.p.y, 10), 'grid snap rounds to the step');

console.log('ortho / polar');
const o1 = SNAP.ortho({ x: 0, y: 0 }, { x: 10, y: 2 });
ok(near(o1.p.y, 0) && near(o1.p.x, 10), 'shallow angle locks to horizontal, keeps length');
const o2 = SNAP.ortho({ x: 0, y: 0 }, { x: 2, y: 10 });
ok(near(o2.p.x, 0) && near(o2.p.y, 10), 'steep angle locks to vertical');
const o3 = SNAP.ortho({ x: 0, y: 0 }, { x: 10, y: 9 }, true);
ok(near(o3.ang, 45), 'polar picks the 45 deg ray');
ok(near(o3.p.x, o3.p.y), 'polar 45 keeps x == y');
const o4 = SNAP.ortho({ x: 0, y: 0 }, { x: -10, y: 0.5 });
ok(near(o4.ang, 180), 'leftward locks to 180 deg');

console.log('onSeg arc containment');
const a = G.arc({ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 0 }, true);   // quarter, ccw
ok(SNAP.onSeg(a, { x: Math.SQRT1_2, y: Math.SQRT1_2 }), 'point inside the sweep is on the arc');
ok(!SNAP.onSeg(a, { x: -1, y: 0 }), 'point on the circle but outside the sweep is not on the arc');

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
