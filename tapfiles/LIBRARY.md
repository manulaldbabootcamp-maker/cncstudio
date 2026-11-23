# What the shop's own programs say

`tapfiles/library/` is the shop's whole TAP archive, copied in on 2026-11-06
from `Downloads\CNC Files-20261106T163840Z-1-001\TAP Files`: **5598 programs,
72 MB of G-code, 3.6 million lines**, in 2059 folders mostly named after
customers. The originals were left where they were.

This is the ground truth for the byte-identical goal. Everything below was
measured from the files, not assumed.

## The dialect is narrow

The entire archive uses twelve codes and ten words. Nothing else.

```
G0 G1 G2 G3 G53 G90      M3 M5 M61 M62      T S F X Y Z I J
```

No `R` arcs anywhere — **1,037,618 arcs, every one in I/J centre-offset form.**
No cutter compensation (`G41`/`G42`), no canned cycles, no subprograms, no line
numbers, no `G20`/`G21` (inches are implied), no `(parens)` comments. Comments
are square brackets only. Line endings are CRLF in 5596 of 5598 files.

Number formatting, all 3.3 million of them, takes exactly five shapes:
`#`, `#.#`, `#.` , `-#.#`, `-#.`  — so a whole number keeps its trailing dot
(`Z0.`, `I0.`, `J-0.1875`) and there is never a leading zero dropped or a
trailing zero kept. Four decimals maximum.

The plunge feed is **glued to the Z word** — `G1 Z0.F20`, no space. The contour
feed is a line of its own (`F200`) set once after the plunge. Anything parsing
these files has to handle both.

## The two header dialects

2683 programs use the older form, 2913 the newer. The difference is where the
date and the spindle speed sit:

```
older (no date)            newer (dated)
G90                        [Creation Date: 10/6/2021 - 8:14:59 AM]
G53                        G90
M61                        G53
[3/8" Upspiral]            M61
M5                         M5
T01                        [3/8" Upspiral]
M3                         T01
                           S23000
G0 X17.375 Y72.5625        M3
S23000
G0 Z1.1875                 G0 X2.6403 Y12.3125
                           G0 Z1.16
```

The footer is effectively one form — 5591 of 5598 files end:

```
M5
G53
M62
G53 X0 Y120
```

Five old files park at `G53 X0 Y0` instead. `G53` appears 11192 times bare
(as a mode line) and 5591 times with coordinates (the park move).

## The real tool library

Read off the programs themselves. `T05`/`T07` are used inconsistently for the
1/8" and 1/16" cutters — the numbering drifted over the years, and the comment
is the reliable identifier, not the T number.

| Tool comment | T | Programs | Spindle | Plunge | Contour | Pass depth |
|---|---|---|---|---|---|---|
| `[3/8" Upspiral]` | T01 | 3308 | 23000 | F20 | F180 | 0.118 / 0.110 |
| `[1/4" Upspiral]` | T02 | 2794 | 23000, often 17000 | F20 | F217 | 0.125 |
| `[1/8" straight cutter]` | T07, also T05 | 380 | 23000 | F20 | F180 | 0.085 |
| `[3/16" straight]` | T04 | 221 | 23000 | F20 | F217 | 0.1875 |
| `[1/2" Straight]` | T03 | 121 | 23000 | F20 | F180 | 0.2375 |
| `[1/16'' Straight Cutter]` | T05, also T07 | 57 | 23000 | F20 | F100 | 0.060 |

Note the `[1/16'' ...]` comment uses two apostrophes where the others use a
double quote. It is quoted verbatim in the files.

Safe/rapid Z is per job, not per tool — the common values are `0.225`, `0.35`,
`1.1875`, `1.236`, i.e. a fixed clearance above whatever is clamped down.

## Cut-through goes *below* zero, barely

Z0 is the bed. 963 programs cut through to `Z-0.01`; the deepest anywhere in the
archive is `Z-0.0275`. The app's default cut-through should be in that range,
and anything past about `-0.03` is outside anything the shop has ever run.

## Passes

| Depths in one program | Programs |
|---|---|
| 1 | 2040 |
| 2 | 2029 |
| 3 | 931 |
| 4 | 350 |
| 5 or more | 246 |

4554 programs use one tool, 874 use two, 134 use three.

## How EnRoute schedules Z — and where we get it wrong

Measured **per part**, not per program: a program interleaves parts and tools,
so the union of its depths looks ragged even when every part is regular.
Grouping the passes that share a start XY gives **77,159 multi-pass parts**:

| A part's own depth steps | Parts | |
|---|---|---|
| **all steps equal** | 75,777 | **98.2 %** |
| equal then a short last step | 772 | 1.0 % |
| genuinely uneven | 506 | 0.7 % |
| equal then a longer last step | 104 | 0.1 % |

| Where the last pass ends | Parts | |
|---|---|---|
| **exactly Z0** | 67,577 | **87.6 %** |
| Z0.205 (a pocket, not a cut-out) | 3,788 | 4.9 % |
| Z0.0075 | 854 | 1.1 % |
| Z−0.01 | 658 | 0.9 % |

So the rule, and it is not the obvious one:

> **N = ceil(thickness / passDepth), step = thickness / N, and the depths are
> `T − step, T − 2·step, … , 0`.** Equal steps all the way down, landing
> **exactly on Z0**. The tool's pass depth is a *maximum*, not the step taken.

Independent confirmation from the pass-step table above: the 3/8" upspiral's two
most common steps are **0.1180** and **0.1100** — which are 0.236 / 2 and
0.22 / 2, the two commonest HDPE thicknesses in the archive divided into two
equal passes. Those numbers cannot arise any other way.

Safe Z is `thickness + Z-lift`. Measured over the same 77,159 parts the lift is
**0.1 in** (21,984) or **1.0 in** (13,894) — the two driver presets. Our
`ENROUTE_CURRENT` already has `zLift: 0.1`.

Cut-through below the bed is rare and small: 658 parts at Z−0.01, nothing past
Z−0.0275. It is an exception, not the default.

### What `passDepths()` used to do — fixed 2026-11-06

`src/post.js` stepped by a fixed `passDepth` and then jumped to the bottom:

```js
let z = thickness - passDepth;
while (z > bottom + 1e-6) { out.push(z); z -= passDepth; }
out.push(bottom);
```

Against the archive's real thicknesses, cutting to the bed (`cutThrough: 0`,
which is the app's default — `src/app.js:203`):

| Thickness | Pass | Old | EnRoute, and now ours |
|---|---|---|---|
| 0.236 | 0.125 | `0.111, 0` | `0.118, 0` |
| 0.22 | 0.125 | `0.095, 0` | `0.11, 0` |
| 0.1875 | 0.125 | `0.0625, 0` | `0.0938, 0` |
| 0.465 | 0.125 | `0.34, 0.215, 0.09, 0` | `0.3488, 0.2325, 0.1163, 0` |
| 0.375 | 0.125 | `0.25, 0.125, 0` | `0.25, 0.125, 0` ✓ |
| 0.5 | 0.125 | `0.375, 0.25, 0.125, 0` | same ✓ |
| 0.75 | 0.1875 | `0.5625, 0.375, 0.1875, 0` | same ✓ |

Two separate faults:

1. **Unequal steps.** On 0.236 stock the old code took a full 0.125 bite and
   then a 0.111 one; on 0.1875 it took 0.125 then a 0.0625 scrape. EnRoute
   divides evenly — 0.118 twice, 0.0938 twice.
2. **A pass through nothing.** With cut-through switched on, the old code
   reached Z0 on a schedule of its own and *then* added a separate
   `−cutThrough` pass. EnRoute folds the cut-through into the division, so the
   last equal bite lands on `−cutThrough` and there is no extra lap.

Only thicknesses that divide evenly by the pass depth came out right — and the
reference programs the tests use (`17K_*`) are exactly that case: 0.375 at
0.125, with `cutThrough: 0`. That is why the suite stayed green while every odd
thickness in this archive came out wrong. `test/zdepth_test.js` now holds the
rule against sixteen ladders copied out of these files.

## Bed extents

```
X  -2.5  ..  61.5625
Y  -1    .. 120.25
Z  -0.0275 .. 3.1
```

So the usable area runs past 60 × 120 in, and the park position `X0 Y120` is a
real corner of it. Small negative X and Y appear in a handful of programs —
overcuts and lead-ins that run off the sheet edge, not mistakes.

## Bridges: a square step now, a smoothstep in the old programs

**Corrected 23 Nov 2026.** This section used to say EnRoute ramps a bridge
with a cubic smoothstep, full stop. That was read off the archive alone, and
the archive is the *old* configuration. A bridge posted from EnRoute on
17 Nov 2026 - `test/ref/bridge_0.5x0.08.TAP` - is a plain square step:

```
G1 X9.7232        cutting at full depth
G1 Z0.08F217      straight up, at the CONTOUR feed, no X or Y
G1 X8.9732        across the bridge at that height
G1 Z0.            straight back down
```

Four lines, no interpolation, no ramp. Three rules come out of it, and
`test/bridge_test.js` holds a whole program to the file byte for byte:

- the raised span is the bridge length **plus the tool diameter** - 0.75 for a
  0.5 bridge with a 0.25 cutter - so the material left is the length asked for;
- `height` is absolute Z, which is the thickness of material left standing;
- the **first** raised move carries the feed word and the rest do not, because
  the last Z move before it was the plunge at F20. Z moves carry their own
  feed, separate from the contour feed.

Placement is the operator's. The reference has its four bridges a quarter of
the path apart but 8.239 in along it from the seam, not half an interval - so
`tabPlan` takes `at`, a list of distances along the path, and falls back to an
even spread when none is given.

### The old shape, for reading old programs

The pre-2025 side of the archive really is a smoothstep. 117 programs modulate
Z inside a contour; most are lead-outs, but `01. Bins\8in_Full sheet tube bin
lids.tap` has **180 real bridges**, all identical:

```
0.8751 in long - 0.08 in tall - 88 segments of ~0.0099 in - one segment at full height
```

| Profile | worst error | rms |
|---|---|---|
| **cubic smoothstep `3u2-2u3` on each half** | **0.00006 in** | **0.00003 in** |
| raised cosine `sin2` | 0.0008 | 0.0005 |
| straight ramps | 0.0077 | 0.0055 |
| sine half-wave | 0.019 | 0.013 |
| parabola | 0.024 | 0.016 |
| circular arc | 0.024 | 0.016 |

0.00006 in is below the four-decimal rounding of the file, so the fit is exact
for those programs - a different bridge style on the old config, not something
the shop posts now. We do not generate it. If an old program ever has to be
reproduced, this is the shape.

**The lesson, for the next time.** The archive says what the shop *used to do*.
Only a fresh export says what it does now, and the two had diverged on the
spindle, the feeds, the stock and the bridge shape. Dating the files first
would have caught it.

## The oddities, for whoever hits them

- `01. Bins\RB\RB101410\inner.tap` and `SWXO\RB101410\inner.tap` are **not
  G-code** — they are Windows `INDX(` index fragments that got the `.tap`
  extension. Any parser run over the archive has to skip them.
- `01. Bins\MSB5_MSB6_MSB7\Master_All pieces_ 4 bins each_17K.tap` has `S17` on
  two lines where `S17000` was meant. A hand edit. It would run the spindle at
  17 rpm if the controller took it literally.
- Three programs carry `F2.0`, `F0.2` and a bare `F` with no number.
- One `T09` and one `S4000` appear once each, nowhere else.

## How this was measured

Four throwaway scripts, in the session scratchpad, not kept: a vocabulary
survey, a structural pass (extents, passes, feed pairing, Z modulation), a
bridge-profile extractor and a curve fit, and a tool-library roll-up. All
read-only. Rerunning them is a few minutes' work from this document if a
number ever needs checking.
