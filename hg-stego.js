/* ===================== ERO stego-HLS 解封装器 =====================
 *
 * 上游 eroshort.net 的部分剧走 delivery = "stego_hls":
 *   - manifest 是标准 m3u8 (无 #EXT-X-KEY), 但每个分片是 .png
 *   - .png 是 1x1 占位图, 真数据塞在非标准 chunk "teXt"(关键字 Comment) 里
 *   - chunk 内容 = RBQV2(5) + media_id(16) + variant_id(16) + seq(4) + IV(12) + AES-GCM(密文+tag)
 *
 * 内容密钥不在分片里, 而在 /playback/resolve 返回的 stego.license (JWT 风格) 里,
 * 用 X25519 包裹:
 *
 *   license = "<key_id>.<payload_b64u>.<sig_b64u>"
 *   payload = { v,iss,aud,build_id,origin,media_id,variant_id,key_id,iat,exp,jti,
 *               wrapped_key: { ephemeral_public_key, nonce, ciphertext } }
 *
 *   shared  = X25519(wrapping_private_key, ephemeral_public_key)
 *   K       = JSON.stringify(payload 的 11 个字段, 固定顺序)
 *   S       = "rbqcms-key-wrap-v2\0" || K
 *   info    = "rbqcms-x25519-wrap-v2\0" || eph_pub || wrapping_pub || S
 *   AesKey  = HKDF-SHA256(ikm=shared, salt="rbqcms-wrap-hkdf-v2", info=info, 32B)  → AES-GCM 256
 *   CKey    = AES-GCM-decrypt(AesKey, iv=nonce, aad=S, ct=wrapped_key.ciphertext) → 32B
 *
 *   分片明文 = AES-GCM-decrypt(CKey, iv=IV, aad="rbqcms-segment-v2\0" || V, ct)
 *   V       = "RBQV2" || uuid(media_id) || uuid(variant_id) || be32(seq) || IV
 *
 * 说明:
 *   上游客户端还会校验 license 的 Ed25519 签名、origin === location.origin、
 *   以及 iat/exp 时间窗。那几项是**客户端自检**, 与解密无关 (Ed25519 只保护
 *   license 本身不被篡改)。本站不是 eroshort.net, 因此这几项不适用, 略去。
 *   X25519 / HKDF / AES-GCM 全部走 WebCrypto (需要 https 安全上下文);
 *   Chrome < 133 的 WebCrypto 没有 X25519, 这里自带一份 RFC 7748 纯 BigInt 实现兜底。
 */

/* ---- base64url ---- */
function esB64u(s) {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = t + '='.repeat((4 - (t.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function esUtf8(s) { return new TextEncoder().encode(s); }
function esCat(...arrs) {
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function esEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function esUuid(t) {
  const h = String(t).replace(/-/g, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
function esBe32(n) {
  return Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

/* ---- X25519 (RFC 7748) — 纯 BigInt, 兜底用 ---- */
const _X_P = (1n << 255n) - 19n;
function _xLe2n(b) {
  let r = 0n;
  for (let i = b.length - 1; i >= 0; i--) r = (r << 8n) | BigInt(b[i]);
  return r;
}
function _xN2le(n) {
  const o = new Uint8Array(32);
  for (let i = 0; i < 32; i++) { o[i] = Number(n & 255n); n >>= 8n; }
  return o;
}
function _xPow(b, e, m) {
  let r = 1n; b %= m;
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r;
}
function esX25519Js(kIn, uIn) {
  const k = new Uint8Array(kIn);
  k[0] &= 248; k[31] &= 127; k[31] |= 64;
  const x1 = _xLe2n(uIn) & _X_P;
  let x2 = 1n, z2 = 0n, x3 = x1, z3 = 1n, swap = 0n;
  const A24 = 121665n;
  for (let t = 254; t >= 0; t--) {
    const kt = BigInt((k[(t >> 3)] >> (t & 7)) & 1);
    swap ^= kt;
    if (swap === 1n) { let s = x2; x2 = x3; x3 = s; s = z2; z2 = z3; z3 = s; }
    swap = kt;
    const A = (x2 + z2) % _X_P, AA = (A * A) % _X_P;
    const B = (x2 - z2 + _X_P) % _X_P, BB = (B * B) % _X_P;
    const E = (AA - BB + _X_P) % _X_P;
    const C = (x3 + z3) % _X_P, D = (x3 - z3 + _X_P) % _X_P;
    const DA = (D * A) % _X_P, CB = (C * B) % _X_P;
    x3 = ((DA + CB) % _X_P) ** 2n % _X_P;
    z3 = (x1 * (((DA - CB + _X_P) % _X_P) ** 2n % _X_P)) % _X_P;
    x2 = (AA * BB) % _X_P;
    z2 = (E * ((AA + A24 * E) % _X_P)) % _X_P;
  }
  if (swap === 1n) { let s = x2; x2 = x3; x3 = s; s = z2; z2 = z3; z3 = s; }
  return _xN2le((x2 * _xPow(z2, _X_P - 2n, _X_P)) % _X_P);
}

/* PKCS#8 前缀 (RFC 8410): 把 32B 裸私钥包成 WebCrypto 能 import 的形式 */
const _X_PKCS8 = Uint8Array.of(48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 110, 4, 34, 4, 32);
let _xSubtle = null;
async function esX25519SubtleOk() {
  if (_xSubtle !== null) return _xSubtle;
  try {
    const priv = await crypto.subtle.importKey('pkcs8', esCat(_X_PKCS8, new Uint8Array(32).fill(1)), 'X25519', false, ['deriveBits']);
    const base = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(9).map((v, i) => (i ? 0 : 9)), 'X25519', false, []);
    await crypto.subtle.deriveBits({ name: 'X25519', public: base }, priv, 256);
    _xSubtle = true;
  } catch (e) { _xSubtle = false; }
  return _xSubtle;
}
async function esX25519(priv32, pub32) {
  if (await esX25519SubtleOk()) {
    const k = await crypto.subtle.importKey('pkcs8', esCat(_X_PKCS8, priv32), 'X25519', false, ['deriveBits']);
    const p = await crypto.subtle.importKey('raw', pub32, 'X25519', false, []);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: p }, k, 256));
  }
  return esX25519Js(priv32, pub32);
}

/* ---- 打开解码器 ---- */
const ES_WRAP_FIELDS = ['v', 'iss', 'aud', 'build_id', 'origin', 'media_id', 'variant_id', 'key_id', 'iat', 'exp', 'jti'];

/**
 * @param {{mediaId:string, assetVersion:string, license:string}} info
 * @param {{wrapping_private_key:string, wrapping_public_key:string}} profile
 * @returns {Promise<{extract:function(Uint8Array,number):Promise<Uint8Array>, destroy:function():void}>}
 */
async function esOpenDecoder(info, profile) {
  if (!info || !info.license || !profile || !profile.wrapping_private_key) throw new Error('es: no license');
  const parts = String(info.license).split('.');
  if (parts.length !== 3) throw new Error('VIDEO_LICENSE_INVALID');
  const keyId = parts[0];
  let pay;
  try {
    pay = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(esB64u(parts[1])));
  } catch (e) { throw new Error('VIDEO_LICENSE_INVALID'); }
  const wk = pay && pay.wrapped_key;
  if (!wk) throw new Error('VIDEO_LICENSE_INVALID');

  const ephPub = esB64u(wk.ephemeral_public_key);
  const nonce = esB64u(wk.nonce);
  const ct = esB64u(wk.ciphertext);
  const priv = esB64u(profile.wrapping_private_key);
  const pub = esB64u(profile.wrapping_public_key);
  if (ephPub.length !== 32 || nonce.length !== 12 || ct.length !== 48 || priv.length !== 32 || pub.length !== 32) {
    throw new Error('VIDEO_LICENSE_INVALID');
  }

  const shared = await esX25519(priv, ephPub);
  let zero = true;
  for (const v of shared) if (v) { zero = false; break; }
  if (zero) throw new Error('VIDEO_LICENSE_INVALID');

  const K = JSON.stringify(Object.fromEntries(ES_WRAP_FIELDS.map((n) => [n, pay[n]])));
  const S = esCat(esUtf8('rbqcms-key-wrap-v2\0'), esUtf8(K));
  const hkInfo = esCat(esUtf8('rbqcms-x25519-wrap-v2\0'), ephPub, pub, S);

  const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const wrapKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: esUtf8('rbqcms-wrap-hkdf-v2'), info: hkInfo },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const raw = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: S, tagLength: 128 }, wrapKey, ct));
  if (raw.length !== 32) throw new Error('VIDEO_LICENSE_INVALID');

  let ckey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  raw.fill(0);

  const mediaId = String(info.mediaId || pay.media_id || '');
  const variantId = String(info.assetVersion || pay.variant_id || '');
  const mediaB = esUuid(mediaId);
  const varB = esUuid(variantId);

  return {
    /** PNG 分片密文 → MPEG-TS 明文 */
    async extract(png, seq) {
      if (!ckey) throw new Error('DECODER_DESTROYED');
      if (!Number.isInteger(seq) || seq < 0) throw new Error('INVALID_SEQUENCE');
      const m = esPngPayload(png);
      const iv = m.subarray(41, 53);
      const V = esCat(esUtf8('RBQV2'), mediaB, varB, esBe32(seq), iv);
      if (!esEq(m.subarray(0, 53), V)) throw new Error('SEGMENT_HEADER_MISMATCH');
      const aad = esCat(esUtf8('rbqcms-segment-v2\0'), V);
      const out = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv, additionalData: aad, tagLength: 128 }, ckey, m.subarray(53));
      if (!ckey) throw new Error('DECODER_DESTROYED');
      return new Uint8Array(out);
    },
    destroy() { ckey = null; },
  };
}

/** 从 PNG 里取出 "teXt"/Comment 载荷 (已去掉 8 字节 "Comment\0" 前缀) */
function esPngPayload(bytes) {
  if (bytes.length > 48 * 1024 * 1024) throw new Error('INVALID_PNG');
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('INVALID_PNG');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = esUtf8('Comment\0');
  let payload = null, a = 8, seenIdat = false, seenIend = false;
  while (a + 12 <= bytes.length) {
    const len = dv.getUint32(a);
    const w = a + 8 + len;
    if (w + 4 > bytes.length) throw new Error('PNG_TRUNCATED');
    const type = String.fromCharCode(bytes[a + 4], bytes[a + 5], bytes[a + 6], bytes[a + 7]);
    if (a === 8 && (type !== 'IHDR' || len !== 13)) throw new Error('PNG_IHDR_INVALID');
    if (type === 'IDAT') seenIdat = true;
    if (type === 'teXt' && len >= 8 && esEq(bytes.subarray(a + 8, a + 16), need)) {
      if (payload) throw new Error('DUPLICATE_PAYLOAD');
      payload = bytes.subarray(a + 16, w);
    }
    a = w + 4;
    if (type === 'IEND') { if (len || a !== bytes.length) throw new Error('PNG_IEND_INVALID'); seenIend = true; break; }
  }
  if (!seenIdat || !seenIend || !payload || payload.length < 69 || payload.length > 32 * 1024 * 1024 + 69) {
    throw new Error('INVALID_PNG');
  }
  return payload;
}

/* ---- 上游 build-profile 常量 (解码所需的静态包裹密钥) ---- */
const ES_BUILD_PROFILE = {
  build_id: 'dcdcc161385053f622cedf86ed610abd33dae3e034af5366a8a76a058baad118',
  wrapping_private_key: '2oAsP24IvR-tFYMRFL7DuDEql5QHDUfFzwumFUUrouo',
  wrapping_public_key: 'I1JaYX63bWzcAx97tdT_e1x6jQSanu93Bar_o7noyik',
};

/* ---- 分片代理 ----
 *
 * 实测 (2026-10-09): 分片主机 pub-XXXX.r2.dev 的 CORS 白名单**只放行 https://eroshort.net**
 *     Origin: https://eroshort.net   → Access-Control-Allow-Origin: https://eroshort.net
 *     Origin: <本站>                  → 无任何 CORS 头
 *     OPTIONS 预检                     → 403
 *   浏览器写死 Origin, 没法伪造 → hls.js 直连读 PNG 必然被拦住。
 *   所以分片统一走自建反代 (vps/seg-proxy.js, 对浏览器带 ACAO 且国内可达)。
 *
 * 代理地址来源, 按优先级:
 *   1) window.ES_SEG_PROXY            (在 index.html 里写死 / 运维注入)
 *   2) 同源 data/es-proxy.json 的 {"seg": "https://..."}
 *   3) API + '/proxy/'                (Worker 兜底, 国内不可达, 仅临时可用)
 * 都没配 → 直连原地址 (只有能过 CORS 的环境, 比如上游自家域, 才可能成功)
 */
let _SEG_PROXY = (typeof window !== 'undefined' && typeof window.ES_SEG_PROXY === 'string')
  ? window.ES_SEG_PROXY : '';
if (!_SEG_PROXY && typeof fetch === 'function') {
  fetch('data/es-proxy.json', { cache: 'no-store' })
    .then((r) => (r && r.ok ? r.json() : null))
    .then((j) => { if (j && typeof j.seg === 'string' && j.seg) _SEG_PROXY = j.seg; })
    .catch(() => { /* 没有配置文件就保持直连 */ });
}
function esSegProxyBase() {
  const b = String(_SEG_PROXY || '').trim().replace(/\/+$/, '');
  return b;
}

/* ---- hls.js 自定义分片加载器 ---- */
function esIsWorkerUrl(u) {
  return typeof API === 'string' && API && u.indexOf(API + '/') === 0;
}
function esProxyUrl(u) {
  if (typeof API !== 'string' || !API) return u;
  return API + '/proxy/' + encodeURIComponent(u);
}
/** 把分片地址改成走自建反代 (没配反代就原样返回) */
function esSegUrl(u) {
  const b = esSegProxyBase();
  if (!b) return u;
  return b + '/seg?u=' + encodeURIComponent(u);
}

/**
 * 包一个 hls.js fLoader: 先原样拉 PNG, 再解封装成 TS 交给 MSE。
 *
 * 分片地址的走法:
 *   配了自建反代 → **直接**走反代 (直连 r2.dev 必被 CORS 拦, 没必要先撞一次)
 *   没配反代     → 先直连, 失败一次后改走本站 Worker /proxy/*
 *
 * @param {object} decoder esOpenDecoder 的返回值
 */
function esMakeStegoLoader(decoder) {
  const Base = (typeof Hls !== 'undefined' && Hls.DefaultConfig && Hls.DefaultConfig.loader) || null;
  if (!Base) return null;
  return class EsStegoLoader {
    constructor(cfg) {
      this.inner = new Base(cfg);
      this.generation = 0;
      this.failed = Object.create(null);
    }
    get stats() { return this.inner.stats; }
    getCacheAge() { return this.inner.getCacheAge ? this.inner.getCacheAge() : null; }
    getResponseHeader(n) { return this.inner.getResponseHeader ? this.inner.getResponseHeader(n) : null; }
    abort() { this.generation++; this.inner.abort(); }
    destroy() { this.generation++; this.inner.destroy(); }
    load(ctx, cfg, cb) {
      const gen = ++this.generation;
      const alive = () => this.generation === gen;
      const orig = ctx.url || '';
      let c2 = ctx;
      if (orig) {
        const viaProxy = esSegUrl(orig);
        if (viaProxy !== orig) {
          // 有反代 → 直接走, 不做"先直连"的无谓尝试
          c2 = Object.assign({}, ctx, { url: viaProxy });
        } else if (this.failed[orig] && !esIsWorkerUrl(orig)) {
          c2 = Object.assign({}, ctx, { url: esProxyUrl(orig) });
        }
      }
      this.inner.load(c2, cfg, {
        onSuccess: (res, stats, c, net) => {
          if (!alive()) return;
          (async () => {
            const sn = ctx.frag && ctx.frag.sn;
            if (!(res.data instanceof ArrayBuffer) || !Number.isInteger(sn)) throw new Error('INVALID_SEGMENT');
            const out = await decoder.extract(new Uint8Array(res.data), sn);
            if (alive()) cb.onSuccess(Object.assign({}, res, { data: out.buffer }), stats, ctx, net);
          })().catch(() => {
            if (!alive()) return;
            if (c2.url === orig) this.failed[orig] = 1;
            cb.onError({ code: 0, text: 'VIDEO_SEGMENT_INVALID' }, ctx, null, stats);
          });
        },
        onError: (err, c, net, stats) => {
          if (c2.url === orig) this.failed[orig] = 1;
          if (alive()) cb.onError(err, ctx, net, stats);
        },
        onTimeout: (e, c, n) => {
          if (c2.url === orig) this.failed[orig] = 1;
          if (alive()) cb.onTimeout(e, ctx, n);
        },
        onAbort: (e, c, n) => { if (cb.onAbort) cb.onAbort(e, ctx, n); },
      });
    }
  };
}
