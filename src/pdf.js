/* ===== pdf.js — vector PDF output for shop drawings =====

   Written by hand rather than pulled from a library: the whole app is
   dependency-free and offline, and a drawing only needs lines, Bezier curves
   and Helvetica text. Being vector (not a screenshot) means it prints to a
   true scale and stays sharp at any size, which matters when someone measures
   off the print at the machine.

   PDF user space is 72 units per inch with the origin at the bottom-left and
   Y increasing upwards — the same orientation as the app's world coordinates,
   so no flipping is needed. */
const PDFDOC = (() => {
  const PT = 72;                       // points per inch
  const PAGES = {
    letter: [8.5, 11], legal: [8.5, 14], tabloid: [11, 17],
    a4: [8.2677, 11.6929], a3: [11.6929, 16.5354],
  };

  function esc(str) {
    return String(str).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }
  // PDF text is Latin-1 here; drop anything that cannot be encoded rather than
  // emitting bytes that would render as garbage
  function latin1(str) {
    return String(str).split('').map(c => c.charCodeAt(0) < 256 ? c : '?').join('');
  }
  const n = (v) => (Math.round(v * 1000) / 1000).toString();

  function doc(opts = {}) {
    const size = PAGES[opts.page || 'letter'] || PAGES.letter;
    const land = !!opts.landscape;
    const W = (land ? size[1] : size[0]) * PT;
    const H = (land ? size[0] : size[1]) * PT;
    const ops = [];
    let scale = 1, ox = 0, oy = 0;      // world inches -> page points

    const api = {
      W, H,
      /* Map a world box onto the page with a margin. Returns the scale used, so
         the caller can report "1:2" or refuse to shrink below a usable size. */
      fit(box, marginIn = 0.6, force1to1) {
        const m = marginIn * PT;
        const aw = W - m * 2, ah = H - m * 2;
        const bw = Math.max(box.w, 1e-6), bh = Math.max(box.h, 1e-6);
        scale = force1to1 ? PT : Math.min(aw / bw, ah / bh);
        ox = m + (aw - bw * scale) / 2 - box.x0 * scale;
        oy = m + (ah - bh * scale) / 2 - box.y0 * scale;
        return scale / PT;              // 1 = full size
      },
      setScale(s, box, marginIn = 0.6) {
        const m = marginIn * PT;
        scale = s * PT;
        ox = m - box.x0 * scale; oy = m - box.y0 * scale;
        return s;
      },
      X: (x) => ox + x * scale,
      Y: (y) => oy + y * scale,
      gray(v) { ops.push(`${n(v)} G`); return api; },
      rgb(r, g, b) { ops.push(`${n(r)} ${n(g)} ${n(b)} RG`); return api; },
      fillRgb(r, g, b) { ops.push(`${n(r)} ${n(g)} ${n(b)} rg`); return api; },
      width(w) { ops.push(`${n(w)} w`); return api; },
      dash(on, off) { ops.push(on ? `[${n(on)} ${n(off)}] 0 d` : '[] 0 d'); return api; },
      moveTo(x, y) { ops.push(`${n(api.X(x))} ${n(api.Y(y))} m`); return api; },
      lineTo(x, y) { ops.push(`${n(api.X(x))} ${n(api.Y(y))} l`); return api; },
      curveTo(c1, c2, p) {
        ops.push(`${n(api.X(c1.x))} ${n(api.Y(c1.y))} ${n(api.X(c2.x))} ${n(api.Y(c2.y))} ${n(api.X(p.x))} ${n(api.Y(p.y))} c`);
        return api;
      },
      stroke() { ops.push('S'); return api; },
      fill() { ops.push('f'); return api; },
      rect(x, y, w, h) { ops.push(`${n(api.X(x))} ${n(api.Y(y))} ${n(w * scale)} ${n(-h * scale)} re`); return api; },
      /* Text is placed in PAGE points, not world inches: a label must stay the
         same size whatever the drawing scale. */
      textPt(xPt, yPt, str, sizePt = 9, align = 'left') {
        const t = latin1(str);
        const w = t.length * sizePt * 0.5;    // Helvetica average; good enough to centre
        const x = align === 'center' ? xPt - w / 2 : align === 'right' ? xPt - w : xPt;
        ops.push(`BT /F1 ${n(sizePt)} Tf ${n(x)} ${n(yPt)} Td (${esc(t)}) Tj ET`);
        return api;
      },
      text(x, y, str, sizePt = 9, align = 'left', dxPt = 0, dyPt = 0) {
        return api.textPt(api.X(x) + dxPt, api.Y(y) + dyPt, str, sizePt, align);
      },
      build(title) {
        const content = ops.join('\n');
        const objs = [];
        objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
        objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
        objs[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(W)} ${n(H)}] `
          + `/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`;
        objs[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
        objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
        objs[6] = `<< /Title (${esc(latin1(title || 'CNC Studio drawing'))}) /Producer (CNC Studio) >>`;

        let out = '%PDF-1.4\n';
        const offsets = [];
        for (let i = 1; i < objs.length; i++) {
          offsets[i] = out.length;
          out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
        }
        const xref = out.length;
        out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
        for (let i = 1; i < objs.length; i++) {
          out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
        }
        out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
        return out;
      },
    };
    return api;
  }

  /* Draw a segment loop. Arcs become cubic Beziers, split so no piece spans
     more than 90 degrees - beyond that a single Bezier visibly deviates. */
  function tracePath(d, loop, G, closed) {
    if (!loop.length) return;
    d.moveTo(loop[0].a.x, loop[0].a.y);
    for (const s of loop) {
      if (s.type === 'line') { d.lineTo(s.b.x, s.b.y); continue; }
      const sweep = G.sweep(s), r = G.radius(s), c = s.c;
      const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
      let a0 = Math.atan2(s.a.y - c.y, s.a.x - c.x);
      const step = sweep / steps;
      for (let i = 0; i < steps; i++) {
        const a1 = a0 + step;
        const k = (4 / 3) * Math.tan(step / 4);
        const p0 = { x: c.x + r * Math.cos(a0), y: c.y + r * Math.sin(a0) };
        const p1 = { x: c.x + r * Math.cos(a1), y: c.y + r * Math.sin(a1) };
        d.curveTo(
          { x: p0.x - k * r * Math.sin(a0), y: p0.y + k * r * Math.cos(a0) },
          { x: p1.x + k * r * Math.sin(a1), y: p1.y - k * r * Math.cos(a1) },
          p1);
        a0 = a1;
      }
    }
  }

  return { doc, tracePath, PAGES, PT };
})();
if (typeof module !== 'undefined') module.exports = PDFDOC;
