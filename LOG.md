# Change Log

Running record of what was added, changed, or removed. Newest first.
Each entry names the commit so anything here can be found in `git log`.

---

## Push 1 — Object snaps, grips, and the activity log

### Added
- **Object snaps** (, new). Endpoint, midpoint, centre, quadrant,
  intersection and nearest-on-edge, with a priority order so an endpoint under
  the cursor always beats the edge it sits on. Each type draws its own CAD
  marker (square / triangle / circle / diamond / cross / tramlines) and the
  status bar names what you are locked to. Toggle the whole thing with **F3**,
  pick types from the snap button in the toolbar.
  Intersections are computed *bounded* — segments are never extended to
  manufacture a crossing that is not really there.
- **Ortho / polar lock.** **F8** to latch, or hold **Shift** for a temporary
  lock while drawing or moving; **Alt** switches to 45° polar. Ortho is applied
  before object snaps, and a snap is only accepted if it stays on the locked
  axis, so the lock cannot be silently broken by a nearby point.
- **Edge and corner grips.** A selected part shows a square grip at every
  vertex and a round grip at the middle of every edge. Drag a vertex to move
  it; drag an edge grip to bow that edge into an arc. This is the workflow you
  asked for: the **bulge distance is shown live at the cursor** and is typeable
  in the new *bulge* column of the points table, so a known bow can be entered
  directly instead of being converted to a radius by hand. Arc R stays
  available for when the radius is the number you have.
  Dragging a grip on a rectangle promotes it to a polygon so its points become
  editable (logged when it happens).
- **Arc tool** (A) — three clicks: start, end, then a point the arc passes
  through. Collinear picks are rejected with a warning rather than producing a
  degenerate arc.
- **Measure tool** (M) — click two points for distance, angle and ΔX/ΔY.
- **Move by an exact distance** (G) — ΔX/ΔY, or distance + direction.
- **Scale** — by factor or to a target width/height, with proportions locked by
  default. Warns before a non-uniform scale on parts containing arcs or
  fillets, because that would turn true arcs into ellipses the post cannot cut.
- **Activity log** (, new) in Settings. Captures actions, warnings
  and errors, including , unhandled promise rejections and
  anything routed to  /  — so a failure that would
  otherwise only appear in devtools is visible in the app. Survives restarts,
  filterable by level, and copyable or savable as a  file to paste back.
- **Icon toolbar** (, new). CAD-conventional glyphs: the
  primitive itself for draw tools, dashed construction lines for modify tools.
- **** (28 assertions) and ****, a
  headless Electron smoke test (19 assertions) that loads the real bundle,
  fails on any console error, and drives the new tools through .
  Run with  and .

### Changed
-  now honours , so **open polylines can carry arcs**. They
  previously emitted straight lines only, which would have made the arc tool
  draw nothing.
- Snap geometry is cached and invalidated on edit; it is queried on every
  mousemove and rebuilding every part's loop at cursor rate made dragging
  sticky with a full sheet of parts.
- Settings load merges the new  block over defaults, so an existing saved
  settings object does not lose the new keys.


---

## Push 0 — Reconcile source with shipped app, fix the build (`365cc9c`)

### Fixed
- **`src/` had drifted behind the shipped app.** `electron/app/CNCStudio.html`
  contained working features that existed nowhere in source. Any rebuild from
  `src/` would have silently deleted them. Recovered by decomposing the bundle
  back into source; the round-trip was verified byte-exact before installing.
- **The build had two disconnected targets.** `node build.js` wrote `dist/`,
  while Electron loaded and packaged `electron/app/`. Nothing copied between
  them, so `build.js` output was never what ran. `build.js` now writes
  `electron/app/CNCStudio.html` only — the file `main.js` loads and the file
  `electron-builder` packages.
- **`test/verify.js` always exited 0**, even on total failure, making it
  useless as a regression guard. It now exits non-zero.

### Added
- Git repository + private GitHub remote as the single source of truth.
- `.gitattributes` marking `*.tap` / `*.dxf` as binary-ish (`-text`) so Git
  cannot rewrite line endings. `Sides_manav.tap` is the golden reference and
  the post-processor emits exact CRLF; normalization would corrupt the test.
- `npm start` / `npm run dev` now bundle before launching, so the build step
  cannot be forgotten. `npm test` runs the regression gate.
- Pass/fail gate in `verify.js`: **61/61 pass-blocks within 3e-4 and a
  byte-exact header/footer**. Deliberately *not* line-by-line identity — our
  nearest-neighbour path ordering differs from EnRoute's by design, so ~1185
  lines differ on a correct build. Confirmed the gate fails on an injected
  1/16" safe-Z change and passes on the reconciled tree.

### Recovered into source (was Electron-only)
- `geom.js`: per-edge arc bulge via `pts[].arcR` in `polyLoop` (+ bulges out,
  − bulges in); fillet radius clamped to half the adjacent edge lengths;
  degenerate-angle guard for straight/doubled-back corners; per-corner rect
  radii (`rectLoop(..., rc[])`); `normalizePolyPts` exported.
- `app.js`: polygon builder dialog (sides by length + absolute or turn angle,
  auto-computed closing side); polygon point/edge table with live editing of
  X, Y, fillet R, edge length, edge direction and arc R; `rotateSel` about the
  bounding-box centre; `X`/`Y`/`A` keys to jump to fields; `[` / `]` to rotate.
- `index.html`: `Dims…` toolbar button, overlay/dialog styles, wider
  properties column.

### Removed
- `dist/CNCStudio.html` and the standalone-HTML build target. The Electron app
  is now the only target.
- The generated bundle is no longer tracked in Git (it is rebuilt by every
  `npm start`), which keeps a 100 KB generated file out of every diff.

---

## Baseline (`b2af4e1`)

Project imported as received, before any modification, so the Electron-only
features have a recoverable commit.
