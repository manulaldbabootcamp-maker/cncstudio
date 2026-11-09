/* Pass depths, against ladders lifted verbatim out of the shop's own archive.

   Every expectation below is a real part's depth list from tapfiles/library,
   with the file it came from, so this test fails if the Z schedule ever drifts
   from the machine again. The rule it holds:

     total = thickness + cutThrough
     N     = ceil(total / passDepth)        <- pass depth is a MAXIMUM
     step  = total / N                      <- equal bites, no scrape at the end
     depth(i) = thickness - i*step, last one exactly -cutThrough

   Measured over 77,159 multi-pass parts: 98.2% have all steps equal, 87.6% end
   exactly on Z0. The remaining ~1% take a short last step - an older setting -
   and are deliberately NOT reproduced; see tapfiles/LIBRARY.md.

   Run: node test/zdepth_test.js       (exits non-zero on failure)  */
const POST = require('../src/post.js');

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + x : '')); } };

const ladder = (T, pd, ct) => POST.passDepths(T, pd, ct).map(v => parseFloat(v.toFixed(4)));
const same = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 6e-4);
const check = (T, pd, ct, want, src) => {
  const got = ladder(T, pd, ct);
  ok(same(got, want), `${T} in stock, ${pd} max pass, ${ct} through -> ${JSON.stringify(want)}`,
    `got ${JSON.stringify(got)}   (${src})`);
};

console.log('cutting through, below the bed - ladders read off real programs');
check(0.236, 0.125, 0.014, [0.111, -0.014], 'Fast Signs/36 x 96 x .236 - 1pc.tap');
check(0.33, 0.125, 0.01, [0.2167, 0.1033, -0.01], 'jb24559 - 3pcs - .33.tap');
check(0.16, 0.0938, 0.01, [0.075, -0.01], 'jb28145.tap');
check(0.465, 0.1875, 0.01, [0.3067, 0.1483, -0.01], '30 x 45 x .465 - 1pc.tap');
check(0.35, 0.1, 0.01, [0.26, 0.17, 0.08, -0.01], 'jb24460 - 24 x 36.68 x .35 - 2pcs.tap');
check(0.35, 0.125, 0.01, [0.23, 0.11, -0.01], 'same file, its other tool');
check(0.21, 0.125, 0.01, [0.1, -0.01], 'SO1185_Nikon-sintra/48 x 10.tap');
check(0.96, 0.25, 0.015, [0.7162, 0.4725, 0.2288, -0.015], '2 lazy susans worth/large pcs.tap');

console.log('finishing on the bed, which is what 87.6% of parts do');
check(0.236, 0.125, 0, [0.118, 0], 'the 0.1180 step, 483 programs - 0.236/2');
check(0.22, 0.125, 0, [0.11, 0], 'the 0.1100 step, 469 programs - 0.22/2');
check(0.375, 0.125, 0, [0.25, 0.125, 0], 'test/ref/17K_3-8in pcs_drop.tap');
check(0.5, 0.125, 0, [0.375, 0.25, 0.125, 0], '00-word cut out.tap, 00-_brackets.tap');
check(0.75, 0.1875, 0, [0.5625, 0.375, 0.1875, 0], '00_two strips warehouse doors.tap');
check(0.46, 0.1875, 0, [0.3067, 0.1533, 0], '00-test.tap');

console.log('the pass depth is a ceiling, never the step actually taken');
{
  for (const [T, pd] of [[0.236, 0.125], [0.22, 0.125], [0.1875, 0.125], [0.465, 0.125], [0.96, 0.25]]) {
    const d = ladder(T, pd, 0);
    const steps = []; for (let i = 1; i < d.length; i++) steps.push(d[i - 1] - d[i]);
    steps.unshift(T - d[0]);
    ok(steps.every(s => s <= pd + 1e-9), `${T} in: no bite deeper than ${pd}`, JSON.stringify(steps));
    ok(steps.every(s => Math.abs(s - steps[0]) < 1.5e-3), `${T} in: every bite the same`, JSON.stringify(steps));
  }
}

console.log('a part never finishes above the bed, and never pointlessly below it');
{
  ok(ladder(0.25, 0.125, 0).slice(-1)[0] === 0, 'an evenly divisible thickness stops at Z0 - no extra air pass',
    JSON.stringify(ladder(0.25, 0.125, 0)));
  ok(ladder(0.25, 0.125, 0).length === 2, 'and takes exactly two passes', JSON.stringify(ladder(0.25, 0.125, 0)));
  ok(ladder(0.5, 0.5, 0).length === 1, 'a pass depth equal to the thickness is one pass');
  ok(ladder(0.125, 0.5, 0).length === 1, 'a pass depth deeper than the stock is still one pass');
  ok(ladder(0.125, 0, 0.01)[0] === -0.01, 'a zero pass depth falls back to a single cut to the bottom');
  ok(ladder(0, 0.125, 0.01)[0] === -0.01, 'zero thickness is a single cut, not an empty program');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
