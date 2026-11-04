/* PDF → Word (.docx) converter.
 * Rebuilds real Word structure: flowing paragraphs, headings, lists, tables (bordered and
 * borderless, with shading and merged cells), images and vector figures, hyperlinks, and
 * repeated headers/footers turned into Word headers/footers with live page-number fields.
 * Runs in the browser; needs pdf-lib (L), the Folio engine (E) and pdf.js. */
(function (root) {
  'use strict';
  const TW = 20, EMU = 12700;
  const BULLETS = '•◦▪▫‣⁃●○■□►▸➢✓✔–-*·';

  /* ---------------- small helpers ---------------- */
  const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const hex2 = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0').toUpperCase();
  const colorHex = (c) => c ? hex2(c[0]) + hex2(c[1]) + hex2(c[2]) : '000000';
  const isWhite = (c) => c && c[0] > 0.97 && c[1] > 0.97 && c[2] > 0.97;
  const esc = (s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const isCJK = (s) => /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯豈-﫿＀-￯]/.test(s);
  const isHangul = (s) => /[ᄀ-ᇿ㄰-㆏가-힯]/.test(s);
  const tw = (pt) => Math.round(pt * TW);
  const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const inside = (r, x, y, pad) => x >= r.x0 - (pad || 0) && x <= r.x1 + (pad || 0) && y >= r.y0 - (pad || 0) && y <= r.y1 + (pad || 0);

  /* PostScript font names → fonts Word users have */
  const FONT_MAP = [
    [/^(arial|helvetica|helv|liberationsans|arimo|nimbussans|swiss)/, 'Arial'],
    [/^(timesnewroman|times|liberationserif|tinos|nimbusroman|tirom)/, 'Times New Roman'],
    [/^(couriernew|courier|liberationmono|cousine|nimbusmono)/, 'Courier New'],
    [/^(carlito)/, 'Calibri'], [/^(caladea)/, 'Cambria'],
    [/^(notosanscjk|notosanskr|notosansmono.*cjk|sourcehansans)/, 'Malgun Gothic'],
    [/^(notoserifcjk|sourcehanserif)/, 'Batang'],
    [/^(malgungothic|malgun)/, 'Malgun Gothic'],
    [/^(dejavusans)/, 'Verdana'], [/^(dejavuserif)/, 'Georgia'],
    [/^(symbol)/, 'Symbol'], [/^(zapfdingbats|dingbats)/, 'Wingdings']
  ];
  function mapFont(base) {
    let n = (base || '').replace(/^[A-Z]{6}\+/, '');
    let style = '';
    const m = n.match(/^([^,\-]+)[,\-](.*)$/);
    if (m) { n = m[1]; style = m[2]; }
    const lower = n.toLowerCase().replace(/[^a-z0-9]/g, '');
    let family = null;
    for (const [re, f] of FONT_MAP) if (re.test(lower)) { family = f; break; }
    if (!family) {
      family = n.replace(/(PSMT|MT|PS|Std|Pro|LT)$/g, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim() || 'Arial';
      family = family.replace(/\s+(Regular|Roman|Book|Medium)$/i, '');
    }
    const all = (n + ' ' + style).toLowerCase();
    return { family, bold: /bold|black|heavy|semibold|demi/.test(all), italic: /italic|oblique|ital/.test(all) };
  }

  /* ---------------- extraction ---------------- */
  async function extractPage(env, ctx, pi) {
    const { L, E } = env;
    const an = E.analyzePage(L, ctx.lib, pi, ctx.fc, { paths: true });
    const page = await ctx.view.getPage(pi + 1);
    // show the page in whichever orientation makes most of its text read left to right
    const votes = { 0: 0, 90: 0, 180: 0, 270: 0 };
    for (const run of an.runs) for (const g of run.glyphs) {
      const a = Math.atan2(g.p1[1] - g.p0[1], g.p1[0] - g.p0[0]) * 180 / Math.PI;
      const q = ((Math.round(a / 90) * 90) % 360 + 360) % 360;
      votes[q]++;
    }
    const best = +Object.keys(votes).sort((x, y) => votes[y] - votes[x])[0];
    const rot = votes[best] > 0 ? best : page.rotate;
    const vp = page.getViewport({ scale: 1, rotation: rot });
    const T = (p) => vp.convertToViewportPoint(p[0], p[1]);
    const W = vp.width, H = vp.height;
    const glyphs = [], rotated = [];
    for (const run of an.runs) {
      if (run.Tr === 3 || run.Tr === 7) continue;
      const fm = mapFont(run.baseFont);
      const style = { font: fm.family, bold: fm.bold || run.Tr === 2, italic: fm.italic, size: Math.round(run.size * 2) / 2, color: colorHex(run.fill) };
      for (const g of run.glyphs) {
        if (!g.ch) continue;
        const a = T(g.p0), b = T(g.p1);
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const item = { ch: g.ch, x0: a[0], x1: b[0], y: a[1], size: run.size, style, rise: run.rise || 0 };
        if (Math.abs(dy) <= Math.max(0.3, Math.abs(dx) * 0.08) && dx >= -0.05) glyphs.push(item);
        else rotated.push({ x0: Math.min(a[0], b[0]) - run.size * 0.2, x1: Math.max(a[0], b[0]) + run.size * 0.9, y0: Math.min(a[1], b[1]) - run.size, y1: Math.max(a[1], b[1]) + run.size * 0.3 });
      }
    }
    const rectOf = (pts) => { const t = pts.map(T); const xs = t.map(p => p[0]), ys = t.map(p => p[1]); return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }; };
    const shapes = an.shapes.map(s => ({ ...s, pts: s.pts.map(T), r: rectOf(s.pts) }));
    const images = an.images.map(im => {
      const b = im.bbox; const r = rectOf([[b.x, b.y], [b.x + b.w, b.y + b.h]]);
      return { r, inForm: !!im.si };
    }).filter(im => im.r.x1 - im.r.x0 > 2 && im.r.y1 - im.r.y0 > 2);
    let links = [];
    try {
      const annots = await page.getAnnotations();
      links = annots.filter(a => a.subtype === 'Link' && (a.url || a.unsafeUrl)).map(a => ({ url: a.url || a.unsafeUrl, r: rectOf([[a.rect[0], a.rect[1]], [a.rect[2], a.rect[3]]]) }));
    } catch (e) { links = []; }
    // characters with no unicode mapping: take text from pdf.js for those lines later
    const bad = glyphs.filter(g => g.ch === '\ufffd').length;
    let pdfjsItems = null;
    if (bad > 3) {
      const tc = await page.getTextContent();
      pdfjsItems = tc.items.filter(i => i.str && i.str.trim()).map(i => { const p = T([i.transform[4], i.transform[5]]); return { str: i.str, x: p[0], y: p[1], w: i.width }; });
    }
    return { pi, W, H, page, rot, glyphs, rotated, shapes, images, links, pdfjsItems };
  }

  /* ---------------- graphics: rules, fills, drawings ---------------- */
  function classifyShapes(pg) {
    const Hr = [], Vr = [], fills = [], drawings = [], dots = [];
    const area = pg.W * pg.H;
    for (const s of pg.shapes) {
      const r = s.r, w = r.x1 - r.x0, h = r.y1 - r.y0;
      if (w * h > area * 0.85) continue; // page background
      const col = s.stroke || s.fill;
      if (s.kind === 'line' && s.stroke && !isWhite(s.stroke)) {
        if (h < 0.8 && w > 2) Hr.push({ x0: r.x0, x1: r.x1, y: (r.y0 + r.y1) / 2, lw: s.lw, color: s.stroke });
        else if (w < 0.8 && h > 2) Vr.push({ y0: r.y0, y1: r.y1, x: (r.x0 + r.x1) / 2, lw: s.lw, color: s.stroke });
        else drawings.push(r);
        continue;
      }
      if (s.kind === 'rect') {
        if (s.fill && !isWhite(s.fill) && h <= 4.2 && w > 4 * h && w > 2.5) { Hr.push({ x0: r.x0, x1: r.x1, y: (r.y0 + r.y1) / 2, lw: Math.max(h, 0.25), color: s.fill }); continue; }
        if (s.fill && !isWhite(s.fill) && w <= 4.2 && h > 4 * w && h > 2.5) { Vr.push({ y0: r.y0, y1: r.y1, x: (r.x0 + r.x1) / 2, lw: Math.max(w, 0.25), color: s.fill }); continue; }
        if (s.stroke && !isWhite(s.stroke)) {
          Hr.push({ x0: r.x0, x1: r.x1, y: r.y0, lw: s.lw, color: s.stroke }, { x0: r.x0, x1: r.x1, y: r.y1, lw: s.lw, color: s.stroke });
          Vr.push({ y0: r.y0, y1: r.y1, x: r.x0, lw: s.lw, color: s.stroke }, { y0: r.y0, y1: r.y1, x: r.x1, lw: s.lw, color: s.stroke });
        }
        if (s.fill && !isWhite(s.fill)) fills.push({ ...r, color: s.fill });
        continue;
      }
      if (s.kind === 'path' && !s.curved && (s.stroke || s.fill)) {
        // polylines made of axis-aligned segments are table borders too
        const pts = s.pts; let axisOnly = true;
        for (let k = 1; k < pts.length; k++) { const a = pts[k - 1], b = pts[k]; if (Math.abs(a[0] - b[0]) > 0.6 && Math.abs(a[1] - b[1]) > 0.6) { axisOnly = false; break; } }
        if (axisOnly && s.stroke && !s.fill) {
          for (let k = 1; k < pts.length; k++) {
            const a = pts[k - 1], b = pts[k];
            if (Math.abs(a[1] - b[1]) < 0.6 && Math.abs(a[0] - b[0]) > 2) Hr.push({ x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y: a[1], lw: s.lw, color: s.stroke });
            else if (Math.abs(a[0] - b[0]) < 0.6 && Math.abs(a[1] - b[1]) > 2) Vr.push({ y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]), x: a[0], lw: s.lw, color: s.stroke });
          }
          continue;
        }
        if (axisOnly && s.fill && !isWhite(s.fill)) { fills.push({ ...r, color: s.fill }); continue; }
      }
      if (col && isWhite(col) && !s.stroke) continue;
      if (w <= 7 && h <= 7 && w > 1 && h > 1 && (s.curved || s.kind === 'rect')) dots.push({ ...r, color: s.fill || s.stroke, curved: s.curved });
      drawings.push(r);
    }
    return { Hr: mergeRules(Hr, 'h'), Vr: mergeRules(Vr, 'v'), fills, drawings, dots };
  }
  function mergeRules(rs, dir) {
    const key = dir === 'h' ? 'y' : 'x', a = dir === 'h' ? 'x0' : 'y0', b = dir === 'h' ? 'x1' : 'y1';
    rs.sort((p, q) => p[key] - q[key] || p[a] - q[a]);
    const out = [];
    for (const r of rs) {
      const last = out.find(o => Math.abs(o[key] - r[key]) < 1 && r[a] <= o[b] + 1.5 && r[b] >= o[a] - 1.5);
      if (last) { last[a] = Math.min(last[a], r[a]); last[b] = Math.max(last[b], r[b]); last.lw = Math.max(last.lw, r.lw); }
      else out.push({ ...r });
    }
    return out;
  }
  function cluster(vals, tol) {
    const s = vals.slice().sort((x, y) => x - y), out = [];
    for (const v of s) { const l = out[out.length - 1]; if (l && v - l.max <= tol) { l.max = v; l.sum += v; l.n++; } else out.push({ min: v, max: v, sum: v, n: 1 }); }
    return out.map(c => c.sum / c.n);
  }

  /* ---------------- bordered tables ---------------- */
  function findTables(G) {
    const { Hr, Vr, fills } = G;
    const rules = Hr.map(r => ({ h: r })).concat(Vr.map(r => ({ v: r })));
    const parent = rules.map((_, i) => i);
    const find = (i) => parent[i] === i ? i : (parent[i] = find(parent[i]));
    const tol = 2.2;
    for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) {
      const A = rules[i], B = rules[j];
      let touch = false;
      if (A.h && B.v) touch = B.v.x >= A.h.x0 - tol && B.v.x <= A.h.x1 + tol && A.h.y >= B.v.y0 - tol && A.h.y <= B.v.y1 + tol;
      else if (A.v && B.h) touch = A.v.x >= B.h.x0 - tol && A.v.x <= B.h.x1 + tol && B.h.y >= A.v.y0 - tol && B.h.y <= A.v.y1 + tol;
      if (touch) parent[find(i)] = find(j);
    }
    const groups = {};
    rules.forEach((r, i) => { (groups[find(i)] = groups[find(i)] || []).push(r); });
    const tables = [];
    for (const g of Object.values(groups)) {
      const hs = g.filter(r => r.h).map(r => r.h), vs = g.filter(r => r.v).map(r => r.v);
      if (hs.length < 2 || vs.length < 2) continue;
      const xs = cluster(vs.map(v => v.x).concat([Math.min(...hs.map(h => h.x0)), Math.max(...hs.map(h => h.x1))]), 2);
      const ys = cluster(hs.map(h => h.y).concat([Math.min(...vs.map(v => v.y0)), Math.max(...vs.map(v => v.y1))]), 2);
      if (xs.length < 2 || ys.length < 2) continue;
      const nR = ys.length - 1, nC = xs.length - 1;
      const covV = (x, y0, y1) => vs.find(v => Math.abs(v.x - x) <= 2 && overlap(v.y0, v.y1, y0, y1) >= (y1 - y0) * 0.6);
      const covH = (y, x0, x1) => hs.find(h => Math.abs(h.y - y) <= 2 && overlap(h.x0, h.x1, x0, x1) >= (x1 - x0) * 0.6);
      // union cells that have no rule between them
      const id = (r, c) => r * nC + c;
      const P = Array.from({ length: nR * nC }, (_, i) => i);
      const f = (i) => P[i] === i ? i : (P[i] = f(P[i]));
      for (let r = 0; r < nR; r++) for (let c = 0; c < nC; c++) {
        if (c + 1 < nC && !covV(xs[c + 1], ys[r], ys[r + 1])) P[f(id(r, c))] = f(id(r, c + 1));
        if (r + 1 < nR && !covH(ys[r + 1], xs[c], xs[c + 1])) P[f(id(r, c))] = f(id(r + 1, c));
      }
      const spans = {};
      for (let r = 0; r < nR; r++) for (let c = 0; c < nC; c++) {
        const k = f(id(r, c)); const s = spans[k] = spans[k] || { r0: r, r1: r, c0: c, c1: c, n: 0 };
        s.r0 = Math.min(s.r0, r); s.r1 = Math.max(s.r1, r); s.c0 = Math.min(s.c0, c); s.c1 = Math.max(s.c1, c); s.n++;
      }
      const cells = [];
      const owner = new Array(nR * nC);
      for (const s of Object.values(spans)) {
        if (s.n !== (s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1)) {
          // not rectangular: split back into single cells
          for (let r = s.r0; r <= s.r1; r++) for (let c = s.c0; c <= s.c1; c++) if (f(id(r, c)) === f(id(s.r0, s.c0)) || true) { /* handled below */ }
        }
      }
      for (let r = 0; r < nR; r++) for (let c = 0; c < nC; c++) {
        if (owner[id(r, c)]) continue;
        const s = spans[f(id(r, c))];
        let rs = 1, cs = 1;
        if (s && s.n === (s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1) && s.r0 === r && s.c0 === c) { rs = s.r1 - s.r0 + 1; cs = s.c1 - s.c0 + 1; }
        const cell = { r, c, rs, cs, x0: xs[c], x1: xs[c + cs], y0: ys[r], y1: ys[r + rs] };
        for (let rr = r; rr < r + rs; rr++) for (let cc = c; cc < c + cs; cc++) owner[id(rr, cc)] = cell;
        const bt = covH(cell.y0, cell.x0, cell.x1), bb = covH(cell.y1, cell.x0, cell.x1), bl = covV(cell.x0, cell.y0, cell.y1), br = covV(cell.x1, cell.y0, cell.y1);
        cell.borders = { top: bt, bottom: bb, left: bl, right: br };
        const fl = fills.filter(fr => fr.x0 <= cell.x0 + 2 && fr.x1 >= cell.x1 - 2 && fr.y0 <= cell.y0 + 2 && fr.y1 >= cell.y1 - 2);
        if (fl.length) cell.shade = colorHex(fl[fl.length - 1].color);
        cells.push(cell);
      }
      const t = { kind: 'table', bordered: true, xs, ys, cells, x0: xs[0], x1: xs[xs.length - 1], y0: ys[0], y1: ys[ys.length - 1] };
      if (cells.length === 1 && (t.x1 - t.x0) * (t.y1 - t.y0) < 200) continue;
      tables.push(t);
    }
    return tables;
  }

  /* ---------------- lines ---------------- */
  function buildLines(glyphs) {
    const gs = glyphs.slice().sort((a, b) => a.y - b.y || a.x0 - b.x0);
    const lines = [];
    for (const g of gs) {
      let best = null;
      for (let k = lines.length - 1; k >= 0 && k >= lines.length - 6; k--) {
        const l = lines[k];
        if (Math.abs(g.y - l.y) <= 0.3 * Math.max(l.size, g.size)) { best = l; break; }
      }
      if (best) { best.glyphs.push(g); best.size = Math.max(best.size, g.size); }
      else lines.push({ y: g.y, size: g.size, glyphs: [g] });
    }
    // superscripts / subscripts set with their own baseline
    lines.sort((a, b) => a.y - b.y);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]; if (!l) continue;
      const maxS = Math.max(...l.glyphs.map(g => g.size));
      const x0 = Math.min(...l.glyphs.map(g => g.x0)), x1 = Math.max(...l.glyphs.map(g => g.x1));
      for (const j of [i - 1, i + 1]) {
        const n = lines[j]; if (!n || n === l) continue;
        if (maxS <= n.size * 0.82 && Math.abs(n.y - l.y) < n.size * 0.7) {
          const nx0 = Math.min(...n.glyphs.map(g => g.x0)), nx1 = Math.max(...n.glyphs.map(g => g.x1));
          if (x0 >= nx0 - n.size && x1 <= nx1 + n.size * 3) {
            l.glyphs.forEach(g => { g.vert = l.y < n.y ? 'superscript' : 'subscript'; n.glyphs.push(g); });
            lines[i] = null; break;
          }
        }
      }
    }
    const out = [];
    for (const l of lines) {
      if (!l) continue;
      const g = l.glyphs.sort((a, b) => a.x0 - b.x0);
      // drop duplicates (fake bold drawn twice)
      const uniq = [];
      for (const x of g) { const p = uniq[uniq.length - 1]; if (p && p.ch === x.ch && Math.abs(p.x0 - x.x0) < 0.35 && Math.abs(p.y - x.y) < 0.5) { p.style = { ...p.style, bold: true }; continue; } uniq.push(x); }
      const base = median(uniq.filter(x => !x.vert).map(x => x.y)) || l.y;
      const size = median(uniq.filter(x => !x.vert && x.ch.trim()).map(x => x.size)) || l.size;
      const segs = [];
      let seg = null, prev = null;
      const segGap = Math.max(1.5 * size, 9);
      for (const x of uniq) {
        if (!x.ch.trim() && (!prev || !seg)) { prev = x; continue; }
        const gap = prev ? x.x0 - prev.x1 : 0;
        if (!seg || (gap > segGap && x.ch.trim())) {
          if (seg) trimSeg(seg);
          seg = { glyphs: [], x0: x.x0, x1: x.x1 }; segs.push(seg);
        } else if (gap > (isCJK(prev.ch) || isCJK(x.ch) ? 0.3 : 0.17) * size && prev.ch.trim() && x.ch.trim()) seg.glyphs.push({ ...x, ch: ' ', virtual: true, x0: prev.x1, x1: x.x0 });
        seg.glyphs.push(x); seg.x1 = Math.max(seg.x1, x.x1);
        prev = x;
      }
      if (seg) trimSeg(seg);
      const segs2 = segs.filter(s => s.glyphs.length);
      if (!segs2.length) continue;
      segs2.forEach(s => { s.text = s.glyphs.map(x => x.ch).join(''); });
      out.push({ y: base, size, segs: segs2, x0: segs2[0].x0, x1: segs2[segs2.length - 1].x1, top: base - size * 0.85, bottom: base + size * 0.25, text: segs2.map(s => s.text).join('\t') });
    }
    return out.sort((a, b) => a.y - b.y || a.x0 - b.x0);
    function trimSeg(s) { while (s.glyphs.length && !s.glyphs[s.glyphs.length - 1].ch.trim()) s.glyphs.pop(); if (s.glyphs.length) s.x1 = s.glyphs[s.glyphs.length - 1].x1; }
  }

  /* when a font has no unicode table, take each line's text from pdf.js instead */
  function patchUnmappedText(lines, items) {
    if (!items) return;
    for (const l of lines) {
      if (l.text.indexOf('\ufffd') < 0) continue;
      const mine = items.filter(i => Math.abs(i.y - l.y) < l.size * 0.4 && i.x >= l.x0 - l.size && i.x <= l.x1).sort((a, b) => a.x - b.x);
      if (!mine.length) continue;
      const st = l.segs[0].glyphs[0].style;
      l.segs = mine.map(i => ({ x0: i.x, x1: i.x + i.w, glyphs: Array.from(i.str).map((ch, k, arr) => ({ ch, x0: i.x + i.w * k / arr.length, x1: i.x + i.w * (k + 1) / arr.length, y: l.y, size: l.size, style: st })), text: i.str }));
      l.text = l.segs.map(s => s.text).join('\t');
    }
  }

  /* ---------------- borderless tables and side-by-side columns ---------------- */
  function findLooseTables(lines, Hr, region) {
    const tables = [], used = new Set();
    let i = 0;
    const multi = (l) => l.segs.length >= 2;
    while (i < lines.length) {
      if (!multi(lines[i])) { i++; continue; }
      let j = i;
      const close = (a, b) => b.y - a.y <= 2.8 * Math.max(a.size, b.size);
      while (j + 1 < lines.length && close(lines[j], lines[j + 1]) && (multi(lines[j + 1]) || (j + 2 < lines.length && multi(lines[j + 2]) && close(lines[j + 1], lines[j + 2])))) j++;
      let grp = lines.slice(i, j + 1);
      // columns = maximal x-intervals covered by text, separated by gutters
      const ivs = grp.flatMap(l => l.segs.map(s => [s.x0, s.x1])).sort((a, b) => a[0] - b[0]);
      const cols = [];
      for (const iv of ivs) { const c = cols[cols.length - 1]; if (c && iv[0] <= c[1] + 4) c[1] = Math.max(c[1], iv[1]); else cols.push([iv[0], iv[1]]); }
      // single-segment lines that sit inside one column belong to the block
      let k = j + 1;
      while (k < lines.length && close(lines[k - 1], lines[k]) && lines[k].segs.length === 1 && cols.length >= 2 && cols.some(c => lines[k].x0 >= c[0] - 3 && lines[k].x1 <= c[1] + 3) ) { grp.push(lines[k]); k++; }
      const nC = cols.length;
      const colOf = (s) => { let b = 0, bo = -1; cols.forEach((c, q) => { const o = overlap(c[0], c[1], s.x0, s.x1); if (o > bo) { bo = o; b = q; } }); return b; };
      const multiRows = grp.filter(multi).length;
      const okTable = nC >= 2 && grp.length >= 2 && multiRows >= 2 && (nC >= 3 || grp.length >= 3 || Hr.some(h => Math.abs(h.y - grp[0].top) < 14 && h.x1 - h.x0 > (region.x1 - region.x0) * 0.4));
      if (!okTable) { i++; continue; }
      const perCol = cols.map(() => []);
      grp.forEach(l => l.segs.forEach(s => perCol[colOf(s)].push({ l, s })));
      const avgLen = grp.flatMap(l => l.segs.map(s => s.text.length)).reduce((a, b) => a + b, 0) / Math.max(1, grp.reduce((a, l) => a + l.segs.length, 0));
      const sizes = (q) => new Set(perCol[q].map(e => Math.round(e.l.size)));
      const textCols = cols.some((_, q) => sizes(q).size > 1 || perCol[q].some(e => /^[•◦▪\-–]$|^\d+[.)]$/.test(e.s.text.trim()))) || (nC === 2 && avgLen > 18);
      const xs = cols.map((c, q) => q === 0 ? c[0] - 3 : (cols[q - 1][1] + c[0]) / 2);
      xs.push(cols[nC - 1][1] + 3);
      const cells = [];
      let ys;
      if (textCols) {
        // side-by-side text blocks: one row, each column flows on its own
        ys = [grp[0].top - 2, grp[grp.length - 1].bottom + 2];
        cols.forEach((c, q) => cells.push({ r: 0, c: q, rs: 1, cs: 1, x0: xs[q], x1: xs[q + 1], y0: ys[0], y1: ys[1], lines: grp.map(l => ({ ...l, segs: l.segs.filter(s => colOf(s) === q) })).filter(l => l.segs.length).map(l => ({ ...l, x0: l.segs[0].x0, x1: l.segs[l.segs.length - 1].x1, text: l.segs.map(s => s.text).join('\t') })), borders: {} }));
      } else {
        ys = [];
        grp.forEach((l, r) => ys.push(r === 0 ? l.top - 2 : (grp[r - 1].bottom + l.top) / 2));
        ys.push(grp[grp.length - 1].bottom + 2);
        grp.forEach((l, r) => cols.forEach((c, q) => {
          const segs = l.segs.filter(s => colOf(s) === q);
          cells.push({ r, c: q, rs: 1, cs: 1, x0: xs[q], x1: xs[q + 1], y0: ys[r], y1: ys[r + 1], lines: segs.length ? [{ ...l, segs, x0: segs[0].x0, x1: segs[segs.length - 1].x1, text: segs.map(s => s.text).join('\t') }] : [], borders: {} });
        }));
        const rh = Hr.filter(h => h.x0 <= xs[0] + (xs[nC] - xs[0]) * 0.5 && h.x1 >= xs[nC] - (xs[nC] - xs[0]) * 0.5 && h.y > ys[0] - 14 && h.y < ys[ys.length - 1] + 14);
        for (const h of rh) {
          let best = 0, bd = 1e9; ys.forEach((y, q) => { const d = Math.abs(y - h.y); if (d < bd) { bd = d; best = q; } });
          cells.forEach(cl => { if (cl.r === best) cl.borders.top = h; if (cl.r + 1 === best) cl.borders.bottom = h; });
          h.usedByTable = true;
        }
        if (rh.length) { ys[0] = Math.min(ys[0], ...rh.map(h => h.y)); ys[ys.length - 1] = Math.max(ys[ys.length - 1], ...rh.map(h => h.y)); cells.forEach(cl => { cl.y0 = ys[cl.r]; cl.y1 = ys[cl.r + 1]; }); }
      }
      tables.push({ kind: 'table', bordered: false, columns: textCols, xs, ys, cells, x0: xs[0], x1: xs[nC], y0: ys[0], y1: ys[ys.length - 1], lines: grp });
      grp.forEach(l => used.add(l));
      i = Math.max(j + 1, k);
    }
    return { tables, used };
  }

  /* ---------------- paragraphs ---------------- */
  const isBulletChar = (c) => c && c.length === 1 && (BULLETS.indexOf(c) >= 0 || (c.charCodeAt(0) >= 0xF000 && c.charCodeAt(0) <= 0xF0FF));
  function listMarker(line) {
    const s0 = line.segs[0];
    const t = s0.text.trim();
    const restStart = line.segs.length > 1 ? line.segs[1].x0 : null;
    if (isBulletChar(t) && line.segs.length > 1) return { kind: 'bullet', marker: t, textX: restStart };
    if (/^(\(?\d{1,3}[.)]|\(?[a-z][.)]|\(?[ivx]{1,4}[.)])$/i.test(t) && line.segs.length > 1) return { kind: /\d/.test(t) ? 'decimal' : (/^[ivx]+/i.test(t.replace(/[().]/g, '')) && t.length > 2 ? 'roman' : 'alpha'), marker: t, textX: restStart, start: parseInt(t.replace(/\D/g, ''), 10) || 1 };
    // bullet glued to text: "• text"
    const g = s0.glyphs;
    if (g.length > 2 && isBulletChar(g[0].ch) && g[0].ch !== '-' && g[0].ch !== '–' && g[1].ch === ' ') return { kind: 'bullet', marker: g[0].ch, textX: g[2].x0, glued: 2 };
    // "1.<wide gap>text": a number followed by more than a normal space
    const mm = s0.text.match(/^(\(?(\d{1,3}|[a-z]|[ivx]{1,4})[.)])(\s)/i);
    if (mm && g.length > mm[1].length + 1) {
      const k = mm[1].length, gap = g[k + 1].x0 - g[k - 1].x1;
      if (gap > 0.55 * line.size) return { kind: /\d/.test(mm[2]) ? 'decimal' : (/^[ivx]{2,}$/i.test(mm[2]) ? 'roman' : 'alpha'), marker: mm[1], textX: g[k + 1].x0, glued: k + 1, start: parseInt(mm[2], 10) || 1 };
    }
    return null;
  }
  function buildParas(lines, region) {
    const paras = [];
    let cur = null;
    const width = Math.max(1, region.x1 - region.x0);
    for (const line of lines) {
      const lm = listMarker(line);
      let cont = false;
      if (cur && !lm && line.segs.length === 1 && cur.lines[cur.lines.length - 1].segs.length === 1 && !cur.tabbed) {
        const prev = cur.lines[cur.lines.length - 1];
        const gap = line.y - prev.y;
        const sameSize = Math.abs(line.size - prev.size) < 0.8;
        const spacingOk = gap > 0 && gap <= 1.75 * Math.max(line.size, prev.size) && (cur.lines.length < 2 || Math.abs(gap - cur.gap) <= 0.35 * line.size);
        const textX = cur.list ? cur.list.textX : (cur.lines.length > 1 ? cur.lines[1].x0 : null);
        const leftOk = textX != null ? Math.abs(line.x0 - textX) < 3 : (Math.abs(line.x0 - prev.x0) < 3 || (line.x0 < prev.x0 - 3 && prev.x0 - line.x0 < 4 * line.size));
        const centered = Math.abs((prev.x0 + prev.x1) / 2 - (line.x0 + line.x1) / 2) < 3 && prev.x0 - region.x0 > 10 && region.x1 - prev.x1 > 10;
        const prevFull = prev.x1 >= region.x1 - Math.max(3.5 * prev.size, width * 0.12);
        const endsSentence = /[.:;!?]$/.test(prev.segs[0].text.trim()) && !prevFull;
        if (sameSize && spacingOk && ((leftOk && prevFull && !endsSentence) || (centered && cur.align === 'center'))) cont = true;
        if (cur.list && leftOk && sameSize && spacingOk && !endsSentence) cont = true;
      }
      if (cont) {
        if (cur.lines.length === 1) cur.gap = line.y - cur.lines[0].y;
        cur.lines.push(line);
      } else {
        cur = { lines: [line], list: lm, tabbed: !lm && line.segs.length > 1 };
        if (lm && lm.glued) cur.gluedMarker = true;
        paras.push(cur);
      }
    }
    for (const p of paras) finishPara(p, region);
    return paras;
  }
  function finishPara(p, region) {
    const L = p.lines, first = L[0];
    p.top = first.top; p.bottom = L[L.length - 1].bottom; p.y = first.y;
    p.size = median(L.map(l => l.size));
    if (L.length > 1) p.gap = median(L.slice(1).map((l, k) => l.y - L[k].y));
    const lefts = L.map(l => l.x0 - region.x0), rights = L.map(l => region.x1 - l.x1);
    const textX = p.list ? p.list.textX : (L.length > 1 ? median(L.slice(1).map(l => l.x0)) : first.x0);
    if (p.list) { p.ind = { left: textX - region.x0, hanging: textX - first.x0 }; p.align = 'left'; }
    else if (p.tabbed) { p.ind = { left: first.x0 - region.x0, first: 0 }; p.align = 'left'; }
    else {
      const centered = L.every((l, k) => Math.abs(lefts[k] - rights[k]) < Math.max(4, l.size * 0.6)) && lefts[0] > 6;
      const rightAl = !centered && L.every((l, k) => rights[k] < 3) && lefts[0] > 20;
      const justified = L.length >= 2 && L.slice(0, -1).every((l, k) => rights[k] < Math.max(2.5, l.size * 0.3)) && L.slice(0, -1).some(l => l.segs[0].glyphs.some(g => g.virtual || g.ch === ' '));
      p.align = centered ? 'center' : rightAl ? 'right' : justified ? 'both' : 'left';
      if (p.align === 'left' || p.align === 'both') p.ind = { left: textX - region.x0, first: first.x0 - textX };
      else p.ind = { left: 0, first: 0 };
    }
    // tab stops for lines with columns
    if (p.tabbed) {
      p.tabs = first.segs.slice(1).map(s => {
        const isRight = region.x1 - s.x1 < 4 && s.x1 - s.x0 < (region.x1 - region.x0) * 0.5;
        return isRight ? { val: 'right', pos: s.x1 - region.x0 } : { val: 'left', pos: s.x0 - region.x0 };
      });
    }
    p.text = L.map(l => l.text).join(' ');
  }

  /* ---------------- figures ---------------- */
  function findFigures(pg, G, tables) {
    const boxes = G.drawings.map(r => ({ ...r }));
    pg.rotated.forEach(r => boxes.push({ ...r, rot: true }));
    const merged = [];
    for (const b of boxes.sort((a, c) => a.y0 - c.y0)) {
      let m = merged.find(o => b.x0 <= o.x1 + 8 && b.x1 >= o.x0 - 8 && b.y0 <= o.y1 + 8 && b.y1 >= o.y0 - 8);
      if (m) { m.x0 = Math.min(m.x0, b.x0); m.y0 = Math.min(m.y0, b.y0); m.x1 = Math.max(m.x1, b.x1); m.y1 = Math.max(m.y1, b.y1); m.n++; m.rot = m.rot || b.rot; }
      else merged.push({ ...b, n: 1 });
    }
    // merging may have created new overlaps
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < merged.length && !changed; i++) for (let j = i + 1; j < merged.length; j++) {
        const a = merged[i], b = merged[j];
        if (b.x0 <= a.x1 + 8 && b.x1 >= a.x0 - 8 && b.y0 <= a.y1 + 8 && b.y1 >= a.y0 - 8) {
          a.x0 = Math.min(a.x0, b.x0); a.y0 = Math.min(a.y0, b.y0); a.x1 = Math.max(a.x1, b.x1); a.y1 = Math.max(a.y1, b.y1); a.n += b.n; a.rot = a.rot || b.rot;
          merged.splice(j, 1); changed = true; break;
        }
      }
    }
    const big = (f) => { const w = f.x1 - f.x0, h = f.y1 - f.y0; return (w > 24 && h > 24 && f.n >= 2) || (f.rot && w * h > 60); };
    const figs = merged.filter(big), small = merged.filter(f => !big(f));
    for (let again = true; again;) {
      again = false;
      for (let i = small.length - 1; i >= 0; i--) {
        const sm = small[i];
        const f = figs.find(f => sm.x0 <= f.x1 + 24 && sm.x1 >= f.x0 - 24 && sm.y0 <= f.y1 + 24 && sm.y1 >= f.y0 - 24);
        if (f) { f.x0 = Math.min(f.x0, sm.x0); f.y0 = Math.min(f.y0, sm.y0); f.x1 = Math.max(f.x1, sm.x1); f.y1 = Math.max(f.y1, sm.y1); f.n += sm.n; small.splice(i, 1); again = true; }
      }
    }
    return figs.filter(f => !tables.some(t => f.x0 >= t.x0 - 2 && f.x1 <= t.x1 + 2 && f.y0 >= t.y0 - 2 && f.y1 <= t.y1 + 2)).map(f => ({ kind: 'figure', x0: f.x0 - 2, y0: f.y0 - 2, x1: f.x1 + 2, y1: f.y1 + 2, n: f.n }));
  }

  /* ---------------- page analysis ---------------- */
  function analyzeLayout(pg) {
    const G = classifyShapes(pg);
    // a small dot just left of a line of text is a list bullet: turn it into a character
    if (G.dots.length) {
      const pre = buildLines(pg.glyphs);
      const used = new Set();
      for (const d of G.dots) {
        const cy = (d.y0 + d.y1) / 2;
        const l = pre.find(l => cy < l.y && cy > l.y - l.size * 0.8 && l.x0 - d.x1 > 0.5 && l.x0 - d.x1 < l.size * 2.2 && (d.x1 - d.x0) < l.size * 0.7);
        if (!l) continue;
        used.add(d);
        const st = l.segs[0].glyphs[0].style;
        pg.glyphs.push({ ch: d.curved ? '•' : '▪', x0: d.x0, x1: d.x1, y: l.y, size: l.size, style: { ...st, bold: false, italic: false } });
      }
      G.drawings = G.drawings.filter(r => !G.dots.some(d => used.has(d) && d.x0 === r.x0 && d.y0 === r.y0 && d.x1 === r.x1 && d.y1 === r.y1));
    }
    let tables = findTables(G);
    let figures = findFigures(pg, G, []);
    // a "table" that encloses drawn curves or diagonals is a chart frame
    tables = tables.filter(t => {
      const area = (t.x1 - t.x0) * (t.y1 - t.y0);
      const hit = figures.filter(f => overlap(f.x0, f.x1, t.x0, t.x1) * overlap(f.y0, f.y1, t.y0, t.y1) > Math.min(area, (f.x1 - f.x0) * (f.y1 - f.y0)) * 0.3);
      if (!hit.length) return true;
      hit.forEach(f => { f.x0 = Math.min(f.x0, t.x0 - 2); f.y0 = Math.min(f.y0, t.y0 - 2); f.x1 = Math.max(f.x1, t.x1 + 2); f.y1 = Math.max(f.y1, t.y1 + 2); f.chart = true; });
      return false;
    });
    // figures inside a table cell stay with the table
    figures = figures.filter(f => !tables.some(t => f.x0 >= t.x0 - 2 && f.x1 <= t.x1 + 2 && f.y0 >= t.y0 - 2 && f.y1 <= t.y1 + 2));
    // axis labels and legends: short text just outside the plot area
    if (figures.length) {
      const pre = buildLines(pg.glyphs);
      let grew = true, guard = 0;
      while (grew && guard++ < 6) {
        grew = false;
        for (const f of figures) for (const l of pre) for (const sg of l.segs) {
          if (sg.inFig === f) continue;
          const short = sg.text.length <= 24 && !/[.!?]$/.test(sg.text);
          const near = sg.x1 >= f.x0 - 34 && sg.x0 <= f.x1 + 20 && l.bottom >= f.y0 - 4 && l.top <= f.y1 + 22;
          const outside = !(sg.x0 >= f.x0 && sg.x1 <= f.x1 && l.top >= f.y0 && l.bottom <= f.y1);
          if (short && near && (outside ? (f.chart || f.n > 3) : true)) {
            sg.inFig = f;
            if (outside) { f.x0 = Math.min(f.x0, sg.x0 - 2); f.x1 = Math.max(f.x1, sg.x1 + 2); f.y0 = Math.min(f.y0, l.top - 2); f.y1 = Math.max(f.y1, l.bottom + 2); grew = true; }
          }
        }
      }
    }
    // merge figures that now touch or contain each other
    for (let again = true; again;) {
      again = false;
      for (let i = 0; i < figures.length && !again; i++) for (let j = i + 1; j < figures.length; j++) {
        const a = figures[i], b = figures[j];
        if (b.x0 <= a.x1 + 6 && b.x1 >= a.x0 - 6 && b.y0 <= a.y1 + 6 && b.y1 >= a.y0 - 6) {
          a.x0 = Math.min(a.x0, b.x0); a.y0 = Math.min(a.y0, b.y0); a.x1 = Math.max(a.x1, b.x1); a.y1 = Math.max(a.y1, b.y1); a.chart = a.chart || b.chart;
          figures.splice(j, 1); again = true; break;
        }
      }
    }
    // shaded boxes (callouts, notes) become one-cell tables with their shading and edge rules
    for (const fl of G.fills) {
      const w = fl.x1 - fl.x0, h = fl.y1 - fl.y0;
      if (w < 30 || h < 8 || w * h > pg.W * pg.H * 0.6) continue;
      if (tables.some(t => overlap(t.x0, t.x1, fl.x0, fl.x1) > 0 && overlap(t.y0, t.y1, fl.y0, fl.y1) > 0)) continue;
      if (figures.some(f => overlap(f.x0, f.x1, fl.x0, fl.x1) > 0 && overlap(f.y0, f.y1, fl.y0, fl.y1) > 0)) continue;
      const hasText = pg.glyphs.some(g => g.x0 >= fl.x0 - 1 && g.x1 <= fl.x1 + 1 && g.y >= fl.y0 && g.y <= fl.y1 + 1 && g.ch.trim());
      if (!hasText) continue;
      const box = { x0: fl.x0, x1: fl.x1, y0: fl.y0, y1: fl.y1 };
      const edge = (side) => side === 'left' ? G.Vr.find(v => Math.abs(v.x - fl.x0) < 4 + v.lw && overlap(v.y0, v.y1, fl.y0, fl.y1) > h * 0.6)
        : side === 'right' ? G.Vr.find(v => Math.abs(v.x - fl.x1) < 4 + v.lw && overlap(v.y0, v.y1, fl.y0, fl.y1) > h * 0.6)
        : side === 'top' ? G.Hr.find(r => Math.abs(r.y - fl.y0) < 4 + r.lw && overlap(r.x0, r.x1, fl.x0, fl.x1) > w * 0.6)
        : G.Hr.find(r => Math.abs(r.y - fl.y1) < 4 + r.lw && overlap(r.x0, r.x1, fl.x0, fl.x1) > w * 0.6);
      const borders = { left: edge('left'), right: edge('right'), top: edge('top'), bottom: edge('bottom') };
      Object.values(borders).forEach(r => { if (r) r.usedByTable = true; });
      if (borders.left) box.x0 = Math.min(box.x0, borders.left.x - borders.left.lw / 2);
      tables.push({ kind: 'table', bordered: true, callout: true, xs: [box.x0, box.x1], ys: [box.y0, box.y1], cells: [{ r: 0, c: 0, rs: 1, cs: 1, ...box, borders, shade: colorHex(fl.color) }], ...box });
    }
    // raster images: scanned pages, images inside figures, images in table cells, standalone
    const images = [];
    for (const im of pg.images) {
      const r = { x0: im.r.x0, y0: im.r.y0, x1: im.r.x1, y1: im.r.y1 };
      const f = figures.find(fg => overlap(fg.x0, fg.x1, r.x0, r.x1) > 0 && overlap(fg.y0, fg.y1, r.y0, r.y1) > 0);
      if (f) { f.x0 = Math.min(f.x0, r.x0); f.y0 = Math.min(f.y0, r.y0); f.x1 = Math.max(f.x1, r.x1); f.y1 = Math.max(f.y1, r.y1); continue; }
      images.push({ kind: 'image', ...r });
    }
    // text that sits inside a figure belongs to the picture (axis labels, legends)
    const inFig = (g) => figures.some(f => g.x0 >= f.x0 - 1 && g.x1 <= f.x1 + 1 && g.y >= f.y0 && g.y - g.size * 0.7 <= f.y1);
    const flowGlyphs = pg.glyphs.filter(g => !inFig(g));
    let lines = buildLines(flowGlyphs);
    patchUnmappedText(lines, pg.pdfjsItems);
    // text over a raster image belongs to it only if the image is a scan
    const scanned = images.some(im => (im.x1 - im.x0) * (im.y1 - im.y0) > pg.W * pg.H * 0.7) && lines.length < 4;
    // underline rules
    const onTable = (h) => tables.some(t => h.y >= t.y0 - 2 && h.y <= t.y1 + 2 && h.x0 >= t.x0 - 3 && h.x1 <= t.x1 + 3);
    for (const h of G.Hr) {
      if (h.x1 - h.x0 > pg.W * 0.8 || onTable(h)) continue;
      for (const l of lines) {
        if (h.y < l.y - 0.05 * l.size || h.y > l.y + 0.35 * l.size) continue;
        let hit = false;
        for (const s of l.segs) for (const g of s.glyphs) if (g.x0 >= h.x0 - 1 && g.x1 <= h.x1 + 1) { g.under = true; hit = true; }
        if (hit) h.underline = true;
      }
    }
    const rules = G.Hr.filter(h => !h.underline && !h.usedByTable && !onTable(h) && h.x1 - h.x0 > 40 && !figures.some(f => h.y >= f.y0 && h.y <= f.y1 && h.x0 >= f.x0 - 2 && h.x1 <= f.x1 + 2));
    // links
    for (const ln of pg.links) for (const l of lines) for (const s of l.segs) for (const g of s.glyphs) {
      const cx = (g.x0 + g.x1) / 2;
      if (cx >= ln.r.x0 && cx <= ln.r.x1 && g.y >= ln.r.y0 - 2 && g.y - g.size * 0.6 <= ln.r.y1 + 2) g.link = ln.url;
    }
    // plain URLs in text become links too
    for (const l of lines) for (const s of l.segs) {
      const re = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:)]/g; let m;
      while ((m = re.exec(s.text))) for (let k = m.index; k < m.index + m[0].length; k++) if (!s.glyphs[k].link) s.glyphs[k].link = m[0];
    }
    return { G, tables, figures, images, lines, scanned, rules };
  }

  /* ---------------- repeated headers and footers ---------------- */
  function detectHeaderFooter(pages) {
    const N = pages.length;
    if (N < 2) {
      // one page: small text in the outer bands is the running header/footer
      const pg = pages[0]; if (!pg) return null;
      const hf = { header: { lines: [], images: [] }, footer: { lines: [], images: [] }, pagesWith: new Set([pg.pi]), pageStart: 1 };
      const fieldsFor = (t) => {
        const m = t.match(/page\s+(\d+)\s*(of|\/)\s*(\d+)/i);
        if (m) return (t.match(/\d+/g) || []).map((d, i, arr) => { const idx = t.indexOf(m[0]); return null; }).map((_, i) => null);
        return null;
      };
      pg.removeLines = new Set();
      for (const l of pg.A.lines) {
        const band = l.bottom < pg.H * 0.06 ? 'header' : l.top > pg.H * 0.94 ? 'footer' : null;
        if (!band || l.size > Math.max(9, 0.8 * median(pg.A.lines.map(x => x.size)))) continue;
        const nums = l.text.match(/\d+/g) || [];
        let fields = nums.map(() => null);
        const m = l.text.match(/page\s+\d+\s*(of|\/)\s*\d+/i);
        if (m) { const before = (l.text.slice(0, l.text.indexOf(m[0])).match(/\d+/g) || []).length; fields[before] = { field: 'PAGE', offset: 0 }; fields[before + 1] = { field: 'NUMPAGES' }; }
        else if (/^\s*-?\s*\d+\s*-?\s*$/.test(l.text)) fields[0] = { field: 'PAGE', offset: 0 };
        hf[band].lines.push({ line: l, fields, pg });
        pg.removeLines.add(l);
      }
      void fieldsFor;
      return hf.header.lines.length || hf.footer.lines.length ? hf : null;
    }
    const norm = (t) => t.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
    const keyOf = (pg, l, band) => band + '|' + norm(l.text) + '|' + Math.round(l.x0 / 8);
    const counts = {};
    pages.forEach(pg => {
      const seen = new Set();
      pg.A.lines.forEach(l => {
        const band = l.bottom < pg.H * 0.13 ? 'h' : l.top > pg.H * 0.86 ? 'f' : null;
        if (!band) return;
        const k = keyOf(pg, l, band); if (seen.has(k)) return; seen.add(k);
        (counts[k] = counts[k] || []).push({ pg, l });
      });
      pg.A.images.forEach(im => {
        const band = im.y1 < pg.H * 0.16 ? 'h' : im.y0 > pg.H * 0.84 ? 'f' : null;
        if (!band) return;
        const k = band + '|img|' + [im.x0, im.y0, im.x1, im.y1].map(v => Math.round(v / 3)).join(',');
        if (seen.has(k)) return; seen.add(k);
        (counts[k] = counts[k] || []).push({ pg, im });
      });
    });
    const need = Math.max(2, Math.ceil(N * 0.75));
    const rep = Object.entries(counts).filter(([, v]) => v.length >= need);
    if (!rep.length) return null;
    const hf = { header: { lines: [], images: [] }, footer: { lines: [], images: [] }, pagesWith: new Set() };
    for (const [k, inst] of rep) {
      const band = k[0] === 'h' ? hf.header : hf.footer;
      inst.forEach(i => { i.pg.removeLines = i.pg.removeLines || new Set(); i.pg.removeImgs = i.pg.removeImgs || new Set(); if (i.l) i.pg.removeLines.add(i.l); if (i.im) i.pg.removeImgs.add(i.im); hf.pagesWith.add(i.pg.pi); });
      const first = inst[0];
      if (first.im) { band.images.push({ ...first.im, pg: first.pg }); continue; }
      // which numbers are page numbers / page counts
      const groups = (t) => (t.match(/\d+/g) || []).map(Number);
      const g0 = groups(first.l.text);
      const fields = g0.map((_, gi) => {
        const vals = inst.map(i => ({ v: groups(i.l.text)[gi], p: i.pg.pi }));
        const offs = new Set(vals.map(x => x.v - (x.p + 1)));
        if (inst.length >= 2 && offs.size === 1 && new Set(vals.map(x => x.v)).size > 1) return { field: 'PAGE', offset: [...offs][0] };
        return null;
      });
      // a page count only counts as one right after a page number ("Page 3 of 12", "3 / 12")
      g0.forEach((_, gi) => {
        if (fields[gi] || gi === 0 || !fields[gi - 1] || fields[gi - 1].field !== 'PAGE') return;
        const vals = inst.map(i => (i.l.text.match(/\d+/g) || []).map(Number)[gi]);
        if (vals.every(v => v === N) && /(of|\/)\s*\d+\D*$|(of|\/)\s*\d+/i.test(first.l.text)) fields[gi] = { field: 'NUMPAGES' };
      });
      band.lines.push({ line: first.l, fields, pg: first.pg });
    }
    hf.titlePg = !hf.pagesWith.has(pages[0].pi) && hf.pagesWith.size >= N - 1;
    const pageOff = [...hf.header.lines, ...hf.footer.lines].flatMap(x => x.fields).find(f => f && f.field === 'PAGE');
    hf.pageStart = pageOff ? 1 + pageOff.offset : 1;
    return hf;
  }

  /* ---------------- XML writing ---------------- */
  class Doc {
    constructor() { this.rels = []; this.media = []; this.nums = []; this.bodyFont = 'Arial'; this.bodySize = 10; this.headings = 0; this.lists = 0; this.tables = 0; this.images = 0; this.links = 0; }
    rel(type, target, ext) {
      const key = type + '|' + target;
      const ex = this.rels.find(r => r.key === key); if (ex) return ex.id;
      const id = 'rId' + (this.rels.length + 10);
      this.rels.push({ id, key, type, target, ext });
      return id;
    }
    addMedia(bytes) { const n = this.media.length + 1; const name = 'image' + n + '.png'; this.media.push({ name, bytes }); this.images++; return this.rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', 'media/' + name); }
    newNum(kind, start) { const id = this.nums.length + 1; this.nums.push({ id, kind, start: start || 1 }); return id; }
  }
  function rPrXml(doc, st, extra) {
    let x = '';
    const font = st.font || doc.bodyFont;
    const cjk = extra && extra.cjk;
    if (font !== doc.bodyFont || cjk) x += '<w:rFonts w:ascii="' + esc(font) + '" w:hAnsi="' + esc(font) + '" w:cs="' + esc(font) + '"' + (cjk ? ' w:eastAsia="' + (extra.hangul ? 'Malgun Gothic' : 'Microsoft YaHei') + '"' : '') + '/>';
    if (st.bold) x += '<w:b/><w:bCs/>';
    if (st.italic) x += '<w:i/><w:iCs/>';
    if (extra && extra.link) x += '<w:color w:val="0563C1"/>';
    else if (st.color && st.color !== '000000') x += '<w:color w:val="' + st.color + '"/>';
    const sz = Math.round((st.size || doc.bodySize) * 2);
    if (sz !== Math.round(doc.bodySize * 2)) x += '<w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/>';
    if ((extra && extra.under) || (extra && extra.link)) x += '<w:u w:val="single"/>';
    if (extra && extra.vert) x += '<w:vertAlign w:val="' + extra.vert + '"/>';
    if (cjk) x += '<w:lang w:eastAsia="' + (extra.hangul ? 'ko-KR' : 'zh-CN') + '"/>';
    return x ? '<w:rPr>' + x + '</w:rPr>' : '';
  }
  function textRun(doc, st, text, extra) {
    const parts = text.split('\t');
    let inner = '';
    parts.forEach((t, k) => { if (k) inner += '<w:tab/>'; if (t) inner += '<w:t xml:space="preserve">' + esc(t) + '</w:t>'; });
    return '<w:r>' + rPrXml(doc, st, extra) + inner + '</w:r>';
  }
  /* glyph list → runs, grouping same formatting and links */
  function runsXml(doc, glyphs, opts) {
    const out = [];
    let cur = null;
    const flush = () => {
      if (!cur) return;
      const cjk = isCJK(cur.text);
      const xml = textRun(doc, cur.st, cur.text, { under: cur.under, vert: cur.vert, link: cur.link, cjk, hangul: cjk && isHangul(cur.text) });
      if (cur.link) { const id = doc.rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink', cur.link, true); doc.links++; out.push({ link: id, xml }); }
      else out.push({ xml });
      cur = null;
    };
    for (const g of glyphs) {
      if (g.field) { flush(); out.push({ xml: fieldXml(doc, g.field, g.style, g.sample) }); continue; }
      const st = g.style || {};
      const key = [st.font, st.bold, st.italic, st.size, st.color, !!g.under, g.vert || '', g.link || ''].join('|');
      if (cur && (cur.key === key || (g.ch === ' ' && !g.link === !cur.link))) { cur.text += g.ch; continue; }
      flush();
      cur = { key, st, text: g.ch, under: !!g.under, vert: g.vert, link: g.link };
    }
    flush();
    // merge consecutive runs of one link into one hyperlink element
    let xml = '';
    for (let i = 0; i < out.length; i++) {
      if (out[i].link) {
        let inner = out[i].xml; const id = out[i].link;
        while (i + 1 < out.length && out[i + 1].link === id) inner += out[++i].xml;
        xml += '<w:hyperlink r:id="' + id + '" w:history="1">' + inner + '</w:hyperlink>';
      } else xml += out[i].xml;
    }
    return xml;
  }
  function fieldXml(doc, field, st, sample) {
    const rp = rPrXml(doc, st || {});
    return '<w:r>' + rp + '<w:fldChar w:fldCharType="begin"/></w:r><w:r>' + rp + '<w:instrText xml:space="preserve"> ' + field + ' </w:instrText></w:r><w:r>' + rp + '<w:fldChar w:fldCharType="separate"/></w:r><w:r>' + rp + '<w:t>' + esc(sample || '1') + '</w:t></w:r><w:r>' + rp + '<w:fldChar w:fldCharType="end"/></w:r>';
  }
  /* glyphs of a paragraph, with spaces between lines and tabs between columns */
  function paraGlyphs(p) {
    const out = [];
    p.lines.forEach((l, li) => {
      if (li > 0) {
        const last = out[out.length - 1];
        if (last && !(last.ch === '-' && /[a-z]/i.test(l.segs[0].glyphs[0].ch)) && last.ch !== ' ') out.push({ ...last, ch: ' ', link: last.link && l.segs[0].glyphs[0].link === last.link ? last.link : undefined, field: undefined });
      }
      l.segs.forEach((s, si) => {
        let gl = s.glyphs;
        if (si === 0 && li === 0 && p.list) {
          if (p.gluedMarker) gl = gl.slice(p.list.glued);
          else return; // marker segment becomes Word numbering
        }
        if (si > 0 && !(p.list && si === 1 && li === 0)) out.push({ ...gl[0], ch: '\t', link: undefined });
        gl.forEach(g => out.push(g));
      });
    });
    return out;
  }
  function pPrXml(doc, p, o) {
    let x = '';
    if (p.style) x += '<w:pStyle w:val="' + p.style + '"/>';
    if (p.keepNext) x += '<w:keepNext/>';
    if (o.pageBreak) x += '<w:pageBreakBefore/>';
    if (p.numId) x += '<w:numPr><w:ilvl w:val="' + (p.level || 0) + '"/><w:numId w:val="' + p.numId + '"/></w:numPr>';
    if (p.leftBar) x += '<w:pBdr><w:left w:val="single" w:sz="' + Math.max(4, Math.min(96, Math.round(p.leftBar.lw * 8))) + '" w:space="' + Math.max(1, Math.min(31, Math.round(p.lines[0].x0 - p.leftBar.x - p.leftBar.lw))) + '" w:color="' + colorHex(p.leftBar.color) + '"/></w:pBdr>';
    if (p.tabs && p.tabs.length) x += '<w:tabs>' + p.tabs.map(t => '<w:tab w:val="' + t.val + '" w:pos="' + Math.max(0, tw(t.pos)) + '"/>').join('') + '</w:tabs>';
    const before = Math.max(0, Math.round(o.before || 0));
    let sp = '<w:spacing w:before="' + before + '" w:after="0"';
    if (p.lines && p.lines.length > 1 && p.gap) {
      const g = tw(p.gap);
      sp += p.gap < p.size * 1.12 ? ' w:line="' + g + '" w:lineRule="exact"' : ' w:line="' + g + '" w:lineRule="atLeast"';
    }
    x += sp + '/>';
    if (p.ind) {
      const left = Math.max(0, tw(p.ind.left || 0));
      if (p.ind.hanging) x += '<w:ind w:left="' + left + '" w:hanging="' + Math.max(0, tw(p.ind.hanging)) + '"/>';
      else if (left || p.ind.first) x += '<w:ind w:left="' + left + '"' + (p.ind.first > 0.5 ? ' w:firstLine="' + tw(p.ind.first) + '"' : p.ind.first < -0.5 ? ' w:hanging="' + tw(-p.ind.first) + '"' : '') + '/>';
    }
    if (p.align && p.align !== 'left') x += '<w:jc w:val="' + p.align + '"/>';
    if (o.sectPr) x += o.sectPr;
    return '<w:pPr>' + x + '</w:pPr>';
  }
  function paraXml(doc, p, o) {
    const gl = o.glyphs || paraGlyphs(p);
    let markRun = '';
    if (o.markSize) markRun = '<w:rPr><w:sz w:val="' + Math.round(o.markSize * 2) + '"/></w:rPr>';
    return '<w:p>' + pPrXml(doc, p, o).replace('</w:pPr>', markRun + '</w:pPr>') + runsXml(doc, gl) + (o.extraRuns || '') + '</w:p>';
  }
  function borderXml(tag, r) {
    if (!r) return '<w:' + tag + ' w:val="nil"/>';
    const sz = Math.max(2, Math.min(96, Math.round((r.lw || 0.5) * 8)));
    return '<w:' + tag + ' w:val="single" w:sz="' + sz + '" w:space="0" w:color="' + colorHex(r.color) + '"/>';
  }
  function tableXml(doc, t, pg, marginLeft, opts) {
    doc.tables++;
    const widths = t.xs.slice(1).map((x, k) => Math.max(1, tw(x - t.xs[k])));
    const total = widths.reduce((a, b) => a + b, 0);
    let x = '<w:tbl><w:tblPr><w:tblW w:w="' + total + '" w:type="dxa"/><w:tblInd w:w="' + tw(t.x0 - marginLeft) + '" w:type="dxa"/>';
    x += '<w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders>';
    const pads = t.cells.filter(c => c.paras && c.paras.length).map(c => Math.min(...c.paras.map(p => p.lines[0].x0 - c.x0)));
    const pad = Math.max(0, Math.min(t.bordered ? 2.85 : 1.4, pads.length ? Math.min(...pads) - 0.3 : 2.85));
    x += '<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="' + tw(pad) + '" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="' + tw(pad) + '" w:type="dxa"/></w:tblCellMar>';
    x += '<w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>';
    x += '<w:tblGrid>' + widths.map(w => '<w:gridCol w:w="' + w + '"/>').join('') + '</w:tblGrid>';
    const nR = t.ys.length - 1, nC = t.xs.length - 1;
    const at = {};
    t.cells.forEach(c => { for (let r = c.r; r < c.r + c.rs; r++) at[r + ',' + c.c] = c; });
    // header row: shaded or all bold, repeated on each page in Word
    const row0 = t.cells.filter(c => c.r === 0);
    const headerRow = nR > 2 && (row0.every(c => c.shade) || row0.every(c => c.paras && c.paras.length && c.paras.every(p => p.lines.every(l => l.segs.every(s => s.glyphs.every(g => !g.ch.trim() || g.style.bold))))));
    for (let r = 0; r < nR; r++) {
      const h = Math.max(1, tw(t.ys[r + 1] - t.ys[r]));
      x += '<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="' + h + '" w:hRule="atLeast"/>' + (r === 0 && headerRow ? '<w:tblHeader/>' : '') + '</w:trPr>';
      for (let c = 0; c < nC;) {
        const cell = at[r + ',' + c];
        if (!cell) { x += '<w:tc><w:tcPr><w:tcW w:w="' + widths[c] + '" w:type="dxa"/></w:tcPr><w:p/></w:tc>'; c++; continue; }
        const w = widths.slice(c, c + cell.cs).reduce((a, b) => a + b, 0);
        const cont = cell.r !== r;
        let tcPr = '<w:tcW w:w="' + w + '" w:type="dxa"/>';
        if (cell.cs > 1) tcPr += '<w:gridSpan w:val="' + cell.cs + '"/>';
        if (cell.rs > 1) tcPr += cont ? '<w:vMerge/>' : '<w:vMerge w:val="restart"/>';
        tcPr += '<w:tcBorders>' + borderXml('top', cell.borders.top) + borderXml('left', cell.borders.left) + borderXml('bottom', cell.borders.bottom) + borderXml('right', cell.borders.right) + '</w:tcBorders>';
        if (cell.shade) tcPr += '<w:shd w:val="clear" w:color="auto" w:fill="' + cell.shade + '"/>';
        if (cell.paras && cell.paras.length && cell.paras.every(p => p.lines.length === 1) && cell.paras.some(p => p.lines[0].x1 > cell.x1 - 6)) tcPr += '<w:noWrap/>';
        if (cell.valign && cell.valign !== 'top') tcPr += '<w:vAlign w:val="' + cell.valign + '"/>';
        let content = '';
        if (!cont) {
          (cell.items || []).forEach((it, k) => {
            if (it.kind === 'img') content += imageParaXml(doc, it, { align: it.align, before: 0, inlineOnly: true });
            else content += paraXml(doc, it, { before: k === 0 ? 0 : it.before || 0 });
          });
        }
        x += '<w:tc><w:tcPr>' + tcPr + '</w:tcPr>' + (content || '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:p>') + '</w:tc>';
        c += cell.cs;
      }
      x += '</w:tr>';
    }
    return x + '</w:tbl>';
  }
  let docPrId = 1;
  function drawingXml(doc, rid, wPt, hPt, anchor) {
    const cx = Math.round(wPt * EMU), cy = Math.round(hPt * EMU), id = docPrId++;
    const graphic = '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="' + id + '" name="Picture ' + id + '"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>';
    if (!anchor) return '<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="' + id + '" name="Picture ' + id + '"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>' + graphic + '</wp:inline></w:drawing>';
    return '<w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="' + (251658240 + id) + '" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>' + Math.round(anchor.x * EMU) + '</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>' + Math.round(anchor.y * EMU) + '</wp:posOffset></wp:positionV><wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="' + id + '" name="Picture ' + id + '"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>' + graphic + '</wp:anchor></w:drawing>';
  }
  function imageParaXml(doc, it, o) {
    const p = { align: o.align || 'left', ind: o.ind };
    return '<w:p>' + pPrXml(doc, p, o) + '<w:r>' + drawingXml(doc, it.rid, it.x1 - it.x0, it.y1 - it.y0) + '</w:r></w:p>';
  }

  /* ---------------- assemble the document ---------------- */
  async function convert(env, bytes, opts) {
    opts = Object.assign({ pageBreaks: true, headersFooters: true, pages: null, onProgress: () => {} }, opts || {});
    const { L, E, pdfjs } = env;
    docPrId = 1;
    const lib = await L.PDFDocument.load(bytes, { updateMetadata: false });
    const view = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: true }).promise;
    const ctx = { lib, view, fc: E.makeFontCache(L, lib) };
    const pageIdx = opts.pages || Array.from({ length: view.numPages }, (_, i) => i);
    const pages = [];
    for (let k = 0; k < pageIdx.length; k++) {
      opts.onProgress('Reading page ' + (k + 1) + ' of ' + pageIdx.length, k / pageIdx.length * 0.6);
      const pg = await extractPage(env, ctx, pageIdx[k]);
      pg.A = analyzeLayout(pg);
      pages.push(pg);
    }
    const doc = new Doc();
    const hf = opts.headersFooters ? detectHeaderFooter(pages) : null;
    // body font and size: most common by characters
    const fontCount = {}, sizeCount = {};
    pages.forEach(pg => pg.A.lines.forEach(l => (pg.removeLines && pg.removeLines.has(l)) ? null : l.segs.forEach(s => s.glyphs.forEach(g => { if (!g.ch.trim()) return; fontCount[g.style.font] = (fontCount[g.style.font] || 0) + 1; sizeCount[g.style.size] = (sizeCount[g.style.size] || 0) + 1; }))));
    const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])[0];
    if (top(fontCount)) doc.bodyFont = top(fontCount)[0];
    if (top(sizeCount)) doc.bodySize = +top(sizeCount)[0];

    // render pages once for pictures
    const crops = async (pg, items, noText) => {
      if (!items.length) return;
      const scale = Math.min(2.5, 6000 / Math.max(pg.W, pg.H));
      const canvas = env.canvas(Math.ceil(pg.W * scale), Math.ceil(pg.H * scale));
      const c2d = canvas.getContext('2d');
      if (noText) { c2d.fillText = () => {}; c2d.strokeText = () => {}; }
      c2d.fillStyle = '#fff'; c2d.fillRect(0, 0, canvas.width, canvas.height);
      await pg.page.render({ canvasContext: c2d, viewport: pg.page.getViewport({ scale, rotation: pg.rot }) }).promise;
      for (const it of items) {
        const sx = Math.max(0, Math.floor(it.x0 * scale)), sy = Math.max(0, Math.floor(it.y0 * scale));
        const sw = Math.min(canvas.width - sx, Math.ceil((it.x1 - it.x0) * scale)), sh = Math.min(canvas.height - sy, Math.ceil((it.y1 - it.y0) * scale));
        if (sw < 2 || sh < 2) continue;
        const out = env.canvas(sw, sh);
        out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
        it.rid = doc.addMedia(await env.png(out));
      }
    };

    // per page: blocks in reading order
    const sections = [];
    for (let k = 0; k < pages.length; k++) {
      const pg = pages[k], A = pg.A;
      opts.onProgress('Laying out page ' + (k + 1), 0.6 + k / pages.length * 0.3);
      const rmL = pg.removeLines || new Set(), rmI = pg.removeImgs || new Set();
      let lines = A.lines.filter(l => !rmL.has(l));
      const images = A.images.filter(i => !rmI.has(i));
      // table contents
      const cellOf = (t, x, y) => t.cells.find(c => x >= c.x0 - 1 && x <= c.x1 + 1 && y >= c.y0 - 1 && y <= c.y1 + 1);
      const tableLines = new Set();
      for (const t of A.tables) {
        const per = new Map();
        for (const l of lines) {
          if (l.y < t.y0 - 1 || l.y > t.y1 + 1 || l.x1 < t.x0 || l.x0 > t.x1) continue;
          tableLines.add(l);
          // a line may cross cells: split its glyphs at the cell borders
          for (const s of l.segs) {
            let cur = null, curCell = null;
            const flush = () => {
              if (!cur || !curCell) return;
              while (cur.length && !cur[cur.length - 1].ch.trim()) cur.pop();
              while (cur.length && !cur[0].ch.trim()) cur.shift();
              if (!cur.length) return;
              const seg = { glyphs: cur, x0: cur[0].x0, x1: cur[cur.length - 1].x1, text: cur.map(g => g.ch).join('') };
              if (!per.has(curCell)) per.set(curCell, []);
              per.get(curCell).push({ ...l, segs: [seg], x0: seg.x0, x1: seg.x1, text: seg.text });
            };
            for (const g of s.glyphs) {
              const c = cellOf(t, (g.x0 + g.x1) / 2, l.y);
              if (c !== curCell) { flush(); cur = []; curCell = c; }
              cur.push(g);
            }
            flush();
          }
        }
        for (const c of t.cells) {
          const ls = (per.get(c) || []).sort((a, b) => a.y - b.y || a.x0 - b.x0);
          // merge segments that share a baseline in one cell back into one line
          const merged = [];
          for (const l of ls) { const m = merged.find(o => Math.abs(o.y - l.y) < 0.5); if (m) { m.segs = m.segs.concat(l.segs).sort((a, b) => a.x0 - b.x0); m.x1 = Math.max(m.x1, l.x1); m.text = m.segs.map(s => s.text).join('\t'); } else merged.push({ ...l }); }
          const region = { x0: c.x0 + Math.min(2.85, Math.max(0, (merged.length ? Math.min(...merged.map(l => l.x0)) : c.x0) - c.x0 - 0.3)), x1: c.x1 - 1 };
          const paras = buildParas(merged, region);
          c.paras = paras;
          c.items = paras.map((p, i) => { if (i > 0) p.before = tw(p.top - paras[i - 1].bottom); return p; });
          if (paras.length) {
            const topGap = paras[0].top - c.y0, botGap = c.y1 - paras[paras.length - 1].bottom;
            c.valign = Math.abs(topGap - botGap) < 3 && topGap > 3 ? 'center' : (topGap > botGap + 6 ? 'bottom' : 'top');
          }
        }
        // images inside cells
        for (const im of images) {
          const c = cellOf(t, (im.x0 + im.x1) / 2, (im.y0 + im.y1) / 2);
          if (c) { im.inCell = true; c.items = (c.items || []).concat([{ kind: 'img', ...im, align: 'center' }]); }
        }
      }
      lines = lines.filter(l => !tableLines.has(l));
      const region = { x0: 0, x1: pg.W };
      const loose = findLooseTables(lines, A.G.Hr, { x0: Math.min(...lines.map(l => l.x0), pg.W), x1: Math.max(...lines.map(l => l.x1), 0) });
      for (const t of loose.tables) for (const c of t.cells) {
        const paras = buildParas(c.lines, { x0: c.x0 + 1.4, x1: c.x1 - 1.4 });
        // keep right-aligned numbers right-aligned
        if (!t.columns) paras.forEach(p => { const col = t.cells.filter(o => o.c === c.c && o.lines.length); const R = (o) => o.lines[0].x1, Lx = (o) => o.lines[0].x0; if (col.length > 1 && col.every(o => Math.abs(R(o) - R(col[0])) < 2) && !col.every(o => Math.abs(Lx(o) - Lx(col[0])) < 2)) { p.align = 'right'; p.ind = { left: 0 }; } });
        paras.forEach((p, i) => { if (i > 0) p.before = tw(p.top - paras[i - 1].bottom); });
        c.paras = paras; c.items = paras;
      }
      lines = lines.filter(l => !loose.used.has(l));
      pg.contentLines = lines;
      pg.blocksRaw = { lines, tables: A.tables.concat(loose.tables), figures: A.figures, images: images.filter(i => !i.inCell), rules: A.rules.filter(h => !h.usedByTable) };
    }

    // margins from body content per orientation group
    const bodyBox = (pg) => {
      const B = pg.blocksRaw;
      const xs0 = [], xs1 = [], ys0 = [], ys1 = [];
      B.lines.forEach(l => { xs0.push(l.x0); xs1.push(l.x1); ys0.push(l.top); ys1.push(l.bottom); });
      B.tables.forEach(t => { xs0.push(t.x0); xs1.push(t.x1); ys0.push(t.y0); ys1.push(t.y1); });
      B.figures.concat(B.images).forEach(f => { xs0.push(f.x0); xs1.push(f.x1); ys0.push(f.y0); ys1.push(f.y1); });
      if (!xs0.length) return null;
      return { x0: Math.min(...xs0), x1: Math.max(...xs1), y0: Math.min(...ys0), y1: Math.max(...ys1) };
    };
    let curSec = null;
    for (const pg of pages) {
      const key = Math.round(pg.W) + 'x' + Math.round(pg.H);
      if (!curSec || curSec.key !== key) { curSec = { key, W: pg.W, H: pg.H, pages: [] }; sections.push(curSec); }
      curSec.pages.push(pg);
    }
    for (const s of sections) {
      const boxes = s.pages.map(bodyBox).filter(Boolean);
      const mL = boxes.length ? Math.min(...boxes.map(b => b.x0)) : 72, mR = boxes.length ? s.W - Math.max(...boxes.map(b => b.x1)) : 72;
      const mT = boxes.length ? Math.min(...boxes.map(b => b.y0)) : 72, mB = boxes.length ? s.H - Math.max(...boxes.map(b => b.y1)) : 72;
      // the bottom margin can't come from where text happens to end (short pages end early)
      s.margin = { left: Math.max(18, Math.min(mL, s.W / 3)), right: Math.max(18, Math.min(mR - 2, s.W / 3)), top: Math.max(18, Math.min(mT - 2, s.H / 3)), bottom: Math.max(18, Math.min(mB - 4, 54)) };
    }

    // headers/footers
    let headerXml = null, footerXml = null;
    if (hf) {
      const s0 = sections.find(s => s.pages.some(p => hf.pagesWith.has(p.pi))) || sections[0];
      const m = s0.margin;
      const buildHF = async (band) => {
        if (!band.lines.length && !band.images.length) return null;
        let x = '';
        const lines = band.lines.slice().sort((a, b) => a.line.y - b.line.y);
        // page number fields replace their digits
        for (const b of lines) {
          if (!b.fields.some(Boolean)) continue;
          let gi = 0;
          for (const s of b.line.segs) {
            const g2 = [];
            const txt = s.glyphs.map(g => g.ch).join('');
            const re = /\d+/g; let mm, pos = 0;
            while ((mm = re.exec(txt))) {
              for (let q = pos; q < mm.index; q++) g2.push(s.glyphs[q]);
              const f = b.fields[gi++];
              if (f) g2.push({ ...s.glyphs[mm.index], field: f.field, sample: mm[0] });
              else for (let q = mm.index; q < mm.index + mm[0].length; q++) g2.push(s.glyphs[q]);
              pos = mm.index + mm[0].length;
            }
            for (let q = pos; q < s.glyphs.length; q++) g2.push(s.glyphs[q]);
            s.glyphs = g2;
          }
        }
        const paras = buildParas(lines.map(b => b.line), { x0: m.left, x1: s0.W - m.right });
        let prevBottom = null;
        // pictures in the header are anchored to the page so they stay where they were
        let anchors = '';
        for (const im of band.images) {
          await crops(im.pg, [im], true);
          if (im.rid) anchors += '<w:r>' + drawingXml(doc, im.rid, im.x1 - im.x0, im.y1 - im.y0, { x: im.x0, y: im.y0 }) + '</w:r>';
        }
        const areaTop = Math.min(...lines.map(b => b.line.top), ...band.images.map(i => i.y0));
        paras.forEach((p, i) => {
          x += paraXml(doc, p, { before: tw(Math.max(0, p.top - (prevBottom == null ? areaTop : prevBottom))), extraRuns: i === 0 ? anchors : '' });
          prevBottom = p.bottom;
        });
        if (!paras.length) x = '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>' + anchors + '</w:p>';
        const top = Math.min(...lines.map(b => b.line.top), ...band.images.map(i => i.y0));
        const bottom = Math.max(...lines.map(b => b.line.bottom), ...band.images.map(i => i.y1));
        return { xml: x, top, bottom };
      };
      const hh = await buildHF(hf.header), ff = await buildHF(hf.footer);
      const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
      if (hh) { headerXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ' + NS + '>' + hh.xml + '</w:hdr>'; hf.headerTop = hh.top; hf.headerBottom = hh.bottom; }
      if (ff) { footerXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ' + NS + '>' + ff.xml + '</w:ftr>'; hf.footerTop = ff.top; hf.footerBottom = ff.bottom; }
      // body must start below the header and end above the footer
      sections.forEach(s => {
        if (hh) s.margin.top = Math.max(s.margin.top, Math.min(hh.bottom + 4, s.H / 3));
        if (ff) s.margin.bottom = Math.max(18, Math.min(s.H - ff.top + 4, s.H / 3));
        s.hdrDist = hh ? Math.max(8, hh.top) : 36; s.ftrDist = ff ? Math.max(8, s.H - ff.bottom) : 36;
      });
    }
    const hdrRid = headerXml ? doc.rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/header', 'header1.xml') : null;
    const ftrRid = footerXml ? doc.rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer', 'footer1.xml') : null;
    const sectPrXml = (s) => {
      let x = '<w:sectPr>';
      if (hdrRid) x += '<w:headerReference w:type="default" r:id="' + hdrRid + '"/>';
      if (ftrRid) x += '<w:footerReference w:type="default" r:id="' + ftrRid + '"/>';
      x += '<w:type w:val="nextPage"/><w:pgSz w:w="' + tw(s.W) + '" w:h="' + tw(s.H) + '"' + (s.W > s.H ? ' w:orient="landscape"' : '') + '/>';
      x += '<w:pgMar w:top="' + tw(s.margin.top) + '" w:right="' + tw(s.margin.right) + '" w:bottom="' + tw(s.margin.bottom) + '" w:left="' + tw(s.margin.left) + '" w:header="' + tw(s.hdrDist || 36) + '" w:footer="' + tw(s.ftrDist || 36) + '" w:gutter="0"/>';
      if (hf && hf.pageStart !== 1) x += '<w:pgNumType w:start="' + hf.pageStart + '"/>';
      if (hf && hf.titlePg) x += '<w:titlePg/>';
      return x + '</w:sectPr>';
    };

    // headings: sizes larger than body text, or bold short lines followed by body text
    const allParas = [];
    for (const s of sections) for (const pg of s.pages) {
      const region = { x0: s.margin.left, x1: s.W - s.margin.right };
      pg.paras = buildParas(pg.blocksRaw.lines, region);
      for (const p of pg.paras) {
        const bar = pg.A.G.Vr.find(v => !v.usedByTable && v.x < p.lines[0].x0 - 1 && v.x > p.lines[0].x0 - 16 && overlap(v.y0, v.y1, p.top, p.bottom) > (p.bottom - p.top) * 0.6);
        if (bar) { p.leftBar = bar; bar.usedByTable = true; }
      }
      pg.paras.forEach(p => allParas.push(p));
    }
    const boldAll = (p) => p.lines.every(l => l.segs.every(s => s.glyphs.every(g => !g.ch.trim() || g.style.bold)));
    const sizeOf = (p) => Math.round(Math.max(...p.lines.flatMap(l => l.segs.flatMap(s => s.glyphs.filter(g => g.ch.trim()).map(g => g.style.size)))) * 2) / 2;
    const cands = allParas.filter((p, i) => !p.list && !p.tabbed && p.lines.length <= 2 && p.text.length <= 110 && !/[.,;]$/.test(p.text.trim()) && /[A-Za-zㄱ-힣]/.test(p.text) && !/^[^:]{1,30}:\s+\S/.test(p.text) &&
      (sizeOf(p) >= doc.bodySize * 1.18 || (boldAll(p) && sizeOf(p) >= doc.bodySize - 0.6 && p.lines[0].segs.length === 1 && allParas[i + 1] && !boldAll(allParas[i + 1]))));
    const sizes = [...new Set(cands.map(p => sizeOf(p) + (boldAll(p) ? 0.01 : 0)))].sort((a, b) => b - a);
    cands.forEach(p => { const lvl = Math.min(3, sizes.indexOf(sizeOf(p) + (boldAll(p) ? 0.01 : 0)) + 1); p.style = 'Heading' + lvl; p.keepNext = true; doc.headings++; });

    // lists: consecutive items share a Word list (body, then each table cell)
    const assignLists = (paras) => {
    let lastList = null;
    for (const p of paras) {
      if (!p.list) { lastList = null; continue; }
      const kind = p.list.kind;
      if (!lastList || lastList.kind !== kind || Math.abs(lastList.x - p.lines[0].x0) > 30) {
        lastList = { kind, x: p.lines[0].x0, numId: doc.newNum(kind, kind === 'bullet' ? 1 : p.list.start), levels: [p.lines[0].x0] };
        doc.lists++;
      }
      let lvl = lastList.levels.findIndex(x => Math.abs(x - p.lines[0].x0) < 6);
      if (lvl < 0) { lastList.levels.push(p.lines[0].x0); lvl = lastList.levels.length - 1; }
      p.numId = lastList.numId; p.level = Math.min(lvl, 2);
      if (p.list.kind === 'bullet') p.bulletChar = p.list.marker;
    }
    };
    assignLists(allParas);
    for (const s of sections) for (const pg of s.pages) for (const t of pg.blocksRaw.tables) for (const c of t.cells) if (c.paras) assignLists(c.paras);

    // emit body
    let body = '';
    for (let si = 0; si < sections.length; si++) {
      const s = sections[si], m = s.margin;
      for (let pi = 0; pi < s.pages.length; pi++) {
        const pg = s.pages[pi];
        const B = pg.blocksRaw;
        await crops(pg, B.figures, false);
        await crops(pg, B.images, true);
        const blocks = [];
        pg.paras.forEach(p => blocks.push({ kind: 'p', top: p.top, bottom: p.bottom, p }));
        B.tables.forEach(t => blocks.push({ kind: 't', top: t.y0, bottom: t.y1, t }));
        B.figures.concat(B.images).forEach(f => { if (f.rid) blocks.push({ kind: 'img', top: f.y0, bottom: f.y1, f }); });
        (B.rules || []).forEach(h => blocks.push({ kind: 'rule', top: h.y - 1, bottom: h.y + 1, h }));
        blocks.sort((a, b) => a.top - b.top);
        // pictures beside text are anchored where they were; pictures on their own line flow inline
        const anchored = [];
        const flow = [];
        for (const b of blocks) {
          if (b.kind === 'img') {
            const beside = blocks.some(o => o !== b && o.kind === 'p' && overlap(o.top, o.bottom, b.top, b.bottom) > Math.min(o.bottom - o.top, b.bottom - b.top) * 0.5 && overlap(o.p.lines[0].x0, o.p.lines[0].x1, b.f.x0, b.f.x1) <= 0);
            if (beside) { anchored.push(b); continue; }
          }
          flow.push(b);
        }
        let prevBottom = m.top;
        const firstOfPage = si > 0 || pi > 0;
        let pageBreakDone = !(firstOfPage && opts.pageBreaks && pi > 0);
        let anchorRuns = anchored.map(b => '<w:r>' + drawingXml(doc, b.f.rid, b.f.x1 - b.f.x0, b.f.y1 - b.f.y0, { x: b.f.x0, y: b.f.y0 }) + '</w:r>').join('');
        if (!flow.length && (anchorRuns || !pageBreakDone)) flow.push({ kind: 'empty', top: m.top, bottom: m.top });
        const newPage = (si > 0 && pi === 0) || pi > 0;
        for (let bi = 0; bi < flow.length; bi++) {
          const b = flow[bi];
          let before = opts.pageBreaks ? tw(Math.max(0, b.top - prevBottom)) : (bi === 0 ? 0 : tw(Math.max(0, b.top - prevBottom)));
          let pb = !pageBreakDone;
          if (bi === 0 && newPage && opts.pageBreaks) {
            // an exact-height spacer carries the page break and the gap below the top margin
            body += '<w:p><w:pPr>' + (pb ? '<w:pageBreakBefore/>' : '') + '<w:spacing w:before="0" w:after="0" w:line="' + Math.max(20, before) + '" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>';
            before = 0; pb = false; pageBreakDone = true;
          }
          if (b.kind === 'p') {
            body += paraXml(doc, b.p, { before, pageBreak: pb, extraRuns: anchorRuns });
            anchorRuns = '';
          } else if (b.kind === 'img') {
            const align = Math.abs((b.f.x0 + b.f.x1) / 2 - s.W / 2) < 12 ? 'center' : (b.f.x0 - m.left > 20 ? 'left' : 'left');
            const ind = align === 'left' ? { left: b.f.x0 - m.left } : null;
            body += '<w:p>' + pPrXml(doc, { align, ind }, { before, pageBreak: pb }) + '<w:r>' + drawingXml(doc, b.f.rid, b.f.x1 - b.f.x0, b.f.y1 - b.f.y0) + '</w:r>' + anchorRuns + '</w:p>';
            anchorRuns = '';
          } else if (b.kind === 't') {
            if (pb || anchorRuns || before > 40) {
              body += '<w:p>' + pPrXml(doc, {}, { before: Math.max(0, before - 40), pageBreak: pb, markSize: 1 }).replace('<w:spacing ', '<w:spacing w:line="20" w:lineRule="exact" ') + anchorRuns + '</w:p>';
              anchorRuns = '';
            }
            body += tableXml(doc, b.t, pg, m.left, opts);
          } else if (b.kind === 'rule') {
            // a drawn line across the page: an empty paragraph with a bottom border
            const h = b.h, sz = Math.max(2, Math.min(96, Math.round(h.lw * 8)));
            const ppr = pPrXml(doc, { ind: { left: h.x0 - m.left } }, { before: Math.max(0, before - 20), pageBreak: pb }).replace('<w:spacing ', '<w:pBdr><w:bottom w:val="single" w:sz="' + sz + '" w:space="1" w:color="' + colorHex(h.color) + '"/></w:pBdr><w:spacing w:line="20" w:lineRule="exact" ');
            body += '<w:p>' + ppr.replace('</w:pPr>', (h.x1 < s.W - m.right - 6 ? '' : '') + '</w:pPr>').replace('<w:ind w:left="', '<w:ind w:right="' + Math.max(0, tw(s.W - m.right - h.x1)) + '" w:left="') + anchorRuns + '</w:p>';
            anchorRuns = '';
          } else {
            body += '<w:p>' + pPrXml(doc, {}, { before: 0, pageBreak: pb }) + anchorRuns + '</w:p>';
            anchorRuns = '';
          }
          pageBreakDone = true;
          prevBottom = b.bottom;
        }
        if (pg.A.scanned) doc.scanned = (doc.scanned || 0) + 1;
      }
      // section break after this section (except the last, which uses body sectPr)
      if (si < sections.length - 1) body += '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr>' + sectPrXml(s) + '</w:pPr></w:p>';
    }
    const last = sections[sections.length - 1];
    const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
    const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ' + NS + '><w:body>' + body + sectPrXml(last) + '</w:body></w:document>';
    opts.onProgress('Packaging', 0.95);
    const files = packageDocx(doc, documentXml, headerXml, footerXml, opts);
    const zip = await zipFiles(files);
    return { bytes: zip, report: { figures: pages.map(pg => pg.A.figures.map(f => [f.x0, f.y0, f.x1, f.y1].map(Math.round))), pages: pages.length, headings: doc.headings, tables: doc.tables, lists: doc.lists, images: doc.images, links: doc.links, headerFooter: !!(headerXml || footerXml), scanned: doc.scanned || 0, bodyFont: doc.bodyFont, bodySize: doc.bodySize } };
  }

  function packageDocx(doc, documentXml, headerXml, footerXml, opts) {
    const enc = new TextEncoder();
    const sz = Math.round(doc.bodySize * 2);
    const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="' + esc(doc.bodyFont) + '" w:hAnsi="' + esc(doc.bodyFont) + '" w:cs="' + esc(doc.bodyFont) + '" w:eastAsia="Malgun Gothic"/><w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/><w:lang w:val="en-US" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:widowControl w:val="0"/></w:pPr></w:style>' +
      [1, 2, 3].map(l => '<w:style w:type="paragraph" w:styleId="Heading' + l + '"><w:name w:val="heading ' + l + '"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="' + (l - 1) + '"/></w:pPr></w:style>').join('') +
      '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/></w:style>' +
      '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>' +
      '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>' +
      '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
      '</w:styles>';
    const lvlXml = (kind, l) => {
      const ind = '<w:pPr><w:ind w:left="' + (360 * (l + 1)) + '" w:hanging="360"/></w:pPr>';
      if (kind === 'bullet') { const ch = ['•', '◦', '▪'][l]; return '<w:lvl w:ilvl="' + l + '"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="' + ch + '"/><w:lvlJc w:val="left"/>' + ind + '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr></w:lvl>'; }
      const fmt = kind === 'decimal' ? ['decimal', 'lowerLetter', 'lowerRoman'][l] : kind === 'alpha' ? 'lowerLetter' : 'lowerRoman';
      return '<w:lvl w:ilvl="' + l + '"><w:start w:val="1"/><w:numFmt w:val="' + fmt + '"/><w:lvlText w:val="%' + (l + 1) + '."/><w:lvlJc w:val="left"/>' + ind + '</w:lvl>';
    };
    const kinds = ['bullet', 'decimal', 'alpha', 'roman'];
    let numbering = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">';
    kinds.forEach((k, i) => { numbering += '<w:abstractNum w:abstractNumId="' + i + '"><w:multiLevelType w:val="hybridMultilevel"/>' + [0, 1, 2].map(l => lvlXml(k, l)).join('') + '</w:abstractNum>'; });
    doc.nums.forEach(n => { numbering += '<w:num w:numId="' + n.id + '"><w:abstractNumId w:val="' + kinds.indexOf(n.kind) + '"/>' + (n.kind !== 'bullet' ? '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="' + n.start + '"/></w:lvlOverride>' : '') + '</w:num>'; });
    numbering += '</w:numbering>';
    const settings = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>';
    let rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>';
    doc.rels.forEach(r => { rels += '<Relationship Id="' + r.id + '" Type="' + r.type + '" Target="' + esc(r.target) + '"' + (r.ext ? ' TargetMode="External"' : '') + '/>'; });
    rels += '</Relationships>';
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
      (headerXml ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : '') +
      (footerXml ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : '') +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>';
    const core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>' + esc(opts.title || '') + '</dc:title><dc:creator>Folio PDF Editor</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified></cp:coreProperties>';
    const app = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Folio PDF Editor</Application></Properties>';
    const files = [
      ['[Content_Types].xml', ct], ['_rels/.rels', rootRels], ['docProps/core.xml', core], ['docProps/app.xml', app],
      ['word/document.xml', documentXml], ['word/styles.xml', styles], ['word/settings.xml', settings], ['word/numbering.xml', numbering], ['word/_rels/document.xml.rels', rels]
    ].map(([n, s]) => ({ name: n, data: enc.encode(s) }));
    if (headerXml) files.push({ name: 'word/header1.xml', data: enc.encode(headerXml) });
    if (footerXml) files.push({ name: 'word/footer1.xml', data: enc.encode(footerXml) });
    // headers need their own relationships for pictures
    const hdrRels = doc.rels.filter(r => /image|hyperlink/.test(r.type)).map(r => '<Relationship Id="' + r.id + '" Type="' + r.type + '" Target="' + esc(r.target) + '"' + (r.ext ? ' TargetMode="External"' : '') + '/>').join('');
    if (headerXml) files.push({ name: 'word/_rels/header1.xml.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + hdrRels + '</Relationships>') });
    if (footerXml) files.push({ name: 'word/_rels/footer1.xml.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + hdrRels + '</Relationships>') });
    doc.media.forEach(m => files.push({ name: 'word/media/' + m.name, data: m.bytes, stored: true }));
    return files;
  }

  /* ---------------- zip (deflate when the browser can) ---------------- */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (d) => { let c = 0xFFFFFFFF; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  async function deflateRaw(data) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      const cs = new CompressionStream('deflate-raw');
      const out = new Response(new Blob([data]).stream().pipeThrough(cs)).arrayBuffer();
      return new Uint8Array(await out);
    } catch (e) { return null; }
  }
  async function zipFiles(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name), c = crc32(f.data);
      let data = f.data, method = 0;
      if (!f.stored) { const d = await deflateRaw(f.data); if (d && d.length < f.data.length) { data = d; method = 8; } }
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, method, true);
      lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true); lh.setUint32(14, c, true); lh.setUint32(18, data.length, true); lh.setUint32(22, f.data.length, true); lh.setUint16(26, name.length, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, method, true);
      ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true); ch.setUint32(16, c, true); ch.setUint32(20, data.length, true); ch.setUint32(24, f.data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), name);
      off += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
    const all = parts.concat(central, [new Uint8Array(end.buffer)]);
    const total = all.reduce((s, p) => s + p.length, 0), out = new Uint8Array(total);
    let p = 0; all.forEach(a => { out.set(a, p); p += a.length; });
    return out;
  }

  const api = { convert, mapFont, _internal: { buildLines, buildParas, findTables, classifyShapes, findLooseTables } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PDFToDocx = api;
})(typeof self !== 'undefined' ? self : this);
