/* ===== font.js — text for cutting and engraving =====

   Two different jobs, two different kinds of geometry:

   1. ENGRAVE (single line). A built-in stroke font whose glyphs are open
      polylines. The tool follows the centreline of each stroke, which is what
      you want for a V-bit or a small endmill putting a part number on a piece.
      A normal font cannot do this - its letters are closed outlines, and
      following one traces around the letter instead of drawing it.

   2. CUT (outline). Parses a real TrueType file and returns the closed
      contours of each glyph, so letters can be cut out of the sheet or
      pocketed. Any .ttf the operator supplies works; nothing is bundled.

   The TrueType side implements just enough of the spec for flat lettering:
   head / maxp / hhea / hmtx / cmap(4,12) / loca / glyf, simple and composite
   glyphs. No hinting, no GPOS kerning - neither affects a cut outline. */
const FONT = (() => {
  const G = typeof GEOM !== 'undefined' ? GEOM : require('./geom.js');
  const P = G.P;

  /* ---------------- built-in single-line stroke font ----------------
     Coordinates are on a 0..20 grid: baseline y=0, cap height 14,
     x-height 10, descender -4. Each glyph is "advance:stroke|stroke",
     a stroke being space-separated "x,y" points. Curves are polygonal on
     purpose - at engraving sizes the facets are far below tool diameter. */
  const STROKES = {
    ' ': '8:',
    'A': '14:1,0 7,14 13,0|3.5,5 10.5,5',
    'B': '13:2,0 2,14|2,14 9,14 11,12 11,9 9,7.5 2,7.5|2,7.5 9.5,7.5 11.5,6 11.5,2 9.5,0 2,0',
    'C': '13:11.5,11 9,14 5,14 2,11 2,3 5,0 9,0 11.5,3',
    'D': '13:2,0 2,14|2,14 8,14 11.5,10.5 11.5,3.5 8,0 2,0',
    'E': '12:10.5,14 2,14 2,0 10.5,0|2,7.5 9,7.5',
    'F': '12:10.5,14 2,14 2,0|2,7.5 9,7.5',
    'G': '14:11.5,11 9,14 5,14 2,11 2,3 5,0 9,0 12,3 12,6.5 8,6.5',
    'H': '14:2,14 2,0|12,14 12,0|2,7.5 12,7.5',
    'I': '6:3,14 3,0',
    'J': '11:9,14 9,3 6.5,0 3.5,0 1,3',
    'K': '13:2,14 2,0|11.5,14 2,6.5|5.5,9.5 12,0',
    'L': '11:2,14 2,0 10,0',
    'M': '16:2,0 2,14 8,5 14,14 14,0',
    'N': '14:2,0 2,14 12,0 12,14',
    'O': '14:5,14 9,14 12,11 12,3 9,0 5,0 2,3 2,11 5,14',
    'P': '13:2,0 2,14 9,14 11.5,11.5 11.5,9 9,6.5 2,6.5',
    'Q': '14:5,14 9,14 12,11 12,3 9,0 5,0 2,3 2,11 5,14|8.5,3.5 12.5,-1',
    'R': '13:2,0 2,14 9,14 11.5,11.5 11.5,9 9,6.5 2,6.5|7,6.5 12,0',
    'S': '13:11.5,11.5 9,14 4.5,14 2,11.5 2,9 4.5,7.5 9,6.5 11.5,5 11.5,2.5 9,0 4,0 1.5,2.5',
    'T': '12:1,14 11,14|6,14 6,0',
    'U': '14:2,14 2,3 5,0 9,0 12,3 12,14',
    'V': '14:1,14 7,0 13,14',
    'W': '18:1,14 4.5,0 9,10 13.5,0 17,14',
    'X': '13:1.5,14 11.5,0|11.5,14 1.5,0',
    'Y': '13:1.5,14 6.5,7 11.5,14|6.5,7 6.5,0',
    'Z': '13:1.5,14 11.5,14 1.5,0 11.5,0',
    'a': '12:10,0 10,10|10,8 8,10 4.5,10 2,7.5 2,2.5 4.5,0 8,0 10,2',
    'b': '12:2,14 2,0|2,8 4,10 7.5,10 10,7.5 10,2.5 7.5,0 4,0 2,2',
    'c': '11:9.5,8 7.5,10 4.5,10 2,7.5 2,2.5 4.5,0 7.5,0 9.5,2',
    'd': '12:10,14 10,0|10,8 8,10 4.5,10 2,7.5 2,2.5 4.5,0 8,0 10,2',
    'e': '12:2,5 10,5 10,7.5 7.5,10 4.5,10 2,7.5 2,2.5 4.5,0 8,0 10,2',
    'f': '8:7,14 5,14 3,12 3,0|1,10 6.5,10',
    'g': '12:10,10 10,-2 8,-4 4.5,-4 2.5,-2.5|10,8 8,10 4.5,10 2,7.5 2,2.5 4.5,0 8,0 10,2',
    'h': '12:2,14 2,0|2,8 4.5,10 8,10 10,8 10,0',
    'i': '5:2.5,10 2.5,0|2.5,13.5 2.5,12.5',
    'j': '6:3.5,10 3.5,-2 2,-4 0.5,-4|3.5,13.5 3.5,12.5',
    'k': '11:2,14 2,0|9.5,10 2,4|5,6.5 10,0',
    'l': '5:2.5,14 2.5,0',
    'm': '18:2,10 2,0|2,8 4,10 6.5,10 8.5,8 8.5,0|8.5,8 10.5,10 13,10 15,8 15,0',
    'n': '12:2,10 2,0|2,8 4.5,10 8,10 10,8 10,0',
    'o': '12:4.5,10 7.5,10 10,7.5 10,2.5 7.5,0 4.5,0 2,2.5 2,7.5 4.5,10',
    'p': '12:2,10 2,-4|2,8 4,10 7.5,10 10,7.5 10,2.5 7.5,0 4,0 2,2',
    'q': '12:10,10 10,-4|10,8 8,10 4.5,10 2,7.5 2,2.5 4.5,0 8,0 10,2',
    'r': '9:2,10 2,0|2,7 4,9.5 7,10',
    's': '11:9.5,8.5 7.5,10 4,10 2,8.5 2,6.5 4,5.5 7.5,5 9.5,4 9.5,1.5 7.5,0 4,0 2,1.5',
    't': '8:3,14 3,2.5 4.5,0 6.5,0|1,10 6.5,10',
    'u': '12:2,10 2,2 4,0 7.5,0 10,2|10,10 10,0',
    'v': '11:1,10 5.5,0 10,10',
    'w': '15:1,10 4,0 7,7.5 10,0 13,10',
    'x': '11:1.5,10 9.5,0|9.5,10 1.5,0',
    'y': '11:1,10 5.5,0|10,10 4.5,-4',
    'z': '11:1.5,10 9.5,10 1.5,0 9.5,0',
    '0': '13:5,14 8,14 11,11 11,3 8,0 5,0 2,3 2,11 5,14|3,3 10,11',
    '1': '9:2.5,11.5 5.5,14 5.5,0|2.5,0 8.5,0',
    '2': '13:2,11.5 4.5,14 8.5,14 11,11.5 11,9 2,0 11,0',
    '3': '13:2,12.5 4.5,14 8.5,14 11,11.5 11,9.5 8.5,7.5 5,7.5|8.5,7.5 11,5.5 11,2.5 8.5,0 4.5,0 2,1.5',
    '4': '13:8.5,0 8.5,14 1.5,4.5 11.5,4.5',
    '5': '13:10.5,14 3,14 2.5,8 5,9.5 8,9.5 11,7 11,3 8,0 4.5,0 2,1.5',
    '6': '13:10,12.5 7.5,14 4.5,14 2,11 2,3 4.5,0 8,0 10.5,2.5 10.5,5 8,7.5 4.5,7.5 2,5.5',
    '7': '13:2,14 11.5,14 5,0',
    '8': '13:5,7.5 2.5,9.5 2.5,12 5,14 8.5,14 11,12 11,9.5 8.5,7.5 5,7.5 2,5.5 2,2 4.5,0 9,0 11.5,2 11.5,5.5 8.5,7.5',
    '9': '13:3,1.5 5.5,0 9,0 11.5,3 11.5,11 9,14 5.5,14 3,11.5 3,9 5.5,6.5 9,6.5 11.5,8.5',
    '.': '6:2.5,0 3.5,0 3.5,1 2.5,1 2.5,0',
    ',': '6:3.5,1 3.5,0 2,-2.5',
    '-': '10:2,6.5 8,6.5',
    '_': '12:1,-3 11,-3',
    '+': '12:2,6.5 10,6.5|6,10.5 6,2.5',
    '=': '12:2,8.5 10,8.5|2,4.5 10,4.5',
    '/': '10:1,0 9,14',
    '\\': '10:1,14 9,0',
    ':': '6:2.5,9 3.5,9 3.5,10 2.5,10 2.5,9|2.5,0 3.5,0 3.5,1 2.5,1 2.5,0',
    ';': '6:2.5,9 3.5,9 3.5,10 2.5,10 2.5,9|3.5,1 3.5,0 2,-2.5',
    '!': '6:3,14 3,4|2.5,0 3.5,0 3.5,1 2.5,1 2.5,0',
    '?': '11:2,11.5 4.5,14 7,14 9.5,11.5 9.5,9.5 5.5,6.5 5.5,4|5,0 6,0 6,1 5,1 5,0',
    '"': '8:2.5,14 2.5,10.5|5.5,14 5.5,10.5',
    "'": '5:2.5,14 2.5,10.5',
    '(': '7:5,14 2.5,10.5 2.5,3.5 5,0',
    ')': '7:2,14 4.5,10.5 4.5,3.5 2,0',
    '[': '7:5,14 2.5,14 2.5,0 5,0',
    ']': '7:2,14 4.5,14 4.5,0 2,0',
    '#': '14:3.5,14 2,0|9.5,14 8,0|1.5,9.5 11,9.5|1,4.5 10.5,4.5',
    '%': '15:2,14 5,14 5,11 2,11 2,14|9,3 12,3 12,0 9,0 9,3|2,0 12,14',
    '&': '15:12,0 4,8 2.5,10 2.5,12 4.5,14 6.5,14 8.5,12 8.5,10 2,5 2,2 4,0 7,0 10,2.5',
    '*': '10:5,12 5,4|1.5,10 8.5,6|8.5,10 1.5,6',
    '@': '18:12,4 12,10 9,10 9,4 12,4|12,10 12,13 9,14 5,14 2,11 2,3 5,0 9,0 12,1.5',
    '$': '13:11,12 8.5,13.5 4.5,13.5 2,12 2,9.5 4.5,8 8.5,7 11,5.5 11,2.5 8.5,1 4.5,1 2,2.5|6.5,14.5 6.5,-0.5',
  };
  const STROKE_EM = 20;      // grid height used above
  const STROKE_CAP = 14;     // cap height on that grid

  let strokeCache = null;
  function strokeGlyphs() {
    if (strokeCache) return strokeCache;
    strokeCache = {};
    for (const ch of Object.keys(STROKES)) {
      const [advStr, body] = STROKES[ch].split(':');
      const polys = (body || '').split('|').filter(Boolean).map(sp =>
        sp.trim().split(/\s+/).map(pt => { const [x, y] = pt.split(','); return { x: +x, y: +y }; }));
      strokeCache[ch] = { adv: +advStr, polys };
    }
    return strokeCache;
  }

  /* Lay out text in the built-in stroke font.
     Returns [{pts:[...], closed:false}] in inches, origin at the baseline
     start, y up. */
  function strokeText(text, opts = {}) {
    const h = opts.height || 1;                  // cap height in inches
    const k = h / STROKE_CAP;                    // grid -> inches
    const tracking = (opts.tracking || 0) / k;   // extra space, in grid units
    const lineGap = (opts.lineGap != null ? opts.lineGap : h * 1.6);
    const glyphs = strokeGlyphs();
    const out = [];
    const missing = new Set();
    let ly = 0;
    for (const rawLine of String(text).split('\n')) {
      let x = 0;
      const lineStart = out.length;
      for (const ch of rawLine) {
        let g = glyphs[ch];
        if (!g) { const up = glyphs[ch.toUpperCase()]; if (up) g = up; }
        if (!g) { missing.add(ch); g = glyphs[' ']; }
        for (const poly of g.polys) {
          out.push({ closed: false, pts: poly.map(p => ({ x: (x + p.x) * k, y: p.y * k + ly })) });
        }
        x += g.adv + tracking;
      }
      // horizontal alignment for this line
      if (opts.align && opts.align !== 'left') {
        const w = x * k;
        const dx = opts.align === 'center' ? -w / 2 : -w;
        for (let i = lineStart; i < out.length; i++) for (const p of out[i].pts) p.x += dx;
      }
      ly -= lineGap;
    }
    return { paths: out, missing: Array.from(missing), single: true };
  }

  /* ---------------- TrueType ---------------- */
  function reader(buf) {
    const dv = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer, buf.byteOffset || 0, buf.byteLength);
    let o = 0;
    return {
      get pos() { return o; }, set pos(v) { o = v; },
      u8: () => dv.getUint8(o++),
      i8: () => dv.getInt8(o++),
      u16: () => { const v = dv.getUint16(o); o += 2; return v; },
      i16: () => { const v = dv.getInt16(o); o += 2; return v; },
      u32: () => { const v = dv.getUint32(o); o += 4; return v; },
      tag: () => { let s = ''; for (let i = 0; i < 4; i++) s += String.fromCharCode(dv.getUint8(o++)); return s; },
      at: (p) => { o = p; },
    };
  }

  function parse(buf) {
    const r = reader(buf);
    let ver = r.u32();
    if (ver === 0x74746366) {          // 'ttcf' collection: take the first font
      r.u32(); r.u32();
      r.at(r.u32()); ver = r.u32();
    }
    if (ver !== 0x00010000 && ver !== 0x74727565) {
      if (ver === 0x4F54544F) throw new Error('This is an OpenType/CFF font (.otf). Only TrueType outlines (.ttf) are supported — most .ttf files work.');
      throw new Error('Not a TrueType font file');
    }
    const numTables = r.u16(); r.u16(); r.u16(); r.u16();
    const tables = {};
    for (let i = 0; i < numTables; i++) { const t = r.tag(); r.u32(); const off = r.u32(); const len = r.u32(); tables[t] = { off, len }; }
    for (const need of ['head', 'maxp', 'cmap', 'glyf', 'loca']) {
      if (!tables[need]) throw new Error(`Font is missing its "${need}" table` + (need === 'glyf' ? ' (it may be an OpenType/CFF font)' : ''));
    }

    r.at(tables.head.off + 18); const unitsPerEm = r.u16();
    r.at(tables.head.off + 50); const indexToLocFormat = r.i16();
    r.at(tables.maxp.off + 4); const numGlyphs = r.u16();
    let numHM = 0;
    if (tables.hhea) { r.at(tables.hhea.off + 34); numHM = r.u16(); }

    // loca
    const loca = new Array(numGlyphs + 1);
    r.at(tables.loca.off);
    for (let i = 0; i <= numGlyphs; i++) loca[i] = indexToLocFormat ? r.u32() : r.u16() * 2;

    // hmtx
    const adv = new Array(numGlyphs).fill(unitsPerEm / 2);
    if (tables.hmtx && numHM) {
      r.at(tables.hmtx.off);
      let last = unitsPerEm / 2;
      for (let i = 0; i < numGlyphs; i++) {
        if (i < numHM) { last = r.u16(); r.i16(); }
        adv[i] = last;
      }
    }

    // cmap: prefer a Unicode subtable
    const cmap = new Map();
    r.at(tables.cmap.off); r.u16();
    const nSub = r.u16();
    let best = null;
    for (let i = 0; i < nSub; i++) {
      const pid = r.u16(), eid = r.u16(), off = r.u32();
      const score = (pid === 3 && eid === 10) ? 5 : (pid === 3 && eid === 1) ? 4 : (pid === 0) ? 3 : (pid === 3 && eid === 0) ? 2 : 1;
      if (!best || score > best.score) best = { off: tables.cmap.off + off, score };
    }
    if (best) {
      r.at(best.off);
      const fmt = r.u16();
      if (fmt === 4) {
        r.u16(); r.u16();
        const segX2 = r.u16(); const seg = segX2 / 2;
        r.u16(); r.u16(); r.u16();
        const end = [], start = [], delta = [], rangeOff = [];
        for (let i = 0; i < seg; i++) end.push(r.u16());
        r.u16();
        for (let i = 0; i < seg; i++) start.push(r.u16());
        for (let i = 0; i < seg; i++) delta.push(r.i16());
        const roBase = r.pos;
        for (let i = 0; i < seg; i++) rangeOff.push(r.u16());
        for (let i = 0; i < seg; i++) {
          for (let c = start[i]; c <= end[i] && c !== 0xFFFF; c++) {
            let g;
            if (rangeOff[i] === 0) g = (c + delta[i]) & 0xFFFF;
            else {
              const gp = roBase + i * 2 + rangeOff[i] + (c - start[i]) * 2;
              r.at(gp); g = r.u16();
              if (g) g = (g + delta[i]) & 0xFFFF;
            }
            if (g) cmap.set(c, g);
          }
        }
      } else if (fmt === 12) {
        r.u16(); r.u32(); r.u32();
        const n = r.u32();
        for (let i = 0; i < n; i++) { const s = r.u32(), e = r.u32(), gi = r.u32(); for (let c = s; c <= e; c++) cmap.set(c, gi + (c - s)); }
      } else if (fmt === 6) {
        r.u16(); r.u16();
        const first = r.u16(), cnt = r.u16();
        for (let i = 0; i < cnt; i++) cmap.set(first + i, r.u16());
      } else if (fmt === 0) {
        r.u16(); r.u16();
        for (let c = 0; c < 256; c++) cmap.set(c, r.u8());
      }
    }
    if (!cmap.size) throw new Error('Could not read the font\'s character map');

    // ---- glyph outlines (quadratic contours), in font units
    function glyphContours(gi, depth = 0) {
      if (gi < 0 || gi >= numGlyphs || depth > 5) return [];
      const off = tables.glyf.off + loca[gi], end = tables.glyf.off + loca[gi + 1];
      if (loca[gi + 1] <= loca[gi]) return [];         // empty glyph (e.g. space)
      r.at(off);
      const nc = r.i16();
      r.i16(); r.i16(); r.i16(); r.i16();
      if (nc < 0) {
        // composite
        const out = [];
        for (;;) {
          const flags = r.u16(), idx = r.u16();
          let dx, dy;
          if (flags & 1) { dx = r.i16(); dy = r.i16(); } else { dx = r.i8(); dy = r.i8(); }
          let a = 1, b = 0, c = 0, d = 1;
          const F2 = () => r.i16() / 16384;
          if (flags & 8) { a = d = F2(); }
          else if (flags & 0x40) { a = F2(); d = F2(); }
          else if (flags & 0x80) { a = F2(); b = F2(); c = F2(); d = F2(); }
          const save = r.pos;
          for (const cont of glyphContours(idx, depth + 1)) {
            out.push(cont.map(p => ({ x: a * p.x + c * p.y + dx, y: b * p.x + d * p.y + dy, on: p.on })));
          }
          r.at(save);
          if (!(flags & 0x20)) break;
        }
        return out;
      }
      const ends = [];
      for (let i = 0; i < nc; i++) ends.push(r.u16());
      const nPts = ends.length ? ends[ends.length - 1] + 1 : 0;
      const il = r.u16(); r.pos = r.pos + il;
      const flags = [];
      while (flags.length < nPts) {
        const f = r.u8(); flags.push(f);
        if (f & 8) { let rep = r.u8(); while (rep-- > 0) flags.push(f); }
      }
      const xs = [], ys = [];
      let v = 0;
      for (let i = 0; i < nPts; i++) {
        const f = flags[i];
        if (f & 2) { const d = r.u8(); v += (f & 16) ? d : -d; }
        else if (!(f & 16)) v += r.i16();
        xs.push(v);
      }
      v = 0;
      for (let i = 0; i < nPts; i++) {
        const f = flags[i];
        if (f & 4) { const d = r.u8(); v += (f & 32) ? d : -d; }
        else if (!(f & 32)) v += r.i16();
        ys.push(v);
      }
      const out = [];
      let s = 0;
      for (const e of ends) {
        const cont = [];
        for (let i = s; i <= e && i < nPts; i++) cont.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 1) });
        if (cont.length) out.push(cont);
        s = e + 1;
      }
      return out;
    }

    // quadratic contour -> polyline
    function contourToPoly(cont, tol, scale) {
      if (!cont.length) return [];
      // rotate so we start on-curve; if none are, synthesise a start point
      let startIdx = cont.findIndex(p => p.on);
      let pts;
      if (startIdx < 0) {
        const a = cont[0], b = cont[cont.length - 1];
        pts = [{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true }].concat(cont);
      } else {
        pts = cont.slice(startIdx).concat(cont.slice(0, startIdx));
      }
      const out = [{ x: pts[0].x, y: pts[0].y }];
      const quad = (p0, pc, p1) => {
        const chord = Math.hypot(p1.x - p0.x, p1.y - p0.y);
        const bow = Math.hypot(pc.x - (p0.x + p1.x) / 2, pc.y - (p0.y + p1.y) / 2);
        const n = Math.max(2, Math.min(48, Math.ceil(Math.sqrt((bow * scale) / Math.max(tol, 1e-9)) * 3) || 2));
        for (let i = 1; i <= n; i++) {
          const t = i / n, mt = 1 - t;
          out.push({ x: mt * mt * p0.x + 2 * mt * t * pc.x + t * t * p1.x, y: mt * mt * p0.y + 2 * mt * t * pc.y + t * t * p1.y });
        }
      };
      let i = 1;
      const N = pts.length;
      let cur = pts[0];
      while (i <= N) {
        const p = pts[i % N];
        if (p.on) { out.push({ x: p.x, y: p.y }); cur = p; i++; continue; }
        // off-curve control; the next on-curve point may be implied (midpoint)
        const nxt = pts[(i + 1) % N];
        const endPt = nxt.on ? nxt : { x: (p.x + nxt.x) / 2, y: (p.y + nxt.y) / 2 };
        quad(cur, p, endPt);
        cur = endPt;
        i += nxt.on ? 2 : 1;
      }
      return out;
    }

    return {
      unitsPerEm, numGlyphs,
      glyphFor: (ch) => cmap.get(ch.codePointAt(0)) || 0,
      advance: (gi) => adv[gi] || unitsPerEm / 2,
      outline: (gi, tol, scale) => glyphContours(gi).map(c => contourToPoly(c, tol, scale)).filter(p => p.length > 2),
      has: (ch) => cmap.has(ch.codePointAt(0)),
    };
  }

  /* Lay out text using a parsed TrueType font.
     Returns closed contours in inches, baseline at y=0. */
  function outlineText(font, text, opts = {}) {
    const h = opts.height || 1;
    const scale = h / font.unitsPerEm * (opts.capRatio || 1.4);   // em -> inches
    const tol = opts.tol || 0.002;
    const tracking = (opts.tracking || 0) / scale;
    const lineGap = (opts.lineGap != null ? opts.lineGap : h * 1.6);
    const paths = [];
    const missing = new Set();
    let ly = 0;
    for (const line of String(text).split('\n')) {
      let x = 0;
      const lineStart = paths.length;
      for (const ch of line) {
        if (ch === ' ') { const gi = font.glyphFor(' '); x += (gi ? font.advance(gi) : font.unitsPerEm / 3) + tracking; continue; }
        const gi = font.glyphFor(ch);
        if (!gi && !font.has(ch)) missing.add(ch);
        for (const poly of font.outline(gi, tol, scale)) {
          paths.push({ closed: true, pts: poly.map(p => ({ x: (x + p.x) * scale, y: p.y * scale + ly })) });
        }
        x += font.advance(gi) + tracking;
      }
      if (opts.align && opts.align !== 'left') {
        const w = x * scale;
        const dx = opts.align === 'center' ? -w / 2 : -w;
        for (let i = lineStart; i < paths.length; i++) for (const p of paths[i].pts) p.x += dx;
      }
      ly -= lineGap;
    }
    return { paths, missing: Array.from(missing), single: false };
  }

  // polyline -> GEOM loop
  function toLoop(pts, closed) {
    const segs = [];
    const n = pts.length;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-9) segs.push(G.line(P(a.x, a.y), P(b.x, b.y)));
    }
    return segs;
  }

  return { strokeText, outlineText, parse, toLoop, strokeGlyphs, STROKE_CAP, STROKE_EM, hasStrokeGlyph: (c) => !!strokeGlyphs()[c] };
})();
if (typeof module !== 'undefined') module.exports = FONT;
