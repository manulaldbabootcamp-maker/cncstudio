/* ===== svg.js — SVG drawings in, point runs in inches out =====
   An SVG is already outlines, so nothing is traced: paths, rectangles,
   circles, ellipses, lines and polylines are read through their transforms,
   curves flattened to within FLAT inches, and the page turned the right way
   up (SVG's y runs down the page). Arcs are put back afterwards by the same
   fitting the picture tracer uses, so a circle still cuts as a circle.
   Pure: text in, data out. Nothing here touches a part or the canvas. */
const SVG = (() => {
  const FLAT = 0.0005;
  // what an unadorned SVG unit is: CSS says 96 to the inch
  const UNIT = { in: 1, cm: 1 / 2.54, mm: 1 / 25.4, pt: 1 / 72, pc: 1 / 6, px: 1 / 96, '': 1 / 96 };
  function length(v) {
    const m = /^\s*([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)\s*([a-z%]*)\s*$/i.exec(v || '');
    if (!m || m[2] === '%' || !(m[2].toLowerCase() in UNIT)) return null;
    return parseFloat(m[1]) * UNIT[m[2].toLowerCase()];
  }

  // ---- affine matrices [a b c d e f]: x' = a x + c y + e, y' = b x + d y + f
  const I = [1, 0, 0, 1, 0, 0];
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const ap = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
  // the most a unit length can grow under m - how finely to cut a curve drawn small and scaled up
  const stretch = (m) => Math.sqrt(Math.max(m[0] * m[0] + m[1] * m[1], m[2] * m[2] + m[3] * m[3]));
  function transform(t) {
    let m = I;
    const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g; let k;
    while ((k = re.exec(t || ''))) {
      const a = (k[2].match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || []).map(Number);
      let n = I;
      if (k[1] === 'matrix' && a.length === 6) n = a;
      else if (k[1] === 'translate') n = [1, 0, 0, 1, a[0] || 0, a[1] || 0];
      else if (k[1] === 'scale') n = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
      else if (k[1] === 'rotate') {
        const r = (a[0] || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), cx = a[1] || 0, cy = a[2] || 0;
        n = mul(mul([1, 0, 0, 1, cx, cy], [c, s, -s, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
      } else if (k[1] === 'skewX') n = [1, 0, Math.tan((a[0] || 0) * Math.PI / 180), 1, 0, 0];
      else if (k[1] === 'skewY') n = [1, Math.tan((a[0] || 0) * Math.PI / 180), 0, 1, 0, 0];
      m = mul(m, n);
    }
    return m;
  }

  /* ---- path data. A hand-rolled scanner, because arc flags may be written
     with no space after them ("a5 5 0 0110 10") and a number pattern would
     read "0110" as one hundred and ten. */
  function pathRuns(d, m) {
    const runs = []; let run = null;
    let i = 0, cmd = null, cx = 0, cy = 0, sx = 0, sy = 0, lc = null, lq = null;
    const ws = () => { while (i < d.length && /[\s,]/.test(d[i])) i++; };
    const num = () => {
      ws(); const r = /^[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/.exec(d.slice(i, i + 40));
      if (!r) throw new Error('bad number in path at ' + i); i += r[0].length; return parseFloat(r[0]);
    };
    const flag = () => { ws(); const c = d[i++]; if (c !== '0' && c !== '1') throw new Error('bad arc flag'); return c === '1'; };
    const tol = FLAT / Math.max(1e-9, stretch(m));   // flatness in the path's own units
    const put = (x, y) => { const p = ap(m, x, y); const l = run.pts[run.pts.length - 1]; if (!l || Math.hypot(l.x - p.x, l.y - p.y) > 1e-9) run.pts.push(p); };
    const start = (x, y) => { run = { pts: [], closed: false, curved: false }; runs.push(run); put(x, y); };
    const cubic = (x1, y1, x2, y2, x, y) => {
      const P0 = { x: cx, y: cy }, P1 = { x: x1, y: y1 }, P2 = { x: x2, y: y2 }, P3 = { x, y };
      const rec = (a, b, c, e, depth) => {
        // flat enough when both inner control points sit within tol of the chord
        const dx = e.x - a.x, dy = e.y - a.y, L = Math.hypot(dx, dy) || 1e-12;
        const d1 = Math.abs((b.x - e.x) * dy - (b.y - e.y) * dx) / L, d2 = Math.abs((c.x - e.x) * dy - (c.y - e.y) * dx) / L;
        if (depth > 16 || Math.max(d1, d2) <= tol) { put(e.x, e.y); return; }
        const mid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
        const ab = mid(a, b), bc = mid(b, c), ce = mid(c, e), abc = mid(ab, bc), bce = mid(bc, ce), o = mid(abc, bce);
        rec(a, ab, abc, o, depth + 1); rec(o, bce, ce, e, depth + 1);
      };
      rec(P0, P1, P2, P3, 0); run.curved = true;
    };
    const quad = (qx, qy, x, y) => cubic(cx + 2 / 3 * (qx - cx), cy + 2 / 3 * (qy - cy), x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), x, y);
    // endpoint arc to centre form, SVG spec F.6.5
    const arc = (rx, ry, phi, large, sweep, x, y) => {
      if (!rx || !ry) { put(x, y); return; }
      rx = Math.abs(rx); ry = Math.abs(ry);
      const f = phi * Math.PI / 180, co = Math.cos(f), si = Math.sin(f);
      const dx = (cx - x) / 2, dy = (cy - y) / 2, x1 = co * dx + si * dy, y1 = -si * dx + co * dy;
      const lam = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry); if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
      const num2 = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1, den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
      let k = Math.sqrt(Math.max(0, num2 / den)); if (large === sweep) k = -k;
      const cxp = k * rx * y1 / ry, cyp = -k * ry * x1 / rx;
      const ccx = co * cxp - si * cyp + (cx + x) / 2, ccy = si * cxp + co * cyp + (cy + y) / 2;
      const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      const t1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
      let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
      if (!sweep && dt > 0) dt -= 2 * Math.PI; else if (sweep && dt < 0) dt += 2 * Math.PI;
      const r = Math.max(rx, ry), step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / r)));
      const n = Math.max(2, Math.ceil(Math.abs(dt) / Math.max(step, 1e-4)));
      for (let s = 1; s <= n; s++) {
        const t = t1 + dt * s / n, px = rx * Math.cos(t), py = ry * Math.sin(t);
        if (s === n) put(x, y); else put(co * px - si * py + ccx, si * px + co * py + ccy);
      }
      run.curved = true;
    };
    while (true) {
      ws(); if (i >= d.length) break;
      if (/[a-zA-Z]/.test(d[i])) cmd = d[i++];
      else if (!cmd) throw new Error('path data must start with a command');
      const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
      const ox = rel ? cx : 0, oy = rel ? cy : 0;
      if (C === 'Z') {
        if (run) { run.closed = true; cx = sx; cy = sy; }
        lc = lq = null; run = null; continue;
      }
      if (!run && C !== 'M') start(cx, cy);   // drawing on after Z starts from where it closed
      if (C === 'M') { const x = num() + ox, y = num() + oy; start(x, y); cx = sx = x; cy = sy = y; cmd = rel ? 'l' : 'L'; lc = lq = null; }
      else if (C === 'L') { const x = num() + ox, y = num() + oy; put(x, y); cx = x; cy = y; lc = lq = null; }
      else if (C === 'H') { const x = num() + ox; put(x, cy); cx = x; lc = lq = null; }
      else if (C === 'V') { const y = num() + oy; put(cx, y); cy = y; lc = lq = null; }
      else if (C === 'C') { const a = [num() + ox, num() + oy, num() + ox, num() + oy, num() + ox, num() + oy]; cubic(...a); lc = { x: a[2], y: a[3] }; lq = null; cx = a[4]; cy = a[5]; }
      else if (C === 'S') {
        const r1 = lc ? { x: 2 * cx - lc.x, y: 2 * cy - lc.y } : { x: cx, y: cy };
        const a = [num() + ox, num() + oy, num() + ox, num() + oy]; cubic(r1.x, r1.y, ...a); lc = { x: a[0], y: a[1] }; lq = null; cx = a[2]; cy = a[3];
      }
      else if (C === 'Q') { const a = [num() + ox, num() + oy, num() + ox, num() + oy]; quad(...a); lq = { x: a[0], y: a[1] }; lc = null; cx = a[2]; cy = a[3]; }
      else if (C === 'T') {
        const q = lq ? { x: 2 * cx - lq.x, y: 2 * cy - lq.y } : { x: cx, y: cy };
        const x = num() + ox, y = num() + oy; quad(q.x, q.y, x, y); lq = q; lc = null; cx = x; cy = y;
      }
      else if (C === 'A') { const rx = num(), ry = num(), ph = num(), la = flag(), sw = flag(), x = num() + ox, y = num() + oy; arc(rx, ry, ph, la, sw, x, y); cx = x; cy = y; lc = lq = null; }
      else throw new Error('unknown path command ' + cmd);
    }
    return runs;
  }

  // every drawable element as path data, so one reader handles them all
  function asPath(tag, a) {
    const n = (k) => parseFloat(a[k]) || 0;
    if (tag === 'path') return a.d || '';
    if (tag === 'line') return `M${n('x1')} ${n('y1')}L${n('x2')} ${n('y2')}`;
    if (tag === 'polyline' || tag === 'polygon') {
      const v = (a.points || '').match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
      if (v.length < 4) return '';
      let s = `M${v[0]} ${v[1]}`; for (let i = 2; i + 1 < v.length; i += 2) s += `L${v[i]} ${v[i + 1]}`;
      return tag === 'polygon' ? s + 'Z' : s;
    }
    if (tag === 'circle' || tag === 'ellipse') {
      const cx = n('cx'), cy = n('cy'), rx = tag === 'circle' ? n('r') : n('rx'), ry = tag === 'circle' ? n('r') : n('ry');
      if (!(rx > 0) || !(ry > 0)) return '';
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    if (tag === 'rect') {
      const x = n('x'), y = n('y'), w = n('width'), h = n('height'); if (!(w > 0) || !(h > 0)) return '';
      let rx = a.rx != null ? n('rx') : a.ry != null ? n('ry') : 0, ry = a.ry != null ? n('ry') : rx;
      rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
      if (!(rx > 0) || !(ry > 0)) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}`
        + `H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
    }
    return null;
  }
  const SKIP = new Set(['defs', 'clipPath', 'mask', 'symbol', 'pattern', 'marker', 'linearGradient', 'radialGradient', 'style', 'title', 'desc', 'metadata', 'script', 'filter', 'foreignObject']);
  // drawn on the page but not outlines - said in passing, like a DXF's text
  const NOTE = { text: 'text', image: 'embedded picture', use: 'reused symbol (<use>)' };

  function parse(text) {
    const src = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<![^>]*>/g, '').replace(/<\?[\s\S]*?\?>/g, '');
    const tagRe = /<(\/?)([a-zA-Z][\w:.-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
    const attrs = (s) => { const o = {}; const re = /([^\s=\/]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g; let k; while ((k = re.exec(s))) o[k[1].replace(/^\w+:/, (p) => p === 'xlink:' ? p : '')] = k[3] ?? k[4] ?? k[5]; return o; };
    const styleOf = (a) => { const o = {}; for (const kv of (a.style || '').split(';')) { const [k, v] = kv.split(':'); if (k && v) o[k.trim()] = v.trim(); } return o; };
    const loops = [], opens = [], notes = {};
    const stack = [{ m: I, skip: 0 }];
    let root = null, k;
    while ((k = tagRe.exec(src))) {
      const [, close, tagFull, rest, selfClose] = k, tag = tagFull.replace(/^\w+:/, '');
      if (close) { if (stack.length > 1) stack.pop(); continue; }
      const a = attrs(rest), st = styleOf(a), top = stack[stack.length - 1];
      const hidden = top.skip || SKIP.has(tag) || a.display === 'none' || st.display === 'none' || a.visibility === 'hidden' || st.visibility === 'hidden';
      let m = top.m;
      if (tag === 'svg' && !root) {
        /* The page: width/height carry the real size (in, mm...) and viewBox
           the drawing units inside it. A plain number, or none, is 96 to the inch. */
        const vb = (a.viewBox || '').trim().split(/[\s,]+/).map(Number);
        const hasVB = vb.length === 4 && vb.every(isFinite) && vb[2] > 0 && vb[3] > 0;
        let W = length(a.width), H = length(a.height);
        let s = 1 / 96;
        if (hasVB) {
          if (W != null) s = W / vb[2]; else if (H != null) s = H / vb[3];
          if (W == null) W = vb[2] * s; if (H == null) H = vb[3] * s;
        }
        root = { W, H, s };
        const offX = hasVB ? -vb[0] : 0, offY = hasVB ? -vb[1] : 0;
        // into inches, and y flipped so the page's top is up
        const pageH = H != null ? H : null;
        root.pageH = pageH;
        m = mul([s, 0, 0, -s, 0, pageH != null ? pageH : 0], [1, 0, 0, 1, offX, offY]);
      }
      if (a.transform && tag !== 'svg') m = mul(m, transform(a.transform));
      if (!hidden && NOTE[tag]) notes[NOTE[tag]] = (notes[NOTE[tag]] || 0) + 1;
      if (!hidden) {
        const d = asPath(tag, a);
        if (d) {
          let runs; try { runs = pathRuns(d, m); } catch (e) { notes['unreadable path'] = (notes['unreadable path'] || 0) + 1; runs = []; }
          /* A circle under a plain move/scale/turn is still a circle: say so, and
             it is cut as two true arcs rather than refitted from points, which
             can leave a chord across the top a few ten-thousandths flat. */
          const circ = (tag === 'circle' || (tag === 'ellipse' && parseFloat(a.rx) === parseFloat(a.ry))) && Math.abs(Math.hypot(m[0], m[1]) - Math.hypot(m[2], m[3])) < 1e-9 && Math.abs(m[0] * m[2] + m[1] * m[3]) < 1e-9;
          for (const r of runs) {
            const pts = r.pts;
            if (circ && r.closed) { const c = ap(m, parseFloat(a.cx) || 0, parseFloat(a.cy) || 0); r.circle = { x: c.x, y: c.y, r: (parseFloat(a.r ?? a.rx) || 0) * Math.hypot(m[0], m[1]) }; }
            if (r.closed && pts.length > 2 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-7) pts.pop();
            if (pts.length < 2) continue;
            if (r.closed && pts.length >= 3) loops.push(r.circle ? { pts, curved: true, circle: r.circle } : { pts, curved: r.curved }); else opens.push({ pts, curved: r.curved });
          }
        }
      }
      if (!selfClose) stack.push({ m, skip: hidden ? 1 : 0 });
    }
    // with no page height known, the flip used 0; lift everything back above the x axis
    if (root && root.pageH == null) {
      let y0 = Infinity; for (const r of loops.concat(opens)) for (const p of r.pts) y0 = Math.min(y0, p.y);
      if (isFinite(y0)) { for (const r of loops.concat(opens)) for (const p of r.pts) p.y -= y0; for (const r of loops) if (r.circle) r.circle.y -= y0; }
    }
    return { loops, opens, notes, page: root ? { w: root.W, h: root.H } : null };
  }

  return { parse, pathRuns, transform, length };
})();
if (typeof module !== 'undefined') module.exports = SVG;
