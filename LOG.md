# Change Log

Running record of what was added, changed, or removed. Newest first.
Each entry names the commit so anything here can be found in `git log`.

---

## Holes show the bed through them

### Fixed
- **A circle cut inside a plate looked like more material.** Every closed shape
  was filled on its own, so an inside-cut sitting in a plate painted a second
  layer of blue on top instead of punching through. A plate is now filled
  together with the holes cut inside it in a single even-odd fill, so the bed
  shows through each hole and the plate reads the way the finished part will.
- A hole is paired with the **smallest** closed, non-inside part that contains
  it, so nested plates and islands resolve correctly. An inside-cut with no
  plate around it (a lone pocket) keeps its own fill.
- World loops are now built once per frame and shared across the fill, stroke
  and toolpath passes.

### Tests
- Smoke test now 260 assertions. The check is done on **pixels**: after
  rendering, a pixel inside the hole must match bare bed while a pixel inside
  the plate must be tinted. Plus pairing: a hole finds its plate, a lone pocket
  finds none, and a hole inside nested plates pairs with the smaller.

---

## Circles stay circles

### Fixed
- **A circle crossed by a line was being cut into arc pieces and demoted from a
  `circle` to a polygon.** From that moment it was fragile: grips appeared on
  the rim, its `R` label became W x H, and any nudge - a grabbed rim grip, a
  retyped width - moved a chord while the arc kept its radius. That is the
  "circle turns into an ellipse with intersecting corners" report.
  The segmentation rule was only ever meant for lines and their intersection
  points, so circles and ellipses are now **left whole**. Lines still split
  where they cross a circle; the circle itself is never cut by a crossing.
  Trim (`K`) still cuts a circle when that is what is asked for explicitly.
- **Retyping the width or height of a part that contains arcs is refused**,
  with a pointer to the Scale dialog. Changing one axis alone is a non-uniform
  scale, which turns arcs into ellipses the post cannot cut.
- **Part ids can no longer collide.** A job file that predates `nextId`, or has
  one behind its own shapes, could hand a new part an id already in use - and a
  duplicate id makes selection and splitting silently skip a part. `makeShape`
  now always issues an id above every existing one.

### Tests
- Smoke test now 255 assertions. The reported case is driven with real mouse
  events: three spokes drawn from a circle's centre leave it kind `circle`,
  still 12 x 12, still enclosing pi*36, with no draggable grips - while the
  spokes themselves still split where they cross the rim. Plus the refused
  one-axis resize on a bowed part, and that a new part never reuses an id.
- The harness now only counts errors raised during its own run. The activity
  log persists across restarts by design, and every headless run shares one
  userData folder, so a broken probe from earlier was leaking into later runs.

---

## Circle snap points, and PDF options matching the design view

### Fixed
- **Snapping to a circle's circumference or centre often did not work.** Snap
  priority was applied globally, so a higher-ranked type won on rank alone no
  matter how far away it was. Clicking 0.1 in from a circle's edge would jump to
  the arc's seam **3.1 in away**, because an endpoint outranks an on-edge snap.
  Zoomed out the tolerance is inches wide, which made this constant.
  Ranking now only applies among candidates that are *actually close to each
  other* — within a band of the nearest hit. A distant endpoint can no longer
  beat the edge under the cursor, while an endpoint you are genuinely on still
  wins over the edge it sits on.
- **Grid snap was swallowing every object snap** once that band existed. At a
  0.001 in step there is always a grid point within half a step of the cursor,
  so it was always the nearest candidate and always won the band. Grid is not an
  object snap: it is now a fallback used only when nothing on the drawing is in
  range. This is what made snapping feel dead while drawing a polyline.

### Added — PDF
- The export dialog now carries **the same toggles as the design view**, and
  **starts from whatever is currently ticked there**, so the print matches what
  is on screen: Toolpaths, **Kerf**, **Centre marks**, Sizes, Part names,
  **Dimensions**, Bed outline.
- **Kerf** draws the removed material at true tool width, scaled with the
  drawing.
- **Dimensions** placed with the D tool are drawn with witness lines in the same
  violet as on screen; **size labels print in green**, matching the canvas.

### Tests
- Smoke test now 247 assertions. The circle case is covered directly: the centre
  snaps, a point near the circumference snaps *to the circumference* and lands
  genuinely on the circle, sitting on the seam still gives the endpoint, and all
  of it still works mid-polyline rather than only with the select tool. Plus the
  PDF dialog offering all seven toggles, kerf defaulting off to match the view,
  and a PDF with the extras on being larger than the outline alone.

---

## Circle size box takes radius or diameter

### Changed
- The circle's entry box now has **two fields like the rectangle**: `R` and
  `dia`. It previously showed only a radius and hid the second field.
- The two track each other as you type — enter `2.5` in R and `5` appears in
  dia, enter `9` in dia and `4.5` appears in R. They are the same number twice
  over, so showing one changing without the other would be misleading.
- **Enter uses whichever field was typed into last**, so a diameter can be
  entered directly without halving it by hand. Stock and cutters are usually
  quoted by diameter while the geometry stores a radius, and that conversion is
  a pointless place to make an arithmetic slip.

### Tests
- Smoke test now 236 assertions: both labels are present and visible, the
  prefilled diameter is exactly twice the radius, typing either field updates
  the other, entering a diameter of 9 gives a radius of 4.5, entering a radius
  still sets the radius, and the resulting circle is 3.5 in across on the
  centre it was drawn from.

---

## The size box stays after the drag

### Fixed
- **The entry box beside the cursor vanished on mouse-up.** It appeared while
  the button was held and disappeared the moment it was released, so there was
  never a point at which it could be typed into. That was the actual complaint;
  the previous attempt added editable labels on the drawing, which is useful but
  was not the thing being asked for.

### Changed
- After drawing a rectangle, circle or ellipse, **the box stays open next to the
  cursor**, prefilled with the size just drawn. Type the real numbers and press
  Enter and the part is resized — it does not create a second one. Tab moves
  between width and height (or the two radii); a circle shows a single `R`.
- It follows the cursor while open, so it never ends up somewhere awkward, and
  closes on Enter, Escape, a click elsewhere, or switching tools.
- Typing a digit focuses it, so the flow is: drag a rough shape, type the exact
  size, Enter. No reaching for the panel.

Both routes now exist and neither is wasted: the box for the part you just
drew, and clicking a dimension on the bed for a part drawn earlier.

### Tests
- Smoke test now 224 assertions, driven as a real drag: the box is still on
  screen after mouse-up, bound to the drawn part and prefilled; typing 6.5 and 7
  resizes that part rather than adding another; a circle asks for `R` and
  retypes to 2.375; and Escape dismisses the box while leaving the part as drawn.

---

## Resize by clicking the dimension on the drawing

### Fixed
- **The typed size box only existed during the drag.** It appeared on mouse-down
  and vanished on release, so there was no moment in which it could actually be
  typed into. Drawing a rectangle roughly and then correcting the numbers is the
  real workflow, and it had no home.

### Added
- **Click a dimension on the bed and retype it.** With a part selected, its size
  labels are live: click the width, type `14.25`, press Enter, and the part is
  14.25 in wide. Escape cancels. The cursor turns into a text caret over a label
  so it reads as editable.
  - A **rectangle** grows from the corner it was placed at, not its centre
  - A **circle** keeps its centre and takes a radius
  - An **ellipse** takes each axis
  - Anything else — a traced template, a boolean result — is scaled to the typed
    width or height about its lower-left bound, so it stays where it was nested
- Dimension labels on features too small to draw arrows into now **keep the
  label and drop the arrows**, instead of disappearing. A small circle's radius
  line is barely any length on screen, and hiding the label left no way to click
  and retype it.

### Tests
- Smoke test now 208 assertions, driving it as a click: the label is hit-tested
  (and a click 200 px away correctly misses), a real mouse-down opens the editor,
  Enter resizes the geometry to 14.25 in *and* leaves the placed corner where it
  was, Escape cancels without resizing, a circle keeps its centre, and a polygon
  scales on one axis without stretching the other.

---

## Typed sizes, PDF drawings, part renaming

### Added
- **Type the size instead of dragging it.** The entry box that already served
  the polyline tools now serves the drag tools, relabelled per tool:
  - **Rectangle** — `w` then Tab then `h`, Enter. "6.5 x 7" is typed, not dragged.
  - **Circle** — `R` and Enter. The second box hides itself.
  - **Ellipse** — `rX` and `rY`.
  Click once to set the corner (or centre), start typing, press Enter. The
  boxes still track the cursor until you type, so they double as a live readout.
- **Export the drawing as a PDF** (`src/pdf.js`, new). Written by hand rather
  than pulled from a library — the app is dependency-free and offline, and a
  drawing needs only lines, Beziers and Helvetica.
  Vector, not a screenshot: it prints to a true scale and stays sharp at any
  size, which matters when someone measures off the print at the machine.
  - Letter / Legal / Tabloid / A4 / A3, portrait or landscape
  - Fit to page, or a fixed 1:1, 1:2 or 1:4
  - Optional part names, sizes, bed outline and toolpaths
  - A title block giving job name, part count, material, the scale actually
    used, overall size, tools, cut length and estimated time
  - A fixed scale that will not fit **says so and stops**, rather than silently
    shrinking the drawing — a print that claims 1:1 but is not is worse than
    no print at all.
- **Rename a part by double-clicking its name** in the parts list. Enter
  commits, Escape cancels, and the rename is one undo step.

### Changed
- Circles now label the **radius** on the drawing, measured from the centre
  out, instead of the diameter across.

### Tests
- `test/pdf_test.js`, 22 assertions on the things a PDF reader actually needs:
  the header and `%%EOF`, a catalog and page object, the correct MediaBox, and
  crucially **that seeking to `startxref` lands on the xref table and every
  xref offset lands exactly on its object header** — a file that downloads but
  will not open is worse than no feature. Also checks the declared stream
  `/Length` matches reality, parentheses and backslashes in text are escaped
  (unescaped ones corrupt the file), and that 1:1 with a 1 in margin puts x=0
  at exactly 72 pt.
- Smoke test now 191 assertions: the size box relabels itself per tool, a typed
  6.5 x 7 rectangle really is 6.5 x 7, a typed R 2.75 circle really is 2.75,
  renaming works through a real double-click, the PDF export writes a file and
  logs its scale, and an oversized job at a fixed 1:1 is refused.

---

## Size labels and sliders for rectangles and circles

### Added
- **Size shows on the drawing, not just in the panel.** Select a part and its
  dimensions are drawn with proper dimension lines — witness lines, arrow ticks
  and a boxed value, the same style as a placed dimension:
  - **Rectangle** — width along the bottom, height up the left side, plus the
    corner radius when there is a uniform one
  - **Circle** — the diameter across the centre as `Ø n"`, with `R n"` beneath it
  - **Ellipse** — both axes
  - **Anything else** — overall width and height across its bounds
  Toggled by **Size labels** in the left panel. Labels are suppressed when the
  part is too small on screen to read, and when more than three parts are
  selected, since a crowd of overlapping numbers helps nobody.
- **Width, height and radius get sliders**, matching the selected-edge editor:
  type an exact value or drag and watch the part change, with one undo step per
  drag. The diameter field tracks the radius slider as it moves.

### Changed
- The dimension-line drawing was pulled out of `drawDims` into a shared
  `drawDimLine`, so placed dimensions and automatic size labels are drawn by
  the same code and cannot drift apart in appearance.

### Tests
- Smoke test now 177 assertions: the toggle exists and defaults on, labels draw
  for both a rectangle and a circle without error, the Width slider genuinely
  resizes the geometry to 15 in, and the diameter field follows the radius
  slider.
- Worth noting one thing the tests caught: selecting a part through
  `setSelEdge` **converts a rectangle into a polygon**, so the rectangle panel
  disappears. A plain `selectShape` was added for selecting without converting.

---

## Fix TAP export, and square-lock the measure tool

### Fixed
- **Export TAP did nothing.** It asked for a filename with `window.prompt()`,
  which Electron's renderer does not implement — it throws *"prompt() is not
  supported"*, so the export died before writing anything. Save project hit the
  same wall. Both now use the app's own dialog.
  `confirm()` (New job, Reset settings, the non-uniform scale warning) is
  replaced too: it works in Electron but blocks the renderer and looks nothing
  like the rest of the app.
- Export now reports failures instead of failing silently: an empty post says
  so and logs a warning, and a write error is caught, logged and shown.
- Exports and saves are recorded in the activity log with the filename, line
  count and part count.
- Saved projects now carry the machine config and tool table alongside the
  material, so a job reopened later posts the same way it did originally.

### Added
- **The measure tool locks square.** Within **10°** of 0/90/180/270 the second
  point is projected onto that axis, so a couple of degrees of mouse drift no
  longer quietly reports the hypotenuse instead of the run. The readout is
  tagged `[90° locked]` when it happens, so a locked reading can never be
  mistaken for a raw one, and **Alt** measures a true diagonal.

### Tests
- Smoke test now 168 assertions. `window.prompt`/`confirm`/`alert` are trapped
  and the export, save and new-job buttons driven — if any of them ever reaches
  for a browser dialog again the test fails. The export is then run end to end
  with a typed filename and the produced `.tap` checked, along with the lock at
  5°, 95°, 180°, a real 31° diagonal, and the Alt bypass.

---

## Trace a paper template from measured offsets

For the job where a customer brings in a paper cut-out — a car window with
curves that differ car to car — and it has to be reproduced exactly.

### Added
- **Trace from measurements** (`T`, or the ruler icon next to Dims…). The shop
  method, made native: lay the cut-out with one square corner on 0,0 and the
  second square corner along the baseline, step along at a fixed interval and
  measure straight up to the curved edge at each station. Type or paste those
  numbers in and the curve is rebuilt through every one of them.
  - Station step is adjustable (1 in default); lines can also be entered as
    `station,offset` pairs where the spacing is not uniform — useful for
    tightening up stations only where the curve bends hard.
  - Baseline can run along X or Y.
  - Ends either close square onto the baseline into a cut-out part, or stay
    open to cut on the line.
  - The curve passes **through** every measured point (Catmull-Rom), which is
    what an operator expects from measured data — a B-spline would not.
  - Optional arc fitting with a tolerance box, so the cut runs G2/G3 rather
    than thousands of tiny moves; same refit used for boolean results.

### Accuracy, measured
Reconstructing a known 30 in-radius arc over a 24 in baseline, measurements
rounded to 0.001 in as a ruler would give:

| Station step | Worst error |
|---|---|
| 0.5 in | 0.0006 in |
| **1 in** | **0.0028 in** |
| 2 in | 0.0107 in |
| 3 in | 0.0239 in |

So 1 in stations land about **five times inside 1/64 in**, and 3 in stations
fall outside it — worth knowing where a curve tightens.

### Tests
- Smoke test now 158 assertions, including the full workflow against that known
  arc: the part spans the baseline, sits on y = 0, closes square, stays within
  0.010 in of the true curve everywhere, and posts to a real program.

---

## Match the machine's real EnRoute configuration

Driven by three production jobs (`17K_*.tap` + their `.rou` sources) and the
Wincnc15 driver dialogs supplied by the operator. **The generator now reproduces
a real EnRoute program byte for byte.**

### What the reference material showed
- **Z Lift is 0.100 in** — safe Z is a height *above the material*, not an
  absolute Z. 0.375 stock gives 0.475, 0.25 stock gives 0.35. The old absolute
  1.1875 was simply that job's thickness + a 1.0 Z Lift.
- **Every lead-in is a 1.000 in ramp**, run backwards along the toolpath: rapid
  to a point 1 in back along the path, feed down to the material surface, then
  ramp to full depth over that inch. All 120 lead-ins across the three files are
  exactly 1.000 in. We were plunging straight down, which is hard on a bit in
  acrylic.
- **Header carries M5**; the tool block is `[name] / T## / S##### / M3` with the
  spindle speed *inside* it, not emitted at the first plunge.
- **A `[Creation Date: 9/2/2026 - 10:48:38 AM]` line** leads the file.
- Machine resolution **1000 steps/in** (0.001 in), **arc tolerance 0.0004 in**,
  arcs enabled, **drill cycles disabled**, feed default 300 / max 1200, plunge
  default 50 / max 400.
- The real turret: 1 = 3/8" Upspiral, 2 = 1/4" Upspiral, 3 = 1/2" Straight,
  4 = 3/16" straight, 5 = 1/8" straight cutter, 7 = 1/16" Straight Cutter
  (6 and 8 empty).

### Added
- Machine options: `zLift`, `leadIn`, `creationDate`, `spindleInToolChange`,
  and an **ENROUTE_CURRENT preset** matching the shop's present setup — now the
  default for new jobs. The legacy preset is kept for the older configuration.
  Both are selectable in Settings, with Z Lift, ramp length and the two format
  switches editable directly.
- Ramp-on lead-in in the post-processor. It walks backwards along the closed
  path, splitting a segment where needed, and interpolates Z across the ramp.
  Skipped automatically on open paths and on paths too short to ramp on.
- Default tool table replaced with the actual turret, with slot 2's real
  feeds and speeds (S17000, F217 cut, F20 plunge) taken from the files.

### Tests
- **`test/enroute_test.js`, 16 assertions** against `17K_3-8in pcs_drop.tap`.
  The part geometry is recovered from the file itself (two 22 x 8 rectangles,
  since the 0.775..23.025 toolpath is a 22 x 8 offset outward by the 0.125 tool
  radius). It checks the frame, safe Z, ramp distances, feed placement and pass
  depths — and finishes with the strongest available assertion: **the generated
  program is byte-identical to the EnRoute reference, all 113 lines.**
- `verify.js` now pins the legacy config explicitly instead of reading the live
  defaults. It was silently coupled to them, so correcting the defaults to match
  the shop broke a golden file that should never have depended on them.
- `npm test` runs both golden files plus the three unit suites.

---

## The segmentation rule, locked down

No behaviour change — the rule was already implemented. These tests state it
explicitly so it cannot regress unnoticed:

> A single continuous line is one line. Wherever another line crosses or joins
> it, it becomes two — or more, one piece per contact point. The same rule
> applies to arcs, and inside a closed loop as well as outside one.

### Tests
- Smoke test now 149 assertions covering every configuration:
  - **X** — two lines crossing: each becomes two
  - **T** — a line ending on another: the crossed line becomes two, the stem
    stays one
  - **L** — endpoints already meeting: nothing splits, since the contact point
    is already there
  - **three contacts on one line**: four pieces
  - **a line through a closed square**: the square goes 4 sides to 6, the line
    becomes three, the square stays closed and still encloses 100 sq in
  - **deleting one side of that closed square**: leaves 5 segments, part intact

---

## Auto-split at crossings, and an inverted arc bug

### Added
- **Points are added automatically where a new line meets existing geometry.**
  Draw a line across a circle and you now get the four quadrant arcs and the
  four radii, each selectable and deletable on its own — instead of two
  semicircles and two full diameters. Draw a line onto the side of a shape and
  that side splits at the contact point, so the leftover can simply be clicked
  and deleted.
  Only the shapes the new one actually touches are examined, so drawing in
  empty space costs nothing, and the split keeps a closed part closed.
  Toggle with **Split at crossings when drawing** in the snap menu.
- Split shapes keep their original id, so selection, grouping and undo stay
  attached to them.

### Fixed
- **Arcs were being built mirrored about their own chord.** `bulgeArc` treats a
  positive bulge as curving to the *right* of travel, while `sagitta()` is
  positive to the *left*; the conversion between them was missing its negation.
  The radius was always right, which is exactly why every existing test passed —
  they only ever checked magnitude. Consequences:
  - the **arc tool** drew the arc on the wrong side of the chord;
  - converting a shape to editable per-edge bulges mirrored every curve, so a
    circle split into quadrants enclosed **30.9 sq in instead of 113.1**.
  The sign conversion now lives in one named place, `arcRFromGeometry`, with
  the reason written down.
- **A circle collapsed to zero area when made editable.** It is stored as two
  semicircles, and a closed shape needs at least three points to survive as a
  polygon, so it became a 2-point degenerate. Segments are now halved first.

### Tests
- Smoke test now 139 assertions. The gap that hid the arc bug is closed: there
  are now assertions on arc **direction**, not just radius — an arc drawn
  through a point above its chord must still bow upward, and a circle's area
  must survive conversion to editable bulges. Plus the full case from the
  screenshot: two diameters split a circle into 4 quadrant arcs and 4 radii,
  the circle still encloses pi*r^2, stays closed, and a single quadrant arc can
  be selected on its own.

---

## Click a line to select it

### Changed
- **One click on a line now selects that line.** Reaching for a leftover
  segment and pressing Delete is the first instinct; it should not need a tool
  change or a second click to drill in. Previously the first click took the
  whole part and only a second click picked a side.
  - Click a **line** → that line is selected (Delete removes just it)
  - **Double-click** anywhere on a part → the whole part
  - **Alt+click** → ignore lines and take the whole part directly
  - Shift+click still adds or removes a line from the selection
  - Dragging from a line still moves the part, so nothing is lost
- **The line under the cursor is previewed** in faint orange before you click,
  so the click target is never a guess.
- The select tool now carries a hint line explaining all of this, since the
  behaviour is not guessable.

### Tests
- Smoke test now 129 assertions, driven through **real mouse events**: a single
  click on an overhang selects exactly that segment, Delete leaves the other
  three, double-click clears back to the whole part, and hovering reports the
  line for the highlight.

---

## Merge leftovers into one closed part

### Fixed
- **Merge silently refused to touch closed parts.** It filtered the selection
  down to open paths only, so a leftover closed outline sitting beside an open
  piece — the usual state after trimming — could never be welded into one part,
  and the command appeared to do nothing. It now accepts any parts, open or
  closed: a closed shape simply contributes its ring of segments, and the
  junction split then puts a vertex wherever the other path meets it.
- **Merged ends are now welded exactly together**, so an outline that comes
  within tolerance of closing is genuinely closed rather than nearly closed —
  which matters, because only a truly closed loop can be offset for tool
  diameter.

### Changed
- A merge that closes the outline now switches it to **cut outside**, so it
  profiles as a part instead of staying an on-the-line path, and the toast says
  which happened: *"Merged into one closed part — 4 sides, cutting outside"* or
  *"…one open part … (ends do not meet, so it cuts on the line)"*.
- **`J`** merges the selection, next to `K` for the trim/erase tool.

### Tests
- Smoke test now 121 assertions: two open halves merge into one **closed**
  4-sided part cutting outside and enclosing the correct area, and a closed
  part plus an open one merges into a single 5-sided part instead of being
  refused.

---

## Box-select across parts, split at intersections, and a bbox bug

### Fixed
- **`bbox()` was wrong for every open path.** `loopPts` skipped each segment's
  end point (correct for a closed loop, where the next segment repeats it) but
  never added the final one back for an open path — so a single-segment open
  path measured as a **zero-size box at its start point**. That is why a box
  selection spanning two parts appeared to ignore one of them: a line looked
  like a dot that fell entirely inside the box, so it was treated as wholly
  selected instead of having its side picked.
  This had been quietly wrong for anything measuring an open path — nesting,
  bed-limit warnings, scale, group bounds and the distance tool.
- **The segment/box test missed lines crossing straight through.** It sampled
  points, and a straight segment samples to just its two endpoints, so a line
  passing through a box with both ends outside was never detected. It now tests
  the endpoints and then the segment against the four sides of the box, which
  is exact for both lines and arcs.
- **Box-select now genuinely spans parts** — a box crossing two objects selects
  sides on both, which is what these two bugs had been preventing.

### Added
- **Split at intersections** (Trim dialog). Turns every crossing into a real
  vertex, so each piece becomes its own selectable side: a line crossed by
  another becomes two lines that can be picked and deleted separately. Handles
  both true crossings and an endpoint that merely touches partway along.
  Runs on the selection, or on the whole job if nothing is selected.

### Tests
- Smoke test now 114 assertions: an open path reports its real bounding box
  while closed shapes and areas are unchanged; a line crossing a box with both
  ends outside is detected; a box crossing two objects selects sides on both;
  and two crossing lines split into four pieces cut exactly at the crossing.

---

## Box-select sides, and merging a line that lands partway along another

### Fixed
- **Box-select ignored sides.** Dragging a selection box only ever selected
  parts that fell *entirely* inside it, so dragging from the top-left corner of
  a square to its centre selected nothing at all. A box that only crosses a
  part now picks the individual **sides** it passes through — that drag selects
  the top and left sides, as expected. A part fully inside the box is still
  selected whole.
- **Only one side could be selected at a time.** Selection is now a set:
  box-select can pick several at once, shift-click adds or removes one, and
  Delete removes all of them. Removing several sides can split a part into more
  than one piece, so the survivors are regrouped into continuous runs and each
  becomes its own path.

### Added
- **Merge into one part** (Trim dialog). Draw a line from a corner to a point
  **partway along** another side and the two are touching but still two
  separate objects, with the touched side still one long segment. Merge splits
  that side at the contact point and combines everything into a single part —
  so a C plus a tie line becomes one 5-sided part, and that 5th side can be
  selected and deleted like any other.
  This is the case ordinary *Join* cannot handle: Join chains matching **ends**,
  while this handles a **T-junction** in the middle of a side.

### Tests
- Smoke test now 103 assertions, driving both cases exactly as described: a box
  from the top-left corner to the centre of a square picks precisely sides 2
  and 3 (top and left) and deleting both leaves 2 segments; and a C plus a line
  landing partway along its top side merges into one 5-side part whose 5th side
  can then be deleted, leaving 4.

---

## Select and edit one side of a shape

### Added
- **Edge sub-selection.** Click a part to select it, then click one of its
  sides to select just that side — so one side of a triangle can be worked on
  by itself. The chosen side is highlighted in orange, and its row in the
  points table is highlighted to match. Clicking a row in that table selects
  the side too. Escape steps back out to the whole part.
- **Delete removes only that side.** With a side selected, Delete (or the
  *Delete this side* button) removes it and leaves the rest — a triangle minus
  one side becomes a two-segment open path.
- **Length, angle and bulge for the selected side**, on the right, each with a
  number field *and* a slider. Type an exact value, or drag the slider to feel
  the shape out with the drawing updating live. Changing length or angle moves
  the far point and the rest of the part follows.
- **Point numbers on the canvas** (P1, P2, …) matching the points table, so the
  rows on the right map onto what is on screen. Toggle with *Point numbers* in
  the left panel.
- **Rectangles and `path` shapes become editable on demand.** Clicking a side
  of a boolean result, imported outline or text converts it to a polygon,
  carrying its arcs across as per-edge bulges so no curve is lost. Logged when
  it happens.

### Changed
- The points table no longer scrolls inside its own 320 px window; the whole
  right-hand panel scrolls as one column, so parts with many points are usable.

### Tests
- Smoke test now 94 assertions: clicking the bottom of a triangle picks side 0,
  the right-hand side picks side 1, clicking the middle picks none; typing 20
  makes the side exactly 20 in and 30 sets exactly 30°; all three sliders are
  present; deleting the side leaves a 2-segment open path; and a `path` shape
  converts to a 4-point polygon.

---

## Snap reach is a real distance, not a screen distance

### Fixed
- **Dragging an endpoint onto another line did not snap.** The snap radius was
  measured in **screen pixels** (11 px). Zoomed in, that is a few thousandths
  of an inch of real distance, so coming at a line from 1/8 in away snapped to
  nothing — the reach shrank exactly when the work got precise.
  Reach is now the **larger of** the screen radius and a real-world radius
  (default **0.125 in**, editable in the snap menu). Screen-only failed zoomed
  in; world-only would fail zoomed out, where 1/8 in is sub-pixel and
  unpickable. Taking the max keeps it usable at every zoom.
- **The snap marker was hidden during a drag** — the one moment confirmation
  matters most. It now stays visible while dragging a grip or a part, so you
  can see what the point has locked onto before letting go.

### Added
- **Dragging a whole part now snaps too.** Grab a part by one of its corners
  and that corner lands exactly on another part's geometry, instead of only
  landing on the grid.
- **Snap within ‹n› in** in the snap menu, so the reach can be tuned.

### Tests
- Smoke test now 81 assertions. Zoomed to 600 px/in, an endpoint 0.1 in from a
  wall lands exactly on x=10 and reports an on-edge snap; a point 0.3 in away is
  left alone; near the wall's end the endpoint wins so shapes close cleanly;
  zoomed out the screen radius takes over again; and a custom radius is honoured.

---

## Precision: 0.001 in snap, zoom limits, healing loose ends

### Fixed
- **The cursor appeared to freeze when zoomed in, and only ever reported
  multiples of 0.125.** Same cause: grid snap was quantising every cursor
  position to 1/8 in, so zoomed in the point jumped in large steps and looked
  stuck between them. Snap now offers **0.001, 0.005, 0.01, 1/64 and 1/32**
  alongside the old fractions, and **0.001 is the default**. Coordinates read
  to 4 decimals, matching what the post-processor actually emits.
- **Zoom is now clamped.** Maximum zoom puts 0.001 in at roughly one screen
  pixel — as fine as the machine output can express, since the TAP is written
  to 4 decimals. Going deeper only lost precision in the view transform without
  buying accuracy. Minimum zoom keeps the whole bed in view. Hitting either
  limit says so instead of silently doing nothing.

### Added
- **Loose ends are healed onto the line they should meet.** A path drawn or
  imported a few thousandths short of another edge is not geometrically a
  crossing, so trim had nothing to cut back to and joins refused to chain.
  - **Trim now heals first**: if the clicked path nearly touches something
    within the tolerance, the loose end is pulled exactly onto that edge and
    the trim proceeds, saying so rather than doing it invisibly.
  - **Snap loose ends to edges** in the Trim dialog does it on demand, for the
    selection or the whole job.
  - Default tolerance **0.125 in**, editable and now saved with settings.
  - A gap wider than the tolerance is deliberately left alone — near misses get
    healed, real gaps do not get silently stretched shut.

### Tests
- Smoke test now 73 assertions: a point resolves to 0.001 rather than 0.125,
  the 0.001 option exists and is the default, a line stopping 0.02 in short
  genuinely reports no crossing, healing pulls its end to exactly x=10, and a
  1 in gap is left untouched.

---

## Delete an edge

### Added
- **Delete a single edge** from any shape — press `K`, or Trim → *Delete an
  edge*, then click the side you want gone.
  - A **closed** part becomes an open path that stops short of the gap: drop
    one side of a rectangle and you get a C, without rebuilding it as a
    three-sided polyline and re-entering every length and angle.
  - An **open** path splits into two at that edge.
  - Deleting a part's last remaining edge removes the part.
  - Fillet arcs are their own segments, so clicking a straight side of a
    rounded rectangle removes only that side and leaves the corners.
  - The result switches to cutting **on** the line, since an open path has no
    inside or outside, and that is stated in a toast rather than left to be
    discovered at the machine.

### Changed
- The Trim tool used to refuse anything but an open path that crossed other
  geometry. It now falls back to deleting the clicked edge when there is
  nothing to trim back to, which is what "remove this line" usually means.
  Where crossings do exist, the old span-trimming behaviour is unchanged.

### Tests
- Smoke test now 64 assertions: a rectangle really does become a continuous
  3-segment open path with its ends where the deleted edge was and a total
  length of 22 in, an open path splits in two, and a single-segment part
  disappears.

---

## Centre marks on all shapes, tool hints, typed length/angle

### Fixed
- **Centre marks only appeared on circles.** A rectangle or polygon showed
  none, because centres were collected from arc geometry only. Every closed
  part now also reports its own centre, drawn as a dashed cross so it reads
  apart from the solid crosses on true arc centres.
- **A part's centre could not be snapped to.** The Centre snap only ever found
  arc centres, so there was no way to put a hole in the middle of a plate.
  Part centres are now fed to the snap engine as well.
- **The Line tool looked broken.** It needs a second action to finish — Enter
  or a double-click — and with no prompt on screen, two clicks produced nothing
  visible and the tool appeared not to work. It was behaving correctly; nothing
  said so.

### Added
- **Tool hints.** A line at the top of the canvas says what the current tool
  expects and, crucially, what finishes it. Shown for every tool that needs
  more than a single drag.
- **Right-click finishes a path**, matching the convention in every other CAD
  package. Middle-drag and space-drag still pan.
- **Typed length and angle while drawing.** With a path started, type a number
  and a small box appears at the anchor: enter the length, press Tab, enter the
  angle, press Enter, and the point lands exactly there. This is how a corner
  at a known angle gets drawn without arithmetic — two legs at 10 in and 6 in
  with a 60° corner between them come out exact to floating-point precision.
  The boxes track the cursor live until you start typing, so they double as a
  readout.

### Tests
- Smoke test now 54 assertions. It draws a two-leg corner through the typed
  entry path and checks both leg lengths, both absolute angles, and the
  included angle are exact; confirms a rectangle centre is both reported and
  snappable; and confirms the Line tool's hint actually mentions Enter.
- A throwaway probe drove real synthetic mouse events through the canvas to
  confirm the Line tool was working before any of this was changed, rather
  than assuming a bug from the report.

---

## Centre marks and the distance tool

### Added
- **Permanent centre marks.** Circles, ellipses and any arc now draw a green
  centre cross all the time, sized to the feature and clamped so it stays
  readable at any zoom. Toggle with **Centre marks** in the left panel.
  Previously a centre was only visible as a *snap marker*, which appears only
  while the cursor is within about 11 px of it and only when the Centre snap is
  enabled — fine as a hover hint, useless as a drawing aid.
- **Distance between two parts.** Select two parts (the first stays put, the
  second moves) and set the spacing directly, instead of working out
  `X2 = X1 + r1 + gap + r2` by hand:
  - centre to centre
  - **gap between edges** (0 means touching)
  - first centre to second edge
  - first edge to second centre
  - far edge to far edge (overall size across both)

  Direction can be horizontal, vertical, the current line between the parts, or
  a typed angle, with an option to line the centres up across that direction.
  The dialog shows the equivalent centre-to-centre distance live, so the number
  is visible before it is applied.
  Edge distances use the **real silhouette** sampled from the outline, not a
  bounding box, so they are exact for circles and correct for arbitrary shapes.
  If the moved part is grouped, the whole group moves with it.

### Tests
- Smoke test now 42 assertions. Beyond checking the arithmetic, it measures the
  **actual closest distance between the two outlines** after applying a 0.25 in
  edge gap and confirms it really is 0.25 in.

---

## Push 3 — Text, groups, ellipse and spline

### Added
- **Text and engraving** (`src/font.js`, new), covering the two genuinely
  different jobs:
  - **Engrave (single line).** A built-in stroke font whose glyphs are *open*
    polylines, so the tool follows the centreline of each letter. This is what
    a V-bit or small endmill needs to put a part number on a piece. A normal
    font cannot do this — its letters are closed outlines, and following one
    traces *around* the letter instead of drawing it. Covers A–Z, a–z, 0–9 and
    common punctuation.
  - **Cut / pocket (outline).** A real TrueType parser: `head`, `maxp`, `hhea`,
    `hmtx`, `cmap` (formats 0/4/6/12), `loca`, `glyf`, including composite
    glyphs and quadratic curve flattening. Load any `.ttf` you own from the
    text dialog; nothing is bundled and nothing is sent anywhere.
    Contours nested an odd number of deep are detected as counters (the hole in
    an "A"), so they are cut as holes rather than as separate islands.
  - Cap height is exact — set 0.5 in and the letters measure 0.5 in, because
    engraving usually has to fit a labelled area.
  - The dialog disables "pocket" and "cut free" for the single-line font and
    explains why, rather than silently producing a traced outline.
  - Characters the chosen font does not contain are reported in a toast and
    the activity log instead of being silently dropped.
  - A text block is one group and keeps its spec, so it can be re-opened and
    edited (change the wording, height or font) rather than deleted and redone.
- **Groups** (`Ctrl+G` / `Ctrl+Shift+G`). Selecting any member selects the
  whole group, so a plate and its holes move together — the gap called out in
  the original list, where nesting handled this implicitly but dragging did not.
- **Ellipse** (`E`) — drag from the centre. Emitted as a fine polyline: a true
  ellipse is not a circular arc, and the machine only understands lines and
  circular arcs, so it has to be approximated. The point count is derived from
  the sagitta tolerance at the tightest end of the curve, and a perfectly round
  ellipse falls back to real arcs.
- **Spline** — Catmull-Rom through the points you click, so the curve passes
  *through* every control point (a B-spline would not, which surprises
  operators). Click the first point again to close it.

### Tests
- `test/font_test.js` — 48 assertions. The TrueType half runs against a real
  font from the Windows font folder and checks the things that reveal a broken
  parse: "A" comes back as an outer contour plus its counter, "O" as two
  concentric rings, contours enclose real area, curves are finely flattened,
  and every outline contour is closed while every stroke path is open.
- The Electron smoke test grew to 36 assertions, adding text, groups, ellipse
  and spline, and confirming engraved text still generates real G-code.
- `npm test` now runs all four Node suites; `npm run smoke` runs the Electron
  one.

### Fixed
- Text was offset twice — the glyph outlines were translated to the anchor and
  the first shape also had its `x`/`y` set, so `worldLoop` applied the anchor a
  second time. The anchor is now stored separately from the shape position.

---

## Push 2 — Construction tools and booleans

### Added
- **Boolean union / subtract** (`src/bool.js`, new). Select two closed parts;
  the first is the one kept. Merge two overlapping rectangles into one outline,
  or subtract a shape to make a notch.
  The app carries **true arcs** (G2/G3 in the TAP), but polygon clipping cannot
  work on arcs, so this flattens, clips with Greiner-Hormann, then **re-fits
  circular arcs on the result** — a curve that was an arc before the boolean
  comes back as an arc, instead of a few hundred tiny G1 moves that cut slowly
  and leave a visibly faceted edge on acrylic.
  Three safeguards, because a wrong outline here gets cut into real material:
  - near-vertex crossings are treated as degenerate (a crossing a millionth of
    the way along an edge is a shared corner in disguise, and feeding it to the
    traversal is how this algorithm returns confident garbage);
  - the result's **area is checked against bounds that must hold** for each
    operation, and an implausible result is refused rather than returned;
  - the arc refit is **verified against the polygon's area** and discarded in
    favour of plain lines if it disagrees. It also only runs when the input
    actually contained arcs, so a boolean of two rectangles can never sprout a
    curve.
  Shared edges (two parts butted exactly together) are resolved by nudging one
  outline 2e-6 in — about 50x below the 1e-4 the post rounds to, so the cut
  geometry is unchanged.
- **Offset** — parallel outline at a distance, inward or outward, keeping or
  replacing the original, with the new outline's cut type selectable (e.g. a
  0.5" inward border to pocket or score). An offset that would turn the outline
  inside out is refused instead of producing a self-crossing path.
- **Array** — rows and columns with centre-to-centre spacing, or a bolt circle
  by count and diameter, with an option to rotate each copy to face outward.
  Copies are independent parts, so each can still be edited or re-nested.
- **Chamfer** and **Fillet** on corners, applied to all corners or only the
  square-ish ones (60–120°). A chamfer replaces the corner with two points, so
  it becomes part of the outline and stays editable point by point; the
  setbacks are measured against the original geometry so one corner's cut does
  not shift the next one's.
- **Trim / extend / join**, aimed at cleaning up imported DXFs:
  - *Join* chains open paths that meet end to end, with an adjustable tolerance
    for ends that nearly meet but do not — the usual DXF problem — and closes
    the result automatically if the ends come together.
  - *Force close* connects the two ends of one open path.
  - *Trim* splits a path at every crossing with other geometry and removes the
    span you click.
  - *Extend* runs the nearer end of a path along its own tangent until it meets
    the next shape.
- **On-canvas dimensions** (`D`) — click two points, then a third to place the
  dimension line. Drawn with witness lines and arrow ticks. They are annotation
  only: stored on the job, saved with the project, and **never posted to the
  TAP**. Delete removes the one under the cursor when nothing is selected.

### Tests
- `test/bool_test.js` — 21 assertions checking booleans by **area**, which is
  what catches a plausible-looking but wrong outline. Covers overlap, notching,
  disjoint and fully-contained cases, arc survival and refit accuracy, the
  guarantee that a square never gains a phantom arc, and the shared-edge case.
- The Electron smoke test grew to 25 assertions, adding booleans, offset and
  dimensions, and confirming a dimension never reaches the generated TAP.

---

## Push 1 — Object snaps, grips, and the activity log (`fe088ee`)

### Added
- **Object snaps** (`src/snap.js`, new). Endpoint, midpoint, centre, quadrant,
  intersection and nearest-on-edge, with a priority order so an endpoint under
  the cursor always beats the edge it sits on. Each type draws its own CAD
  marker (square / triangle / circle / diamond / cross / tramlines) and the
  status bar names what you are locked to. Toggle the whole thing with **F3**;
  pick which types are active from the snap button in the toolbar.
  Intersections are computed *bounded* — segments are never extended to
  manufacture a crossing that is not really there.
- **Ortho / polar lock.** **F8** to latch, or hold **Shift** for a temporary
  lock while drawing or moving; **Alt** switches to 45° polar. Ortho resolves
  before object snaps, and a snap is only accepted if it stays on the locked
  axis, so the lock cannot be silently broken by a nearby point.
- **Edge and corner grips.** A selected part shows a square grip at every
  vertex and a round grip at the middle of every edge. Drag a vertex to move
  it; drag an edge grip to bow that edge into an arc. This is the workflow
  asked for: the **bulge distance is shown live at the cursor** and is typeable
  in the new *bulge* column of the points table, so a known bow can be entered
  directly instead of being converted into a radius by hand. *Arc R* stays
  available for when the radius is the number you already have.
  Dragging a grip on a rectangle promotes it to a polygon so its points become
  editable — logged when it happens, so the change is never silent.
- **Arc tool** (`A`) — three clicks: start, end, then a point the arc passes
  through. Collinear picks are rejected with a warning instead of producing a
  degenerate arc.
- **Measure tool** (`M`) — click two points for distance, angle and ΔX/ΔY.
- **Move by an exact distance** (`G`) — ΔX/ΔY, or distance + direction.
- **Scale** — by factor or to a target width/height, proportions locked by
  default. Warns before a non-uniform scale on parts containing arcs or
  fillets, because that turns true arcs into ellipses the post cannot cut.
- **Activity log** (`src/log.js`, new) in Settings. Captures actions, warnings
  and errors, including `window.onerror`, unhandled promise rejections, and
  anything routed to `console.warn` / `console.error` — so a failure that would
  otherwise only surface in devtools is visible inside the app. Survives
  restarts, filters by level, and copies or saves as a `.log` file to paste
  back into a conversation.
- **Icon toolbar** (`src/icons.js`, new). CAD-conventional glyphs: the
  primitive itself for draw tools, dashed construction lines for modify tools.
- **`test/snap_test.js`** (28 assertions) and **`test/smoke_main.js`**, a
  headless Electron smoke test (19 assertions) that loads the real bundle,
  fails on any console error, and drives the new tools through `window.CNC`.
  Run with `npm test` and `npm run smoke` from `electron/`.

### Changed
- `polyOpen` now honours `arcR`, so **open polylines can carry arcs**. It
  previously emitted straight lines only, which would have made the arc tool
  draw nothing at all.
- Snap geometry is cached and invalidated on edit. It is queried on every
  mousemove, and rebuilding every part's loop at cursor rate made dragging
  visibly sticky with a full sheet of parts.
- Settings loading merges the new `snap` block over the defaults, so an
  existing saved settings object does not come back missing the new keys.

---

## Push 0 — Reconcile source with shipped app, fix the build (`365cc9c`)

### Fixed
- **`src/` had drifted behind the shipped app.** `electron/app/CNCStudio.html`
  contained working features that existed nowhere in source. Any rebuild from
  `src/` would have silently deleted them. Recovered by decomposing the bundle
  back into source; the round-trip was verified byte-exact before installing.
- **The build had two disconnected targets.** `node build.js` wrote `dist/`,
  while Electron loaded and packaged `electron/app/`. Nothing copied between
  them, so `build.js` output was never what actually ran. `build.js` now writes
  `electron/app/CNCStudio.html` only — the file `main.js` loads and the file
  `electron-builder` packages.
- **`test/verify.js` always exited 0**, even on total failure, which made it
  useless as a regression guard. It now exits non-zero.

### Added
- Git repository + private GitHub remote as the single source of truth.
- `.gitattributes` marking `*.tap` / `*.dxf` as binary-ish (`-text`) so Git
  cannot rewrite their line endings. `Sides_manav.tap` is the golden reference
  and the post-processor emits exact CRLF; normalization would corrupt the test.
- `npm start` / `npm run dev` now bundle before launching, so the build step
  cannot be forgotten. `npm test` runs the regression gate.
- Pass/fail gate in `verify.js`: **61/61 pass-blocks within 3e-4 and a
  byte-exact header/footer**. Deliberately *not* line-by-line identity — the
  nearest-neighbour path ordering differs from EnRoute's by design, so ~1185
  lines differ on a perfectly correct build. Confirmed the gate fails on an
  injected 1/16" safe-Z change and passes on the reconciled tree.

### Recovered into source (was Electron-only)
- `geom.js`: per-edge arc bulge via `pts[].arcR` in `polyLoop` (+ bulges out,
  − bulges in); fillet radius clamped to half the adjacent edge lengths;
  degenerate-angle guard for straight or doubled-back corners; per-corner rect
  radii (`rectLoop(..., rc[])`); `normalizePolyPts` exported.
- `app.js`: polygon builder dialog (sides by length + absolute or turn angle,
  with the closing side computed automatically); polygon point/edge table with
  live editing of X, Y, fillet R, edge length, edge direction and arc R;
  `rotateSel` about the bounding-box centre; `X`/`Y`/`A` keys to jump to
  fields; `[` and `]` to rotate.
- `index.html`: `Dims…` toolbar button, overlay/dialog styles, wider properties
  column.

### Removed
- `dist/CNCStudio.html` and the standalone-HTML build target. The Electron app
  is now the only target.
- The generated bundle is no longer tracked in Git — it is rebuilt by every
  `npm start`, and tracking it put a 100 KB generated file into every diff.

---

## Baseline (`b2af4e1`)

Project imported as received, before any modification, so the Electron-only
features have a recoverable commit.
