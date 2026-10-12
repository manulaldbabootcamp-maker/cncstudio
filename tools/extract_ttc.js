/* Split a TrueType Collection (.ttc) into standalone .ttf files.

   A collection packs several fonts into one file, sharing the tables they have
   in common. The app's parser reads a single font's table directory, so it only
   ever sees the FIRST font in the collection - which is why loading
   C:\Windows\Fonts\Nirmala.ttc gives one weight and no way to reach the other
   five. Writing each one out as its own file makes them all selectable, and each
   file is small because only the tables that font actually references are
   copied.

   This is how cncstudio/fonts/Nirmala-*.ttf were made:

     node tools/extract_ttc.js "C:\Windows\Fonts\Nirmala.ttc" fonts

   Each file is parsed with the app's own font.js before it is left on disk, so
   a file that would fail in the Text box fails here instead. */
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2];
const OUT = process.argv[3] || 'fonts';
if (!SRC) {
  console.error('usage: node tools/extract_ttc.js <font.ttc> [output dir]');
  process.exit(2);
}
const FONT = require(path.join(__dirname, '..', 'src', 'font.js'));

const buf = fs.readFileSync(SRC);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);

if (buf.slice(0, 4).toString('latin1') !== 'ttcf') {
  console.error('not a collection: ' + SRC + ' (a plain .ttf needs no extracting - load it as it is)');
  process.exit(1);
}

const numFonts = dv.getUint32(8);
console.log(`${path.basename(SRC)}: ${numFonts} fonts inside`);

// the name table, so each file is called what the font is called
function nameOf(fontOff) {
  const numTables = dv.getUint16(fontOff + 4);
  let nameRec = null;
  for (let t = 0; t < numTables; t++) {
    const rec = fontOff + 12 + t * 16;
    if (buf.slice(rec, rec + 4).toString('latin1') === 'name') {
      nameRec = { off: dv.getUint32(rec + 8), len: dv.getUint32(rec + 12) };
      break;
    }
  }
  if (!nameRec) return null;
  const base = nameRec.off;
  const count = dv.getUint16(base + 2);
  const strOff = base + dv.getUint16(base + 4);
  const want = {};
  for (let i = 0; i < count; i++) {
    const r = base + 6 + i * 12;
    const platform = dv.getUint16(r);
    const nameId = dv.getUint16(r + 6);
    const len = dv.getUint16(r + 8);
    const off = dv.getUint16(r + 10);
    if (nameId !== 1 && nameId !== 2 && nameId !== 4) continue;
    let str = '';
    if (platform === 3) {                      // Windows, UTF-16BE
      for (let k = 0; k < len; k += 2) str += String.fromCharCode(dv.getUint16(strOff + off + k));
    } else {
      str = buf.slice(strOff + off, strOff + off + len).toString('latin1');
    }
    if (!want[nameId]) want[nameId] = str;
  }
  return want[4] || [want[1], want[2]].filter(Boolean).join(' ') || null;
}

// rebuild one font as a standalone file
function extract(fontOff) {
  const n = dv.getUint16(fontOff + 4);
  const recs = [];
  for (let t = 0; t < n; t++) {
    const r = fontOff + 12 + t * 16;
    recs.push({
      tag: buf.slice(r, r + 4).toString('latin1'),
      checksum: dv.getUint32(r + 4),
      off: dv.getUint32(r + 8),
      len: dv.getUint32(r + 12),
    });
  }
  const headerLen = 12 + n * 16;
  let total = headerLen;
  for (const r of recs) total += (r.len + 3) & ~3;
  const out = Buffer.alloc(total);
  buf.copy(out, 0, fontOff, fontOff + headerLen);      // sfnt header + records
  let pos = headerLen;
  recs.forEach((r, i) => {
    buf.copy(out, pos, r.off, r.off + r.len);
    out.writeUInt32BE(pos, 12 + i * 16 + 8);           // point the record at its new home
    pos += (r.len + 3) & ~3;
  });
  return out;
}

fs.mkdirSync(OUT, { recursive: true });
let made = 0;
for (let i = 0; i < numFonts; i++) {
  const off = dv.getUint32(12 + i * 4);
  const label = nameOf(off) || `font ${i}`;
  const file = label.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.ttf';
  const data = extract(off);
  fs.writeFileSync(path.join(OUT, file), data);

  // prove each one loads in the app's own parser before leaving it there
  let note;
  try {
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.length);
    const f = FONT.parse(ab);
    const devan = ['क', 'ख', 'ह'].filter(c => f.glyphFor(c)).length;
    const latin = ['A', 'a', '0'].filter(c => f.glyphFor(c)).length;
    note = `${f.numGlyphs} glyphs, ${f.unitsPerEm}/em, latin ${latin}/3, devanagari ${devan}/3`;
    made++;
  } catch (e) {
    note = 'FAILED TO PARSE: ' + e.message;
  }
  console.log(`  ${file.padEnd(34)} ${String((data.length / 1024).toFixed(0)).padStart(5)} KB   ${note}`);
}
console.log('');
console.log(`${made} of ${numFonts} font(s) written to ${OUT} and readable by the Text box`);
