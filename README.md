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

## Files
- `electron/app/CNCStudio.html` — GENERATED bundle (`node build.js`). Do not edit by hand; it is gitignored and rebuilt on every `npm start`.
- `src/geom.js` — geometry: lines/arcs, tool offsetting, DXF read/write
- `src/post.js` — toolpaths + WinCNC TAP post-processor
- `src/nest.js` — bottom-left nesting
- `src/app.js`, `src/index.html` — UI
- `test/verify.js` — regenerates `Sides_manav.tap` from its own geometry and compares; the gate is 61/61 pass-blocks within 3e-4 and a byte-exact header/footer, not line-by-line identity (path ordering differs from EnRoute by design)
- `test/sides_full.dxf` — the 30 parts from your sample job as DXF (Open… it in the app, then Export TAP)

## Machine defaults (Settings page)
Bed 60 × 120 in (X × Y), origin bottom-left, Z0 = bed surface, safe Z 1.1875,
header `G90/G53/M61`, tool change `[name] M5 T## M3`, footer `M5/G53/M62/G53 X0 Y120`.
All editable. Tool table: slot, diameter, RPM, feed, plunge, pass depth.

## Claude API
Settings → paste your API key. AI Design tab: describe parts ("7 rectangles 6.5 × 7"), they're added and nested from 0,0.
