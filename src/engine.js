/* PDF edit engine: parses page content streams, locates every glyph and image
 * placement, and rewrites the stream so edited text is genuinely removed
 * (not covered) while all untouched content keeps its exact position.
 * Depends on the pdf-lib global (PDFLib) or a passed-in module. */
(function (root) {
  'use strict';

  /* ---------- byte helpers ---------- */
  function bytesToLatin1(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return s;
  }
  function latin1ToBytes(s) {
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255;
    return u;
  }
  function hexOf(bin) {
    let h = '';
    for (let i = 0; i < bin.length; i++) h += bin.charCodeAt(i).toString(16).padStart(2, '0');
    return '<' + h + '>';
  }
  function num(n) {
    if (!isFinite(n)) n = 0;
    let s = (Math.round(n * 10000) / 10000).toString();
    if (s.indexOf('e') >= 0) s = n.toFixed(6);
    return s === '-0' ? '0' : s;
  }

  /* ---------- matrices (PDF row-vector convention) ---------- */
  const I = [1, 0, 0, 1, 0, 0];
  function mul(m1, m2) {
    return [
      m1[0] * m2[0] + m1[1] * m2[2], m1[0] * m2[1] + m1[1] * m2[3],
      m1[2] * m2[0] + m1[3] * m2[2], m1[2] * m2[1] + m1[3] * m2[3],
      m1[4] * m2[0] + m1[5] * m2[2] + m2[4], m1[4] * m2[1] + m1[5] * m2[3] + m2[5]
    ];
  }
  function inv(m) {
    const det = m[0] * m[3] - m[1] * m[2];
    if (Math.abs(det) < 1e-12) return null;
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
      (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
  }
  function apply(m, x, y) { return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]; }
  function bboxOf(m) {
    const pts = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)];
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return { x: Math.min.apply(0, xs), y: Math.min.apply(0, ys), w: Math.max.apply(0, xs) - Math.min.apply(0, xs), h: Math.max.apply(0, ys) - Math.min.apply(0, ys) };
  }

  /* ---------- tokenizer ---------- */
  const WS = { 0: 1, 9: 1, 10: 1, 12: 1, 13: 1, 32: 1 };
  const DELIM = { 40: 1, 41: 1, 60: 1, 62: 1, 91: 1, 93: 1, 123: 1, 125: 1, 47: 1, 37: 1 };

  function tokenize(src) {
    const toks = [];
    const n = src.length;
    let i = 0;
    while (i < n) {
      const c = src.charCodeAt(i);
      if (WS[c]) { i++; continue; }
      if (c === 37) { while (i < n && src[i] !== '\n' && src[i] !== '\r') i++; continue; } // %
      const start = i;
      if (c === 40) { // literal string
        let depth = 1, out = ''; i++;
        while (i < n && depth > 0) {
          const ch = src[i];
          if (ch === '\\') {
            const nx = src[i + 1];
            const esc = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
            if (nx in esc) { out += esc[nx]; i += 2; }
            else if (nx >= '0' && nx <= '7') {
              let o = ''; let k = i + 1;
              while (k < n && o.length < 3 && src[k] >= '0' && src[k] <= '7') o += src[k++];
              out += String.fromCharCode(parseInt(o, 8) & 255); i = k;
            } else if (nx === '\r') { i += (src[i + 2] === '\n') ? 3 : 2; }
            else if (nx === '\n') { i += 2; }
            else { i += 1; }
          } else if (ch === '(') { depth++; out += ch; i++; }
          else if (ch === ')') { depth--; if (depth) out += ch; i++; }
          else { out += ch; i++; }
        }
        toks.push({ t: 'str', v: out, s: start, e: i });
        continue;
      }
      if (c === 60) { // < or <<
        if (src[i + 1] === '<') { toks.push({ t: '<<', s: i, e: i + 2 }); i += 2; continue; }
        let j = i + 1, h = '';
        while (j < n && src[j] !== '>') { if (!WS[src.charCodeAt(j)]) h += src[j]; j++; }
        if (h.length % 2) h += '0';
        let out = '';
        for (let k = 0; k < h.length; k += 2) out += String.fromCharCode(parseInt(h.substr(k, 2), 16) || 0);
        toks.push({ t: 'str', v: out, s: start, e: j + 1, hex: true });
        i = j + 1; continue;
      }
      if (c === 62) { if (src[i + 1] === '>') { toks.push({ t: '>>', s: i, e: i + 2 }); i += 2; } else i++; continue; }
      if (c === 91) { toks.push({ t: '[', s: i, e: i + 1 }); i++; continue; }
      if (c === 93) { toks.push({ t: ']', s: i, e: i + 1 }); i++; continue; }
      if (c === 123 || c === 125) { i++; continue; }
      if (c === 47) { // name
        let j = i + 1;
        while (j < n && !WS[src.charCodeAt(j)] && !DELIM[src.charCodeAt(j)]) j++;
        const raw = src.slice(i + 1, j).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
        toks.push({ t: 'name', v: raw, s: start, e: j }); i = j; continue;
      }
      // number or keyword
      let j = i;
      while (j < n && !WS[src.charCodeAt(j)] && !DELIM[src.charCodeAt(j)]) j++;
      if (j === i) { i++; continue; }
      const word = src.slice(i, j);
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { toks.push({ t: 'num', v: parseFloat(word), s: start, e: j }); i = j; continue; }
      if (word === 'true' || word === 'false') { toks.push({ t: 'bool', v: word === 'true', s: start, e: j }); i = j; continue; }
      if (word === 'null') { toks.push({ t: 'null', v: null, s: start, e: j }); i = j; continue; }
      toks.push({ t: 'op', v: word, s: start, e: j });
      i = j;
      if (word === 'ID') { // inline image data
        i++; // single whitespace after ID
        const re = /[\0\t\n\f\r ]EI(?=[\0\t\n\f\r \/\[<(%]|$)/g;
        re.lastIndex = i;
        const m = re.exec(src);
        const end = m ? m.index : n;
        toks.push({ t: 'inline', s: i, e: end });
        if (m) { toks.push({ t: 'op', v: 'EI', s: m.index + 1, e: m.index + 3 }); i = m.index + 3; }
        else i = n;
      }
    }
    return toks;
  }

  /* ---------- parse tokens into operations ---------- */
  function parseOps(src) {
    const toks = tokenize(src);
    const ops = [];
    let stack = []; // each entry {v, s}
    let arrStack = [];
    let dictDepth = 0;
    let inlineStart = -1;
    for (const tk of toks) {
      if (inlineStart >= 0) {
        if (tk.t === 'op' && tk.v === 'EI') { ops.push({ op: 'INLINE', args: [], s: inlineStart, e: tk.e }); inlineStart = -1; stack = []; }
        continue;
      }
      if (tk.t === '[') { arrStack.push({ items: [], s: tk.s }); continue; }
      if (tk.t === ']') {
        const a = arrStack.pop();
        if (!a) continue;
        const val = { v: a.items, s: a.s, arr: true };
        if (arrStack.length) arrStack[arrStack.length - 1].items.push(val); else stack.push(val);
        continue;
      }
      if (tk.t === '<<') { dictDepth++; if (!arrStack.length && dictDepth === 1) stack.push({ v: null, s: tk.s, dict: true }); continue; }
      if (tk.t === '>>') { dictDepth = Math.max(0, dictDepth - 1); continue; }
      if (dictDepth > 0) continue; // dict contents (e.g. BDC properties) kept verbatim
      if (tk.t === 'op') {
        if (tk.v === 'BI') { inlineStart = tk.s; stack = []; continue; }
        const s = stack.length ? stack[0].s : tk.s;
        ops.push({ op: tk.v, args: stack, s, e: tk.e });
        stack = []; arrStack = [];
        continue;
      }
      const val = { v: tk.v, s: tk.s, t: tk.t, hex: tk.hex };
      if (arrStack.length) arrStack[arrStack.length - 1].items.push(val); else stack.push(val);
    }
    return ops;
  }

  /* ---------- glyph -> unicode ---------- */
  function utf16be(bin) {
    let s = '';
    for (let i = 0; i + 1 < bin.length; i += 2) s += String.fromCharCode((bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1));
    if (bin.length % 2) s += String.fromCharCode(bin.charCodeAt(bin.length - 1));
    return s;
  }
  function hexBin(h) { let o = ''; for (let i = 0; i < h.length; i += 2) o += String.fromCharCode(parseInt(h.substr(i, 2), 16)); return o; }
  function parseToUnicode(str) {
    const map = new Map();
    let bytes = 0;
    const blocks = str.split(/beginbf(char|range)/);
    for (let b = 1; b < blocks.length; b += 2) {
      const kind = blocks[b];
      const body = blocks[b + 1].split(/endbf(char|range)/)[0];
      if (kind === 'char') {
        const re = /<([0-9a-fA-F\s]*)>\s*<([0-9a-fA-F\s]*)>/g; let m;
        while ((m = re.exec(body))) {
          const src = m[1].replace(/\s/g, ''), dst = m[2].replace(/\s/g, '');
          bytes = Math.max(bytes, src.length / 2);
          map.set(parseInt(src, 16), utf16be(hexBin(dst)));
        }
      } else {
        const re = /<([0-9a-fA-F\s]*)>\s*<([0-9a-fA-F\s]*)>\s*(<[0-9a-fA-F\s]*>|\[[^\]]*\])/g; let m;
        while ((m = re.exec(body))) {
          const lo = parseInt(m[1].replace(/\s/g, ''), 16), hi = parseInt(m[2].replace(/\s/g, ''), 16);
          bytes = Math.max(bytes, m[1].replace(/\s/g, '').length / 2);
          if (hi - lo > 70000) continue;
          if (m[3][0] === '[') {
            const items = m[3].match(/<([0-9a-fA-F\s]*)>/g) || [];
            items.forEach((it, k) => map.set(lo + k, utf16be(hexBin(it.replace(/[<>\s]/g, '')))));
          } else {
            const base = utf16be(hexBin(m[3].replace(/[<>\s]/g, '')));
            for (let c = lo; c <= hi; c++) {
              map.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo)));
            }
          }
        }
      }
    }
    return { map, bytes };
  }
  const WINANSI_HI = { 128: '€', 130: '‚', 131: 'ƒ', 132: '„', 133: '…', 134: '†', 135: '‡', 136: 'ˆ', 137: '‰', 138: 'Š', 139: '‹', 140: 'Œ', 142: 'Ž', 145: '‘', 146: '’', 147: '“', 148: '”', 149: '•', 150: '–', 151: '—', 152: '˜', 153: '™', 154: 'š', 155: '›', 156: 'œ', 158: 'ž', 159: 'Ÿ' };
  const GLYPHNAMES = {
    space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'", quoteright: '’', quoteleft: '‘',
    parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-', minus: '−', period: '.', slash: '/', colon: ':', semicolon: ';',
    less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', underscore: '_', braceleft: '{', bar: '|',
    braceright: '}', asciitilde: '~', bullet: '•', endash: '–', emdash: '—', degree: '°', mu: 'µ', plusminus: '±', copyright: '©',
    registered: '®', trademark: '™', quotedblleft: '“', quotedblright: '”', ellipsis: '…', fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl',
    zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', multiply: '×', section: '§', paragraph: '¶'
  };
  function glyphNameToUnicode(n) {
    if (GLYPHNAMES[n]) return GLYPHNAMES[n];
    if (/^[A-Za-z]$/.test(n)) return n;
    let m = /^uni([0-9A-Fa-f]{4})$/.exec(n) || /^u([0-9A-Fa-f]{4,6})$/.exec(n);
    if (m) return String.fromCodePoint(parseInt(m[1], 16));
    return null;
  }

  /* ---------- fonts ---------- */
  function makeFontCache(L, doc) {
    const { PDFName, PDFArray, PDFNumber, PDFDict, PDFRef } = L;
    const cache = new Map();
    const stdCache = {};
    const n = (o) => (o instanceof PDFNumber ? o.asNumber() : 0);
    const nm = (o) => (o instanceof PDFName ? o.decodeText() : (o && o.decodeText ? o.decodeText() : ''));
    function stdWidths(base) {
      const b = base.replace(/^[A-Z]{6}\+/, '').toLowerCase();
      let key = 'Helvetica';
      const bold = /bold|black|heavy|semibold|demi/.test(b), it = /italic|oblique/.test(b);
      if (/times|serif|roman/.test(b) && !/sans/.test(b)) key = bold && it ? 'TimesRomanBoldItalic' : bold ? 'TimesRomanBold' : it ? 'TimesRomanItalic' : 'TimesRoman';
      else if (/courier|mono/.test(b)) key = bold && it ? 'CourierBoldOblique' : bold ? 'CourierBold' : it ? 'CourierOblique' : 'Courier';
      else if (/symbol/.test(b)) key = 'Symbol';
      else if (/dingbat/.test(b)) key = 'ZapfDingbats';
      else key = bold && it ? 'HelveticaBoldOblique' : bold ? 'HelveticaBold' : it ? 'HelveticaOblique' : 'Helvetica';
      if (!stdCache[key]) {
        let emb = null;
        try { emb = L.StandardFontEmbedder.for(L.StandardFonts[key]); } catch (e) { emb = null; }
        const tbl = {};
        stdCache[key] = (code) => {
          if (code in tbl) return tbl[code];
          let w = 500;
          try { if (emb) w = emb.widthOfTextAtSize(String.fromCharCode(code), 1000); } catch (e) { w = 500; }
          return (tbl[code] = w);
        };
      }
      return stdCache[key];
    }
    function info(fontRefOrDict) {
      const key = fontRefOrDict instanceof PDFRef ? fontRefOrDict.toString() : fontRefOrDict;
      if (cache.has(key)) return cache.get(key);
      const d = fontRefOrDict instanceof PDFRef ? doc.context.lookup(fontRefOrDict) : fontRefOrDict;
      const res = { twoByte: false, widthScale: 0.001, width: () => 500, baseFont: '', subtype: '', ref: fontRefOrDict instanceof PDFRef ? fontRefOrDict : null, dict: d };
      if (d instanceof PDFDict) {
        res.subtype = nm(d.get(PDFName.of('Subtype')));
        res.baseFont = nm(d.get(PDFName.of('BaseFont')));
        if (res.subtype === 'Type0') {
          res.twoByte = true;
          const desc = d.lookup(PDFName.of('DescendantFonts'));
          const df = desc instanceof PDFArray ? desc.lookup(0) : null;
          const map = new Map();
          let dw = 1000;
          if (df instanceof PDFDict) {
            if (!res.baseFont) res.baseFont = nm(df.get(PDFName.of('BaseFont')));
            const dwo = df.lookup(PDFName.of('DW')); if (dwo instanceof PDFNumber) dw = dwo.asNumber();
            const W = df.lookup(PDFName.of('W'));
            if (W instanceof PDFArray) {
              const arr = W.asArray().map(o => doc.context.lookup(o));
              let k = 0;
              while (k < arr.length) {
                const first = n(arr[k]);
                const nx = arr[k + 1];
                if (nx instanceof PDFArray) {
                  const ws = nx.asArray();
                  for (let q = 0; q < ws.length; q++) map.set(first + q, n(doc.context.lookup(ws[q])));
                  k += 2;
                } else {
                  const last = n(nx), w = n(arr[k + 2]);
                  for (let q = first; q <= last && q - first < 70000; q++) map.set(q, w);
                  k += 3;
                }
              }
            }
          }
          res.width = (cid) => (map.has(cid) ? map.get(cid) : dw);
        } else {
          if (res.subtype === 'Type3') {
            const fm = d.lookup(PDFName.of('FontMatrix'));
            if (fm instanceof PDFArray) res.widthScale = n(fm.lookup(0)) || 0.001;
          }
          const W = d.lookup(PDFName.of('Widths'));
          const fc = n(d.lookup(PDFName.of('FirstChar')));
          let missing = 0;
          const fd = d.lookup(PDFName.of('FontDescriptor'));
          if (fd instanceof PDFDict) { const mw = fd.lookup(PDFName.of('MissingWidth')); if (mw instanceof PDFNumber) missing = mw.asNumber(); }
          if (W instanceof PDFArray) {
            const ws = W.asArray().map(o => n(doc.context.lookup(o)));
            res.width = (code) => { const k = code - fc; return k >= 0 && k < ws.length ? ws[k] : missing; };
          } else {
            res.width = stdWidths(res.baseFont || 'Helvetica');
          }
        }
      }
      // unicode mapping for each code
      let tu = null;
      if (d instanceof PDFDict) {
        const tus = d.lookup(PDFName.of('ToUnicode'));
        if (tus instanceof L.PDFRawStream) { try { tu = parseToUnicode(bytesToLatin1(L.decodePDFRawStream(tus).decode())).map; } catch (e) { tu = null; } }
      }
      const diffs = {};
      if (d instanceof PDFDict && !res.twoByte) {
        const enc = d.lookup(PDFName.of('Encoding'));
        if (enc instanceof PDFDict) {
          const D = enc.lookup(PDFName.of('Differences'));
          if (D instanceof PDFArray) {
            let code = 0;
            D.asArray().forEach(o => { o = doc.context.lookup(o); if (o instanceof PDFNumber) code = o.asNumber(); else if (o instanceof PDFName) { const u = glyphNameToUnicode(o.decodeText()); if (u) diffs[code] = u; code++; } });
          }
        }
      }
      res.uni = (code) => {
        if (tu && tu.has(code)) {
          const u = tu.get(code), c0 = u.charCodeAt(0);
          // private-use mappings are often generator bugs: prefer the glyph name when there is one
          if (c0 >= 0xE000 && c0 <= 0xF8FF && !res.twoByte && code in diffs) return diffs[code];
          return u;
        }
        if (res.twoByte) return '\ufffd';
        if (code in diffs) return diffs[code];
        if (code >= 128 && code < 160) return WINANSI_HI[code] || '\ufffd';
        if (code < 32) return '\ufffd';
        return String.fromCharCode(code);
      };
      // reverse mapping, so changed text can reuse this font when it has the glyphs
      let enc;
      res.encodeMap = () => {
        if (enc !== undefined) return enc;
        enc = null;
        if (tu) { enc = new Map(); tu.forEach((s, code) => { if (Array.from(s).length === 1 && !enc.has(s)) enc.set(s, code); }); }
        else if (!res.twoByte && !/^[A-Z]{6}\+/.test(res.baseFontRaw || '')) {
          enc = new Map();
          for (let c = 32; c < 256; c++) { const ch = res.uni(c); if (ch !== '\ufffd' && (c === 32 || res.width(c) > 0) && !enc.has(ch)) enc.set(ch, c); }
        }
        return enc;
      };
      res.baseFontRaw = res.baseFont;
      cache.set(key, res);
      return res;
    }
    return { info };
  }

  /* ---------- page access ---------- */
  function contentRefs(L, page) {
    const c = page.node.get(L.PDFName.of('Contents'));
    if (!c) return [];
    if (c instanceof L.PDFArray) return c.asArray();
    return [c];
  }
  function streamBytes(L, doc, refOrObj) {
    const o = refOrObj instanceof L.PDFRef ? doc.context.lookup(refOrObj) : refOrObj;
    if (o instanceof L.PDFRawStream) return L.decodePDFRawStream(o).decode();
    if (o && o.getUnencodedContents) return o.getUnencodedContents();
    if (o && o.getContents) return o.getContents();
    return new Uint8Array(0);
  }
  function pageContent(L, doc, page) {
    const parts = contentRefs(L, page).map(r => bytesToLatin1(streamBytes(L, doc, r)));
    return parts.join('\n');
  }
  function resourcesOf(L, page) {
    const r = page.node.Resources();
    return r instanceof L.PDFDict ? r : null;
  }

  /* ---------- interpreter ---------- */
  // Runs the page's content and every form XObject it draws (headers, footers, stamps),
  // recording each glyph and image with the stream it lives in.
  function analyzePage(L, doc, pageIndex, fontCache, aopts) {
    const wantPaths = !!(aopts && aopts.paths);
    const shapes = [], graphics = [];
    const page = doc.getPages()[pageIndex];
    const fc = fontCache || makeFontCache(L, doc);
    const N = (k) => L.PDFName.of(k);
    const streams = [];
    const runs = [], images = [];
    let gs = { ctm: I.slice(), fill: [0, 0, 0], stroke: [0, 0, 0], lw: 1, Tr: 0, font: null, fontName: '', Tfs: 0, Tc: 0, Tw: 0, Th: 1, TL: 0, rise: 0 };
    let gstack = [];
    let Tm = I.slice(), Tlm = I.slice();
    let posSinceShow = true;
    const cmyk2rgb = (c, m, y, k) => [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];

    function exec(si) {
      const S = streams[si];
      const fontsDict = S.res ? S.res.lookup(N('Font')) : null;
      const xobjDict = S.res ? S.res.lookup(N('XObject')) : null;
      let qd = 0;
      let path = [], cur = null, curve = false, clipNext = false, pathStart = -1;
      const setFont = (name, size) => {
        gs.fontName = name; gs.Tfs = size; gs.font = null;
        if (fontsDict instanceof L.PDFDict) {
          const raw = fontsDict.get(N(name));
          if (raw) gs.font = fc.info(raw instanceof L.PDFRef ? raw : fontsDict.lookup(N(name)));
        }
      };
      const td = (tx, ty) => { Tlm = mul([1, 0, 0, 1, tx, ty], Tlm); Tm = Tlm.slice(); posSinceShow = true; };
      const showRun = (opIndex, elems, kind) => {
        const f = gs.font || { twoByte: false, widthScale: 0.001, width: () => 500, baseFont: '', uni: c => String.fromCharCode(c), encodeMap: () => null };
        const glyphs = [];
        const startM = mul(Tm, gs.ctm);
        for (let ei = 0; ei < elems.length; ei++) {
          const el = elems[ei];
          if (typeof el === 'number') { Tm = mul([1, 0, 0, 1, -el / 1000 * gs.Tfs * gs.Th, 0], Tm); continue; }
          const step = f.twoByte ? 2 : 1;
          for (let k = 0; k < el.length; k += step) {
            const code = f.twoByte ? ((el.charCodeAt(k) << 8) | (el.charCodeAt(k + 1) || 0)) : el.charCodeAt(k);
            const tx = (f.width(code) * f.widthScale * gs.Tfs + gs.Tc + (!f.twoByte && code === 32 ? gs.Tw : 0)) * gs.Th;
            const tm0 = Tm;
            const p0 = apply(mul(Tm, gs.ctm), 0, 0);
            Tm = mul([1, 0, 0, 1, tx, 0], Tm);
            const p1 = apply(mul(Tm, gs.ctm), 0, 0);
            glyphs.push({ el: ei, bytes: el.substr(k, step), adv: tx, p0, p1, tm: tm0, code, ch: f.uni ? f.uni(code) : String.fromCharCode(code) });
          }
        }
        runs.push({
          si, opIndex, kind, glyphs, elems, font: f,
          Tfs: gs.Tfs, Th: gs.Th, Tc: gs.Tc, Tw: gs.Tw,
          baseFont: (f.baseFont || '').replace(/^[A-Z]{6}\+/, ''),
          fill: gs.fill.slice(), size: gs.Tfs * Math.hypot(startM[2], startM[3]),
          dir: Math.atan2(startM[1], startM[0]), sx: Math.hypot(startM[0], startM[1]) || 1,
          positioned: posSinceShow, Tr: gs.Tr, rise: gs.rise * Math.hypot(startM[2], startM[3]), Ts: gs.rise, ctm: gs.ctm.slice()
        });
        posSinceShow = false;
      };
      const ops = S.ops;
      for (let oi = 0; oi < ops.length; oi++) {
        const o = ops[oi];
        const a = o.args.map(x => x.v);
        switch (o.op) {
          case 'q': qd++; gstack.push({ ...gs, ctm: gs.ctm.slice(), fill: gs.fill.slice(), stroke: gs.stroke.slice() }); break;
          case 'Q': qd = Math.max(0, qd - 1); if (gstack.length) gs = gstack.pop(); break;
          case 'cm': if (a.length === 6) gs.ctm = mul(a, gs.ctm); break;
          case 'BT': Tm = I.slice(); Tlm = I.slice(); posSinceShow = true; break;
          case 'Tf': setFont(a[0], a[1] || 0); break;
          case 'Tc': gs.Tc = a[0] || 0; break;
          case 'Tw': gs.Tw = a[0] || 0; break;
          case 'Tz': gs.Th = (a[0] == null ? 100 : a[0]) / 100; break;
          case 'TL': gs.TL = a[0] || 0; break;
          case 'Ts': gs.rise = a[0] || 0; break;
          case 'Td': td(a[0] || 0, a[1] || 0); break;
          case 'TD': gs.TL = -(a[1] || 0); td(a[0] || 0, a[1] || 0); break;
          case 'Tm': if (a.length === 6) { Tm = a.slice(); Tlm = a.slice(); } posSinceShow = true; break;
          case 'T*': td(0, -gs.TL); break;
          case 'Tj': showRun(oi, [a[0] || ''], 'Tj'); break;
          case 'TJ': showRun(oi, (a[0] || []).map(x => x.v), 'TJ'); break;
          case "'": td(0, -gs.TL); showRun(oi, [a[0] || ''], "'"); break;
          case '"': gs.Tw = a[0] || 0; gs.Tc = a[1] || 0; td(0, -gs.TL); showRun(oi, [a[2] || ''], '"'); break;
          case 'Tr': gs.Tr = a[0] || 0; break;
          case 'w': gs.lw = a[0] || 0; break;
          case 'G': gs.stroke = [a[0], a[0], a[0]]; break;
          case 'RG': gs.stroke = [a[0], a[1], a[2]]; break;
          case 'K': gs.stroke = cmyk2rgb(a[0], a[1], a[2], a[3]); break;
          case 'SC': case 'SCN': {
            const nums = a.filter(x => typeof x === 'number');
            if (nums.length === 1) gs.stroke = [nums[0], nums[0], nums[0]];
            else if (nums.length === 3) gs.stroke = nums.slice();
            else if (nums.length === 4) gs.stroke = cmyk2rgb.apply(null, nums);
            break;
          }
          case 'm': if (wantPaths && !path.length) pathStart = oi; if (wantPaths) { cur = [[apply(gs.ctm, a[0], a[1])]]; path.push(cur[0]); curve = false; } break;
          case 'l': if (wantPaths && path.length) path[path.length - 1].push(apply(gs.ctm, a[0], a[1])); break;
          case 'c': case 'v': case 'y': if (wantPaths && path.length) { const n = a.length; path[path.length - 1].push(apply(gs.ctm, a[n - 2], a[n - 1])); path[path.length - 1].curved = true; } break;
          case 'h': if (wantPaths && path.length) path[path.length - 1].closed = true; break;
          case 're': if (wantPaths && !path.length) pathStart = oi; if (wantPaths) { const [x, y, w, h] = a; const sp = [apply(gs.ctm, x, y), apply(gs.ctm, x + w, y), apply(gs.ctm, x + w, y + h), apply(gs.ctm, x, y + h)]; sp.closed = true; sp.rect = true; path.push(sp); } break;
          case 'W': case 'W*': clipNext = true; break;
          case 'n': path = []; clipNext = false; pathStart = -1; break;
          case 'S': case 's': case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': {
            if (wantPaths && path.length && !clipNext) {
              const stroke = /^[SsBb]/.test(o.op), fill = o.op !== 'S' && o.op !== 's';
              const lw = gs.lw * Math.hypot(gs.ctm[0], gs.ctm[1]) || 0.5;
              const gi = graphics.length, first = shapes.length;
              for (const sp of path) {
                const xs = sp.map(p => p[0]), ys = sp.map(p => p[1]);
                const bb = { x: Math.min.apply(0, xs), y: Math.min.apply(0, ys) }; bb.w = Math.max.apply(0, xs) - bb.x; bb.h = Math.max.apply(0, ys) - bb.y;
                let kind = 'path';
                const axis = !sp.curved && sp.every((p, k) => { const q = sp[(k + 1) % sp.length]; return Math.abs(p[0] - q[0]) < 0.01 || Math.abs(p[1] - q[1]) < 0.01; });
                if (sp.length === 2 && !sp.curved) kind = 'line';
                else if (axis && (sp.length === 4 || (sp.length === 5 && Math.abs(sp[0][0] - sp[4][0]) < 0.01 && Math.abs(sp[0][1] - sp[4][1]) < 0.01))) kind = 'rect';
                else if (!sp.curved && sp.length > 2 && sp.every((p, k) => k === 0 || Math.abs(p[0] - sp[0][0]) < 0.01 || Math.abs(p[1] - sp[0][1]) < 0.01) && (bb.w < 0.01 || bb.h < 0.01)) kind = 'line';
                shapes.push({ kind, pts: sp, bbox: bb, fill: fill ? gs.fill.slice() : null, stroke: stroke ? gs.stroke.slice() : null, lw, curved: !!sp.curved, si, g: gi });
              }
              // the whole painted path, from its first point to the paint operator, as one editable graphic
              const mine = shapes.slice(first);
              if (pathStart >= 0 && mine.length) {
                const x0 = Math.min(...mine.map(m => m.bbox.x)), y0 = Math.min(...mine.map(m => m.bbox.y));
                const x1 = Math.max(...mine.map(m => m.bbox.x + m.bbox.w)), y1 = Math.max(...mine.map(m => m.bbox.y + m.bbox.h));
                const pad = stroke ? lw / 2 : 0;
                graphics.push({ id: 'g' + gi, index: gi, si, op0: pathStart, op1: oi, op: o.op, ctm: gs.ctm.slice(), shapes: mine, kind: mine.length === 1 ? mine[0].kind : 'path',
                  bbox: { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad }, fill: fill ? gs.fill.slice() : null, stroke: stroke ? gs.stroke.slice() : null, lw: stroke ? lw : 0 });
              }
            }
            pathStart = -1;
            path = []; clipNext = false;
            break;
          }
          case 'g': gs.fill = [a[0], a[0], a[0]]; break;
          case 'rg': gs.fill = [a[0], a[1], a[2]]; break;
          case 'k': gs.fill = cmyk2rgb(a[0], a[1], a[2], a[3]); break;
          case 'sc': case 'scn': {
            const nums = a.filter(x => typeof x === 'number');
            if (nums.length === 1) gs.fill = [nums[0], nums[0], nums[0]];
            else if (nums.length === 3) gs.fill = nums.slice();
            else if (nums.length === 4) gs.fill = cmyk2rgb.apply(null, nums);
            break;
          }
          case 'Do': {
            const name = a[0];
            const raw = xobjDict instanceof L.PDFDict ? xobjDict.get(N(name)) : null;
            const xo = raw ? doc.context.lookup(raw) : null;
            if (!xo || !xo.dict) break;
            const st = xo.dict.get(N('Subtype'));
            const kind = st && st.decodeText ? st.decodeText() : '';
            if (kind === 'Image') { images.push({ id: 'img' + images.length, si, opIndex: oi, name, ctm: gs.ctm.slice(), bbox: bboxOf(gs.ctm), inline: false }); break; }
            if (kind !== 'Form' || S.depth >= 6) break;
            const key = raw instanceof L.PDFRef ? raw.toString() : '';
            if (key && S.chain.includes(key)) break;
            let src = '';
            try { src = bytesToLatin1(streamBytes(L, doc, xo)); } catch (e) { break; }
            const fres = xo.dict.lookup(N('Resources'));
            const M = xo.dict.lookup(N('Matrix'));
            const m = M instanceof L.PDFArray && M.size() === 6 ? M.asArray().map(v => { const n = doc.context.lookup(v); return n && n.asNumber ? n.asNumber() : 0; }) : I.slice();
            const ci = streams.length;
            streams.push({ id: ci, src, ops: parseOps(src), res: fres instanceof L.PDFDict ? fres : S.res, ownRes: fres instanceof L.PDFDict, parent: si, doOp: oi, xo, depth: S.depth + 1, chain: S.chain.concat(key ? [key] : []) });
            const saved = { gs: { ...gs, ctm: gs.ctm.slice(), fill: gs.fill.slice(), stroke: gs.stroke.slice() }, gstack, Tm, Tlm };
            gs.ctm = mul(m, gs.ctm); gstack = []; posSinceShow = true;
            exec(ci);
            gs = saved.gs; gstack = saved.gstack; Tm = saved.Tm; Tlm = saved.Tlm; posSinceShow = true;
            break;
          }
          case 'INLINE':
            images.push({ id: 'img' + images.length, si, opIndex: oi, name: null, ctm: gs.ctm.slice(), bbox: bboxOf(gs.ctm), inline: true });
            break;
          default: break;
        }
      }
      S.qDepth = qd;
    }

    const src = pageContent(L, doc, page);
    streams.push({ id: 0, src, ops: parseOps(src), res: resourcesOf(L, page), parent: -1, depth: 0, chain: [] });
    exec(0);
    // stream 0 shortcuts kept for older callers
    return { pageIndex, streams, src: streams[0].src, ops: streams[0].ops, runs, images, shapes, graphics, qDepth: streams[0].qDepth || 0 };
  }

  /* ---------- matching edit boxes to glyphs ---------- */
  // box: { origin:[x,y], dir:[dx,dy] (unit), width, height } in user space
  function glyphsInBox(analysis, box) {
    const hits = [];
    const [ox, oy] = box.origin, [dx, dy] = box.dir;
    const h = box.height || 10;
    for (let ri = 0; ri < analysis.runs.length; ri++) {
      const r = analysis.runs[ri];
      for (let gi = 0; gi < r.glyphs.length; gi++) {
        const g = r.glyphs[gi];
        const mx = (g.p0[0] + g.p1[0]) / 2 - ox, my = (g.p0[1] + g.p1[1]) / 2 - oy;
        const u = mx * dx + my * dy;
        const v = -mx * dy + my * dx;
        const tolU = Math.max(0.5, h * 0.15);
        if (u >= -tolU && u <= box.width + tolU && v >= -h * 0.45 && v <= h * 0.85) hits.push([ri, gi, u]);
      }
    }
    return hits;
  }

  const proj = (p, box) => (p[0] - box.origin[0]) * box.dir[0] + (p[1] - box.origin[1]) * box.dir[1];

  /* decode the text under a box into units (one per glyph, plus virtual spaces for gaps) */
  function boxText(analysis, box) {
    const hits = glyphsInBox(analysis, box).sort((x, y) => x[2] - y[2]);
    const units = [];
    let prev = null;
    for (const [ri, gi] of hits) {
      const run = analysis.runs[ri], g = run.glyphs[gi];
      if (prev) {
        const gap = proj(g.p0, box) - proj(prev.g.p1, box);
        if (gap > Math.max(prev.run.size, run.size) * 0.18 && prev.g.ch !== ' ' && g.ch !== ' ')
          units.push({ ch: ' ', virtual: true, p0: prev.g.p1, p1: g.p0 });
      }
      units.push({ ch: g.ch, ri, gi, p0: g.p0, p1: g.p1 });
      prev = { run, g };
    }
    // edge spaces usually belong to neighbouring text that brushes the box: leave them alone
    while (units.length && /^\s+$/.test(units[0].ch)) units.shift();
    while (units.length && /^\s+$/.test(units[units.length - 1].ch)) units.pop();
    const keep = new Set(units.filter(u => !u.virtual).map(u => u.ri + ':' + u.gi));
    const text = units.map(u => u.ch).join('');
    return { units, text, hits: hits.filter(h => keep.has(h[0] + ':' + h[1])) };
  }

  function dominantRun(analysis, refs) {
    const count = new Map();
    refs.forEach(([ri]) => count.set(ri, (count.get(ri) || 0) + 1));
    let best = null, bc = -1;
    count.forEach((c, ri) => { if (c > bc) { bc = c; best = ri; } });
    return best == null ? null : analysis.runs[best];
  }

  function styleFromRun(run, fallbackSize) {
    if (!run) return { family: 'Helvetica', bold: false, italic: false, size: fallbackSize || 11, color: [0, 0, 0] };
    const st = styleOf(run.baseFont);
    return { family: familyOf(run.baseFont), bold: st.bold, italic: st.italic, size: run.size || fallbackSize || 11, color: run.fill.slice() };
  }

  /*
   * Plan a text edit. Only the characters that changed are removed. When the PDF's own
   * font has every new character, they are written into the original text run so the
   * result is typographically identical; otherwise they are drawn in a matching font.
   * Text after the change shifts when the replacement is longer or shorter.
   * measure(text, style) -> width in user space units (for drawn text)
   */
  function planTextEdit(analysis, box, newText, opts) {
    opts = opts || {};
    const bt = boxText(analysis, box);
    const angle = Math.atan2(box.dir[1], box.dir[0]);
    const norm = (t) => (t || '').replace(/\s+/g, '');
    const reliable = bt.units.length > 0 && bt.text.indexOf('\ufffd') < 0 && (opts.originalText == null || norm(bt.text) === norm(opts.originalText));
    const plan = { removed: [], desired: new Map(), draw: null, insert: null, mode: 'none', decoded: bt.text };
    if (!bt.units.length) {
      plan.mode = 'cover';
      const st = Object.assign(styleFromRun(null, box.height), opts.style || {});
      if (newText) plan.draw = Object.assign({ text: newText, x: box.origin[0], y: box.origin[1], angle }, st);
      return plan;
    }
    if (!reliable || opts.whole) {
      plan.mode = 'whole';
      plan.removed = bt.hits.map(h => [h[0], h[1]]);
      const st = Object.assign(styleFromRun(dominantRun(analysis, plan.removed), box.height), opts.style || {});
      if (newText) plan.draw = Object.assign({ text: newText, x: box.origin[0], y: box.origin[1], angle }, st);
      return plan;
    }
    const U = bt.units, n = U.length;
    let p = 0, pc = 0;
    while (p < n && newText.substr(pc, U[p].ch.length) === U[p].ch) { pc += U[p].ch.length; p++; }
    let sfx = 0, sc = 0;
    while (sfx < n - p) {
      const ch = U[n - 1 - sfx].ch;
      if (newText.length - sc - ch.length < pc) break;
      if (newText.substr(newText.length - sc - ch.length, ch.length) !== ch) break;
      sc += ch.length; sfx++;
    }
    const removedUnits = U.slice(p, n - sfx);
    const inserted = newText.slice(pc, newText.length - sc);
    if (!removedUnits.length && !inserted) return plan;
    plan.mode = 'diff';
    const realRemoved = removedUnits.filter(u => !u.virtual);
    plan.removed = realRemoved.map(u => [u.ri, u.gi]);
    let anchor, removedW = 0;
    if (removedUnits.length) {
      anchor = removedUnits[0].p0;
      removedW = proj(removedUnits[removedUnits.length - 1].p1, box) - proj(anchor, box);
    } else anchor = p > 0 ? U[p - 1].p1 : U[0].p0;
    let newW = 0;
    // 1) write into the original run with the original font
    let host = null;
    if (realRemoved.length) host = { ri: realRemoved[0].ri, gi: realRemoved[0].gi, where: 'before' };
    else if (p > 0 && !U[p - 1].virtual) host = { ri: U[p - 1].ri, gi: U[p - 1].gi, where: 'after' };
    else if (p > 1 && U[p - 1].virtual && !U[p - 2].virtual) host = null; // gap: draw instead
    else if (p === 0 && !U[0].virtual) host = { ri: U[0].ri, gi: U[0].gi, where: 'before' };
    if (inserted && host && !opts.style && !opts.noReuse) {
      const run = analysis.runs[host.ri];
      const enc = encodeInRun(run, inserted);
      if (enc) {
        plan.insert = Object.assign(host, { parts: enc.parts, adv: enc.adv });
        newW = enc.adv * run.sx;
        plan.mode = 'reuse';
      }
    }
    // 2) otherwise draw the new characters
    if (inserted && !plan.insert) {
      const srcUnit = realRemoved[0] || [U[p - 1], U[p], U[p - 2], U[p + 1]].find(u => u && !u.virtual);
      const st = Object.assign(styleFromRun(srcUnit ? analysis.runs[srcUnit.ri] : null, box.height), opts.style || {});
      plan.draw = Object.assign({ text: inserted, x: anchor[0], y: anchor[1], angle }, st);
      newW = opts.measure ? opts.measure(inserted, st) : 0;
    }
    const delta = newW - removedW;
    if (sfx > 0 && Math.abs(delta) > 0.01) U.slice(n - sfx).forEach(u => { if (!u.virtual) plan.desired.set(u.ri + ':' + u.gi, delta); });
    return plan;
  }

  /* encode text in a run's own font; spaces the font lacks become positioning */
  function encodeInRun(run, text) {
    const f = run.font;
    if (!f || !f.encodeMap) return null;
    const m = f.encodeMap();
    if (!m || !m.size) return null;
    const parts = [];
    let adv = 0;
    for (const ch of text) {
      const code = m.get(ch);
      if (code == null) {
        if (ch === ' ') { const a = 0.28 * run.Tfs * run.Th; parts.push({ adv: a }); adv += a; continue; }
        return null;
      }
      if (ch !== ' ' && !(f.width(code) > 0)) return null;
      const bytes = f.twoByte ? String.fromCharCode((code >> 8) & 255, code & 255) : String.fromCharCode(code & 255);
      const a = (f.width(code) * f.widthScale * run.Tfs + run.Tc + (!f.twoByte && code === 32 ? run.Tw : 0)) * run.Th;
      parts.push({ bytes, adv: a }); adv += a;
    }
    return { parts, adv };
  }

  /* ---------- rewriting ---------- */
  function rebuildRun(run, removed, adjust, inserts) {
    const parts = [];
    let pending = 0; // text-space advance not yet written
    let cur = '';
    const scale = run.Tfs * run.Th;
    const flushStr = () => { if (cur) { parts.push(hexOf(cur)); cur = ''; } };
    const flushAdv = () => {
      if (Math.abs(pending) > 1e-9) {
        flushStr();
        if (scale) parts.push(num(-pending * 1000 / scale));
        pending = 0;
      }
    };
    const emitInsert = (ins) => {
      flushAdv();
      for (const pt of ins.parts) {
        if (pt.bytes) cur += pt.bytes;
        else { flushStr(); pending += pt.adv; flushAdv(); }
      }
      // keep the following glyphs where they were; shifting is handled separately
      flushStr(); pending -= ins.adv;
    };
    let gi = 0;
    for (let ei = 0; ei < run.elems.length; ei++) {
      const el = run.elems[ei];
      if (typeof el === 'number') { flushStr(); pending += -el / 1000 * run.Tfs * run.Th; continue; }
      while (gi < run.glyphs.length && run.glyphs[gi].el === ei) {
        const g = run.glyphs[gi];
        const ins = inserts && inserts.get(gi);
        if (ins && ins.where === 'before') emitInsert(ins);
        if (removed.has(gi)) { flushStr(); pending += g.adv; }
        else {
          if (adjust.has(gi)) { flushStr(); pending += adjust.get(gi); }
          flushAdv(); cur += g.bytes;
        }
        if (ins && ins.where === 'after') emitInsert(ins);
        gi++;
      }
    }
    flushAdv(); flushStr();
    let body = '[' + parts.join(' ') + '] TJ';
    if (run.kind === "'") body = 'T* ' + body;
    if (run.kind === '"') body = num(run.Tw) + ' Tw ' + num(run.Tc) + ' Tc T* ' + body;
    return body;
  }

  function nameToken(name) {
    return '/' + name.replace(/[^\x21-\x7e]|[()<>\[\]{}\/%#]/g, c => '#' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  }

  /* fit a w×h image inside the unit square, centered */
  function fitUnit(imgW, imgH, boxW, boxH) {
    if (!imgW || !imgH || !boxW || !boxH) return I.slice();
    const ra = imgW / imgH, rb = boxW / boxH;
    if (ra > rb) { const hh = rb / ra; return [1, 0, 0, hh, 0, (1 - hh) / 2]; }
    const ww = ra / rb; return [ww, 0, 0, 1, (1 - ww) / 2, 0];
  }

  /*
   * edits = { text: [plan], images: [{ id, action:'delete'|'move'|'replace', rect?, newName?, imgW?, imgH?, stretch? }] }
   * returns { repl: Map(streamIndex -> Map(opIndex -> string)), removedGlyphs, changed }
   */
  function rewriteContent(analysis, edits) {
    const repl = new Map();
    const put = (si, oi, str) => { if (!repl.has(si)) repl.set(si, new Map()); repl.get(si).set(oi, str); };
    const removedByRun = new Map(), insertsByRun = new Map();
    const desired = new Map();
    let removedCount = 0;
    for (const plan of (edits.text || [])) {
      for (const [ri, gi] of plan.removed) {
        if (!removedByRun.has(ri)) removedByRun.set(ri, new Set());
        const set = removedByRun.get(ri);
        if (!set.has(gi)) { set.add(gi); removedCount++; }
      }
      if (plan.insert) {
        if (!insertsByRun.has(plan.insert.ri)) insertsByRun.set(plan.insert.ri, new Map());
        insertsByRun.get(plan.insert.ri).set(plan.insert.gi, plan.insert);
      }
      plan.desired.forEach((d, k) => desired.set(k, (desired.get(k) || 0) + d));
    }
    let carried = 0;
    analysis.runs.forEach((run, ri) => {
      if (run.positioned) carried = 0;
      const rem = removedByRun.get(ri) || new Set();
      const ins = insertsByRun.get(ri);
      const adj = new Map();
      run.glyphs.forEach((g, gi) => {
        if (rem.has(gi)) return;
        const d = desired.get(ri + ':' + gi) || 0;
        if (Math.abs(d - carried) > 1e-6) { adj.set(gi, (d - carried) / run.sx); carried = d; }
      });
      if (rem.size || adj.size || ins) put(run.si, run.opIndex, rebuildRun(run, rem, adj, ins));
    });
    for (const ge of (edits.graphics || [])) {
      const g = (analysis.graphics || [])[ge.index];
      if (!g) continue;
      put(g.si, g.op0, graphicReplacement(analysis, g, ge));
      for (let k = g.op0 + 1; k <= g.op1; k++) put(g.si, k, '');
    }
    for (const ie of (edits.images || [])) {
      const img = analysis.images.find(x => x.id === ie.id);
      if (!img) continue;
      const S = analysis.streams[img.si];
      const op = S.ops[img.opIndex];
      const original = S.src.slice(op.s, op.e);
      if (ie.action === 'delete') { put(img.si, img.opIndex, ''); continue; }
      const C = img.ctm;
      let M = I.slice();
      if (ie.rect) {
        const b = img.bbox;
        const sx = b.w ? ie.rect.w / b.w : 1, sy = b.h ? ie.rect.h / b.h : 1;
        const Sm = [sx, 0, 0, sy, ie.rect.x - b.x * sx, ie.rect.y - b.y * sy];
        const Ci = inv(C);
        if (Ci) M = mul(mul(C, Sm), Ci);
      }
      if (ie.action === 'replace' && ie.newName) {
        const boxW = Math.hypot(C[0], C[1]) * (ie.rect && img.bbox.w ? ie.rect.w / img.bbox.w : 1);
        const boxH = Math.hypot(C[2], C[3]) * (ie.rect && img.bbox.h ? ie.rect.h / img.bbox.h : 1);
        const F = ie.stretch ? I.slice() : fitUnit(ie.imgW, ie.imgH, boxW, boxH);
        M = mul(F, M);
        put(img.si, img.opIndex, 'q ' + M.map(num).join(' ') + ' cm ' + nameToken(ie.newName) + ' Do Q');
      } else {
        put(img.si, img.opIndex, 'q ' + M.map(num).join(' ') + ' cm ' + original + ' Q');
      }
    }
    return { repl, removedGlyphs: removedCount, changed: repl.size > 0 };
  }

  function splice(S, map) {
    if (!map || !map.size) return S.src;
    const idxs = Array.from(map.keys()).sort((a, b) => a - b);
    let out = '', pos = 0;
    for (const oi of idxs) { const op = S.ops[oi]; out += S.src.slice(pos, op.s) + map.get(oi); pos = op.e; }
    return out + S.src.slice(pos);
  }

  function uniqueName(L, resDict, prefix, taken) {
    const x = resDict instanceof L.PDFDict ? resDict.lookup(L.PDFName.of('XObject')) : null;
    for (let i = 1; ; i++) {
      const nm = prefix + i;
      if (taken.has(nm)) continue;
      if (x instanceof L.PDFDict && x.get(L.PDFName.of(nm))) continue;
      taken.add(nm); return nm;
    }
  }

  /*
   * Write all changed streams. Changed headers/footers (form XObjects) are copied so the
   * edit only affects this page; the parent stream is pointed at the copy.
   * extraX: Map(streamIndex -> {name: ref}) of XObjects the new content needs.
   */
  function materialize(L, doc, page, an, repl, extraX) {
    const ctx = doc.context, N = (k) => L.PDFName.of(k);
    const taken = new Set();
    for (let si = an.streams.length - 1; si >= 1; si--) {
      const S = an.streams[si];
      const ex = extraX.get(si);
      if (!repl.has(si) && !ex) continue;
      const content = splice(S, repl.get(si));
      const st = ctx.flateStream(latin1ToBytes(content));
      for (const [k, v] of S.xo.dict.entries()) { const kn = k.decodeText(); if (kn !== 'Length' && kn !== 'Filter' && kn !== 'DecodeParms') st.dict.set(k, v); }
      if (ex) {
        const base = S.res instanceof L.PDFDict ? S.res : ctx.obj({});
        const res = base.clone(ctx);
        const xd0 = res.lookup(N('XObject'));
        const xd = xd0 instanceof L.PDFDict ? xd0.clone(ctx) : ctx.obj({});
        Object.keys(ex).forEach(nm => xd.set(N(nm), ex[nm]));
        res.set(N('XObject'), xd);
        st.dict.set(N('Resources'), res);
      }
      const ref = ctx.register(st);
      const P = an.streams[S.parent];
      const nm = uniqueName(L, P.res, 'FmEd', taken);
      const pop = P.ops[S.doOp];
      if (!repl.has(S.parent)) repl.set(S.parent, new Map());
      repl.get(S.parent).set(S.doOp, nameToken(nm) + ' Do');
      if (!extraX.has(S.parent)) extraX.set(S.parent, {});
      extraX.get(S.parent)[nm] = ref;
      void pop;
    }
    const top = an.streams[0];
    const wrapped = 'q\n' + splice(top, repl.get(0)) + '\n' + 'Q\n'.repeat((top.qDepth || 0) + 1);
    setPageContent(L, doc, page, wrapped);
    const ex0 = extraX.get(0);
    if (ex0) {
      page.node.normalize();
      const { XObject } = page.node.normalizedEntries();
      Object.keys(ex0).forEach(nm => XObject.set(N(nm), ex0[nm]));
    }
  }

  /* write new content to page, deleting the old streams so no stale copy survives in the file */
  function setPageContent(L, doc, page, content) {
    const old = contentRefs(L, page);
    const stream = doc.context.flateStream(latin1ToBytes(content));
    const ref = doc.context.register(stream);
    page.node.set(L.PDFName.of('Contents'), doc.context.obj([ref]));
    const stillUsed = new Set();
    doc.getPages().forEach(p => { if (p !== page) contentRefs(L, p).forEach(r => { if (r instanceof L.PDFRef) stillUsed.add(r.toString()); }); });
    old.forEach(r => { if (r instanceof L.PDFRef && !stillUsed.has(r.toString())) doc.context.delete(r); });
    page.contentStream = undefined; page.contentStreamRef = undefined;
  }

  /* ---------- fonts for new text ---------- */
  function standardFontFor(L, baseFont, bold, italic) { return stdName(L, familyOf(baseFont), bold, italic); }
  function stdName(L, fam, bold, italic) {
    const S = L.StandardFonts;
    if (fam === 'Courier') return bold && italic ? S.CourierBoldOblique : bold ? S.CourierBold : italic ? S.CourierOblique : S.Courier;
    if (fam === 'Times') return bold && italic ? S.TimesRomanBoldItalic : bold ? S.TimesRomanBold : italic ? S.TimesRomanItalic : S.TimesRoman;
    return bold && italic ? S.HelveticaBoldOblique : bold ? S.HelveticaBold : italic ? S.HelveticaOblique : S.Helvetica;
  }
  function familyOf(baseFont) {
    const b = (baseFont || '').toLowerCase();
    if (/courier|mono|consol/.test(b)) return 'Courier';
    if (/times|serif|roman|georgia|garamond|cambria|book|minion|palatino/.test(b) && !/sans/.test(b)) return 'Times';
    return 'Helvetica';
  }
  function styleOf(baseFont) {
    const b = (baseFont || '').toLowerCase();
    return { bold: /bold|black|heavy|semibold|demi/.test(b), italic: /italic|oblique/.test(b) };
  }
  let _ansi = null;
  /* characters the standard (WinAnsi) fonts can't draw */
  function unsupportedChars(L, text) {
    const emb = _ansi || (_ansi = L.StandardFontEmbedder.for(L.StandardFonts.Helvetica));
    const bad = new Set();
    for (const ch of text) { try { emb.encodeText(ch); } catch (e) { bad.add(ch); } }
    return Array.from(bad);
  }
  function measureStd(L, text, st) {
    try { return L.StandardFontEmbedder.for(stdName(L, st.family, st.bold, st.italic)).widthOfTextAtSize(text, st.size); }
    catch (e) { return text.length * st.size * 0.55; }
  }
  const isIdeo = (cp) => (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0xF900 && cp <= 0xFAFF);
  const parsedFonts = {};
  /* fonts beyond the standard 14, loaded on demand: 'uni' (Hangul, kana, Latin, symbols), 'cjk' (ideographs), 'ext' (wider Latin/Greek/Cyrillic) */
  function makeUniDrawer(L, doc, loadFont) {
    const U = (typeof module !== 'undefined' && module.exports) ? require('./unifont.js') : root.PDFUniFont;
    const uses = {};
    const pageFontNames = new Map();
    async function use(kind) {
      if (uses[kind]) return uses[kind];
      if (!parsedFonts[kind]) {
        const bytes = await loadFont(kind);
        if (!bytes) return null;
        parsedFonts[kind] = U.parseTTF(bytes);
      }
      return (uses[kind] = new U.FontUse(parsedFonts[kind], kind, doc));
    }
    // split text into runs by font that has each character
    async function segments(text, bold) {
      const w = bold ? 'bold' : 'regular';
      const order = ['uni-' + w, 'ext-' + w, 'cjk-' + w];
      const segs = [], missing = new Set();
      for (const ch of text) {
        const cp = ch.codePointAt(0);
        const tryKinds = isIdeo(cp) ? ['cjk-' + w, 'uni-' + w] : order;
        let chosen = null;
        for (const k of tryKinds) { const u = await use(k); if (u && u.has(ch)) { chosen = u; break; } }
        if (!chosen) { if (ch !== ' ') missing.add(ch); chosen = await use('uni-' + w); if (!chosen) continue; }
        const last = segs[segs.length - 1];
        if (last && last.use === chosen) last.text += ch; else segs.push({ use: chosen, text: ch });
      }
      return { segs, missing: Array.from(missing) };
    }
    async function prepare(text, bold) { return segments(text, bold); }
    function widthOf(prep, size) { return prep.segs.reduce((s, g) => s + g.use.widthOf(g.text, size), 0); }
    function fontName(page, u) {
      if (!pageFontNames.has(page)) pageFontNames.set(page, new Map());
      const m = pageFontNames.get(page);
      if (!m.has(u)) m.set(u, page.node.newFontDictionary('UniF', u.ref).decodeText());
      return m.get(u);
    }
    /* returns content operators that draw the text */
    function ops(page, prep, d) {
      const c = Math.cos(d.angle || 0), s = Math.sin(d.angle || 0);
      const k = d.italic ? 0.21 : 0;
      let x = d.x, y = d.y, out = 'q ' + d.color.map(num).join(' ') + ' rg\n';
      for (const g of prep.segs) {
        const m = mul([1, 0, k, 1, 0, 0], [c, s, -s, c, x, y]);
        out += 'BT /' + fontName(page, g.use) + ' ' + num(d.size) + ' Tf ' + m.map(num).join(' ') + ' Tm ' + g.use.encode(g.text) + ' Tj ET\n';
        const w = g.use.widthOf(g.text, d.size);
        x += c * w; y += s * w;
      }
      return out + 'Q\n';
    }
    function finish() { Object.values(uses).forEach(u => { if (u.used.size) u.embed(L, doc); else doc.context.assign(u.ref, doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' })); }); }
    return { prepare, widthOf, ops, finish, needed: (text) => unsupportedChars(L, text).length > 0 };
  }

  /* ---------- text blocks: paragraphs and lines, as people see them ---------- */
  const isCJKch = (c) => /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯豈-﫿＀-￯]/.test(c);
  const BULLET_RE = /^([•◦▪▫‣⁃●○■□►▸➢✓✔–\-*·]|\(?\d{1,3}[.)]|\(?[a-z][.)])$/i;
  // for each character of b, the index of the same character in a (or -1); LCS on words then characters
  function charMatch(a, b) {
    const out = new Array(b.length).fill(-1);
    let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) { out[p] = p; p++; }
    let q = 0; while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) { out[b.length - 1 - q] = a.length - 1 - q; q++; }
    const A = a.slice(p, a.length - q), B = b.slice(p, b.length - q);
    if (!A.length || !B.length) return out;
    const tok = (t) => { const r = []; const re = /\s+|[^\s]+/g; let m; while ((m = re.exec(t))) r.push({ s: m[0], i: m.index }); return r; };
    const lcs = (X, Y, eq) => {
      const n = X.length, m = Y.length;
      if (n * m > 4e6) return [];
      const D = new Array(n + 1); for (let i = 0; i <= n; i++) D[i] = new Uint16Array(m + 1);
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) D[i][j] = eq(X[i], Y[j]) ? D[i + 1][j + 1] + 1 : Math.max(D[i + 1][j], D[i][j + 1]);
      const pairs = []; let i = 0, j = 0;
      while (i < n && j < m) { if (eq(X[i], Y[j])) { pairs.push([i, j]); i++; j++; } else if (D[i + 1][j] >= D[i][j + 1]) i++; else j++; }
      return pairs;
    };
    const TA = tok(A), TB = tok(B);
    const wp = lcs(TA, TB, (x, y) => x.s === y.s);
    wp.forEach(([i, j]) => { for (let k = 0; k < TB[j].s.length; k++) out[p + TB[j].i + k] = p + TA[i].i + k; });
    // characters inside changed words: match what is left between matched words
    let ai = 0, bi = 0;
    const fill = (a0, a1, b0, b1) => {
      const x = A.slice(a0, a1), y = B.slice(b0, b1);
      if (!x.length || !y.length) return;
      lcs([...x], [...y], (c1, c2) => c1 === c2).forEach(([i, j]) => { out[p + b0 + j] = p + a0 + i; });
    };
    for (const [i, j] of wp) { fill(ai, TA[i].i, bi, TB[j].i); ai = TA[i].i + TA[i].s.length; bi = TB[j].i + TB[j].s.length; }
    fill(ai, A.length, bi, B.length);
    return out;
  }

  function buildBlocks(an) {
    // vertical and horizontal rules split text into cells
    const vr = [], hr = [], dots = [];
    for (const s of (an.shapes || [])) {
      const b = s.bbox;
      if (s.fill && b.w > 0.8 && b.h > 0.8 && b.w < 6 && b.h < 6 && Math.abs(b.w - b.h) < 1.5) { dots.push({ x: b.x + b.w / 2, y: b.y + b.h / 2 }); continue; }
      if (s.kind === 'line' || (s.kind === 'rect' && s.fill && (b.w < 4.2 || b.h < 4.2))) {
        if (b.w < 4.2 && b.h > 3) vr.push({ x: b.x + b.w / 2, y0: b.y, y1: b.y + b.h });
        else if (b.h < 4.2 && b.w > 3) hr.push({ y: b.y + b.h / 2, x0: b.x, x1: b.x + b.w });
      } else if (s.kind === 'rect' && s.stroke) {
        vr.push({ x: b.x, y0: b.y, y1: b.y + b.h }, { x: b.x + b.w, y0: b.y, y1: b.y + b.h });
        hr.push({ y: b.y, x0: b.x, x1: b.x + b.w }, { y: b.y + b.h, x0: b.x, x1: b.x + b.w });
      }
    }
    const groups = new Map();
    an.runs.forEach((r, ri) => {
      if (r.Tr === 3 || r.Tr === 7) return;
      r.glyphs.forEach((g, gi) => {
        if (!g.ch) return;
        const dx = g.p1[0] - g.p0[0], dy = g.p1[1] - g.p0[1];
        const ang = Math.abs(dx) + Math.abs(dy) > 1e-4 ? Math.atan2(dy, dx) : r.dir;
        const key = Math.round(ang * 180 / Math.PI);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ ri, gi, g, r });
      });
    });
    const blocks = [];
    for (const [deg, items] of groups) {
      const th = deg * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
      const U = (x, y) => x * c + y * s, V = (x, y) => -x * s + y * c;
      const gl = items.map(it => ({ ...it, u0: U(it.g.p0[0], it.g.p0[1]), u1: U(it.g.p1[0], it.g.p1[1]), v: V(it.g.p0[0], it.g.p0[1]), size: it.r.size || 10, ch: it.g.ch }));
      const vrl = deg === 0 ? vr.map(r => ({ u: r.x, v0: r.y0, v1: r.y1 })) : [];
      const hrl = deg === 0 ? hr.map(r => ({ v: r.y, u0: r.x0, u1: r.x1 })) : [];
      gl.sort((a, b) => b.v - a.v || a.u0 - b.u0);
      const lines = [];
      for (const x of gl) {
        let L = null;
        for (let k = lines.length - 1; k >= 0 && k >= lines.length - 8; k--) if (Math.abs(lines[k].v - x.v) <= 0.3 * Math.max(lines[k].size, x.size)) { L = lines[k]; break; }
        if (L) { L.items.push(x); L.size = Math.max(L.size, x.size); } else lines.push({ v: x.v, size: x.size, items: [x] });
      }
      // segments: split at wide gaps and at table rules
      const segs = [];
      for (const L of lines) {
        L.items.sort((a, b) => a.u0 - b.u0);
        const size = L.size;
        let seg = null, prev = null;
        for (const x of L.items) {
          const dup = prev && prev.ch === x.ch && Math.abs(prev.u0 - x.u0) < 0.35 && Math.abs(prev.v - x.v) < 0.5;
          if (dup) { seg.dups.push([x.ri, x.gi]); continue; }
          const gap = prev ? x.u0 - prev.u1 : 0;
          const ruleBetween = prev && vrl.some(r => r.u > prev.u1 - 0.5 && r.u < x.u0 + 0.5 && r.v0 <= L.v + size * 0.2 && r.v1 >= L.v);
          if (!seg || (x.ch.trim() && (gap > Math.max(1.5 * size, 9) || ruleBetween))) {
            seg = { v: L.v, size, units: [], dups: [], u0: x.u0, u1: x.u1 };
            segs.push(seg); prev = null;
          }
          if (!seg.units.length && !x.ch.trim()) { seg.dups.push([x.ri, x.gi]); continue; }
          if (prev && gap > (isCJKch(prev.ch) || isCJKch(x.ch) ? 0.3 : 0.17) * size && prev.ch.trim() && x.ch.trim()) seg.units.push({ ch: ' ', virtual: true, u0: prev.u1, u1: x.u0 });
          seg.units.push({ ch: x.ch, ref: [x.ri, x.gi], u0: x.u0, u1: x.u1, ri: x.ri });
          seg.u1 = Math.max(seg.u1, x.u1);
          prev = x;
        }
      }
      for (const sg of segs) {
        while (sg.units.length && !sg.units[sg.units.length - 1].ch.trim()) { const u = sg.units.pop(); if (u.ref) sg.dups.push(u.ref); }
        if (sg.units.length) sg.u1 = sg.units[sg.units.length - 1].u1;
        sg.text = sg.units.map(u => u.ch).join('');
        sg.first = sg.units.length ? sg.units[0].ch : '';
      }
      // paragraphs: stack segments that continue each other
      const live = segs.filter(sg => sg.units.length).sort((a, b) => b.v - a.v || a.u0 - b.u0);
      const paras = [];
      const startsItem = (sg) => {
        if (deg === 0 && dots.some(d => d.x < sg.u0 && d.x > sg.u0 - 2.5 * sg.size && d.y > sg.v && d.y < sg.v + sg.size * 0.8)) return true;
        const t = sg.text.trim(); const w0 = t.split(/\s+/)[0]; return BULLET_RE.test(w0) || /^[•◦▪]/.test(t); };
      for (const sg of live) {
        let best = null;
        for (const P of paras) {
          const last = P.segs[P.segs.length - 1];
          const gap = last.v - sg.v;
          if (gap <= 0.2 * sg.size || gap > 1.45 * Math.max(sg.size, last.size)) continue;
          if (Math.abs(sg.size - last.size) > 0.8) continue;
          if (P.segs.length >= 2 && Math.abs(gap - P.gap) > 0.3 * sg.size) continue;
          const leftOk = Math.abs(sg.u0 - (P.segs.length >= 2 ? P.segs[1].u0 : last.u0)) < 3 || (P.segs.length === 1 && sg.u0 < last.u0 - 3 && last.u0 - sg.u0 < 4 * sg.size) || (P.item && Math.abs(sg.u0 - P.textU) < 3);
          const centered = Math.abs((last.u0 + last.u1) / 2 - (sg.u0 + sg.u1) / 2) < 3;
          if (!leftOk && !centered) continue;
          if (startsItem(sg)) continue;
          // the previous line must run on: not much shorter than this one, and not ending a sentence early
          const longest = Math.max(...P.segs.map(x => x.u1), sg.u1);
          const prevFull = last.u1 >= longest - Math.max(2.5 * sg.size, 0.12 * (longest - last.u0));
          if (!prevFull && !centered) continue;
          if (hrl.some(h => h.v < last.v - 0.2 * last.size && h.v > sg.v + sg.size * 0.8 && h.u0 < sg.u1 && h.u1 > sg.u0)) continue;
          if (overlapU(last, sg) <= 0) continue;
          best = P; break;
        }
        if (best) { if (best.segs.length === 1) best.gap = best.segs[0].v - sg.v; best.segs.push(sg); }
        else {
          const P = { segs: [sg], item: startsItem(sg) };
          if (P.item) { const k = sg.units.findIndex((u, i) => i > 0 && u.ch === ' '); P.textU = k > 0 && sg.units[k + 1] ? sg.units[k + 1].u0 : sg.u0; }
          paras.push(P);
        }
      }
      for (const P of paras) {
        const units = [];
        P.segs.forEach((sg, k) => {
          if (k > 0) { const last = units[units.length - 1]; if (!(last && last.ch === '-')) units.push({ ch: ' ', virtual: true, join: true }); }
          sg.units.forEach(u => units.push({ ...u, line: k }));
        });
        const refs = [];
        P.segs.forEach(sg => { sg.units.forEach(u => { if (u.ref) refs.push(u.ref); }); sg.dups.forEach(r => refs.push(r)); });
        const u0 = Math.min(...P.segs.map(x => x.u0)), u1 = Math.max(...P.segs.map(x => x.u1));
        const vTop = P.segs[0].v + P.segs[0].size * 0.88, vBot = P.segs[P.segs.length - 1].v - P.segs[P.segs.length - 1].size * 0.24;
        const X = (u, v) => [u * c - v * s, u * s + v * c];
        const corners = [X(u0, vBot), X(u1, vBot), X(u1, vTop), X(u0, vTop)];
        const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
        const justified = P.segs.length > 2 && P.segs.slice(0, -1).every(sg => Math.abs(sg.u1 - u1) < 1.2) && P.segs.slice(1).every(sg => Math.abs(sg.u0 - u0) < 1.2) && P.segs[P.segs.length - 1].u1 < u1 - 2;
        const centeredAll = P.segs.length > 1 && P.segs.every(sg => Math.abs((sg.u0 + sg.u1) / 2 - (u0 + u1) / 2) < 3) && P.segs.some(sg => sg.u0 - u0 > 6);
        blocks.push({
          index: blocks.length, angle: th, dir: [c, s], units, refs, lines: P.segs.map(sg => ({ v: sg.v, u0: sg.u0, u1: sg.u1, size: sg.size, text: sg.text })),
          text: units.map(u => u.ch).join(''), u0, u1, vTop, vBot, size: P.segs[0].size, gap: P.gap || P.segs[0].size * 1.2,
          align: centeredAll ? 'center' : justified ? 'justify' : 'left', corners, bbox: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
        });
      }
    }
    // reading order: top to bottom, then left to right
    blocks.sort((a, b) => (b.bbox.y + b.bbox.h) - (a.bbox.y + a.bbox.h) || a.bbox.x - b.bbox.x);
    blocks.forEach((b, i) => { b.index = i; });
    return blocks;
    function overlapU(a, b) { return Math.min(a.u1, b.u1) - Math.max(a.u0, b.u0) + 3; }
  }

  /*
   * Graphics that belong together: lines and thin bars that touch form a group (a table grid,
   * a chart's axes); fills inside a grid (header shading) join it. Huge fills (page backgrounds)
   * stay on their own and are not offered for selection.
   */
  // the pieces of a graphic that can touch something: a fill's area, a line, each edge of an outline
  function partsOf(g) {
    const out = [], pad = g.stroke ? Math.max(g.lw || 0, 0.5) / 2 : 0;
    const box = (x0, y0, x1, y1) => out.push({ x: Math.min(x0, x1) - pad, y: Math.min(y0, y1) - pad, w: Math.abs(x1 - x0) + 2 * pad, h: Math.abs(y1 - y0) + 2 * pad });
    for (const sh of g.shapes) {
      const b = sh.bbox, P = sh.pts;
      if (g.fill && Math.min(b.w, b.h) > 4.2) { box(b.x, b.y, b.x + b.w, b.y + b.h); out[out.length - 1].area = true; continue; }
      if (Math.min(b.w, b.h) <= 4.2 || P.length <= 2) { box(b.x, b.y, b.x + b.w, b.y + b.h); continue; }
      for (let k = 0; k + 1 < P.length; k++) box(P[k][0], P[k][1], P[k + 1][0], P[k + 1][1]);
      if (sh.pts.closed || sh.pts.rect) box(P[P.length - 1][0], P[P.length - 1][1], P[0][0], P[0][1]);
    }
    return out.length > 600 ? [g.bbox] : out;
  }
  // pieces touch when they meet; a piece lying wholly inside a filled area (a table on a panel) does not count
  function partsTouch(A, B, t) {
    const within = (a, b) => a.x >= b.x + 1 && a.y >= b.y + 1 && a.x + a.w <= b.x + b.w - 1 && a.y + a.h <= b.y + b.h - 1;
    for (const a of A) for (const b of B) {
      if (!(a.x - t <= b.x + b.w && b.x - t <= a.x + a.w && a.y - t <= b.y + b.h && b.y - t <= a.y + a.h)) continue;
      if ((b.area && within(a, b)) || (a.area && within(b, a))) continue;
      return true;
    }
    return false;
  }
  function groupGraphics(an, pageArea) {
    const G = an.graphics || [];
    const area = pageArea || 612 * 792;
    const thin = (g) => Math.min(g.bbox.w, g.bbox.h) <= 4.2;
    // only a single filled shape covering most of the page counts as a page background;
    // a big table's grid or all its row shading drawn as one path is still part of the table
    const info = G.map(g => ({ g, huge: !g.stroke && g.shapes.length === 1 && g.bbox.w * g.bbox.h > area * 0.5, link: !!g.stroke || thin(g), parts: partsOf(g) }));
    const parent = G.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const T = 1.2;
    const touch = (a, b) => a.x - T <= b.x + b.w && b.x - T <= a.x + a.w && a.y - T <= b.y + b.h && b.y - T <= a.y + a.h;
    // lines link when they touch; a fill (cell shading) links to what it shares an edge with,
    // but never to things it merely sits behind (a panel behind a table stays separate)
    const inside = (a, b) => a.x >= b.x + 1 && a.y >= b.y + 1 && a.x + a.w <= b.x + b.w - 1 && a.y + a.h <= b.y + b.h - 1;
    const L = info.map((x, i) => i).filter(i => !info[i].huge);
    L.sort((a, b) => G[a].bbox.x - G[b].bbox.x);
    for (let a = 0; a < L.length; a++) {
      const A = G[L[a]].bbox, la = info[L[a]].link;
      for (let b = a + 1; b < L.length; b++) {
        const B = G[L[b]].bbox, lb = info[L[b]].link;
        if (B.x - T > A.x + A.w) break;
        if (!touch(A, B)) continue;
        // compare the actual pieces (each line of a grid drawn as one path, each box's edges)
        if (!partsTouch(info[L[a]].parts, info[L[b]].parts, !la && !lb ? 0.6 : T)) continue;
        const ra = find(L[a]), rb = find(L[b]); if (ra !== rb) parent[ra] = rb;
      }
    }
    // table rows: horizontal rules and row bands spanning the same width, stacked close together
    const rowish = L.filter(i => { const b = G[i].bbox; return b.w > 24 && ((info[i].link && b.h <= 4.2) || (!info[i].link && b.h < 60)); });
    rowish.sort((a, b) => G[a].bbox.x - G[b].bbox.x || G[a].bbox.y - G[b].bbox.y);
    for (let a = 0; a < rowish.length; a++) {
      const A = G[rowish[a]].bbox;
      for (let b = a + 1; b < rowish.length; b++) {
        const B = G[rowish[b]].bbox;
        if (B.x - A.x > 1.5) break;
        if (Math.abs(B.x + B.w - A.x - A.w) > 1.5) continue;
        const gap = Math.max(B.y - (A.y + A.h), A.y - (B.y + B.h));
        if (gap > 36) continue;
        const ra = find(rowish[a]), rb = find(rowish[b]); if (ra !== rb) parent[ra] = rb;
      }
    }
    const comps = new Map();
    L.forEach(i => { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(i); });
    // pieces drawn inside a bigger group's frame (a chart's data line inside its axes) join it
    const comp = [...comps.values()].map(m => ({ m, bb: unionBox(m.map(i => G[i].bbox)) })).sort((a, b) => b.bb.w * b.bb.h - a.bb.w * a.bb.h);
    for (let a = 0; a < comp.length; a++) {
      const A = comp[a]; if (!A.m.length || A.m.length < 3) continue;
      for (let b = a + 1; b < comp.length; b++) {
        const B = comp[b]; if (!B.m.length) continue;
        if (B.bb.x >= A.bb.x - 1 && B.bb.y >= A.bb.y - 1 && B.bb.x + B.bb.w <= A.bb.x + A.bb.w + 1 && B.bb.y + B.bb.h <= A.bb.y + A.bb.h + 1) { A.m.push(...B.m); B.m = []; }
      }
    }
    const groups = [];
    const groupOf = G.map(() => -1);
    for (const { m: members } of comp) {
      if (members.length < 2) continue;
      const bb = unionBox(members.map(i => G[i].bbox));
      const hs = members.filter(i => { const b = G[i].bbox; return b.h <= 4.2 && b.w > 6; }).length + members.filter(i => G[i].kind === 'rect' && G[i].stroke && !thin(G[i])).length;
      const vs = members.filter(i => { const b = G[i].bbox; return b.w <= 4.2 && b.h > 6; }).length + members.filter(i => G[i].kind === 'rect' && G[i].stroke && !thin(G[i])).length;
      const axisShape = (sh) => !sh.curved && (sh.kind === 'rect' || (sh.kind === 'line' && Math.min(sh.bbox.w, sh.bbox.h) <= 4.2));
      const straight = members.every(i => G[i].shapes.every(axisShape));
      const shapesOf = members.flatMap(i => G[i].shapes.length > 1 ? G[i].shapes : []);
      const hs2 = shapesOf.filter(sh => sh.bbox.h <= 4.2 && sh.bbox.w > 6).length, vs2 = shapesOf.filter(sh => sh.bbox.w <= 4.2 && sh.bbox.h > 6).length;
      const fills = members.filter(i => !info[i].link).length;
      if (!members.some(i => info[i].link) && fills < 2) continue;
      groups.push({ index: groups.length, members: members.slice(), bbox: bb, table: straight && ((hs + hs2 >= 2 && vs + vs2 >= 2) || (fills >= 2 && hs + vs + hs2 + vs2 >= 1)) });
    }
    // fills sitting inside a group join it (cell shading, chart markers)
    info.forEach((x, i) => {
      if (x.link || x.huge || groups.some(gr => gr.members.includes(i))) return;
      const b = G[i].bbox;
      const host = groups.find(gr => gr.members.length >= 3 && b.x >= gr.bbox.x - 1 && b.y >= gr.bbox.y - 1 && b.x + b.w <= gr.bbox.x + gr.bbox.w + 1 && b.y + b.h <= gr.bbox.y + gr.bbox.h + 1);
      if (host) host.members.push(i);
    });
    info.forEach((x, i) => {
      if (!x.huge || groups.some(gr => gr.members.includes(i))) return;
      const b = G[i].bbox;
      const host = groups.find(gr => Math.abs(b.x - gr.bbox.x) < 4 && Math.abs(b.y - gr.bbox.y) < 4 && Math.abs(b.x + b.w - gr.bbox.x - gr.bbox.w) < 4 && Math.abs(b.y + b.h - gr.bbox.y - gr.bbox.h) < 4);
      if (host) { host.members.push(i); x.huge = false; }
    });
    groups.forEach(gr => { gr.members.sort((a, b) => a - b); gr.members.forEach(i => { groupOf[i] = gr.index; }); });
    return { groups, groupOf, huge: info.map(x => x.huge) };
  }
  // a short fingerprint so an edit is never applied to a different path
  function graphicSig(g) { return g.op + ':' + [g.bbox.x, g.bbox.y, g.bbox.w, g.bbox.h].map(v => Math.round(v * 10)).join(','); }
  function unionBox(bs) {
    const x0 = Math.min(...bs.map(b => b.x)), y0 = Math.min(...bs.map(b => b.y));
    const x1 = Math.max(...bs.map(b => b.x + b.w)), y1 = Math.max(...bs.map(b => b.y + b.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  /* rewrite one painted path: delete it, move it, recolor it, change its width or a line's ends */
  function graphicReplacement(an, g, ed) {
    const S = an.streams[g.si];
    if (ed.del) return '';
    const C = g.ctm, Ci = inv(C);
    let pre = 'q ';
    if (ed.move && Ci && (Math.abs(ed.move.dx) > 1e-4 || Math.abs(ed.move.dy) > 1e-4)) pre += mul(mul(C, [1, 0, 0, 1, ed.move.dx, ed.move.dy]), Ci).map(num).join(' ') + ' cm ';
    if (ed.stroke && g.stroke) pre += ed.stroke.map(num).join(' ') + ' RG ';
    if (ed.fill && g.fill) pre += ed.fill.map(num).join(' ') + ' rg ';
    if (ed.lw != null && g.stroke) pre += num(Math.max(0, ed.lw) / (Math.hypot(C[0], C[1]) || 1)) + ' w ';
    let body;
    if (ed.line && g.kind === 'line' && Ci) {
      const a = apply(Ci, ed.line[0][0], ed.line[0][1]), b = apply(Ci, ed.line[1][0], ed.line[1][1]);
      body = num(a[0]) + ' ' + num(a[1]) + ' m ' + num(b[0]) + ' ' + num(b[1]) + ' l ' + S.src.slice(S.ops[g.op1].s, S.ops[g.op1].e);
    } else body = S.src.slice(S.ops[g.op0].s, S.ops[g.op1].e);
    return pre + body + ' Q';
  }

  /* draw glyphs with the document's own fonts at exact positions */
  function glyphItemOps(L, doc, page, item, fontNames) {
    const f = item.run.font;
    if (!f.ref) { f.ref = doc.context.register(f.dict); }
    const key = f.ref.toString();
    if (!fontNames.has(key)) fontNames.set(key, page.node.newFontDictionary('FolioF', f.ref).decodeText());
    const r = item.run, scale = r.Tfs * r.Th;
    const parts = [];
    let cur = '', pos = 0;
    item.glyphs.forEach((g, k) => {
      if (k > 0) {
        const kern = scale ? -((g.x - pos)) * 1000 / scale : 0;
        if (Math.abs(kern) > 0.01) { if (cur) { parts.push(hexOf(cur)); cur = ''; } parts.push(num(kern)); }
      }
      cur += g.bytes;
      pos = g.x + (f.width(g.code) * f.widthScale * r.Tfs) * r.Th;
    });
    if (cur) parts.push(hexOf(cur));
    const col = (item.color || r.fill || [0, 0, 0]).map(num).join(' ');
    let ops = 'BT /' + fontNames.get(key) + ' ' + num(r.Tfs) + ' Tf ';
    if (r.Th !== 1) ops += num(r.Th * 100) + ' Tz ';
    if (r.Ts) ops += num(r.Ts) + ' Ts ';
    if (r.Tr === 1 || r.Tr === 2) ops += r.Tr + ' Tr ' + col + ' RG ';
    ops += col + ' rg ' + item.M.map(num).join(' ') + ' Tm [' + parts.join(' ') + '] TJ ET\n';
    return ops;
  }

  /*
   * Plan an edit of a text block.
   * edit: { newText, style?, move?: {dx, dy} }
   * Returns a plan for rewriteContent plus drawing work:
   *   { removed, desired, insert, draw (drawn text, single), draws:[...], glyphItems:[...] }
   */
  function planBlockEdit(an, block, edit, opts) {
    opts = opts || {};
    const newText = edit.newText == null ? block.text : edit.newText;
    const move = edit.move && (Math.abs(edit.move.dx) > 0.01 || Math.abs(edit.move.dy) > 0.01) ? edit.move : null;
    const empty = { removed: [], desired: new Map(), draw: null, draws: [], glyphItems: [], mode: 'none' };
    const width0 = edit.width != null && Math.abs(edit.width - (block.u1 - block.u0)) > 0.5 ? Math.max(block.size, edit.width) : null;
    if (newText === block.text && !move && !edit.style && width0 == null) return empty;
    const c = block.dir[0], s = block.dir[1];
    const X = (u, v) => [u * c - v * s, u * s + v * c];
    // 1) small change inside one line, nothing moved: edit that line in place
    if (!move && !edit.style && width0 == null && newText.indexOf('\n') < 0) {
      const U = block.units, n = U.length;
      let p = 0; while (p < n && p < newText.length && newText[p] === U[p].ch) p++;
      let q = 0; while (q < n - p && q < newText.length - p && newText[newText.length - 1 - q] === U[n - 1 - q].ch) q++;
      const changed = U.slice(Math.max(0, p - 1), n - q + 1).filter(u => u.line != null);
      const linesTouched = new Set(changed.map(u => u.line));
      const joinTouched = U.slice(p, n - q).some(u => u.join);
      if (linesTouched.size <= 1 && !joinTouched) {
        const li = linesTouched.size ? [...linesTouched][0] : (U[p] && U[p].line != null ? U[p].line : block.lines.length - 1);
        const line = block.lines[li];
        const start = U.findIndex(u => u.line === li), end = U.length - 1 - [...U].reverse().findIndex(u => u.line === li);
        const newLine = newText.slice(start, newText.length - (n - 1 - end));
        const grow = opts.measure ? opts.measure(newLine, opts.styleOf(block, li)) - (line.u1 - line.u0) : 0;
        // stays in place when it still fits the paragraph's width (a lone line may grow freely)
        if (block.lines.length === 1 || line.u1 + grow <= block.u1 + block.size * 0.6) {
          const box = { origin: X(line.u0, line.v), dir: [c, s], width: line.u1 - line.u0, height: line.size };
          const plan = planTextEdit(an, box, newLine, { originalText: line.text, measure: opts.measure, noReuse: edit.noReuse });
          if (plan.mode !== 'whole' && plan.mode !== 'cover') { plan.draws = plan.draw ? [plan.draw] : []; plan.draw = null; plan.glyphItems = []; return plan; }
        }
      }
    }
    // 2) moved, restyled or rewrapped: take the block out and set it again
    const plan = { removed: block.refs.slice(), desired: new Map(), draw: null, draws: [], glyphItems: [], mode: move && newText === block.text && !edit.style && width0 == null ? 'move' : 'reflow' };
    const dx = move ? move.dx : 0, dy = move ? move.dy : 0;
    if (plan.mode === 'move') {
      // exact copy of every glyph, offset
      const byRun = new Map();
      for (const [ri, gi] of block.refs) { if (!byRun.has(ri)) byRun.set(ri, []); byRun.get(ri).push(gi); }
      for (const [ri, gis] of byRun) {
        const r = an.runs[ri]; gis.sort((a, b) => a - b);
        // consecutive glyphs share one TJ; offsets are measured along the baseline in text space
        let group = [];
        const flush = () => {
          if (!group.length) return;
          const g0 = r.glyphs[group[0]];
          const M = mul(g0.tm, r.ctm); M[4] += dx; M[5] += dy;
          const sx = Math.hypot(M[0], M[1]) || 1, ux = M[0] / sx, uy = M[1] / sx;
          plan.glyphItems.push({ run: r, M, glyphs: group.map(gi => { const g = r.glyphs[gi]; return { bytes: g.bytes, code: g.code, x: ((g.p0[0] - g0.p0[0]) * ux + (g.p0[1] - g0.p0[1]) * uy) / sx }; }) });
          group = [];
        };
        gis.forEach((gi, k) => { if (k && gi !== gis[k - 1] + 1) flush(); group.push(gi); });
        flush();
      }
      return plan;
    }
    // reflow: carry each character's style across the edit (characters matched by a diff)
    const U = block.units, n = U.length;
    const runOf = (k) => { for (let i = k; i >= 0; i--) if (U[i] && U[i].ri != null) return U[i].ri; for (let i = k; i < n; i++) if (U[i] && U[i].ri != null) return U[i].ri; return null; };
    const src = U.map(u => u.ch).join('');
    const match = charMatch(src, newText);
    const chars = [];
    let lastSrc = -1;
    for (let j = 0; j < newText.length; j++) {
      const i = match[j];
      if (i >= 0) { lastSrc = i; chars.push({ ch: newText[j], ri: runOf(i) }); }
      else {
        // typed text takes the style of the text it follows (or, at the start, the text after it)
        let ri = lastSrc >= 0 ? runOf(lastSrc) : null;
        if (ri == null) { for (let k = j + 1; k < newText.length; k++) if (match[k] >= 0) { ri = runOf(match[k]); break; } }
        if (ri == null) ri = runOf(0);
        chars.push({ ch: newText[j], ri });
      }
    }
    const st = edit.style || null;
    const widthOf = (ch, ri) => {
      const r = ri != null ? an.runs[ri] : null;
      if (!st && r && r.font && r.font.encodeMap) {
        const m = r.font.encodeMap(); const code = m && m.get(ch);
        if (code != null && (ch === ' ' || r.font.width(code) > 0)) return { own: true, code, w: r.font.width(code) * r.font.widthScale * r.Tfs * r.Th * r.sx };
        if (ch === ' ' && m) return { own: true, space: true, w: 0.28 * r.Tfs * r.Th * r.sx };
      }
      const sty = Object.assign(styleFromRun(r, block.size), st || {});
      return { own: false, w: opts.measure ? opts.measure(ch, sty) : sty.size * 0.55, sty };
    };
    const measured = chars.map(x => ({ ...x, ...widthOf(x.ch, x.ri) }));
    // wrap at word boundaries within the block's width
    const width = width0 != null ? width0 : Math.max(block.u1 - block.u0, opts.minWidth || 0);
    const firstIndent = block.lines[0].u0 - block.u0;
    const outLines = [];
    let line = [], lw = 0;
    const avail = () => width - (outLines.length === 0 ? firstIndent : 0);
    let i = 0;
    while (i < measured.length) {
      const m = measured[i];
      if (m.ch === '\n') { line.hard = true; outLines.push(line); line = []; lw = 0; i++; continue; }
      // a word with its following space
      let j = i; while (j < measured.length && measured[j].ch !== ' ' && measured[j].ch !== '\n') j++;
      let k = j; while (k < measured.length && measured[k].ch === ' ') k++;
      const word = measured.slice(i, j), spaces = measured.slice(j, k);
      const ww = word.reduce((a, b) => a + b.w, 0);
      if (line.length && lw + ww > avail() + 0.5) { while (line.length && line[line.length - 1].ch === ' ') line.pop(); outLines.push(line); line = []; lw = 0; }
      if (!line.length && ww > avail() + 0.5) {
        // a word longer than the line: break it
        for (const w of word) { if (line.length && lw + w.w > avail() + 0.5) { outLines.push(line); line = []; lw = 0; } line.push(w); lw += w.w; }
      } else { word.forEach(w => line.push(w)); lw += ww; }
      spaces.forEach(sp => { line.push(sp); lw += sp.w; });
      i = k;
    }
    while (line.length && line[line.length - 1].ch === ' ') line.pop();
    outLines.push(line);
    const gap = block.lines.length > 1 ? block.gap : block.size * 1.2;
    outLines.forEach((ln, li) => {
      let total = ln.reduce((a, b) => a + b.w, 0);
      if (block.align === 'justify' && li < outLines.length - 1 && !ln.hard) {
        const spaces = ln.filter(x => x.ch === ' ');
        const extra = (width - (li === 0 ? firstIndent : 0)) - total;
        if (spaces.length && extra > 0 && extra < width * 0.35) { ln.forEach((x, k) => { if (x.ch === ' ') ln[k] = { ...x, w: x.w + extra / spaces.length, space: true, own: x.own }; }); total += extra; }
      }
      let u = block.u0 + (li === 0 ? firstIndent : 0);
      if (block.align === 'center') u = block.u0 + width / 2 - total / 2;
      const v = block.lines[0].v - li * gap;
      // consecutive characters drawn the same way form one piece
      let k = 0;
      while (k < ln.length) {
        const a = ln[k];
        let e = k + 1;
        while (e < ln.length && ln[e].own === a.own && ln[e].ri === a.ri && !ln[e].space === !a.space && !(a.space || ln[e].space)) e++;
        const piece = ln.slice(k, e);
        const [x, y] = X(u, v);
        if (a.own && !a.space) {
          const r = an.runs[a.ri];
          const g0 = r.glyphs[0];
          const A = mul(g0.tm, r.ctm);
          const M = [A[0], A[1], A[2], A[3], x + dx, y + dy];
          const sx = Math.hypot(M[0], M[1]) || 1;
          let off = 0;
          const glyphs = piece.map(pc => { const bytes = r.font.twoByte ? String.fromCharCode((pc.code >> 8) & 255, pc.code & 255) : String.fromCharCode(pc.code & 255); const g = { bytes, code: pc.code, x: off / sx }; off += pc.w; return g; });
          plan.glyphItems.push({ run: r, M, glyphs });
        } else if (!a.own && !a.space) {
          const sty = a.sty;
          plan.draws.push(Object.assign({ text: piece.map(pc => pc.ch).join(''), x: x + dx, y: y + dy, angle: block.angle }, sty));
        }
        u += piece.reduce((s2, pc) => s2 + pc.w, 0);
        k = e;
      }
    });
    plan.lines = outLines.length;
    return plan;
  }

  /* ---------- applying one page's edits ---------- */
  async function applyPageEdits(L, doc, page, pi, pe, ctx) {
    const { fc, uni, font, embedImg, report } = ctx;
    const an = analyzePage(L, doc, pi, fc, { paths: (pe.blocks || []).length > 0 || (pe.graphics || []).length > 0 });
    // images: embed replacements and name them in the stream that draws them
    const imgEdits = [], extraX = new Map(), taken = new Set();
    for (const ie of (pe.images || [])) {
      const e = { id: ie.id, action: ie.action, rect: ie.rect, stretch: ie.stretch };
      if (ie.action === 'replace' && ie.file) {
        const img = an.images.find(x => x.id === ie.id);
        if (!img) continue;
        const emb = await embedImg(ie.file);
        e.newName = uniqueName(L, an.streams[img.si].res, 'ImgEd', taken);
        e.imgW = emb.width; e.imgH = emb.height;
        if (!extraX.has(img.si)) extraX.set(img.si, {});
        extraX.get(img.si)[e.newName] = emb.ref;
      }
      imgEdits.push(e);
    }
    // text: prepare unicode text first so its width is known when planning
    const texts = pe.text || [];
    const preps = new Map();
    const measure = (t, st) => {
      if (!uni.needed(t)) return measureStd(L, t, st);
      const p = preps.get(t + '|' + !!st.bold);
      return p ? uni.widthOf(p, st.size) : t.length * st.size * 0.6;
    };
    const plans = [];
    for (const t of texts) {
      let plan = planTextEdit(an, t.box, t.newText || '', { originalText: t.originalText, style: t.style, whole: t.whole, measure, noReuse: t.noReuse });
      if (plan.draw && uni.needed(plan.draw.text) && !preps.has(plan.draw.text + '|' + !!plan.draw.bold)) {
        preps.set(plan.draw.text + '|' + !!plan.draw.bold, await uni.prepare(plan.draw.text, !!plan.draw.bold));
        plan = planTextEdit(an, t.box, t.newText || '', { originalText: t.originalText, style: t.style, whole: t.whole, measure, noReuse: t.noReuse });
      }
      plans.push(plan);
    }
    // text blocks (paragraphs): edit in place, rewrap or move
    const blockPlans = [];
    if ((pe.blocks || []).length) {
      const blocks = buildBlocks(an);
      const styleOf = (b, li) => styleFromRun(an.runs[(b.units.find(u => u.line === li && u.ri != null) || b.units.find(u => u.ri != null) || {}).ri], b.size);
      for (const be of pe.blocks) {
        const b = blocks[be.index];
        if (!b || (be.originalText != null && be.originalText !== b.text)) { report.stale = (report.stale || 0) + 1; continue; }
        let bp = planBlockEdit(an, b, be, { measure, styleOf });
        const needs = (bp.draws || []).filter(d => uni.needed(d.text) && !preps.has(d.text + '|' + !!d.bold));
        for (const d of needs) preps.set(d.text + '|' + !!d.bold, await uni.prepare(d.text, !!d.bold));
        if (needs.length) bp = planBlockEdit(an, b, be, { measure, styleOf });
        blockPlans.push(bp);
        report.blocks = (report.blocks || 0) + 1;
      }
    }
    const gEdits = (pe.graphics || []).filter(ge => { const g = an.graphics[ge.index]; if (!g || (ge.sig && ge.sig !== graphicSig(g))) { report.stale = (report.stale || 0) + 1; return false; } return true; });
    report.graphics = (report.graphics || 0) + gEdits.length;
    const rw = rewriteContent(an, { text: plans.concat(blockPlans), images: imgEdits, graphics: gEdits });
    materialize(L, doc, page, an, rw.repl, extraX);
    report.pages[pi] = { removedGlyphs: rw.removedGlyphs, modes: plans.map(p => p.mode), blockModes: blockPlans.map(p => p.mode) };
    blockPlans.forEach(p => { if (p.mode === 'reuse') report.reused++; });
    let extra = '';
    plans.forEach((plan, i) => {
      if (plan.mode === 'whole') report.wholeLine++;
      if (plan.mode === 'reuse') report.reused++;
      if (plan.mode !== 'cover') return;
      const b = texts[i].box;
      report.coveredOnly++;
      const nx = -b.dir[1], ny = b.dir[0];
      page.drawRectangle({
        x: b.origin[0] - nx * b.height * 0.25, y: b.origin[1] - ny * b.height * 0.25,
        width: b.width, height: b.height * 1.15, color: L.rgb(1, 1, 1),
        rotate: L.radians(Math.atan2(b.dir[1], b.dir[0]))
      });
    });
    const draw = async (d) => {
      if (!d || !d.text) return;
      if (uni.needed(d.text)) {
        const key = d.text + '|' + !!d.bold;
        const prep = preps.get(key) || await uni.prepare(d.text, !!d.bold);
        prep.missing.forEach(ch => report.missingChars.add(ch));
        extra += uni.ops(page, prep, d);
        report.unicode++;
        return;
      }
      const f = await font(stdName(L, d.family, d.bold, d.italic));
      page.drawText(d.text, { x: d.x, y: d.y, size: d.size, font: f, color: L.rgb(d.color[0], d.color[1], d.color[2]), rotate: L.radians(d.angle || 0) });
    };
    for (const plan of plans) await draw(plan.draw);
    const fontNames = new Map();
    for (const bp of blockPlans) {
      for (const d of (bp.draws || [])) await draw(d);
      for (const it of (bp.glyphItems || [])) extra += glyphItemOps(L, doc, page, it, fontNames);
    }
    for (const t of (pe.addText || [])) {
      if (!t.text) continue;
      const a = t.angle || 0;
      const lines = t.text.split('\n');
      for (let k = 0; k < lines.length; k++) {
        await draw({ text: lines[k], x: t.x + Math.sin(a) * k * t.size * 1.2, y: t.y - Math.cos(a) * k * t.size * 1.2, size: t.size, family: t.family, bold: t.bold, italic: t.italic, color: t.color, angle: a });
      }
    }
    for (const ai of (pe.addImages || [])) {
      const emb = await embedImg(ai.file);
      page.drawImage(emb, { x: ai.rect.x, y: ai.rect.y, width: ai.rect.w, height: ai.rect.h });
    }
    if (extra) page.node.addContentStream(doc.context.register(doc.context.flateStream(extra)));
  }

  function newContext(L, doc, opts) {
    const fontObjs = {};
    return {
      fc: makeFontCache(L, doc),
      uni: makeUniDrawer(L, doc, (opts && opts.loadFont) || (async () => null)),
      font: async (name) => (fontObjs[name] = fontObjs[name] || await doc.embedFont(name)),
      embedImg: async (file) => file.type === 'png' ? doc.embedPng(file.bytes) : doc.embedJpg(file.bytes),
      report: { pages: {}, coveredOnly: 0, wholeLine: 0, reused: 0, unicode: 0, missingChars: new Set() }
    };
  }
  const hasEdits = (pe) => pe && ((pe.text || []).length || (pe.blocks || []).length || (pe.graphics || []).length || (pe.images || []).length || (pe.addText || []).length || (pe.addImages || []).length);

  /* Edits on one document, pages unchanged. pages: { [pageIndex]: pageEdits } */
  async function exportPdf(L, srcBytes, pages, opts) {
    const doc = await L.PDFDocument.load(srcBytes, { updateMetadata: false });
    const ctx = newContext(L, doc, opts);
    const all = doc.getPages();
    for (const key of Object.keys(pages)) {
      const pi = +key;
      if (!all[pi] || !hasEdits(pages[key])) continue;
      await applyPageEdits(L, doc, all[pi], pi, pages[key], ctx);
    }
    ctx.uni.finish();
    const bytes = await doc.save({ useObjectStreams: false });
    ctx.report.missingChars = Array.from(ctx.report.missingChars);
    return { bytes, report: ctx.report };
  }

  /* ---------- removing unreachable objects ---------- */
  function collectGarbage(L, doc) {
    const ctx = doc.context, seen = new Set();
    const stack = [];
    const ti = ctx.trailerInfo;
    [ti.Root, ti.Info].forEach(r => { if (r) stack.push(r); });
    while (stack.length) {
      const o = stack.pop();
      if (o instanceof L.PDFRef) {
        const k = o.toString();
        if (seen.has(k)) continue;
        seen.add(k);
        const v = ctx.lookup(o);
        if (v) stack.push(v);
      } else if (o instanceof L.PDFDict) {
        for (const [, v] of o.entries()) stack.push(v);
      } else if (o instanceof L.PDFArray) {
        for (let i = 0; i < o.size(); i++) stack.push(o.get(i));
      } else if (o && o.dict instanceof L.PDFDict) {
        stack.push(o.dict);
      }
    }
    let removed = 0;
    for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.toString())) { ctx.delete(ref); removed++; }
    return removed;
  }

  /*
   * Build a document from pages of one or more PDFs, then apply edits.
   *   sources: { [sid]: Uint8Array }, primary: sid whose metadata, bookmarks and forms are kept
   *   order:   [{ sid, idx, rot, blank:{w,h} }]  (rot is added to the page's own rotation)
   *   edits:   array aligned with order (pageEdits or null)
   */
  async function buildDocument(L, input, opts) {
    opts = opts || {};
    const { sources, order } = input;
    const primary = input.primary in sources ? input.primary : Object.keys(sources)[0];
    const doc = primary != null ? await L.PDFDocument.load(sources[primary], { updateMetadata: false }) : await L.PDFDocument.create();
    const docs = { [primary]: doc };
    for (const e of order) if (!e.blank && !docs[e.sid]) docs[e.sid] = await L.PDFDocument.load(sources[e.sid], { updateMetadata: false });
    const orig = primary != null ? doc.getPages() : [];
    const used = new Set();
    const pages = [];
    // pass 1: gather pages (copies before any rotation is changed)
    for (const e of order) {
      if (e.blank) { pages.push(doc.addPage([e.blank.w, e.blank.h])); continue; }
      if (e.sid === primary && !used.has(e.idx) && orig[e.idx]) { used.add(e.idx); pages.push(orig[e.idx]); continue; }
      const [cp] = await doc.copyPages(docs[e.sid], [e.idx]);
      pages.push(cp);
    }
    // pass 2: rotation
    order.forEach((e, i) => { if (e.rot) pages[i].setRotation(L.degrees(((pages[i].getRotation().angle + e.rot) % 360 + 360) % 360)); });
    // rebuild the page tree in the new order
    for (let i = doc.getPageCount() - 1; i >= 0; i--) doc.removePage(i);
    pages.forEach((p, i) => doc.insertPage(i, p));
    // pages that were dropped: empty them so their content can't survive in the file
    orig.forEach((p, i) => {
      if (used.has(i)) return;
      p.node.set(L.PDFName.of('Contents'), doc.context.obj([]));
      p.node.delete(L.PDFName.of('Annots'));
      p.node.set(L.PDFName.of('Resources'), doc.context.obj({}));
    });
    const ctx = newContext(L, doc, opts);
    const edits = input.edits || [];
    for (let i = 0; i < pages.length; i++) if (hasEdits(edits[i])) await applyPageEdits(L, doc, pages[i], i, edits[i], ctx);
    ctx.uni.finish();
    if (opts.gc !== false) ctx.report.garbage = collectGarbage(L, doc);
    const bytes = await doc.save({ useObjectStreams: false });
    ctx.report.missingChars = Array.from(ctx.report.missingChars);
    return { bytes, report: ctx.report };
  }

  /*
   * Fast build for on-screen previews: a new file holding only the pages asked for, copied from
   * already-open source documents (which are left untouched), so the cost follows the edited pages
   * rather than the size of the whole PDF.
   */
  async function buildPreview(L, input, opts) {
    opts = opts || {};
    const out = await L.PDFDocument.create({ updateMetadata: false });
    const pages = [];
    for (const e of input.order) {
      if (e.blank) { pages.push(out.addPage([e.blank.w, e.blank.h])); continue; }
      const [cp] = await out.copyPages(input.docs[e.sid], [e.idx]);
      out.addPage(cp); pages.push(cp);
    }
    input.order.forEach((e, i) => { if (e.rot) pages[i].setRotation(L.degrees(((pages[i].getRotation().angle + e.rot) % 360 + 360) % 360)); });
    const ctx = newContext(L, out, opts);
    const edits = input.edits || [];
    for (let i = 0; i < pages.length; i++) if (hasEdits(edits[i])) await applyPageEdits(L, out, pages[i], i, edits[i], ctx);
    ctx.uni.finish();
    const bytes = await out.save({ useObjectStreams: false, addDefaultPage: false });
    ctx.report.missingChars = Array.from(ctx.report.missingChars);
    return { bytes, report: ctx.report };
  }

  const api = {
    buildPreview,
    tokenize, parseOps, analyzePage, makeFontCache, buildBlocks, planBlockEdit, groupGraphics, graphicSig, glyphsInBox, boxText, planTextEdit, rewriteContent, exportPdf, buildDocument, collectGarbage, measureStd,
    standardFontFor, familyOf, styleOf, styleFromRun, unsupportedChars, stdName,
    bytesToLatin1, latin1ToBytes, mul, apply, inv, bboxOf
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PDFEngine = api;
})(typeof self !== 'undefined' ? self : this);
