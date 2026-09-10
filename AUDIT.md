# Audit — 9 September 2026

A read-through of the geometry, post-processor, snapping and boolean code, plus
an automated run of the ten designs from `test/test-sheet.html`.

Everything here was reproduced before it was written down. Fixes are individual
commits with their own tests, so any one can be reverted on its own. Anything
that involves a judgement call about how the app *should* behave is written up
below and left alone.

Re-run any time with:

```
cd electron
npm test          # 7 suites, ~150 assertions
npm run smoke     # 260 assertions in a real renderer
npm run scenarios # the 10 designs, with screenshots in test/shots/
```

---

## Fixed

### 1 · A circle centred on the edge it cuts was refused — `318c1c5`
**Severity: high.** Subtracting a circle centred exactly on a rectangle's edge —
the ordinary way to make a semicircular notch — failed outright with *"could not
resolve these shapes"*.

Two causes, one hiding the other:

- The fallback nudge pushed the clip polygon's vertices **outward from its own
  centroid**. For a circle centred *on* the line it is subtracted from, the
  topmost and bottommost vertices move **parallel** to that line and stay
  exactly on it, so the degeneracy survived every attempt. Replaced with a
  **translation** of the clip polygon along several generic directions, with the
  result translated back — translation moves every vertex off a shared line and
  preserves shape exactly. Offsets are ~1e-6 in, four orders below the 1e-4 the
  post rounds to.
- Each strategy's result was returned as soon as it was non-null. A
  near-degenerate configuration can produce a plausible-looking but *wrong*
  outline, which then short-circuited the strategies that would have got it
  right. Every candidate is now validated against the area bounds for its
  operation before being accepted.

Now: notch-on-edge gives 86.1826 against a true 86.1850 (within the flattening
tolerance) and keeps its arc. Circle on a corner, circle inscribed touching two
edges, two rectangles sharing a full edge, and two identical rectangles all
resolve correctly.

### 1b · Shapes that touch were not merged, and results depended on where they sat — `c6e4189`
**Severity: high.** Two more boolean defects, both found by running the same
operation at different places on the bed:

- **Butted shapes came back unmerged.** Two squares sharing an edge have no
  *crossings* — they only touch — so the clipper reported them disjoint and
  returned both, unmerged. Their shared edge would then be cut **twice**. A
  disjoint answer is now only accepted at face value when the outlines are too
  far apart to touch; otherwise it is held as a fallback while the perturbations
  are tried, and a perturbation turns contact into a real crossing so the union
  comes back as one outline. Genuinely separate shapes are still kept separate.
- **The area check was too weak.** When both inputs have the same area, a union
  that returns only *one* of them still satisfies "at least as big as the larger,
  no bigger than the sum". That is exactly what happened: butted squares unioned
  correctly at the origin and returned a single square at x=62. Results are now
  also required to **reach** as far as they must — a union must span both inputs'
  bounds, an intersection cannot exceed either, a subtraction cannot exceed its
  first operand.

The lesson worth keeping: a validity check that only looks at *size* will accept
an answer of the right size in the wrong place.

### 2 · A two-point closed shape vanished silently — `bcb7551`
**Severity: medium.** `polyLoop` returned an empty array for any polygon with
fewer than three points. But two points with both edges bowed enclose real area —
a lens — and that is reachable by closing a two-point path and bowing its edges.
The part disappeared completely: no outline, no area, nothing posted, and no
warning. Two points now build the two arcs when at least one edge is bowed;
two straight edges still return nothing, since that encloses no area.

### 4 · Nesting separated grouped parts, and packed bounding boxes
**Severity: medium.** Fixed. Two parts put in a group were pulled apart by Nest,
and every part reserved its whole bounding box, so an L-bracket claimed the
rectangle around it. Nest now works on real outlines and treats a group - or a
plate with its holes - as one unit. Twelve L-brackets fit a 30 x 30 sheet where
four fitted before. See the change log for the numbers.

### 3 · Toolpaths that cannot be cut were emitted silently — `30a281f`
**Severity: high — this is the one that scraps material.** Three ways a job
could be posted that would cut wrong, none of them reported:

- **A hole or slot smaller than the cutter.** A 0.20 in wide slot asked of a
  0.25 in cutter emitted a *collapsed sliver* of a toolpath — the slot would have
  been cut to the tool's width rather than the drawing's. A 0.20 in hole produced
  an empty path and was simply skipped, so the operator would find the hole
  missing only after cutting the sheet. Inside cuts now require the feature to be
  wider than the cutter in both directions.
- **An offset that turns the outline inside out.** Offsetting a concave part
  inward past its local width inverts the loop and the path then cuts in
  entirely the wrong place. The *Offset tool* already guarded against this; the
  toolpath builder — which every inside and outside cut goes through — did not.
- **An offset that folds over without inverting.** Added a bounded
  self-intersection test, limited to short paths since it is O(n²) and the
  shapes it protects (holes, slots, pockets, brackets) have few segments.

Depth settings are now reported too, **without changing what is cut**, since the
operator may mean them: a cut-through deeper than the stock, and a zero or
negative pass depth that would cut everything in one full-depth pass.

Problems appear in the Output panel and the activity log, naming the part so it
can be found on the drawing, and each is logged once rather than on every
redraw. A sound job stays silent.

---

## Found, not fixed — these are your call

### 5 · Export proceeds with parts off the bed
**Severity: medium.** The Output panel and the activity log both warn, and the
part is drawn red — but Export TAP still writes the file. Running that program
would drive the machine into its limits.

A confirmation before exporting would be safer. I left it because you may
deliberately park parts off the bed while working, and a dialog every time would
be irritating. A one-line "N part(s) are off the bed — export anyway?" on the
export dialog would cover it without nagging.

### 6 · A zero pass depth still cuts in one full-depth pass
Now warned (item 3), but not refused. On 3/16 in acrylic a single full-depth
pass is survivable; on 1/2 in HDPE it would break the cutter. Refusing outright
would be safer but would also block anyone who genuinely wants a single pass on
thin stock.

---

## Checked and sound

- **Holes follow their plate through nesting**, including when the plate is
  rotated 90° — verified with the hole's position relative to the plate before
  and after.
- **DXF import is robust.** Empty input, a file with no `ENTITIES` section, an
  entity truncated mid-stream, and plain garbage all return empty rather than
  throwing. Duplicate points in a closed polyline are absorbed correctly.
- **All ten designs** build, produce finite geometry, and post to TAP.
- **The EnRoute reproduction still holds byte-for-byte** — the 113-line
  production file regenerates exactly, so none of these changes touched output
  format.
- Circles stay circles when lines cross them; holes show the bed through them;
  the segmentation rule holds in every configuration.

---

## Noted, harmless

- **Boolean output can contain segments shorter than 0.0001 in** — sub-resolution
  debris from the flattening and re-fitting. The machine steps in 0.001 in and
  the post omits axis words that have not changed, so these emit nothing at all
  and cost neither time nor accuracy. Left alone rather than adding a cleanup
  pass that could disturb geometry that is currently byte-exact.

## Code health — no user impact

- **`parseDXF` keeps state in a module-level array.** `opens2` is declared
  outside the function and cleared inside `chainOpen`, which `parseDXF` then
  reads back. It works only because `chainOpen` happens to clear it first — it is
  non-reentrant by construction and a trap for anyone editing it later. Not
  fixed, because it manifests no bug and `parseDXF` is on the path the golden
  test depends on; not worth the risk for zero user benefit.

---

## On adding libraries

Worth recording, since it came up: **every bug found this session was a logic
error in our own code** — an inverted sign, a perturbation that moved the wrong
way, a priority rule applied too broadly. No third-party library would have
prevented any of them.

The obvious candidate, **Clipper2**, is the industry standard for polygon
booleans and offsetting, but it works in integers and **polygonises arcs**. The
one thing here that is provably correct is the byte-identical `G2`/`G3` output
against real EnRoute files, and adopting Clipper as the primary engine would
regress exactly that. If it earns a place later it should be as a *validator* —
a second opinion on self-intersection — not as the generator.
