/* ===== icons.js — CAD toolbar glyphs =====
   24x24 stroked outlines on a shared grid, following the conventions CAD
   operators already read: an arrow for select, the primitive itself for the
   draw tools, dashed construction lines for the modify tools, and a witness
   line + arrows for measure/dimension. Stroke inherits currentColor so the
   active/hover states in CSS keep working. */
const ICONS = (() => {
  // each entry is the inner markup of a 0 0 24 24 viewBox
  const P = {
    // --- file
    'new': '<path d="M6 2h8l5 5v15H6z"/><path d="M14 2v5h5"/>',
    'open': '<path d="M3 6h6l2 3h10v11H3z"/>',
    'save': '<path d="M3 3h14l4 4v14H3z"/><path d="M7 3v7h9V3"/><rect x="7" y="14" width="10" height="7"/>',
    'undo': '<path d="M4 13a8 8 0 1 1 3 6"/><path d="M4 8v5h5"/>',
    'redo': '<path d="M20 13a8 8 0 1 0-3 6"/><path d="M20 8v5h-5"/>',
    'duplicate': '<rect x="3" y="3" width="13" height="13"/><path d="M8 21h13V8"/>',
    'delete': '<path d="M4 6h16"/><path d="M9 6V3h6v3"/><path d="M6 6l1 15h10l1-15"/><path d="M10 10v8M14 10v8"/>',

    // --- draw
    'select': '<path d="M5 3l14 8-6 1.6L10 20z"/>',
    'rect': '<rect x="3" y="6" width="18" height="12"/>',
    'circle': '<circle cx="12" cy="12" r="8"/>',
    'poly': '<path d="M12 3l8 6-3 10H7L4 9z"/>',
    'pline': '<path d="M3 18l5-9 5 5 8-11"/><circle cx="3" cy="18" r="1.6"/><circle cx="21" cy="3" r="1.6"/>',
    'arc': '<path d="M3 19a13 13 0 0 1 18-6"/><circle cx="3" cy="19" r="1.8"/><circle cx="21" cy="13" r="1.8"/><circle cx="9.5" cy="14.2" r="1.8"/>',
    'ellipse': '<ellipse cx="12" cy="12" rx="9" ry="6"/>',
    'spline': '<path d="M3 17c4 0 4-10 8-10s5 10 10 10"/><circle cx="3" cy="17" r="1.5"/><circle cx="21" cy="17" r="1.5"/>',
    'text': '<path d="M4 6V4h16v2"/><path d="M12 4v16"/><path d="M8 20h8"/>',

    // --- modify
    'move': '<path d="M12 2v20M2 12h20"/><path d="M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l3 3"/>',
    'scale': '<rect x="3" y="10" width="11" height="11"/><path d="M9 3h12v12" stroke-dasharray="3 2"/><path d="M14 10L21 3"/>',
    'rotate': '<path d="M20 12a8 8 0 1 1-3-6"/><path d="M20 3v5h-5"/>',
    'mirror': '<path d="M12 2v20" stroke-dasharray="3 2"/><path d="M9 6L3 12l6 6z"/><path d="M15 6l6 6-6 6z"/>',
    'array': '<rect x="2" y="3" width="6" height="6"/><rect x="10" y="3" width="6" height="6"/><rect x="18" y="3" width="4" height="6"/><rect x="2" y="12" width="6" height="6"/><rect x="10" y="12" width="6" height="6"/><rect x="18" y="12" width="4" height="6"/>',
    'offset': '<rect x="6" y="6" width="12" height="12"/><rect x="2" y="2" width="20" height="20" stroke-dasharray="3 2"/>',
    'chamfer': '<path d="M3 21V8l5-5h13"/><path d="M3 8h5V3" stroke-dasharray="2 2"/>',
    'fillet': '<path d="M3 21V13A10 10 0 0 1 13 3h8"/><path d="M3 13h10V3" stroke-dasharray="2 2"/>',
    'trim': '<path d="M4 20L20 4" stroke-dasharray="3 2"/><circle cx="7" cy="6" r="2.5"/><circle cx="7" cy="18" r="2.5"/><path d="M9 7.5L20 19M9 16.5L20 5"/>',
    'join': '<path d="M3 12h7M14 12h7"/><circle cx="12" cy="12" r="2.5"/>',
    'union': '<path d="M9 3h12v12H15V9H9z"/><path d="M3 9h12v12H3z"/>',
    'subtract': '<path d="M3 9h12v12H3z"/><path d="M9 3h12v12" stroke-dasharray="3 2"/>',
    'group': '<rect x="3" y="3" width="8" height="8"/><rect x="13" y="13" width="8" height="8"/><path d="M2 2h20v20H2z" stroke-dasharray="2 3"/>',

    // --- measure / annotate
    'measure': '<path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M11 9l2 2M15 5l2 2"/>',
    'dimension': '<path d="M3 6v12M21 6v12"/><path d="M3 12h18"/><path d="M6 9l-3 3 3 3M18 9l3 3-3 3"/>',

    // --- cam
    'nest': '<rect x="2" y="2" width="20" height="20" stroke-dasharray="3 2"/><rect x="4" y="4" width="8" height="6"/><rect x="13" y="4" width="7" height="6"/><rect x="4" y="12" width="6" height="8"/>',
    'dxf': '<path d="M6 2h8l5 5v15H6z"/><path d="M14 2v5h5"/><path d="M9 12l6 6M15 12l-6 6"/>',
    'tap': '<path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M4 19h16"/>',
    'sim': '<path d="M6 4l14 8-14 8z"/>',
    'log': '<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/>',
    'settings': '<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.2 2.2M16.9 16.9l2.2 2.2M19.1 4.9l-2.2 2.2M7.1 16.9l-2.2 2.2"/>',
    'snap': '<path d="M12 3v18M3 12h18" stroke-dasharray="2 3"/><rect x="8" y="8" width="8" height="8"/>',
    'ortho': '<path d="M4 20V4h16" /><path d="M4 20l16-16" stroke-dasharray="3 2"/>',
  };

  function svg(name, size = 16) {
    const inner = P[name];
    if (!inner) return '';
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" `
      + `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  }

  // fill every [data-icon] under root; keeps any existing text as a label
  function apply(root = document) {
    root.querySelectorAll('[data-icon]').forEach(el => {
      const n = el.dataset.icon;
      if (!P[n]) { console.warn('icons: no glyph named ' + n); return; }
      if (el.querySelector('svg')) return;                 // already applied
      el.insertAdjacentHTML('afterbegin', svg(n, +el.dataset.iconSize || 16));
    });
  }

  return { svg, apply, names: () => Object.keys(P) };
})();
if (typeof module !== 'undefined') module.exports = ICONS;
