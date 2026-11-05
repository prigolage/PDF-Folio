/* PDF standard security handler: removes encryption (RC4 40/128, AES-128, AES-256)
 * so the document can be edited. Needs pdf-lib (PDFLib). */
(function (root) {
  'use strict';

  /* ---------- MD5 ---------- */
  function md5(data) {
    const K = new Uint32Array(64), S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    const len = data.length, padLen = ((len + 8) >> 6) + 1 << 6;
    const buf = new Uint8Array(padLen); buf.set(data); buf[len] = 0x80;
    const bits = len * 8;
    buf[padLen - 8] = bits & 255; buf[padLen - 7] = (bits >>> 8) & 255; buf[padLen - 6] = (bits >>> 16) & 255; buf[padLen - 5] = (bits >>> 24) & 255;
    buf[padLen - 4] = Math.floor(len / 536870912) & 255;
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const M = new Uint32Array(16);
    for (let off = 0; off < padLen; off += 64) {
      for (let i = 0; i < 16; i++) M[i] = buf[off + i * 4] | (buf[off + i * 4 + 1] << 8) | (buf[off + i * 4 + 2] << 16) | (buf[off + i * 4 + 3] << 24);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
        else { F = C ^ (B | ~D); g = (7 * i) & 15; }
        F = (F + A + K[i] + M[g]) | 0;
        A = D; D = C; C = B;
        B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    const out = new Uint8Array(16);
    [a0, b0, c0, d0].forEach((v, k) => { out[k * 4] = v & 255; out[k * 4 + 1] = (v >>> 8) & 255; out[k * 4 + 2] = (v >>> 16) & 255; out[k * 4 + 3] = (v >>> 24) & 255; });
    return out;
  }

  /* ---------- RC4 ---------- */
  function rc4(key, data) {
    const s = new Uint8Array(256);
    for (let i = 0; i < 256; i++) s[i] = i;
    for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; const t = s[i]; s[i] = s[j]; s[j] = t; }
    const out = new Uint8Array(data.length);
    for (let k = 0, i = 0, j = 0; k < data.length; k++) {
      i = (i + 1) & 255; j = (j + s[i]) & 255; const t = s[i]; s[i] = s[j]; s[j] = t;
      out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
    }
    return out;
  }

  /* ---------- AES (128/256), CBC ---------- */
  const SBOX = new Uint8Array(256), INV = new Uint8Array(256);
  (function () {
    let p = 1, q = 1;
    do {
      p = p ^ ((p << 1) & 255) ^ (p & 0x80 ? 0x1b : 0);
      q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 255; if (q & 0x80) q ^= 0x09;
      const x = q ^ ((q << 1) | (q >> 7)) & 255 ^ ((q << 2) | (q >> 6)) & 255 ^ ((q << 3) | (q >> 5)) & 255 ^ ((q << 4) | (q >> 4)) & 255;
      SBOX[p] = (x ^ 0x63) & 255;
    } while (p !== 1);
    SBOX[0] = 0x63;
    for (let i = 0; i < 256; i++) INV[SBOX[i]] = i;
  })();
  const xt = (a) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 255;
  const gmul = (a, b) => { let r = 0; while (b) { if (b & 1) r ^= a; a = xt(a); b >>= 1; } return r; };
  function expandKey(key) {
    const Nk = key.length / 4, Nr = Nk + 6, w = new Uint8Array(16 * (Nr + 1));
    w.set(key);
    let rcon = 1;
    for (let i = Nk; i < 4 * (Nr + 1); i++) {
      let t = w.slice((i - 1) * 4, i * 4);
      if (i % Nk === 0) { t = new Uint8Array([SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]); rcon = xt(rcon); }
      else if (Nk > 6 && i % Nk === 4) t = t.map(b => SBOX[b]);
      for (let k = 0; k < 4; k++) w[i * 4 + k] = w[(i - Nk) * 4 + k] ^ t[k];
    }
    return { w, Nr };
  }
  function encBlock(ks, inp) {
    const s = new Uint8Array(inp), { w, Nr } = ks;
    for (let i = 0; i < 16; i++) s[i] ^= w[i];
    for (let r = 1; r <= Nr; r++) {
      for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
      const t = s.slice();
      for (let c = 0; c < 4; c++) for (let rw = 0; rw < 4; rw++) s[c * 4 + rw] = t[((c + rw) % 4) * 4 + rw];
      if (r !== Nr) for (let c = 0; c < 4; c++) {
        const a = s.slice(c * 4, c * 4 + 4);
        s[c * 4] = xt(a[0]) ^ xt(a[1]) ^ a[1] ^ a[2] ^ a[3];
        s[c * 4 + 1] = a[0] ^ xt(a[1]) ^ xt(a[2]) ^ a[2] ^ a[3];
        s[c * 4 + 2] = a[0] ^ a[1] ^ xt(a[2]) ^ xt(a[3]) ^ a[3];
        s[c * 4 + 3] = xt(a[0]) ^ a[0] ^ a[1] ^ a[2] ^ xt(a[3]);
      }
      for (let i = 0; i < 16; i++) s[i] ^= w[r * 16 + i];
    }
    return s;
  }
  function decBlock(ks, inp) {
    const s = new Uint8Array(inp), { w, Nr } = ks;
    for (let i = 0; i < 16; i++) s[i] ^= w[Nr * 16 + i];
    for (let r = Nr - 1; r >= 0; r--) {
      const t = s.slice();
      for (let c = 0; c < 4; c++) for (let rw = 0; rw < 4; rw++) s[((c + rw) % 4) * 4 + rw] = t[c * 4 + rw];
      for (let i = 0; i < 16; i++) s[i] = INV[s[i]];
      for (let i = 0; i < 16; i++) s[i] ^= w[r * 16 + i];
      if (r !== 0) for (let c = 0; c < 4; c++) {
        const a = s.slice(c * 4, c * 4 + 4);
        s[c * 4] = gmul(a[0], 14) ^ gmul(a[1], 11) ^ gmul(a[2], 13) ^ gmul(a[3], 9);
        s[c * 4 + 1] = gmul(a[0], 9) ^ gmul(a[1], 14) ^ gmul(a[2], 11) ^ gmul(a[3], 13);
        s[c * 4 + 2] = gmul(a[0], 13) ^ gmul(a[1], 9) ^ gmul(a[2], 14) ^ gmul(a[3], 11);
        s[c * 4 + 3] = gmul(a[0], 11) ^ gmul(a[1], 13) ^ gmul(a[2], 9) ^ gmul(a[3], 14);
      }
    }
    return s;
  }
  // table-free AES is slow; cache decryption round tables per key for bulk work
  function aesCbcDecrypt(key, data, iv, unpad) {
    const ks = expandKey(key);
    const n = data.length - (data.length % 16);
    const out = new Uint8Array(n);
    let prev = iv;
    for (let o = 0; o < n; o += 16) {
      const blk = data.subarray(o, o + 16);
      const d = decBlock(ks, blk);
      for (let i = 0; i < 16; i++) out[o + i] = d[i] ^ prev[i];
      prev = blk;
    }
    if (unpad && n) { const p = out[n - 1]; if (p >= 1 && p <= 16) return out.subarray(0, n - p); }
    return out;
  }
  function aesCbcEncryptNoPad(key, data, iv) {
    const ks = expandKey(key), out = new Uint8Array(data.length);
    let prev = iv;
    for (let o = 0; o < data.length; o += 16) {
      const blk = new Uint8Array(16);
      for (let i = 0; i < 16; i++) blk[i] = data[o + i] ^ prev[i];
      const e = encBlock(ks, blk); out.set(e, o); prev = e;
    }
    return out;
  }

  /* ---------- SHA-2 via WebCrypto ---------- */
  const subtle = (root.crypto && root.crypto.subtle) || (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle);
  // pure-JS fallback for pages without WebCrypto (non-secure contexts)
  const K256 = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  function sha256js(data) {
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const len = data.length, n = ((len + 9 + 63) >> 6) << 6, b = new Uint8Array(n); b.set(data); b[len] = 0x80;
    const dv = new DataView(b.buffer); dv.setUint32(n - 4, len * 8); dv.setUint32(n - 8, Math.floor(len / 536870912));
    const W = new Uint32Array(64), rotr = (x, r) => (x >>> r) | (x << (32 - r));
    for (let o = 0; o < n; o += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) { const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3), s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10); W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0; }
      let [a, bb, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + W[i]) | 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
      }
      H[0] += a; H[1] += bb; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    const out = new Uint8Array(32), od = new DataView(out.buffer); H.forEach((v, i) => od.setUint32(i * 4, v)); return out;
  }
  let K512 = null;
  function sha512js(data, is384) {
    const M = (1n << 64n) - 1n;
    if (!K512) K512 = ['428a2f98d728ae22','7137449123ef65cd','b5c0fbcfec4d3b2f','e9b5dba58189dbbc','3956c25bf348b538','59f111f1b605d019','923f82a4af194f9b','ab1c5ed5da6d8118','d807aa98a3030242','12835b0145706fbe','243185be4ee4b28c','550c7dc3d5ffb4e2','72be5d74f27b896f','80deb1fe3b1696b1','9bdc06a725c71235','c19bf174cf692694','e49b69c19ef14ad2','efbe4786384f25e3','0fc19dc68b8cd5b5','240ca1cc77ac9c65','2de92c6f592b0275','4a7484aa6ea6e483','5cb0a9dcbd41fbd4','76f988da831153b5','983e5152ee66dfab','a831c66d2db43210','b00327c898fb213f','bf597fc7beef0ee4','c6e00bf33da88fc2','d5a79147930aa725','06ca6351e003826f','142929670a0e6e70','27b70a8546d22ffc','2e1b21385c26c926','4d2c6dfc5ac42aed','53380d139d95b3df','650a73548baf63de','766a0abb3c77b2a8','81c2c92e47edaee6','92722c851482353b','a2bfe8a14cf10364','a81a664bbc423001','c24b8b70d0f89791','c76c51a30654be30','d192e819d6ef5218','d69906245565a910','f40e35855771202a','106aa07032bbd1b8','19a4c116b8d2d0c8','1e376c085141ab53','2748774cdf8eeb99','34b0bcb5e19b48a8','391c0cb3c5c95a63','4ed8aa4ae3418acb','5b9cca4f7763e373','682e6ff3d6b2b8a3','748f82ee5defb2fc','78a5636f43172f60','84c87814a1f0ab72','8cc702081a6439ec','90befffa23631e28','a4506cebde82bde9','bef9a3f7b2c67915','c67178f2e372532b','ca273eceea26619c','d186b8c721c0c207','eada7dd6cde0eb1e','f57d4f7fee6ed178','06f067aa72176fba','0a637dc5a2c898a6','113f9804bef90dae','1b710b35131c471b','28db77f523047d84','32caab7b40c72493','3c9ebe0a15c9bebc','431d67c49c100d4c','4cc5d4becb3e42b6','597f299cfc657e2a','5fcb6fab3ad6faec','6c44198c4a475817'].map(h => BigInt('0x' + h));
    let H = (is384 ? ['cbbb9d5dc1059ed8','629a292a367cd507','9159015a3070dd17','152fecd8f70e5939','67332667ffc00b31','8eb44a8768581511','db0c2e0d64f98fa7','47b5481dbefa4fa4'] : ['6a09e667f3bcc908','bb67ae8584caa73b','3c6ef372fe94f82b','a54ff53a5f1d36f1','510e527fade682d1','9b05688c2b3e6c1f','1f83d9abfb41bd6b','5be0cd19137e2179']).map(h => BigInt('0x' + h));
    const len = data.length, n = ((len + 17 + 127) >> 7) << 7, b = new Uint8Array(n); b.set(data); b[len] = 0x80;
    const dv = new DataView(b.buffer); dv.setUint32(n - 4, (len * 8) >>> 0); dv.setUint32(n - 8, Math.floor(len / 536870912));
    const rotr = (x, r) => ((x >> BigInt(r)) | (x << BigInt(64 - r))) & M;
    const W = new Array(80);
    for (let o = 0; o < n; o += 128) {
      for (let i = 0; i < 16; i++) W[i] = (BigInt(dv.getUint32(o + i * 8)) << 32n) | BigInt(dv.getUint32(o + i * 8 + 4));
      for (let i = 16; i < 80; i++) { const s0 = rotr(W[i - 15], 1) ^ rotr(W[i - 15], 8) ^ (W[i - 15] >> 7n), s1 = rotr(W[i - 2], 19) ^ rotr(W[i - 2], 61) ^ (W[i - 2] >> 6n); W[i] = (W[i - 16] + s0 + W[i - 7] + s1) & M; }
      let [a, bb, c, d, e, f, g, h] = H;
      for (let i = 0; i < 80; i++) {
        const t1 = (h + (rotr(e, 14) ^ rotr(e, 18) ^ rotr(e, 41)) + ((e & f) ^ (~e & M & g)) + K512[i] + W[i]) & M;
        const t2 = ((rotr(a, 28) ^ rotr(a, 34) ^ rotr(a, 39)) + ((a & bb) ^ (a & c) ^ (bb & c))) & M;
        h = g; g = f; f = e; e = (d + t1) & M; d = c; c = bb; bb = a; a = (t1 + t2) & M;
      }
      H = [a, bb, c, d, e, f, g, h].map((v, i) => (H[i] + v) & M);
    }
    const out = new Uint8Array(is384 ? 48 : 64);
    for (let i = 0; i < out.length / 8; i++) { let v = H[i]; for (let k = 7; k >= 0; k--) { out[i * 8 + k] = Number(v & 255n); v >>= 8n; } }
    return out;
  }
  const sha = async (alg, data) => {
    if (subtle) return new Uint8Array(await subtle.digest(alg, data));
    return alg === 'SHA-256' ? sha256js(data) : sha512js(data, alg === 'SHA-384');
  };

  /* ---------- helpers ---------- */
  const PAD = new Uint8Array([0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08, 0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A]);
  const cat = (...arrs) => { const n = arrs.reduce((s, a) => s + a.length, 0), o = new Uint8Array(n); let p = 0; arrs.forEach(a => { o.set(a, p); p += a.length; }); return o; };
  const eq = (a, b, n) => { for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; return true; };
  const utf8 = (s) => new TextEncoder().encode(s);
  function latin1Pw(s) { const b = []; for (const ch of s) { const c = ch.codePointAt(0); b.push(c < 256 ? c : 63); } return new Uint8Array(b); }
  function padPw(pw) { const p = pw.slice(0, 32); return cat(p, PAD.subarray(0, 32 - p.length)); }

  /* R2–R4 */
  function computeKeyR4(pw, enc) {
    const n = enc.R === 2 ? 5 : enc.Length / 8;
    let h = md5(cat(padPw(pw), enc.O.subarray(0, 32), new Uint8Array([enc.P & 255, (enc.P >>> 8) & 255, (enc.P >>> 16) & 255, (enc.P >>> 24) & 255]), enc.ID0,
      enc.R >= 4 && !enc.EncryptMetadata ? new Uint8Array([255, 255, 255, 255]) : new Uint8Array(0)));
    if (enc.R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
    return h.subarray(0, n);
  }
  function checkUserR4(key, enc) {
    if (enc.R === 2) return eq(rc4(key, PAD), enc.U, 32);
    let x = rc4(key, md5(cat(PAD, enc.ID0)));
    for (let i = 1; i <= 19; i++) x = rc4(key.map(b => b ^ i), x);
    return eq(x, enc.U, 16);
  }
  function userPwFromOwnerR4(pw, enc) {
    const n = enc.R === 2 ? 5 : enc.Length / 8;
    let h = md5(padPw(pw));
    if (enc.R >= 3) for (let i = 0; i < 50; i++) h = md5(h);
    const k = h.subarray(0, n);
    let x = enc.O.subarray(0, 32);
    if (enc.R === 2) x = rc4(k, x);
    else for (let i = 19; i >= 0; i--) x = rc4(k.map(b => b ^ i), x);
    return x;
  }
  /* R5/R6 */
  async function hashR6(pw, salt, udata, R) {
    if (R === 5) return sha('SHA-256', cat(pw, salt, udata));
    let K = await sha('SHA-256', cat(pw, salt, udata));
    for (let round = 0; ; round++) {
      const one = cat(pw, K, udata);
      const K1 = new Uint8Array(one.length * 64);
      for (let i = 0; i < 64; i++) K1.set(one, i * one.length);
      const E = aesCbcEncryptNoPad(K.subarray(0, 16), K1, K.subarray(16, 32));
      let mod = 0; for (let i = 0; i < 16; i++) mod += E[i];
      mod %= 3;
      K = await sha(mod === 0 ? 'SHA-256' : mod === 1 ? 'SHA-384' : 'SHA-512', E);
      if (round >= 63 && E[E.length - 1] <= round - 32) break;
    }
    return K.subarray(0, 32);
  }
  async function keyR6(pwStr, enc) {
    const pw = utf8(pwStr).subarray(0, 127);
    const U = enc.U, O = enc.O;
    if (eq(await hashR6(pw, U.subarray(32, 40), new Uint8Array(0), enc.R), U, 32)) {
      const k = await hashR6(pw, U.subarray(40, 48), new Uint8Array(0), enc.R);
      return { key: aesCbcDecrypt(k, enc.UE, new Uint8Array(16), false), as: 'user' };
    }
    const u48 = U.subarray(0, 48);
    if (eq(await hashR6(pw, O.subarray(32, 40), u48, enc.R), O, 32)) {
      const k = await hashR6(pw, O.subarray(40, 48), u48, enc.R);
      return { key: aesCbcDecrypt(k, enc.OE, new Uint8Array(16), false), as: 'owner' };
    }
    return null;
  }

  /* read the Encrypt dictionary into plain values */
  function readEncrypt(L, ctx, encObj, idArr) {
    const { PDFName, PDFNumber, PDFDict, PDFArray, PDFBool } = L;
    const d = ctx.lookup(encObj);
    const num = (k, def) => { const v = d.lookup(PDFName.of(k)); return v instanceof PDFNumber ? v.asNumber() : def; };
    const bytes = (k) => { const v = d.lookup(PDFName.of(k)); return v && v.asBytes ? v.asBytes() : new Uint8Array(0); };
    const name = (o) => (o instanceof PDFName ? o.decodeText() : '');
    const enc = {
      Filter: name(d.lookup(PDFName.of('Filter'))), V: num('V', 0), R: num('R', 2), Length: num('Length', 40), P: num('P', -1) | 0,
      O: bytes('O'), U: bytes('U'), OE: bytes('OE'), UE: bytes('UE'), EncryptMetadata: true, StmF: 'V2', StrF: 'V2'
    };
    const em = d.lookup(PDFName.of('EncryptMetadata'));
    if (em && em.asBoolean) enc.EncryptMetadata = em.asBoolean();
    if (enc.V >= 4) {
      const cf = d.lookup(PDFName.of('CF'));
      const method = (fname) => {
        if (fname === 'Identity') return 'Identity';
        const f = cf instanceof PDFDict ? cf.lookup(PDFName.of(fname)) : null;
        const m = f instanceof PDFDict ? name(f.lookup(PDFName.of('CFM'))) : 'V2';
        if (f instanceof PDFDict) { const len = f.lookup(PDFName.of('Length')); if (len instanceof PDFNumber && enc.V === 4) enc.Length = len.asNumber() <= 32 ? len.asNumber() * 8 : len.asNumber(); }
        return m || 'V2';
      };
      enc.StmF = method(name(d.lookup(PDFName.of('StmF'))) || 'Identity');
      enc.StrF = method(name(d.lookup(PDFName.of('StrF'))) || 'Identity');
    }
    if (!enc.Length || enc.Length < 40) enc.Length = 40;
    if (enc.R >= 3 && enc.V < 4 && enc.Length > 128) enc.Length = 128;
    let id0 = new Uint8Array(0);
    const ida = idArr ? ctx.lookup(idArr) : null;
    if (ida instanceof PDFArray && ida.size()) { const o = ida.lookup(0); if (o && o.asBytes) id0 = o.asBytes(); }
    enc.ID0 = id0;
    return enc;
  }

  /* returns {key, as:'user'|'owner'} or null when the password is wrong */
  async function deriveKey(enc, password) {
    if (enc.Filter && enc.Filter !== 'Standard') throw Object.assign(new Error('This PDF uses a certificate or custom security handler, which can\'t be opened here.'), { code: 'unsupported' });
    if (enc.R >= 5) return keyR6(password, enc);
    const pw = latin1Pw(password);
    let k = computeKeyR4(pw, enc);
    if (checkUserR4(k, enc)) return { key: k, as: 'user' };
    const up = userPwFromOwnerR4(pw, enc);
    k = computeKeyR4(up, enc);
    if (checkUserR4(k, enc)) return { key: k, as: 'owner' };
    return null;
  }

  function objectKey(fileKey, enc, num, gen, aes) {
    if (enc.R >= 5) return fileKey;
    const ext = cat(fileKey, new Uint8Array([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]), aes ? new Uint8Array([0x73, 0x41, 0x6C, 0x54]) : new Uint8Array(0));
    return md5(ext).subarray(0, Math.min(fileKey.length + 5, 16));
  }
  function decryptData(fileKey, enc, num, gen, data, method) {
    if (method === 'Identity' || method === 'None') return data;
    const aes = method === 'AESV2' || method === 'AESV3';
    const k = objectKey(fileKey, enc, num, gen, aes);
    if (aes) { if (data.length < 32) return data.length < 16 ? new Uint8Array(0) : aesCbcDecrypt(k, data.subarray(16), data.subarray(0, 16), true); return aesCbcDecrypt(k, data.subarray(16), data.subarray(0, 16), true); }
    return rc4(k, data);
  }

  /*
   * Load a PDF, decrypting it when needed.
   * returns { bytes, encrypted:false } for plain files, or
   *         { bytes (decrypted, no encryption), encrypted:true, openedAs:'user'|'owner', restricted }
   * throws { code:'password' } when a password is needed or the one given is wrong.
   */
  async function decryptPdf(L, input, password) {
    const quiet = async (fn) => { const w = console.warn, l = console.log; console.warn = console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };
    const probe = await quiet(() => L.PDFDocument.load(input, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false })).catch(() => null);
    // fast path: unencrypted and parsed fine
    if (probe && !probe.isEncrypted) return { bytes: input, encrypted: false };

    const Parser = L.PDFParser.prototype, OSP = L.PDFObjectStreamParser, Ctx = L.PDFContext.prototype;
    const origHeader = Parser.parseIndirectObjectHeader, origFor = OSP.forStream, origAssign = Ctx.assign;
    let lastRef = null, inObjStm = false, state = null;
    const fromObjStm = new Set();
    Parser.parseIndirectObjectHeader = function () { const r = origHeader.call(this); lastRef = r; return r; };
    Ctx.assign = function (ref, obj) { if (inObjStm) fromObjStm.add(ref.toString()); return origAssign.call(this, ref, obj); };
    try {
      // pass 1: find the Encrypt dictionary without reading object streams
      OSP.forStream = function () { return { parseIntoContext: async () => {} }; };
      const d1 = await quiet(() => L.PDFDocument.load(input, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false }));
      const ti = d1.context.trailerInfo;
      if (!ti.Encrypt) return { bytes: input, encrypted: false };
      const enc = readEncrypt(L, d1.context, ti.Encrypt, ti.ID);
      const got = await deriveKey(enc, password || '');
      if (!got) throw Object.assign(new Error(password ? 'That password is not correct.' : 'This PDF needs a password to open.'), { code: 'password', wrong: !!password });
      const fileKey = got.key;
      state = { enc, fileKey };
      // pass 2: decrypt object streams as they are parsed
      OSP.forStream = function (raw, wait) {
        const ref = lastRef;
        if (ref && enc.StmF !== 'Identity') raw.contents = decryptData(fileKey, enc, ref.objectNumber, ref.generationNumber, raw.contents, enc.StmF === 'Identity' ? 'Identity' : enc.V >= 4 ? enc.StmF : 'V2');
        const p = origFor.call(this, raw, wait);
        const run = p.parseIntoContext.bind(p);
        p.parseIntoContext = async () => { inObjStm = true; try { await run(); } finally { inObjStm = false; } };
        return p;
      };
      const doc = await L.PDFDocument.load(input, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
      const ctx = doc.context;
      const encRef = ctx.trailerInfo.Encrypt;
      const encKey = encRef instanceof L.PDFRef ? encRef.toString() : null;
      const strM = enc.V >= 4 ? enc.StrF : 'V2', stmM = enc.V >= 4 ? enc.StmF : 'V2';
      const fixStrings = (obj, num, gen, depth) => {
        if (depth > 50 || !obj) return obj;
        if (obj instanceof L.PDFString || obj instanceof L.PDFHexString) {
          const dec = decryptData(fileKey, enc, num, gen, obj.asBytes(), strM);
          let h = ''; for (let i = 0; i < dec.length; i++) h += dec[i].toString(16).padStart(2, '0');
          return L.PDFHexString.of(h);
        }
        if (obj instanceof L.PDFDict) {
          const isSig = !!obj.get(L.PDFName.of('ByteRange'));
          for (const [k, v] of obj.entries()) {
            if (isSig && k.decodeText() === 'Contents') continue;
            const nv = fixStrings(v, num, gen, depth + 1);
            if (nv !== v) obj.set(k, nv);
          }
          return obj;
        }
        if (obj instanceof L.PDFArray) {
          for (let i = 0; i < obj.size(); i++) { const v = obj.get(i); const nv = fixStrings(v, num, gen, depth + 1); if (nv !== v) obj.set(i, nv); }
          return obj;
        }
        return obj;
      };
      for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
        const key = ref.toString();
        if (key === encKey || fromObjStm.has(key)) continue;
        const num = ref.objectNumber, gen = ref.generationNumber;
        if (obj instanceof L.PDFRawStream) {
          const type = obj.dict.lookup(L.PDFName.of('Type'));
          const tn = type instanceof L.PDFName ? type.decodeText() : '';
          if (tn === 'XRef') continue;
          fixStrings(obj.dict, num, gen, 0);
          if (tn === 'Metadata' && !enc.EncryptMetadata) continue;
          const filt = obj.dict.lookup(L.PDFName.of('Filter'));
          const hasCryptFilter = filt instanceof L.PDFName ? filt.decodeText() === 'Crypt' : (filt instanceof L.PDFArray && filt.asArray().some(f => f instanceof L.PDFName && f.decodeText() === 'Crypt'));
          if (hasCryptFilter) continue;
          obj.contents = decryptData(fileKey, enc, num, gen, obj.contents, stmM);
        } else fixStrings(obj, num, gen, 0);
      }
      if (encRef instanceof L.PDFRef) ctx.delete(encRef);
      ctx.trailerInfo.Encrypt = undefined;
      const out = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
      // owner-level restrictions: anything other than full permissions
      const P = enc.P >>> 0;
      const restricted = got.as === 'user' && ((P & 0x8) === 0 || (P & 0x20) === 0 || (P & 0x400) === 0 && enc.R >= 3);
      return { bytes: out, encrypted: true, openedAs: got.as, restricted, needsPassword: password ? true : false };
    } finally {
      Parser.parseIndirectObjectHeader = origHeader; OSP.forStream = origFor; Ctx.assign = origAssign;
    }
  }

  /* ---------- encrypting: AES-256 standard security (PDF 2.0, revision 6; Acrobat X and later) ---------- */
  // permission bits (1-based bit numbers from the PDF spec)
  const PERM = { print: 1 << 2, modify: 1 << 3, copy: 1 << 4, annotate: 1 << 5, fill: 1 << 8, access: 1 << 9, assemble: 1 << 10, printHigh: 1 << 11 };
  function permissionsValue(o) {
    // bits 7, 8 and 13-32 must be set; 1-2 must be clear
    let p = 0xFFFFF0C0;
    if (!o || o.all) return (p | 0xF3C) | 0;
    p |= PERM.access;
    if (o.print) p |= PERM.print | PERM.printHigh;
    if (o.copy) p |= PERM.copy;
    if (o.annotate) p |= PERM.annotate | PERM.fill;
    if (o.fill) p |= PERM.fill;
    if (o.modify) p |= PERM.modify;
    if (o.assemble) p |= PERM.assemble;
    return p | 0;
  }
  function randomBytes(n) {
    const out = new Uint8Array(n);
    const c = (root.crypto && root.crypto.getRandomValues) ? root.crypto : (typeof globalThis !== 'undefined' && globalThis.crypto);
    if (!c || !c.getRandomValues) throw new Error('This browser cannot create secure random numbers, so it cannot encrypt files.');
    c.getRandomValues(out); return out;
  }
  const hexOf = (b) => { let h = ''; for (let i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, '0'); return h; };
  function aesEncryptData(key, data) {
    const iv = randomBytes(16), pad = 16 - (data.length % 16);
    const padded = new Uint8Array(data.length + pad); padded.set(data); padded.fill(pad, data.length);
    return cat(iv, aesCbcEncryptNoPad(key, padded, iv));
  }
  /*
   * opts: { userPassword (needed to open; may be empty), ownerPassword (needed to change permissions),
   *         permissions: { all } | { print, copy, annotate, fill, modify, assemble } }
   */
  async function encryptPdf(L, input, opts) {
    opts = opts || {};
    const userPw = utf8(opts.userPassword || '').subarray(0, 127);
    const ownerStr = opts.ownerPassword || hexOf(randomBytes(16));
    const ownerPw = utf8(ownerStr).subarray(0, 127);
    if (opts.userPassword && opts.ownerPassword && opts.userPassword === opts.ownerPassword) throw new Error('The open password and the permissions password must be different.');
    const fileKey = randomBytes(32), zero = new Uint8Array(16);
    const uvs = randomBytes(8), uks = randomBytes(8), ovs = randomBytes(8), oks = randomBytes(8);
    const U = cat(await hashR6(userPw, uvs, new Uint8Array(0), 6), uvs, uks);
    const UE = aesCbcEncryptNoPad(await hashR6(userPw, uks, new Uint8Array(0), 6), fileKey, zero);
    const O = cat(await hashR6(ownerPw, ovs, U, 6), ovs, oks);
    const OE = aesCbcEncryptNoPad(await hashR6(ownerPw, oks, U, 6), fileKey, zero);
    const P = permissionsValue(opts.permissions);
    const pb = new Uint8Array(16);
    pb[0] = P & 255; pb[1] = (P >>> 8) & 255; pb[2] = (P >>> 16) & 255; pb[3] = (P >>> 24) & 255;
    pb[4] = pb[5] = pb[6] = pb[7] = 255; pb[8] = 0x54; pb[9] = 0x61; pb[10] = 0x64; pb[11] = 0x62; pb.set(randomBytes(4), 12);
    const Perms = aesCbcEncryptNoPad(fileKey, pb, zero);

    const doc = await L.PDFDocument.load(input, { updateMetadata: false });
    const ctx = doc.context;
    const encStr = (obj, depth) => {
      if (depth > 60 || !obj) return obj;
      if (obj instanceof L.PDFString || obj instanceof L.PDFHexString) return L.PDFHexString.of(hexOf(aesEncryptData(fileKey, obj.asBytes())));
      if (obj instanceof L.PDFDict) { for (const [k, v] of obj.entries()) { const nv = encStr(v, depth + 1); if (nv !== v) obj.set(k, nv); } return obj; }
      if (obj instanceof L.PDFArray) { for (let i = 0; i < obj.size(); i++) { const v = obj.get(i), nv = encStr(v, depth + 1); if (nv !== v) obj.set(i, nv); } return obj; }
      return obj;
    };
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (obj instanceof L.PDFRawStream) {
        encStr(obj.dict, 0);
        obj.contents = aesEncryptData(fileKey, obj.contents);
        obj.dict.set(L.PDFName.of('Length'), L.PDFNumber.of(obj.contents.length));
      } else if (obj && obj.getContents && obj.dict) {
        // a stream pdf-lib created itself: freeze its bytes, then encrypt them
        const raw = L.PDFRawStream.of(obj.dict, aesEncryptData(fileKey, obj.getContents()));
        encStr(raw.dict, 0);
        raw.dict.set(L.PDFName.of('Length'), L.PDFNumber.of(raw.contents.length));
        ctx.assign(ref, raw);
      } else encStr(obj, 0);
    }
    const enc = ctx.obj({
      Filter: 'Standard', V: 5, R: 6, Length: 256, P,
      CF: { StdCF: { Type: 'CryptFilter', AuthEvent: 'DocOpen', CFM: 'AESV3', Length: 32 } }, StmF: 'StdCF', StrF: 'StdCF',
      O: L.PDFHexString.of(hexOf(O)), U: L.PDFHexString.of(hexOf(U)), OE: L.PDFHexString.of(hexOf(OE)), UE: L.PDFHexString.of(hexOf(UE)), Perms: L.PDFHexString.of(hexOf(Perms)),
      EncryptMetadata: true
    });
    ctx.trailerInfo.Encrypt = ctx.register(enc);
    const id = L.PDFHexString.of(hexOf(randomBytes(16)));
    ctx.trailerInfo.ID = ctx.obj([id, id]);
    return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  }

  const api = { decryptPdf, encryptPdf, permissionsValue, md5, rc4, aesCbcDecrypt, aesCbcEncryptNoPad, sha256js, sha512js };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PDFCrypto = api;
})(typeof self !== 'undefined' ? self : this);
