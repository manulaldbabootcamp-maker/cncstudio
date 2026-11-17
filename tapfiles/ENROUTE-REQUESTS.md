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

## 2. Bridges, at two different sizes

Same rectangle, same position, same 0.25 stock — **bridges on**, 4 of them,
spread around the outline. Export it twice, changing only the bridge size:

**`02a_24x36_0.25_bridge-0.5x0.08.tap`**
- bridge **length 0.5 in**, **height 0.08 in**
- `-> write down:` exactly what the two bridge fields are called and what you
  typed in them, and whether the count is "4 bridges" or a spacing.

**`02b_24x36_0.25_bridge-1.0x0.04.tap`**
- bridge **length 1.0 in**, **height 0.04 in**, everything else identical.

**What it proves.** Your archive has 180 bridges and they are all the same size
— 0.875 in long, 0.08 tall, cut as 88 tiny straight segments. The Z profile
fits a cubic smoothstep to 0.00006 in, which is below the file's own rounding,
so the *shape* is settled. What I cannot tell from one size is whether EnRoute
always uses **88 segments** or always uses a **~0.01 in step**: at one size
those are the same thing. Two sizes separate them.

Our bridges are currently a straight ramp up, a flat top, and a ramp down —
a shape I invented when there was no reference to copy. These two files are
what I need to replace it with EnRoute's actual arch.

---

## 3. A circle and a hole, on current stock

**`03_circle-and-hole_0.25.tap`**

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
