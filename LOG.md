# Change Log

Running record of what was added, changed, or removed. Newest first.
Each entry names the commit so anything here can be found in `git log`.

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
