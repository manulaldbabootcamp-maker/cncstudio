# Working notes for Claude

Read this before changing anything. It is the part of the project that is not in
the code: who it is for, what must not break, and how the last round of work was
done. Conversations do not travel between machines — this file does.

## What this is

A 2D CAD/CAM app replacing EnRoute 5, driving a WinCNC 5×10 ft router that cuts
flat plastic — acrylic and HDPE. The operator is a working shop, not a hobbyist:
parts get cut in real material, and a wrong toolpath costs a sheet.

## The north star

**Byte-identical reproduction of EnRoute's output.** `test/enroute_test.js` and
`test/verify.js` hold the line, and `tapfiles/` has EnRoute's own files beside
ours for the same part. A change that alters the posted program for an unchanged
drawing is a regression unless it was asked for. New features default to OFF for
this reason — holding tabs, for instance.

## How to work on it

- **Reproduce before fixing.** Every bug reported here turned out to have a
  different cause than the symptom suggested — the drag that "moved the circle
  but not its centre" was snapping the grab point, not the centre; the "merge
  that squashed a dome" was an arc→bulge round-trip two steps later. Build the
  failing case first, in a test or a headless run, and let it tell you where it
  actually breaks. Guessing has been wrong nearly every time.
- **When a test disagrees with the code, check the test first.** That has been
  the answer three times in a row.
- `cd electron && npm test` (10 suites), `npm run smoke` (headless Electron,
  305 assertions), `npm run scenarios` (ten designs, screenshots in
  `test/shots/`). Run them. `npm start` rebuilds and launches.
- `src/*.js` are plain IIFE modules concatenated by `build.js` in a fixed order
  (`log, geom, post, nest, snap, align, bool, region, font, pdf, icons, app`). A module
  may only call a later one lazily, at call time — `post.js` reaches `snap.js`
  through `snapMod()` for exactly that reason.
- `electron/app/CNCStudio.html` is generated. Never edit it; editing it is how
  the shipped app once drifted ahead of `src/`.

## Comments

Comments say **why**, not what. They name the failure that forced the code to be
the way it is, so the next person does not undo it. Match that density and tone;
do not strip them, and do not add narration of the obvious.

## Things learned the hard way

- **A circle stays a circle.** Operations that need a circle split into arcs
  build the arrangement from *copies* (`src/region.js`). Cutting the drawing's
  own geometry to answer a question about area is what turned circles into
  four-point polygons and made the app unusable.
- **Arcs are true arcs** end to end — `{type:'arc',a,b,c,ccw}` through to G2/G3.
  A polygon stores a curved side as a bulge off its chord, which is exact under
  180° and destroys anything larger, so `makeEditable` verifies area and bbox and
  restores the shape as a path when they do not survive.
- **Refuse rather than cut wrong.** An offset that collapses, a path that folds
  over, a tool that will not fit between two lines: say so, with the reason, and
  cut nothing. Silently cutting down the middle of a line is the worst outcome
  available.
- **Left is left.** For an open path, the side is independent of the direction it
  was drawn — `canonicalOpen()` fixes the run before offsetting. Square corners
  stay square (mitred), and the cut edge runs a tool radius past each end.
- **Units are a display skin.** Everything is stored and posted in inches;
  `toU`/`fromU`/`uParse`/`fmtIn` convert at the edges only. A field that reads
  `parseFloat` instead of `uParse` is a bug in millimetre mode.

## Operator's standing instructions

- **Do not touch the DXF file.** Said once, plainly; it stands.
- Do what was asked and stop there. "You can continue, but do not test it — I
  will do my test, just relaunch" means exactly that; so does "build and let me
  test".
- Short answers. Plain words. No lectures.
- Relaunch the app after changes unless told otherwise.

## Still open

- **DIV loses 0.2405 in.** A circle divided by a line came back 28.2595 where
  28.5 was right, and the green dimension reports the selected part. My first
  explanation — a stray rim fragment — was disproven by my own test. Unresolved.
- **A chord crossing a circle twice near the rim returns one region, not two.**
  Found while chasing the above; looks like `arrange` drops those crossings.
- Indic shaping (GSUB) is not implemented: single glyphs like ॐ cut correctly,
  conjuncts and matras do not.
