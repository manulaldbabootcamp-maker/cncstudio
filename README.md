# CNC Studio — EnRoute 5 replacement for WinCNC

2D CAD/CAM for flat sheet work on a 5×10 ft router with an auto tool changer.
Draws parts, offsets toolpaths for the tool diameter, simulates the cut (kerf shown as removed material),
imports/exports DXF, and writes WinCNC `.TAP` files in the exact EnRoute format.

## Run it (two options)

**A. Just open the file** — `CNCStudio.html` runs in Chrome/Edge directly (double-click it).
Everything works, including the Claude API. Exports go to your Downloads folder.

**B. Windows desktop app (Electron)** — gives a real "Save As" dialog for TAP/DXF.
```
cd electron
npm install
npm start          # run
npm run build      # makes a portable CNC Studio.exe in electron/dist
```

## Files
- `dist/CNCStudio.html` — the whole app in one file (built from `src/` with `node build.js`)
- `src/geom.js` — geometry: lines/arcs, tool offsetting, DXF read/write
- `src/post.js` — toolpaths + WinCNC TAP post-processor
- `src/nest.js` — bottom-left nesting
- `src/app.js`, `src/index.html` — UI
- `test/verify.js` — regenerates `Sides_manav.tap` from its own geometry and compares (run `node test/verify.js`)
- `test/sides_full.dxf` — the 30 parts from your sample job as DXF (Open… it in the app, then Export TAP)

## Machine defaults (Settings page)
Bed 60 × 120 in (X × Y), origin bottom-left, Z0 = bed surface, safe Z 1.1875,
header `G90/G53/M61`, tool change `[name] M5 T## M3`, footer `M5/G53/M62/G53 X0 Y120`.
All editable. Tool table: slot, diameter, RPM, feed, plunge, pass depth.

## Claude API
Settings → paste your API key. AI Design tab: describe parts ("7 rectangles 6.5 × 7"), they're added and nested from 0,0.
