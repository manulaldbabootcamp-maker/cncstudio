/* Holding tabs (bridges), and scaling a part by typing a size.
   The claims worth holding them to: with tabs off nothing in the program
   changes at all, a tab rises to leave material as a square step,
   tabs land on every pass that goes deeper than the tab, a part cut on the line
   never gets one, a path too short for the tabs asked for is reported rather
   than cut to pieces, and scaling a part keeps it where it was.
   Run: node test/tabs_test.js */
const G = require('../src/geom.js');
const POST = require('../src/post.js');

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + x : '')); } };

const tool = { id: 1, slot: 1, name: '1/4in', dia: 0.25, rpm: 18000, feed: 150, plunge: 20, passDepth: 0.125, type: 'endmill' };
const plate = (w = 6, h = 4, props = {}) => ({
  name: 'plate', op: 'outside', toolId: 1, open: false,
  loop: G.rectLoop(10, 10, w, h, 0), ...props,
});
const job = (shapes, extra = {}) => ({
  shapes, tools: [tool], material: { thickness: 0.25 }, cutThrough: 0.02,
  machine: { ...POST.DEFAULT_MACHINE }, now: new Date(2026, 0, 1), ...extra,
});
const lines = (j) => POST.generate(j).gcode.split(/\r?\n/);

console.log('with tabs off, the program is exactly what it always was');
{
  const a = POST.generate(job([plate()])).gcode;
  const b = POST.generate(job([plate()], { tabs: { on: false, count: 4, len: 0.3, height: 0.03 } })).gcode;
  ok(a === b, 'tabs switched off change nothing');
  ok(!/Z0\.03/.test(a), 'and no tab height appears anywhere', a.split('\n').filter(l => /Z/.test(l)).join(' | '));
}

console.log('a tab leaves material standing, as a square step');
{
  /* EnRoute's bridge is a vertical hop, a flat run across, and a vertical
     plunge back - no ramp. Measured from "Path file with bridge .5_.08h.tap";
     bridge_test.js holds a whole program to it byte for byte. */
  const L = lines(job([plate()], { tabs: { on: true, count: 4, len: 0.3, height: 0.03 } }));
  const up = L.filter(l => /^G1 Z0\.03(F[\d.]+)?$/.test(l));
  ok(up.length >= 4, 'the tool rises to the tab height once per tab, on its own line', String(up.length));
  /* No cutting move carries a Z word: that is what separates a square step
     from the ramp this used to be, because a Z on an XY move interpolates. */
  const ramped = L.filter(l => /^G[123] .*[XY].*Z/.test(l));
  ok(ramped.length === 0, 'no cutting move carries a Z - nothing is ramped', JSON.stringify(ramped.slice(0, 4)));
  /* Every Z the program commands is either a pass depth or the tab top -
     nothing in between, which is what a square step means. */
  const zs = L.filter(l => /^G1 Z/.test(l)).map(l => parseFloat(/Z(-?[\d.]+)/.exec(l)[1]));
  const allowed = POST.passDepths(0.25, 0.125, 0.02).concat([0.03]);
  ok(zs.every(z => allowed.some(a => Math.abs(a - z) < 1e-9)),
    'every Z is a pass depth or the tab top, never between', JSON.stringify(zs.slice(0, 8)));
}

console.log('tabs land on every pass that goes deeper than the tab');
{
  /* 0.5 in stock, 0.125 max pass, no cut-through: Z0.375 0.25 0.125 0.
     A 0.15 in tab is above the last two of those, so both have to ramp over it.
     This case used to be written as a 0.03 tab and leaned on the old pass
     schedule putting both Z0 and Z-0.02 under it; the depths are equal bites
     now (see zdepth_test.js), so the claim is tested with a tab tall enough to
     clear two real passes instead of an artefact of the ladder. */
  const j = job([plate()], { tabs: { on: true, count: 2, len: 0.3, height: 0.15 } });
  j.material.thickness = 0.5;
  j.cutThrough = 0;
  const L = lines(j);
  const tabbed = L.filter(l => /^G1 Z0\.15(F[\d.]+)?$/.test(l)).length;
  ok(tabbed >= 4, 'the last two passes both reach the tab, so both step over it', String(tabbed));
  const deepPasses = POST.passDepths(0.5, 0.125, 0).filter(z => z < 0.15).length;
  ok(deepPasses === 2, 'and there are exactly two such passes', String(deepPasses));
}

console.log('what never gets a tab');
{
  const on = lines(job([plate(6, 4, { op: 'on', open: false })], { tabs: { on: true, count: 4, len: 0.3, height: 0.03 } }));
  ok(!on.some(l => /Z0\.03/.test(l)), 'a part cut ON the line is not being cut free, so it gets none');
  const off = lines(job([plate(6, 4, { tabs: false })], { tabs: { on: true, count: 4, len: 0.3, height: 0.03 } }));
  ok(!off.some(l => /Z0\.03/.test(l)), 'and a part that says no overrides the job');
  const forced = lines(job([plate(6, 4, { tabs: true })], { tabs: { on: false, count: 4, len: 0.3, height: 0.03 } }));
  ok(forced.some(l => /Z0\.03/.test(l)), 'a part that says yes gets tabs with the job setting off');
}

console.log('a path that cannot hold the tabs asked for says so');
{
  const r = POST.generate(job([plate(0.5, 0.5)], { tabs: { on: true, count: 8, len: 0.3, height: 0.03 } }));
  ok(/holding tabs but got none/.test(r.stats.issues.join(' ')), 'eight tabs on a 2 in perimeter is refused and reported',
    JSON.stringify(r.stats.issues));
  ok(!/Z0\.03/.test(r.gcode), 'and the part is cut free rather than chewed up');
  const zero = POST.generate(job([plate()], { tabs: { on: true, count: 4, len: 0.3, height: 0 } }));
  ok(/nothing holding the part/.test(zero.stats.issues.join(' ')), 'a zero-height tab is refused with the reason',
    JSON.stringify(zero.stats.issues));
}

console.log('the plan itself');
{
  const path = G.rectLoop(0, 0, 10, 10, 0);          // 40 in round
  const p = POST.tabPlan(path, { count: 4, len: 0.3, height: 0.03 });
  ok(p.spans.length === 4, 'four tabs asked for, four planned', String(p.spans.length));
  ok(Math.abs(p.total - 40) < 1e-9, 'the path is measured right', String(p.total));
  // evenly spread, and offset half an interval so none sits on the start
  const mids = p.spans.map(sp => (sp.m0 + sp.m1) / 2);
  ok(JSON.stringify(mids.map(m => +m.toFixed(3))) === JSON.stringify([5, 15, 25, 35]),
    'spread evenly and clear of the seam at distance 0', JSON.stringify(mids));
  const flat = p.spans.map(sp => +(sp.s1 - sp.s0).toFixed(6));
  ok(flat.every(f => Math.abs(f - 0.3) < 1e-9), 'each span is the length asked for when no tool is given', JSON.stringify(flat));

  /* The span is the material left PLUS the tool diameter: the cutter has to be
     clear of the bridge at both ends, so a 0.5 bridge with a 0.25 cutter keeps
     the tool up for 0.75 - which is what the reference file does. */
  const withTool = POST.tabPlan(path, { count: 4, len: 0.5, height: 0.08 }, 0.25);
  ok(Math.abs(withTool.span - 0.75) < 1e-9, 'with a 0.25 cutter a 0.5 bridge raises the tool for 0.75', String(withTool.span));

  // placed by hand: `at` is the centre of each bridge, in inches along the path
  const byHand = POST.tabPlan(path, { count: 4, len: 0.3, height: 0.03, at: [2, 12, 30] }, 0);
  ok(byHand.spans.length === 3, 'three placements give three bridges, whatever the count says', String(byHand.spans.length));
  ok(Math.abs((byHand.spans[0].s0 + byHand.spans[0].s1) / 2 - 2) < 1e-9, 'and the first sits where it was put');
  const offEnd = POST.tabPlan(path, { count: 1, len: 0.3, height: 0.03, at: [0.05] }, 0.25);
  ok(!offEnd.spans.length && /does not fit/.test(offEnd.why || ''),
    'a placement too near the seam is refused with a reason', JSON.stringify(offEnd.why));

  // the pieces cover the path once, in order, with no length lost
  const all = POST.tabPieces(path, p, -0.02);
  const pieces = all.filter(x => x.seg);      // the rest are the vertical steps
  ok(all.length - pieces.length === 8, 'four tabs means eight vertical steps, up and down',
    String(all.length - pieces.length));
  const sum = pieces.reduce((a, x) => a + G.segLen(x.seg), 0);
  ok(Math.abs(sum - 40) < 1e-6, 'the split path is still the same length', String(sum));
  ok(pieces.some(x => Math.abs(x.z - 0.03) < 1e-12), 'some pieces end at the tab top');
  ok(pieces.some(x => Math.abs(x.z + 0.02) < 1e-12), 'and some at full depth');
  for (let i = 1; i < pieces.length; i++) {
    if (G.dist(pieces[i - 1].seg.b, pieces[i].seg.a) > 1e-9) { ok(false, 'pieces join end to end', 'break at ' + i); break; }
    if (i === pieces.length - 1) ok(true, 'pieces join end to end');
  }
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
