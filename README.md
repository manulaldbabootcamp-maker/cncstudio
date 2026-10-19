# CNC Studio — EnRoute 5 replacement for WinCNC

2D CAD/CAM for flat sheet work on a 5×10 ft router with an auto tool changer.
Draws parts, offsets toolpaths for the tool diameter, simulates the cut (kerf shown as removed material),
imports/exports DXF, and writes WinCNC `.TAP` files in the exact EnRoute format.

## Run it

One-time setup: install [Node.js](https://nodejs.org), then:
```
cd electron
npm install
```

After that, the whole loop is:
```
git pull
cd electron && npm start
```
`npm start` rebuilds the bundle from `src/` and launches the app, so there is no
separate build step to forget. `npm run build` makes a portable `CNC Studio.exe`
in `electron/dist`.

Run the regression test before/after changes (exits non-zero on failure):
```
cd electron && npm test
```

## Drawing and editing

**Draw:** rectangle `R`, circle `C`, arc `A` (3 points), polygon `P`, polyline `L`,
ellipse `E`, spline, and text. `Dims…` builds a polygon from side lengths and angles.

**Object snaps** — endpoint, midpoint, centre, quadrant, intersection, nearest on
edge. `F3` toggles; the snap button picks which types are live. Each type draws its
own marker and the status bar names what you are locked to.

**Ortho** — `F8` latches, **Shift** is a temporary lock while drawing or moving,
**Alt** gives 45° polar.

**Grips** — a selected part shows a square grip at each corner and a round grip at
the middle of each edge. Drag an edge grip to bow it into an arc; the bulge distance
shows live at the cursor and is typeable in the *bulge* column of the points table.
That is the "pull the middle of the line out to a known distance" workflow — no
radius arithmetic needed. *Arc R* is the same curve as a radius when that is the
number you have.

**Modify** — move by exact distance `G`, scale, offset, array (grid or bolt circle),
chamfer, fillet, union, subtract, trim / extend / join, measure `M`, dimension `D`,
group `Ctrl+G`.

**Text** — the built-in font is *single-line*: each letter is one open stroke the
tool follows down the middle, which is what a V-bit needs for a part number. Load
your own `.ttf` in the text dialog to cut or pocket real letter outlines.

Dimensions are annotation only — they are saved with the project and never posted
to the TAP.

## Files
- `electron/app/CNCStudio.html` — GENERATED bundle (`node build.js`). Do not edit by hand; it is gitignored and rebuilt on every `npm start`.
- `src/log.js` — activity log (loaded first so it captures startup failures)
- `src/geom.js` — geometry: lines/arcs, offsetting, ellipse/spline, DXF read/write
- `src/snap.js` — object snaps + ortho/polar constraint
- `src/bool.js` — boolean union/subtract/intersect, with arc refitting
- `src/font.js` — single-line stroke font + TrueType parser
- `src/post.js` — toolpaths + WinCNC TAP post-processor
- `src/nest.js` — bottom-left nesting
- `src/icons.js` — toolbar glyphs
- `src/app.js`, `src/index.html` — UI
- `test/verify.js` — regenerates `Sides_manav.tap` from its own geometry and compares; the gate is 61/61 pass-blocks within 3e-4 and a byte-exact header/footer, not line-by-line identity (path ordering differs from EnRoute by design)
- `test/snap_test.js`, `test/bool_test.js`, `test/font_test.js` — unit suites (`npm test`)
- `test/smoke_main.js` — headless Electron test: loads the real bundle, fails on any console error (`npm run smoke`)
- `test/sides_full.dxf` — the 30 parts from your sample job as DXF (Open… it in the app, then Export TAP)
- `tapfiles/` — reference material: EnRoute's own `.tap` output next to ours for the same part, plus the DXFs and screenshots behind past investigations
- `fonts/` — TrueType fonts the Text box can load (Nirmala UI, for Devanagari and the Om symbol). Windows' own copy is a `.ttc` collection, which the parser cannot read past the first font, so each weight is split out with `tools/extract_ttc.js`. Bold English fonts for cut lettering: Arial Bold, Arial Black, Calibri Bold, Segoe UI Bold, Verdana Bold, Tahoma Bold, Trebuchet Bold, Times New Roman Bold, Georgia Bold, Consolas Bold, Impact, and Stencil (letters with bridges, so the centres of A, O, R stay attached when cut out). Playful (for stencils with Bridges ticked): Comic Sans Bold, Cooper Black, Kristen, Snap, Showcard Gothic, Gill Sans Ultra Bold, Berlin Sans Bold, Jokerman, Ravie, Curlz, Tempus Sans, Eras Bold, Segoe UI Black. Cursive: Brush Script, Freestyle Script, French Script, Edwardian Script, Kunstler Script, Vivaldi, Vladimir Script, Palace Script, Mistral, Monotype Corsiva, Lucida Handwriting, Lucida Calligraphy, Bradley Hand, Segoe Script (and Bold), Segoe Print (and Bold), Script MT Bold, Pristina, Rage Italic, Matura Script, Gabriola, Ink Free
- `tools/extract_ttc.js` — splits a `.ttc` collection into loadable `.ttf` files

## Moving to another PC

Everything the app needs is in this repo. Two things are not, because they are
rebuilt rather than carried: `node_modules` (run `npm install`) and the generated
bundle (`npm start` rebuilds it).

```
git clone https://github.com/manulaldbabootcamp-maker/cncstudio.git
cd cncstudio/electron
npm install
npm start
```

What the repo cannot hold is your **settings** — tools, feeds, machine preset,
materials, units and keyboard shortcuts live in the app's local storage on that
PC, not in a file. On the old machine: Settings → **Export settings**. On the new
one: Settings → **Import settings**. That file carries the Claude API key too, so
move it directly rather than emailing it.

The fonts in `fonts/` are Microsoft's, shipped with Windows and kept here only so
this private repo is self-contained. They are not ours to redistribute, so this
repo stays private.

## When something misbehaves
Settings → **Activity log**. It records actions, warnings and errors, including ones
that would otherwise only appear in the developer console, and it survives a restart.
**Copy all** or **Save .log** to hand the record over.

## Machine defaults (Settings page)
Bed 60 × 120 in (X × Y), origin bottom-left, Z0 = bed surface, safe Z 1.1875,
header `G90/G53/M61`, tool change `[name] M5 T## M3`, footer `M5/G53/M62/G53 X0 Y120`.
All editable. Tool table: slot, diameter, RPM, feed, plunge, pass depth.

## Claude API
Settings → paste your API key. AI Design tab: describe parts ("7 rectangles 6.5 × 7"), they're added and nested from 0,0.
