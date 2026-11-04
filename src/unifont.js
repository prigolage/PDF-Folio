/* Minimal TrueType reader, glyph subsetter and PDF Type0 embedder, so replacement
 * text can use characters the 14 standard PDF fonts don't have (Hangul, Greek, CJK…). */
(function (root) {
  'use strict';

  function parseTTF(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint16(4);
    const tables = {};
    for (let i = 0; i < n; i++) {
      const o = 12 + i * 16;
      const tag = String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
      tables[tag] = { off: dv.getUint32(o + 8), len: dv.getUint32(o + 12) };
    }
    const T = (t) => tables[t];
    const head = T('head').off, hhea = T('hhea').off, maxp = T('maxp').off;
    const f = {
      bytes, dv, tables,
      upem: dv.getUint16(head + 18),
      bbox: [dv.getInt16(head + 36), dv.getInt16(head + 38), dv.getInt16(head + 40), dv.getInt16(head + 42)],
      locFmt: dv.getInt16(head + 50),
      ascent: dv.getInt16(hhea + 4), descent: dv.getInt16(hhea + 6),
      nHM: dv.getUint16(hhea + 34), numGlyphs: dv.getUint16(maxp + 4),
      capHeight: 0, cmap: new Map(), name: 'NotoSansKR'
    };
    const os2 = T('OS/2');
    if (os2 && dv.getUint16(os2.off) >= 2) f.capHeight = dv.getInt16(os2.off + 88);
    if (!f.capHeight) f.capHeight = Math.round(f.ascent * 0.7);
    // cmap: prefer (3,10) format 12, else (3,1) format 4
    const cm = T('cmap').off, nsub = dv.getUint16(cm + 2);
    let best = null, bestScore = -1;
    for (let i = 0; i < nsub; i++) {
      const pid = dv.getUint16(cm + 4 + i * 8), eid = dv.getUint16(cm + 6 + i * 8), off = dv.getUint32(cm + 8 + i * 8);
      const fmt = dv.getUint16(cm + off);
      const score = (fmt === 12 ? 2 : fmt === 4 ? 1 : 0) + (pid === 3 || pid === 0 ? 1 : 0) * 0 + (eid === 10 ? 1 : 0);
      if ((fmt === 12 || fmt === 4) && score > bestScore) { best = cm + off; bestScore = score; }
    }
    if (best != null) {
      const fmt = dv.getUint16(best);
      if (fmt === 12) {
        const ng = dv.getUint32(best + 12);
        for (let g = 0; g < ng; g++) {
          const o = best + 16 + g * 12, s = dv.getUint32(o), e = dv.getUint32(o + 4), sg = dv.getUint32(o + 8);
          for (let c = s; c <= e; c++) f.cmap.set(c, sg + c - s);
        }
      } else {
        const segX2 = dv.getUint16(best + 6), seg = segX2 / 2;
        const ends = best + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
        for (let s = 0; s < seg; s++) {
          const end = dv.getUint16(ends + s * 2), start = dv.getUint16(starts + s * 2), delta = dv.getInt16(deltas + s * 2), ro = dv.getUint16(ranges + s * 2);
          for (let c = start; c <= end && c !== 0xFFFF; c++) {
            let g;
            if (ro === 0) g = (c + delta) & 0xFFFF;
            else { const gi = ranges + s * 2 + ro + (c - start) * 2; g = dv.getUint16(gi); if (g) g = (g + delta) & 0xFFFF; }
            if (g) f.cmap.set(c, g);
          }
        }
      }
    }
    // PostScript name
    const nm = T('name');
    if (nm) {
      const cnt = dv.getUint16(nm.off + 2), strOff = nm.off + dv.getUint16(nm.off + 4);
      for (let i = 0; i < cnt; i++) {
        const r = nm.off + 6 + i * 12;
        if (dv.getUint16(r + 6) === 6) {
          const pid = dv.getUint16(r), len = dv.getUint16(r + 8), off = dv.getUint16(r + 10);
          let s = '';
          if (pid === 3 || pid === 0) for (let k = 0; k < len; k += 2) s += String.fromCharCode(dv.getUint16(strOff + off + k));
          else for (let k = 0; k < len; k++) s += String.fromCharCode(bytes[strOff + off + k]);
          if (s) { f.name = s.replace(/[^A-Za-z0-9\-]/g, ''); break; }
        }
      }
    }
    f.advance = (g) => dv.getUint16(T('hmtx').off + 4 * Math.min(g, f.nHM - 1));
    f.width1000 = (g) => Math.round(f.advance(g) * 1000 / f.upem);
    f.glyphRange = (g) => {
      const lo = T('loca').off;
      if (f.locFmt === 0) return [dv.getUint16(lo + g * 2) * 2, dv.getUint16(lo + g * 2 + 2) * 2];
      return [dv.getUint32(lo + g * 4), dv.getUint32(lo + g * 4 + 4)];
    };
    return f;
  }

  function components(f, g) {
    const [a, b] = f.glyphRange(g);
    if (b <= a) return [];
    const base = f.tables.glyf.off + a, dv = f.dv;
    if (dv.getInt16(base) >= 0) return [];
    const out = [];
    let p = base + 10, flags;
    do {
      flags = dv.getUint16(p); out.push(dv.getUint16(p + 2)); p += 4;
      p += (flags & 1) ? 4 : 2;
      if (flags & 8) p += 2; else if (flags & 0x40) p += 4; else if (flags & 0x80) p += 8;
    } while (flags & 0x20);
    return out;
  }

  function checksum(u8, off, len) {
    let s = 0;
    const n = (len + 3) & ~3;
    for (let i = 0; i < n; i += 4) s = (s + (((u8[off + i] || 0) << 24) | ((u8[off + i + 1] || 0) << 16) | ((u8[off + i + 2] || 0) << 8) | (u8[off + i + 3] || 0))) >>> 0;
    return s;
  }

  /* keep only the glyphs in `gids` (glyph ids stay the same) */
  function subsetTTF(f, gids) {
    const keep = new Set([0]);
    const stack = Array.from(gids);
    while (stack.length) { const g = stack.pop(); if (keep.has(g) || g >= f.numGlyphs) continue; keep.add(g); components(f, g).forEach(c => stack.push(c)); }
    const N = f.numGlyphs, src = f.bytes;
    // glyf + loca
    let size = 0; const ranges = [];
    for (let g = 0; g < N; g++) { if (keep.has(g)) { const [a, b] = f.glyphRange(g); ranges[g] = [a, b]; size += ((b - a) + 3) & ~3; } }
    const glyf = new Uint8Array(size || 4), loca = new Uint8Array((N + 1) * 4);
    const ldv = new DataView(loca.buffer);
    let pos = 0;
    for (let g = 0; g < N; g++) {
      ldv.setUint32(g * 4, pos);
      if (ranges[g]) { const [a, b] = ranges[g]; glyf.set(src.subarray(f.tables.glyf.off + a, f.tables.glyf.off + b), pos); pos += ((b - a) + 3) & ~3; }
    }
    ldv.setUint32(N * 4, pos);
    // hmtx with one entry per glyph (unused ones zeroed)
    const hmtx = new Uint8Array(N * 4), hdv = new DataView(hmtx.buffer);
    keep.forEach(g => hdv.setUint16(g * 4, f.advance(g)));
    const copy = (t) => src.slice(f.tables[t].off, f.tables[t].off + f.tables[t].len);
    const head = copy('head'); const headDv = new DataView(head.buffer);
    headDv.setUint32(8, 0); headDv.setInt16(50, 1);
    const hhea = copy('hhea'); new DataView(hhea.buffer).setUint16(34, N);
    const maxp = copy('maxp');
    const post = new Uint8Array(32); new DataView(post.buffer).setUint32(0, 0x00030000);
    const tbl = { glyf, head, hhea, hmtx, loca, maxp, post };
    if (f.tables['OS/2']) tbl['OS/2'] = copy('OS/2');
    const tags = Object.keys(tbl).sort();
    let total = 12 + 16 * tags.length;
    tags.forEach(t => { total += (tbl[t].length + 3) & ~3; });
    const out = new Uint8Array(total), odv = new DataView(out.buffer);
    const nt = tags.length; let es = 0; while ((1 << (es + 1)) <= nt) es++;
    odv.setUint32(0, 0x00010000); odv.setUint16(4, nt); odv.setUint16(6, (1 << es) * 16); odv.setUint16(8, es); odv.setUint16(10, nt * 16 - (1 << es) * 16);
    let off = 12 + 16 * nt, headOff = 0;
    tags.forEach((t, i) => {
      const data = tbl[t]; out.set(data, off);
      const r = 12 + i * 16;
      for (let k = 0; k < 4; k++) out[r + k] = t.charCodeAt(k);
      odv.setUint32(r + 4, checksum(out, off, data.length)); odv.setUint32(r + 8, off); odv.setUint32(r + 12, data.length);
      if (t === 'head') headOff = off;
      off += (data.length + 3) & ~3;
    });
    odv.setUint32(headOff + 8, (0xB1B0AFBA - checksum(out, 0, out.length)) >>> 0);
    return out;
  }

  const hex4 = (n) => n.toString(16).padStart(4, '0');
  function utf16hex(str) { let h = ''; for (let i = 0; i < str.length; i++) h += hex4(str.charCodeAt(i)); return h; }

  /* Collects glyphs used in one output document, then embeds one subset font. */
  class FontUse {
    constructor(f, label, doc) { this.f = f; this.label = label; this.used = new Map(); this.ref = doc ? doc.context.nextRef() : null; }
    glyphFor(ch) { const g = this.f.cmap.get(ch.codePointAt(0)); return g || 0; }
    has(ch) { return this.f.cmap.has(ch.codePointAt(0)); }
    widthOf(text, size) { let w = 0; for (const ch of text) w += this.f.advance(this.glyphFor(ch)); return w * size / this.f.upem; }
    encode(text) { let h = ''; for (const ch of text) { const g = this.glyphFor(ch); if (g) this.used.set(g, ch); h += hex4(g); } return '<' + h + '>'; }
    embed(L, doc) {
      const ctx = doc.context, f = this.f;
      const tag = Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
      const baseName = tag + '+' + f.name;
      const ttf = subsetTTF(f, this.used.keys());
      const fileRef = ctx.register(ctx.flateStream(ttf, { Length1: ttf.length }));
      const sc = (v) => Math.round(v * 1000 / f.upem);
      const desc = ctx.register(ctx.obj({
        Type: 'FontDescriptor', FontName: baseName, Flags: 4, FontBBox: f.bbox.map(sc), ItalicAngle: 0,
        Ascent: sc(f.ascent), Descent: sc(f.descent), CapHeight: sc(f.capHeight), StemV: 80, FontFile2: fileRef
      }));
      const gids = Array.from(this.used.keys()).sort((a, b) => a - b);
      const W = [];
      gids.forEach(g => { W.push(g, [f.width1000(g)]); });
      const cid = ctx.register(ctx.obj({
        Type: 'Font', Subtype: 'CIDFontType2', BaseFont: baseName,
        CIDSystemInfo: { Registry: L.PDFString.of('Adobe'), Ordering: L.PDFString.of('Identity'), Supplement: 0 },
        FontDescriptor: desc, DW: 1000, W, CIDToGIDMap: 'Identity'
      }));
      let cm = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
      for (let i = 0; i < gids.length; i += 100) {
        const chunk = gids.slice(i, i + 100);
        cm += chunk.length + ' beginbfchar\n' + chunk.map(g => '<' + hex4(g) + '> <' + utf16hex(this.used.get(g)) + '>').join('\n') + '\nendbfchar\n';
      }
      cm += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
      const tu = ctx.register(ctx.flateStream(cm));
      const t0 = ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: baseName, Encoding: 'Identity-H', DescendantFonts: [cid], ToUnicode: tu });
      if (this.ref) ctx.assign(this.ref, t0); else this.ref = ctx.register(t0);
      return this.ref;
    }
  }

  const api = { parseTTF, subsetTTF, FontUse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PDFUniFont = api;
})(typeof self !== 'undefined' ? self : this);
