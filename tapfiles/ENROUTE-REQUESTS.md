# Programs to draw in EnRoute and export

**Program 1 is done. Two jobs left, three `.tap` files.**

Program 2 gets exported twice, program 3 once. Save them into
`tapfiles/ref-new/` with the exact names below, and write the dialog values you
typed onto the lines marked **`-> write down:`** — the typed value is the thing
I cannot recover from the file, and it is the whole point of program 1.

Keep these the same in both, so the only thing that varies is what is
being tested:

| Setting | Value |
|---|---|
| Tool | 1/4" Upspiral, slot **T02** |
| Spindle | **17000** |
| Cut feed | **217** |
| Plunge feed | **20** |
| Max pass / cut depth | **0.125** |
| Z Lift | **0.1** |
| Lead-in (ramp on) | **1.0 in** |
| Cut-through / allowance below the bed | **0** — finish on Z0 |
| Output | inches, arcs on, `.tap` |

Start points: set them the way you normally do - part-way along a straight
edge, not on a corner - and tell me roughly where, so I can pin them in the
diff instead of guessing. An explicit start point is now honoured exactly.

Position matters. Put the **lower-left corner of the part at X2.0 Y2.0** every
time. Last time a 24×36 landed somewhere else and it muddied the comparison for
no reason — if the corner is fixed, any X/Y difference left over is a real bug
in our offsetting rather than a placement difference.

---

## 1. ~~The one that settles the pass-depth rule~~ - DONE, skip it

Settled on 9 Nov 2026 from `24x36_rect.TAP` plus the archive's own file dates.
The operator confirmed the rule: thickness divided by the number of passes is
each pass depth, and the cut-depth field is the ceiling that sets the count.
0.236 is dead stock from the old config - all 490 programs with a 0.118 bite
are in the pre-2025 undated header dialect and no dated file uses it. Pinned in
`test/zdepth_test.js` and `test/seam_test.js` (byte-identical).

## 2. ~~Bridges, at two different sizes~~ - DONE from one file

Settled 23 Nov 2026 from `Path file with bridge .5_.08h.tap`. The bridge turned
out to be a **square step**, not the smoothstep arch I had read out of the old
archive, so the segment-count question the second size was for does not exist.

Measured and now reproduced byte for byte in `test/bridge_test.js`:
the raised span is the bridge length plus the tool diameter, the height is
absolute Z, and the first raised move carries the feed word because the plunge
left F20 behind. `tapfiles/LIBRARY.md` has the correction and keeps the old
smoothstep on record for reading old programs.

**Still worth one more file, when convenient:** the same part with a
**1.0 x 0.04** bridge. The "span = length + tool diameter" rule rests on a
single measurement with a single tool, and that would confirm it. Not blocking
anything.

## 3. A circle and a hole, on current stock

**`03_circle-and-hole_0.25.tap`** - **still needed.** The file sent on 23 Nov
was an EnRoute *project* file saved with a `.tap` extension (binary, no
G-code in it at all). It needs posting through Output, not Save As.

- A **12 in diameter circle**, centre at **X10 Y10**, cut **outside**.
- A **10 × 10 square**, lower-left at **X26 Y2**, cut **outside**, with a
  **3 in diameter hole** through the middle of it (centre X31 Y7), cut
  **inside**.
- **Material thickness 0.25**, bridges **off**.
- Both parts in **one** program, one tool.

**What it proves.** Three things at once:

1. The pass rule on an odd thickness with arcs in it — 0.25 should come out as
   `Z0.125` then `Z0.` if rule 1 holds.
2. **Hole ordering.** Does EnRoute cut the hole before the outside of the part
   it sits in, or after? This is the gap `test/verify.js` currently tolerates:
   our nesting picks the next path by nearest neighbour and EnRoute does
   something else, so ~1185 lines differ on a correct build. Two parts and one
   hole is the smallest case that shows me the actual rule.
3. **Where an arc starts and which way it goes.** A full circle has to break
   somewhere into G2/G3, and I want to see where EnRoute breaks it and whether
   the lead-in ramp happens on the arc or on a straight entry.

---

## When they come back

Drop the three files in `tapfiles/ref-new/` and tell me. I will:

1. Rebuild each job in the app from the same numbers and diff against yours.
2. Promote whichever ones are clean into `test/ref/` as golden files, so
   `enroute_test.js` covers an odd thickness, a bridge, and a hole — it
   currently covers none of those, which is exactly how the Z bug survived with
   a green suite.
3. Fix whatever does not match, bridges first.

Nothing gets committed until you have seen the diffs.
