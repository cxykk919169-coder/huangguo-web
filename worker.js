/**
 * 湟果视频 · Cloudflare Worker (双模: 静态托管 + API 代理 + 自愈)
 * ==============================================================
 * 个人学习项目 · 非商业用途 · 不存储任何视听内容
 * 所有数据均来自第三方公开网页, 仅做索引与跳转
 *
 * 路由:
 *   /                -> index.html (前端界面)
 *   /api/health      -> 健康检查 (带镜像缓存)
 *   /api/selfcheck   -> 全量自检报告
 *   /api/list        -> 列表 (五源合并解析)
 *   /api/search      -> 搜索
 *   /api/video       -> 详情
 *   /api/ep          -> 单集播放源
 *   /proxy/*         -> m3u8/图片透传
 *   其他             -> 静态资源 (env.ASSETS)
 *
 * 部署: wrangler deploy (需要 wrangler.toml 的 [assets] 绑定)
 */

// 官方站镜像列表 (自动选第一个可用的)
// 2026-10 更新: vchllzwu.cc 整池失效, 真站已迁到 wrjmtnebd.cc 站群;
//   huangguo10/8/9 已变"地址发布页"(不含剧集数据), 只能用来发现新域名。
const MIRRORS = [
  // ---- 2026-10-16 实测: wrjmtnebd.cc / fyxybiblx.cc 整池已死 ----
  // 当前线路 = 「随机段.根域名」, 根域名: bg40t53p.cc / hn18a20s.cc; 另有固定跳板域名。
  // ⚠ 这些节点现在返回的都是【下载落地页】(见 isLandingPage), 不是剧集站。
  //   保留在列表里的作用是: 让 mirrorOrder() 能靠它们拿到 appConfig 里的最新域名,
  //   并让 /api/health 说实话 —— 而不是假装"站点正常"。
  "https://997.tc41p53k.cc",
  "https://w4.hn18a20s.cc",
  "https://i9t19.bg40t53p.cc",
  "https://khqk.bg40t53p.cc",
  "https://rps5z.bg40t53p.cc",
  "https://u4g5a6.bg40t53p.cc",
  "https://mtnnbs.bg40t53p.cc",
  "https://r75t2z.bg40t53p.cc",
  "https://tdz2.bg40t53p.cc",
  "https://flf2if.bg40t53p.cc",
  "https://w1b6k.bg40t53p.cc",
  "https://w4qg8.bg40t53p.cc",
  "https://po259.bg40t53p.cc",
  "https://tn658.bg40t53p.cc",
  "https://v4il.bg40t53p.cc",
  "https://9b94a.wy60j19s.cc",
  "https://huangguoju.com",
  "https://huangguojob.com",
  "https://huangguoai.me",
  // ---- 地址发布页 (只用于自动发现新域名, 永不作为数据源) ----
  "https://huangguoai.pages.dev",
  "https://huangguoai.com",
  "https://huangguoai.ai",
  "https://hgai5.com",
  "https://huangguo10.com",
  "https://huangguo9.com",
];

// 死域后缀 (已整池失效) 与推广/宣传域 (播放会落到官方宣传物料)
const DEAD_SUFFIX = /\.(?:vchllzwu|gkudvxhjh|ngfxaxnp|igjktqpd|wrjmtnebd|fyxybiblx)\.[a-z]+$/i;
const PROMO_HOST = /(?:^|\.)(?:wqgkfvxk|fakieggtv|mqahxxhp|eisees)\.|huangguoai|\/chan\//i;

/* ================== 上游架构变更适配 (2026-10-16) ==================
 * 黄果在 2026-10 把整站换成了「APP 下载落地页 + 加密 API」:
 *
 *   落地页 (997.tc41p53k.cc / *.bg40t53p.cc / *.hn18a20s.cc …)
 *     ├─ HTML 里没有 hg-drama-card / videoInitialData —— 一条剧集数据都没有
 *     ├─ 真内容藏在 <script id="landing-payload"> 里, 是 hex(明文 XOR 0x5A)
 *     └─ 解码后是落地页本身, 里面 window.appConfig 给了最新线路:
 *          links.latest / links.official / links.permanent / webAppUrl
 *
 *   业务接口 POST /api/v1/* → {"errcode":0,"data":"<AES 密文>","sign":…,"timestamp":…}
 *     ↑ 需要 App 内置密钥才能解; 网页端不提供, 剧集只在 APP 里看。
 *
 * 结论: 网页侧已无公开剧集数据可抓。
 *   所以本 Worker 的策略是 —— 宁可返回 404「上游已改版」, 也绝不把落地页上的
 *   品牌宣传片当成剧集播放源返回。后者正是"播放内容全是官方宣传广告"的直接成因。
 * ================================================================= */
const LANDING_MARK = /id="landing-payload"|data-obfuscation=|hgdj-landing-page|window\.appConfig/;

function isLandingPage(html) {
  const s = String(html || "");
  if (s.length > 400000) return LANDING_MARK.test(s.slice(0, 400000));
  return LANDING_MARK.test(s);
}

// landing-payload: 每 2 个 hex 字符 = 1 字节明文 XOR 0x5A
function decodeLandingPayload(html) {
  const m = String(html || "").match(/<script id="landing-payload"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return "";
  let arr;
  try { arr = JSON.parse(m[1]); } catch (e) { return ""; }
  if (!Array.isArray(arr)) return "";
  let out = "";
  for (const s of arr) {
    if (typeof s !== "string") continue;
    for (let i = 0; i + 1 < s.length; i += 2) {
      const b = parseInt(s.substr(i, 2), 16);
      if (Number.isNaN(b)) continue;
      out += String.fromCharCode(b ^ 0x5A);
    }
  }
  return out;
}

// 从落地页提取真正有用的东西: 最新线路 + WebApp 入口
function extractLandingConfig(html) {
  const plain = decodeLandingPayload(html) || String(html || "");
  const out = { latest: "", official: "", permanent: "", webAppUrl: "", tpl: "", plain };
  const m = plain.match(/window\.appConfig\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (m) {
    try {
      const cfg = JSON.parse(m[1]);
      const L = cfg.links || {};
      out.latest = L.latest || "";
      out.official = L.official || "";
      out.permanent = L.permanent || "";
      out.webAppUrl = cfg.webAppUrl || "";
      out.tpl = cfg.tpl || "";
    } catch (e) { /* JSON 烂了就只靠正则兜底 */ }
  }
  if (!out.latest) {
    const g = plain.match(/"latest"\s*:\s*"(https?:[^"]+)"/);
    if (g) out.latest = g[1];
  }
  return out;
}

// 是不是"和某个镜像同主机" —— 落地页上那个品牌宣传片就是自托管的,
// 真剧集的 m3u8 一定在别的 CDN 上。用它把宣传片剔出去。
function isMirrorHosted(u) {
  let h;
  try { h = new URL(u).host.toLowerCase(); } catch (e) { return false; }
  for (const m of MIRRORS) {
    try { if (new URL(m).host.toLowerCase() === h) return true; } catch (e) { /* skip */ }
  }
  if (LEARNED_MIRROR) {
    try { if (new URL(LEARNED_MIRROR).host.toLowerCase() === h) return true; } catch (e) { /* skip */ }
  }
  return false;
}

// 推广/宣传源判定 —— 命中即丢弃, 绝不当成剧集播放源
function isPromoUrl(u) {
  if (!u) return true;
  const s = String(u);
  if (PROMO_HOST.test(s)) return true;
  if (/pages\.dev|t\.me|youtube|tiktok/i.test(s)) return true;
  return false;
}

// 地址发布页主机 (命中则提取真站域名, 不作数据源)
const PUBLISH_HOSTS = [
  "huangguo9.com", "huangguo10.com", "huangguo8.com", "hgai1.com", "hgai5.com",
  "huangguoai.com", "huangguoai.ai", "huangguoai.pages.dev", "huangguoai.me",
  "huang-guo.pages.dev",
];

function extractRealHosts(html) {
  const found = [];
  // TLD 白名单与 hg_discover.py / hg-direct.js 保持一致
  const re = /https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:cc|com|net|xyz|vip|top|site|sbs|lol|icu|fun|cyou|buzz|monster|link|pro|online|art|shop|club|live|info|biz|org|co))\//gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const host = m[1].toLowerCase();
    if (PUBLISH_HOSTS.indexOf(host) >= 0) continue;
    if (/huangguoai|pages\.dev|yandex|google|cloudflare/.test(host)) continue;
    if (/^(?:vchllzwu|cname\d|gkudvxhjh|ngfxaxnp|igjktqpd)\./i.test(host)) continue;
    if (found.indexOf(host) < 0) found.push(host);
  }
  return found;
}


// 运行期记住的"当前最佳镜像" (Worker 实例级)
let ACTIVE_MIRROR = null;
let MIRROR_CHECKED_AT = 0;
const MIRROR_TTL = 60 * 1000;   // 1 分钟内信任缓存
let BAD_MIRRORS = {};           // { mirror: 拉黑到期时间戳 }
const BAD_MIRROR_TTL = 90 * 1000;
// 运行期学到的"最新域名" (上游会 301 换站, 我们把落点记下来优先用)
let LEARNED_MIRROR = null;

// 黄豆短剧 (hddj) API 线路 — 可从 /distribution 动态刷新
let HD_API_LINES = ["https://hddj.zen-vip.com/api/app"];
let HD_BAD = {};
const HD_BAD_TTL = 90 * 1000;
// 视频流主机 (managed-media 会在这几个域上都可用)
// 2026-10-16 实测: /play 下发的 playbackLines 已到 7 条, 多出 hdv6。
const HD_MEDIA_HOSTS = [
  "https://hddj.zen-vip.com",
  "https://hdv1.zen-vip.com",
  "https://hdv2.zen-vip.com",
  "https://hdv4.zen-vip.com",
  "https://hdv5.zen-vip.com",
  "https://hdv6.zen-vip.com",
];

// ★ 锚点原文必须原样保留 —— patch_file 的 old 会替换掉这一段,
//   如果不在这里重新声明, const UA 就没了, 之后每次 fetch 都 ReferenceError。
//   (实测踩过: node --check 只查语法, 抓不到未声明标识符; 必须在 Node 里真跑一次路由才暴露。)
let LAST_SELFCHECK = null;
// ↓ 中间插入一行注释, 是为了让本补丁的 old 锚点在应用后**不再匹配** ——
//   否则重复执行会把整个补丁块再插一遍 (实测: 二次执行后 worker.js 多出 1000+ 行)。
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

  /* ============ 黄果官方站 (huangguoai.com) ============
   * 2026-10 实测: 主站 + 9 个备用域名, 内容完全一致 (同一批 ID / 同一 total=2697)。
   * 这批域名是站方自己的 CDN 前置, 不是"地址发布页", 可以直接取数。
   */
  const HG_BASES = [
    "https://huangguoai.com",
    "https://l5f9m.rxzfszht.cc",
    "https://blolhh.rxzfszht.cc",
    "https://mxz58.rxzfszht.cc",
    "https://owfv.rxzfszht.cc",
    "https://zd43td.rxzfszht.cc",
    "https://qp0h.rxzfszht.cc",
    "https://olci.rxzfszht.cc",
    "https://j5rs.rxzfszht.cc",
    "https://lhsb.rxzfszht.cc",
  ];

  // cate_id 来自上游 /api/home 的 cate_rec, 实测 ?cate_id=N 能真正过滤 (其它参数名一律无效)
  const HG_CATES = [
    { id: 24, name: "AI成人短剧", path: "/ai-duanju/" },
    { id: 25, name: "AI成人漫剧", path: "/ai-manju/" },
    { id: 26, name: "AI换脸", path: "/ai-huanlian/" },
    { id: 27, name: "AI魔改", path: "/ai-mogai/" },
  ];

  // 只允许这几台上游媒体主机经过 /api/hg/media —— 防止被当成任意 SSRF 跳板
  const HG_MEDIA_HOST_RE = /^(?:[a-z0-9-]+\.)?(?:hzjvlo\.cn|drleao\.cn|eisees\.com)$/i;

  const HG_BAD_UNTIL = {};

  function hgAbs(u) {
    if (!u) return "";
    if (/^https?:\/\//i.test(u)) return u;
    return "https://huangguoai.com" + (u.charAt(0) === "/" ? u : "/" + u);
  }

  // ★ 上游用的是**数字实体** (&#34;) 而不是 &quot; —— 只处理命名实体会导致
  //   JSON.parse 必然失败 (实测踩过)。数字实体放最前, &amp; 放最后, 保证只解一层。
  function hgUnesc(s) {
    return String(s == null ? "" : s)
      .replace(/&#x([0-9a-f]+);/gi, function (_m, h) {
        try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return _m; }
      })
      .replace(/&#(\d+);/g, function (_m, d) {
        try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return _m; }
      })
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&");
  }

  // 上游 item → 本项目的卡片结构
  function hgCard(x) {
    x = x || {};
    return {
      id: x.id,
      title: x.title || "",
      cover: hgAbs(x.cover || ""),
      score: x.score || "",
      ep: x.is_finished ? ("全" + (x.episode_count || x.total_episodes || 0) + "集")
                        : ("更新至" + (x.episode_count || x.total_episodes || 0) + "集"),
      epTotal: x.episode_count || x.total_episodes || 0,
      desc: x.description || "",
      tags: x.tags || [],
      hot: x.hot || 0,
      author: (x.author && x.author.name) || "",
      original: x.is_original === 1,
      duration: x.duration || "",
      at: x.new_at || x.last_ep_at || 0,
    };
  }

  // 带故障切换的请求: 主站挂了自动轮到备用域名
  async function hgFetchRaw(path, accept) {
    const now = Date.now();
    let last = { ok: false, error: "no mirror" };
    for (let i = 0; i < HG_BASES.length; i++) {
      const base = HG_BASES[i];
      if (HG_BAD_UNTIL[base] && HG_BAD_UNTIL[base] > now) continue;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 12000);
        let r;
        try {
          r = await fetch(base + path, {
            headers: {
              "User-Agent": UA,
              "Accept": accept || "application/json, text/plain, */*",
              "Accept-Language": "zh-CN,zh;q=0.9",
              "Accept-Encoding": "identity",
              "Referer": base + "/",
            },
            redirect: "follow",
            signal: ctl.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (!r.ok) {
          last = { ok: false, error: "HTTP " + r.status + " @ " + base, base: base };
          if (r.status === 404 || r.status === 403) HG_BAD_UNTIL[base] = now + 60000;
          continue;
        }
        const body = accept === "text/html" ? await r.text() : await r.text();
        delete HG_BAD_UNTIL[base];
        return { ok: true, body: body, base: base, status: r.status };
      } catch (e) {
        last = { ok: false, error: String((e && e.message) || e) + " @ " + base, base: base };
        HG_BAD_UNTIL[base] = now + 90000;
      }
    }
    return last;
  }

  async function hgJson(path) {
    const r = await hgFetchRaw(path, "application/json, text/plain, */*");
    if (!r.ok) return r;
    try {
      return { ok: true, data: JSON.parse(r.body), base: r.base };
    } catch (e) {
      // 被风控挡成 HTML 时要能分辨出来, 不能假装是空数据
      const t = String(r.body || "");
      return { ok: false, error: /^\s*<(?:!DOCTYPE|html)/i.test(t)
        ? "上游返回了 HTML (可能被风控): " + r.base
        : "JSON 解析失败: " + String((e && e.message) || e), base: r.base };
    }
  }

  // ★ 这里重写一遍黄果的 hgText —— 它正是本补丁块的 old 锚点。
  //   文本上等价但写法不同, 这样锚点被真正消费掉, 重复执行不会把函数定义两遍。
  const HG_ACCEPT_TEXT = "text/html,application/xhtml+xml,*/*;q=0.8";
  async function hgText(path) {
    const r = await hgFetchRaw(path, HG_ACCEPT_TEXT);
    if (!r.ok) return r;
    return { ok: true, text: r.body, base: r.base };
  }

  /* ============ 橙果短剧 (chengguodj.com) ============
   * 2026-10 实测: 站方 Web 前端走一套**加密信封** API, 全部逆出来了。
   *
   * 从 /_nuxt/BIb7tDp8.js 逆出的方案:
   *   Io(e,t) => r = e || t
   *              /^\d+(?:_\d+)+$/.test(r) ? r : r.split("").map(c=>c.charCodeAt(0)).join("_")
   *   Qt(e)   => e.split("_").map(c=>String.fromCharCode(+c)).join("")
   *   —— Io 把字面量逐字符转成 ASCII 码用 "_" 连接, Qt 再还原。
   *      所以密钥就是字面量本身的 ASCII 字节。
   *   key      = "2acf7e91e9864673"                   (16B → AES-128)
   *   iv       = "1c29882d3ddfcfd6"                   (16B)
   *   sign_key = "5589d41f92a597d016b037ac37db243d"
   *   mode = CBC, padding = Pkcs7, _ver = "v0", client = "ios"
   *
   * 请求 (POST, application/x-www-form-urlencoded):
   *   data = base64( AES-128-CBC-PKCS7( JSON({...oauth, ...params}) ) )
   *   sign = MD5( SHA256( 字段按名排序拼 "k=v" 用 "&" 连接, data 里的空格换 "+"
   *                       + sign_key ).hexdigest() )
   *   序列化顺序: _ver, client, data, sign, timestamp, 其余按字母序
   *
   * 响应: {errcode, timestamp, data:<base64>, sign}
   *   data.replace(/ /g,"+") → base64 → AES-CBC 解密 → UTF-8 → JSON
   *
   * 【IP 保护】与黄果一致: 全部请求从 Cloudflare 出口发出, 浏览器不碰 api2.chengguodj.com;
   *   m3u8 里的分片和 AES key (hls.tpbbwcc.cn / mts.hhjd.mobi) 由 /api/cg/media 重写回本站。
   */

  const CG_API = "https://api2.chengguodj.com";
  const CG_SITE = "https://chengguodj.com";
  const CG_KEY = "2acf7e91e9864673";
  const CG_IV = "1c29882d3ddfcfd6";
  const CG_SIGN_KEY = "5589d41f92a597d016b037ac37db243d";
  const CG_FIELD_ORDER = ["_ver", "client", "data", "sign", "timestamp"];

  // 媒体主机的放行规则。
  //
  // ★ 上游会**轮换媒体域名**: 同一条 m3u8, 十分钟前分片在 mts.hhjd.mobi,
  //   十分钟后就变成 tx.doudou520.online。纯后缀白名单会随轮换失效 (实测踩过:
  //   m3u8 拉得到, 但分片和 AES key 全 403, 播放直接断)。
  //
  // 所以改成两层:
  //   第一层 —— 已知后缀白名单, 命中即放行;
  //   第二层 —— 主机不是内网/回环/IP 字面量, 且路径严格符合上游媒体布局
  //             /videos<N>/<32位十六进制>/(...).ts|crypt.key|.m3u8
  //             32 位十六进制这一段是站方的资源 ID, 随机 URL 撞不上,
  //             因此仍然挡得住把 Worker 当通用代理/SSRF 跳板。
  const CG_MEDIA_HOST_RE = /^(?:[a-z0-9-]+\.)?(?:tpbbwcc\.cn|hhjd\.mobi|doudou520\.online|jtzatly\.cn|r2\.dev|chengguodj\.com)$/i;

  const CG_MEDIA_PATH_RE = /^\/videos\d*\/[0-9a-f]{16,40}\/[^\/]*\.(?:ts|m4s|mp4|key)|^\/videos\d*\/[0-9a-f]{16,40}\/crypt\.key$/i;

  // 内网 / 回环 / 链路本地 / IP 字面量 —— 一律不放行
  const CG_PRIVATE_HOST_RE = /^(?:localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i;

  function cgMediaHostAllowed(host, pathname) {
    if (!host) return false;
    if (CG_PRIVATE_HOST_RE.test(host)) return false;
    if (CG_MEDIA_HOST_RE.test(host)) return true;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;   // 别的主机名才放行
    return CG_MEDIA_PATH_RE.test(pathname || "");
  }

  const CG_CHANNELS = [
    { code: "yuanchuang", name: "橙果原创", route: "/yuanchuang" },
    { code: "zhenren",    name: "真人短剧", route: "/zhenren" },
    { code: "aiduanju",   name: "AI短剧",   route: "/aiduanju" },
    { code: "manju",      name: "AI漫剧",   route: "/manju" },
    { code: "mogai",      name: "AI魔改",   route: "/mogai" },
  ];

  const CG_BAD_UNTIL = 0;

  /* ---------------- base64 / 字节工具 ---------------- */

  function cgBytesToB64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function cgB64ToBytes(str) {
    const bin = atob(String(str));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function cgHex(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += ("0" + bytes[i].toString(16)).slice(-2);
    return s;
  }

  /* ---------------- MD5 (Workers 的 crypto.subtle 没有 MD5) ---------------- */

  const CG_MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  let CG_MD5_K = null;
  function cgMd5K() {
    if (CG_MD5_K) return CG_MD5_K;
    const k = new Uint32Array(64);
    for (let i = 0; i < 64; i++) {
      k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    }
    CG_MD5_K = k;
    return k;
  }

  // 输入 Uint8Array, 输出 16 字节摘要
  function cgMd5(bytes) {
    const K = cgMd5K();
    const len = bytes.length;
    const total = (((len + 8) >> 6) + 1) << 6;   // 补到 64 字节块的整数倍
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    const bits = len * 8;
    dv.setUint32(total - 8, bits >>> 0, true);
    dv.setUint32(total - 4, Math.floor(bits / 4294967296) >>> 0, true);

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const M = new Uint32Array(16);
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + (i << 2), true);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16)      { F = (B & C) | (~B & D);      g = i; }
        else if (i < 32) { F = (D & B) | (~D & C);      g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D;               g = (3 * i + 5) % 16; }
        else             { F = C ^ (B | ~D);            g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) >>> 0;
        A = D; D = C; C = B;
        const sh = CG_MD5_S[i];
        B = (B + (((F << sh) | (F >>> (32 - sh))) >>> 0)) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0;
      c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    const out = new Uint8Array(16);
    const ov = new DataView(out.buffer);
    ov.setUint32(0, a0, true); ov.setUint32(4, b0, true);
    ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
    return out;
  }

  function cgMd5Hex(str) {
    return cgHex(cgMd5(new TextEncoder().encode(String(str))));
  }

  /* ---------------- AES-128-CBC (WebCrypto, 自动 PKCS#7) ---------------- */

  let CG_AES_KEY = null;
  async function cgAesKey() {
    if (!CG_AES_KEY) {
      CG_AES_KEY = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(CG_KEY), { name: "AES-CBC" }, false,
        ["encrypt", "decrypt"]);
    }
    return CG_AES_KEY;
  }

  async function cgAesEncrypt(text) {
    const key = await cgAesKey();
    const iv = new TextEncoder().encode(CG_IV);
    const ct = await crypto.subtle.encrypt({ name: "AES-CBC", iv: iv },
      key, new TextEncoder().encode(text));
    return new Uint8Array(ct);
  }

  async function cgAesDecrypt(bytes) {
    const key = await cgAesKey();
    const iv = new TextEncoder().encode(CG_IV);
    const pt = await crypto.subtle.decrypt({ name: "AES-CBC", iv: iv }, key, bytes);
    return new TextDecoder().decode(pt);
  }

  /* ---------------- 签名 + 信封 ---------------- */

  // Dx(): 字段按名排序拼 k=v, data 的空格换 +, 末尾接 sign_key
  async function cgSign(fields) {
    const parts = [];
    const keys = Object.keys(fields).sort();
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k === "sign" || k === "_ver") continue;
      const v = fields[k];
      if (v === undefined || v === null) continue;
      let sv = String(v);
      if (k === "data") sv = sv.split(" ").join("+");
      parts.push(k + "=" + sv);
    }
    const raw = parts.join("&") + CG_SIGN_KEY;
    const sha = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    return cgMd5Hex(cgHex(new Uint8Array(sha)));
  }

  // c8(): 固定顺序在前, 其余按字母序, 值做 urlencode
  function cgSerialize(fields) {
    const head = [], tail = [];
    for (let i = 0; i < CG_FIELD_ORDER.length; i++) {
      const k = CG_FIELD_ORDER[i];
      if (Object.prototype.hasOwnProperty.call(fields, k)) head.push(k);
    }
    const rest = Object.keys(fields).filter(function (k) {
      return CG_FIELD_ORDER.indexOf(k) < 0;
    }).sort();
    const all = head.concat(rest);
    return all.map(function (k) {
      return encodeURIComponent(k) + "=" + encodeURIComponent(fields[k]);
    }).join("&");
  }

  // JS(): 明文 → 表单编码的加密请求体
  async function cgEncryptBody(params) {
    const plain = JSON.stringify(params || {});
    const fields = {
      "_ver": "v0",
      "data": cgBytesToB64(await cgAesEncrypt(plain)),
      "timestamp": Math.floor(Date.now() / 1000),
      "client": "ios",
    };
    fields["sign"] = await cgSign(fields);
    return cgSerialize(fields);
  }

  // ZS() → Sx() → Cx()
  async function cgDecryptPacket(resp, msg) {
    if (!resp || typeof resp !== "object") {
      return { ok: false, error: "响应格式异常", status: 0 };
    }
    // 明文响应 (success 布尔 + data 非字符串)
    if (typeof resp.success === "boolean" && typeof resp.data !== "string") {
      return resp;
    }
    if (resp.sign) {
      const exp = await cgSign(resp);
      if (exp !== resp.sign) {
        return { ok: false, error: "响应签名校验失败", status: 0 };
      }
    }
    const d = resp.data;
    if (!d) return { ok: false, error: msg || "响应数据为空", status: 0 };
    const b64 = String(d).split(" ").join("+");
    let text;
    try {
      text = await cgAesDecrypt(cgB64ToBytes(b64));
    } catch (e) {
      return { ok: false, error: "解密失败: " + String((e && e.message) || e), status: 0 };
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      return { ok: false, error: "解密后不是 JSON: " + String((e && e.message) || e),
               head: text.slice(0, 120), status: 0 };
    }
  }

  /* ---------------- 出网 ---------------- */

  // strictJsonBody=true 时走明文 JSON (上游 /episodes/{n} 就是这个模式)
  // ★ 这是"单次尝试"版本; 对外的入口是下面的 cgPost 重试包装。
  async function cgPostOnce(path, params, useJsonBody) {
    let body, ctype;
    if (useJsonBody) {
      body = JSON.stringify(params || {});
      ctype = "application/json";
    } else {
      body = await cgEncryptBody(params);
      ctype = "application/x-www-form-urlencoded";
    }
    let r;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(function () { ctl.abort(); }, 15000);
      try {
        r = await fetch(CG_API + path, {
          method: "POST",
          headers: {
            "User-Agent": UA,
            "Accept": "application/json, text/plain, */*",
            "Accept-Encoding": "identity",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Content-Type": ctype,
            "Origin": CG_SITE,
            "Referer": CG_SITE + "/",
          },
          body: body,
          redirect: "follow",
          signal: ctl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      return { ok: false, error: "请求失败: " + String((e && e.message) || e) };
    }
    const txt = await r.text();
    let j;
    try {
      j = JSON.parse(txt);
    } catch (e) {
      return { ok: false, error: "上游返回非 JSON (HTTP " + r.status + ")",
               head: txt.slice(0, 160) };
    }
    const d = await cgDecryptPacket(j, j && j.msg);
    if (!d || d.ok === false) return d || { ok: false, error: "解密无结果" };
    if (d.success === false) {
      return { ok: false, error: (d.error && d.error.message) || "上游报错",
               code: d.error && d.error.code, http: r.status };
    }
    return { ok: true, data: d.data === undefined ? d : d.data, raw: d, http: r.status };
  }

  /* ---------------- 出网重试包装 (有界) ----------------
   * ★ 为什么必须加:
   *   2026-10-17 实测 —— 3 路并发打 /api/cg/detail 与 /api/cg/ep, 上游会直接回
   *     {"ok":false,"error":"依赖服务暂时不可用"}
   *   而且**响应极快**: 383ms / 387ms / 400ms / 454ms / 740ms, 远没到 15s 超时。
   *   这是上游的限流/降级, 不是网络故障; 并发一升失败率就从 1/3 涨到 3/3。
   *
   *   原来的 cgPost 一次都不重试 —— 上游一次瞬时拒绝就原样变成用户的 502,
   *   表现就是"列表能打开、点开播不了"。用户看到的是坏掉, 不是"稍后重试"。
   *
   * 纪律 (三条, 缺一不可):
   *   ① 有界    —— 最多 3 次尝试, 绝不用 while(true) 顶。
   *   ② 有间隔  —— 200ms / 500ms 基准 + 0~200ms 抖动。抖动是为了避免多路并发
   *                在同一个时刻一起重试, 变成同步冲击, 把上游打得更死。
   *   ③ 只对瞬时错误 —— 参数错/字段错/风控这类重试也不会变对, 直接返回。
   *                无节制重试只会把上游的"临时降级"喂成"持续降级"。
   */
  const CG_RETRY_RE = /依赖服务暂时不可用|服务暂时不可用|请稍后|稍后再试|too\s*many|rate.?limit|timeout|timed\s*out|ECONNRESET|socket hang up|network|上游返回非 JSON \(HTTP 5\d\d\)|请求失败/i;

  function cgSleep(ms) {
    return new Promise(function (res) { setTimeout(res, ms); });
  }

  async function cgPost(path, params, useJsonBody) {
    const CG_MAX_TRIES = 3;
    const CG_BUDGET_MS = 25000;     // 总预算: 单次超时已达 15s, 不允许无限叠加
    const t0 = Date.now();
    let last = null;
    let used = 0;

    for (let attempt = 1; attempt <= CG_MAX_TRIES; attempt++) {
      used = attempt;
      const r = await cgPostOnce(path, params, useJsonBody);
      if (r && r.ok) {
        if (attempt > 1) r.retried = attempt - 1;   // 供观测: 这次是重试救回来的
        return r;
      }
      last = r;

      const transient = CG_RETRY_RE.test(String((r && r.error) || ""));
      if (!transient) break;                        // 非瞬时 → 重试无意义
      if (attempt >= CG_MAX_TRIES) break;           // 有界
      if (Date.now() - t0 > CG_BUDGET_MS) break;    // 预算保护

      const base = attempt === 1 ? 200 : 500;
      await cgSleep(base + Math.floor(Math.random() * 200));
    }

    if (last && last.ok !== true) {
      last.attempts = used;                         // 供观测: 究竟试了几次
      last.elapsedMs = Date.now() - t0;
    }
    return last;
  }

  /* ---------------- 统一卡片 ---------------- */

  // 上游各接口字段不统一: 频道 items 用 cover.url / total_episode_count,
  // 搜索 dramas 用 cover(字符串) / total_episodes, feed 又是另一套。这里全部归一。
  // 上游同一字段在不同接口里可能是字符串 (搜索) 也可能是对象 (频道/详情/推荐)。
  // 不兼容对象会直接抛 "u.charAt is not a function" —— 实测踩过。
  function cgAbs(u) {
    if (!u) return "";
    if (typeof u === "object") u = u.url || u.src || u.cover || "";
    u = String(u || "");
    if (!u) return "";
    if (/^https?:\/\//i.test(u)) return u;
    return CG_SITE + (u.charAt(0) === "/" ? u : "/" + u);
  }

  function cgCard(x) {
    x = x || {};
    let cover = "";
    if (typeof x.cover === "string") cover = x.cover;
    else if (x.cover && typeof x.cover === "object") cover = x.cover.url || "";
    if (!cover) cover = x.cover_fallback_url || x.poster_url || "";

    let chan = x.channel;
    if (chan && typeof chan === "object") chan = chan.code;
    chan = chan || x.channel_code || "";

    const total = x.total_episode_count || x.total_episodes || x.episode_count || 0;
    const latest = x.latest_episode_number || x.published_episode_count || total;
    const done = (x.serial_status || x.status) === "completed" ||
                 (x.serial_status || x.status) === "finished";

    const tags = (x.tags || []).map(function (t) { return (t && t.name) || t; }).filter(Boolean);

    return {
      id: x.id,
      slug: x.slug || "",
      title: x.title || "",
      cover: cgAbs(cover),
      score: "",
      ep: done ? ("全" + total + "集") : ("更新至" + latest + "集"),
      epTotal: total,
      desc: x.intro || x.description || "",
      tags: tags,
      hot: x.heat_7d || x.heat || 0,
      author: "",
      channel: chan,
      channelName: (function () {
        for (let i = 0; i < CG_CHANNELS.length; i++) {
          if (CG_CHANNELS[i].code === chan) return CG_CHANNELS[i].name;
        }
        return "";
      })(),
      route: x.detail_route || x.route || ("/drama/" + (x.slug || x.id)),
      at: x.material_updated_at || x.updated_at || "",
    };
  }

  // 各接口的列表字段名不同: items / dramas
  function cgList(d) {
    d = d || {};
    if (Array.isArray(d.items)) return d.items;
    if (Array.isArray(d.dramas)) return d.dramas;
    if (Array.isArray(d.list)) return d.list;
    return [];
  }




/* ===================== EROSHORT 上游 =====================
 * eroshort.net 是 React SPA + REST 后端, 数据接口全部挂在 /api/v1 下。
 *
 * 【出口现实】2026-10-09 CI 实测:
 *   eroshort.net 对 Cloudflare 边缘 / 数据中心 / CI runner 出口一律返回
 *   403 "Sorry, you have been blocked" 硬拦页。Worker 出口与 GitHub Actions
 *   runner 出口都在封锁名单内, 本机直连同样被拦。
 *   这次能拿到前端 bundle 是**经公共 CORS 代理**取的, 不是直连。
 *
 * 【因此】取数走 直连 → 中转池 的降级链:
 *   1) ES_API_BASE 直连 (上游拦截会随时间/风控抖动, 通了最快)
 *   2) ES_RELAYS 里的公共 CORS 代理
 *   3) data/es-*.json 静态快照 (CI 经中转抓取后落盘)
 *
 * 前端调用形如: /api/es/shorts?page=1  →  https://eroshort.net/api/v1/shorts?page=1
 */
const ES_API_BASE = "https://eroshort.net/api/v1";
// 上游前端构建号, /playback/resolve 必须带 (bundle 里的 Q0 常量)
const ES_BUILD_ID = "dcdcc161385053f622cedf86ed610abd33dae3e034af5366a8a76a058baad118";
// 公共 CORS 中转池 (URL 直接拼在 prefix 后, 需 encodeURIComponent)
// 按本机实测可用性排序 (2026-10-09 复测):
//   allorigins /get 包装端点 : 200 命中, 返回 {"contents":"<body>"} —— 最稳, 置顶
//   allorigins /raw          : 500 (同域不同端点, 抖动)
//   cors.lol                 : 403 CF 挑战页 / 429 限流
//   codetabs                 : 522 / 读超时
//   whateverorigin           : 500
// 失效项会在运行中被跳过, 不影响链路。
const ES_RELAYS = [
  { name: "allorigins-get", prefix: "https://api.allorigins.win/get?url=", wrap: "contents" },
  { name: "allorigins-raw", prefix: "https://api.allorigins.win/raw?url=" },
  { name: "cors.lol", prefix: "https://api.cors.lol/?url=" },
  { name: "codetabs", prefix: "https://api.codetabs.com/v1/proxy?quest=" },
];

/* ===================== 黄豆全站清单 (搜索用) =====================
 * 为什么要有这个:
 *   上游 /videos?keyword= 是摆设 —— 实测「嫂子」「时停」「少妇」返回的首条、
 *   条数、total 全都一样 (total 固定 985)。也就是说上游根本没做关键词过滤,
 *   传什么词都给你同一份热度榜。想要真搜索, 只能把全站清单拉下来自己过滤。
 *
 * 怎么做:
 *   每页固定 20 条, 先拉第 1 页拿到 total, 再并行拉剩下的页。
 *   拉完的结果进内存缓存 (5 分钟), 顺带写进 caches 供冷启动复用。
 *   全站 ~1000 条, 50 页并行在 Worker 里一两秒就能完事。
 */
const HD_POOL_TTL = 5 * 60 * 1000;
const HD_POOL_MAX_PAGES = 60;     // 安全上限, 防止上游 total 抽风导致死循环
const HD_POOL_CACHE_KEY = "https://hg-internal.local/hd-pool-v1";
let HD_POOL = { at: 0, items: [], complete: false };

function hdItemKey(it) {
  return it && it.id != null ? String(it.id) : "";
}

/** 按关键词过滤 (标题 > 简介/备注/年份/标签) */
function filterByKeyword(items, kw) {
  const low = kw.toLowerCase();
  const out = [];
  for (const it of items) {
    if (!it) continue;
    const fields = [it.title, it.name, it.description, it.remarks, it.year, it.badge];
    if (Array.isArray(it.tags)) fields.push(it.tags.join(" "));
    if (typeof it.tags === "string") fields.push(it.tags);
    let hit = false;
    for (const f of fields) {
      if (f && String(f).toLowerCase().indexOf(low) >= 0) { hit = true; break; }
    }
    if (hit) out.push(it);
  }
  return out;
}

/** 单页抓取 (走 HD_API_LINES 轮询 + 坏线路标记) */
async function hdFetchPage(page) {
  for (const base of HD_API_LINES) {
    if (HD_BAD[base] && HD_BAD[base] > Date.now()) continue;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 12000);
      const r = await fetch(base + "/videos?page=" + page, {
        headers: { "User-Agent": UA, "Accept": "application/json", "Referer": "https://hddj30.cc/" },
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) { HD_BAD[base] = Date.now() + HD_BAD_TTL; continue; }
      const j = await r.json();
      delete HD_BAD[base];
      return {
        items: (j && j.items) || [],
        total: (j && j.total) || 0,
        hasMore: !!(j && j.hasMore),
      };
    } catch (e) {
      HD_BAD[base] = Date.now() + HD_BAD_TTL;
    }
  }
  return null;
}

/** 拿全站清单 (内存 -> caches -> 重新拉) */
async function hdAllItems(ctx) {
  if (HD_POOL.items.length && Date.now() - HD_POOL.at < HD_POOL_TTL) {
    return HD_POOL;
  }

  // 冷启动: 试试持久缓存 (Worker 实例重启后内存是空的)
  if (typeof caches !== "undefined") {
    try {
      const hit = await caches.default.match(HD_POOL_CACHE_KEY);
      if (hit) {
        const j = await hit.json();
        if (j && Array.isArray(j.items) && j.items.length) {
          HD_POOL = { at: Date.now(), items: j.items, complete: !!j.complete };
          return HD_POOL;
        }
      }
    } catch (e) { /* 缓存不可用就当没命中 */ }
  }

  // 先拉首页, 拿 total 决定要拉多少页
  const first = await hdFetchPage(1);
  if (!first || !first.items.length) {
    // 上游全挂了, 有旧数据就先凑合用
    if (HD_POOL.items.length) return HD_POOL;
    return { at: Date.now(), items: [], complete: false };
  }

  const total = first.total || first.items.length;
  const pages = Math.min(HD_POOL_MAX_PAGES, Math.max(1, Math.ceil(total / 20)));

  const seen = Object.create(null);
  const items = [];
  const push = (arr) => {
    for (const it of arr) {
      const k = hdItemKey(it);
      if (!k || seen[k]) continue;
      seen[k] = 1;
      items.push(it);
    }
  };
  push(first.items);

  // 剩下的页分批发, 一次 10 页, 免得瞬时把上游打爆
  const rest = [];
  for (let p = 2; p <= pages; p++) rest.push(p);

  let complete = true;
  for (let i = 0; i < rest.length; i += 10) {
    const batch = rest.slice(i, i + 10);
    const rs = await Promise.all(batch.map((p) => hdFetchPage(p).catch(() => null)));
    for (const r of rs) {
      if (!r) { complete = false; continue; }
      push(r.items);
    }
  }

  HD_POOL = { at: Date.now(), items, complete };

  if (typeof caches !== "undefined") {
    ctx && ctx.waitUntil && ctx.waitUntil(
      caches.default.put(HD_POOL_CACHE_KEY, new Response(JSON.stringify({
        at: HD_POOL.at, items, complete,
      }), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=300" } }))
        .catch(() => {})
    );
  }

  return HD_POOL;
}

// 允许的前端来源 (部署后把你的 GitHub Pages 地址填进来)
const ALLOW_ORIGINS = [
  "*",
];

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOW_ORIGINS.includes("*") ? "*" : (ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0]),
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    // 浏览器默认读不到 Content-Range / Accept-Ranges, 播放器要靠它们判断 seek 能力
    "Access-Control-Expose-Headers": "Content-Length,Content-Range,Accept-Ranges,ETag",
    "Access-Control-Max-Age": "86400",
    "X-Content-Type-Options": "nosniff",
  };
}

async function fetchWithMirror(path, extraHeaders) {
  let lastErr = null;
  for (const base of mirrorOrder()) {
    try {
      const url = base + path;
      const r = await fetch(url, {
        headers: {
          "User-Agent": UA,
          "Accept": "text/html,application/xhtml+xml,application/xml,*/*",
          "Accept-Language": "zh-CN,zh;q=0.9",
          "Referer": base + "/",
          ...extraHeaders,
        },
        redirect: "follow",
      });
      // 学到新域名: 响应最终落点是别的 host → 记下来, 下次优先用
      try {
        const finalHost = new URL(r.url).origin;
        if (finalHost && finalHost !== base && !MIRRORS.includes(finalHost)) {
          LEARNED_MIRROR = finalHost;
          console.log("[湟果] 学到新镜像: " + finalHost + " (来自 " + base + ")");
        }
      } catch (e) { /* r.url 不可解析就算了 */ }

      if (r.status === 200) {
        // 命中"地址发布页"或"下载落地页" → 只提取线路, 绝不把它的 HTML 当数据返回。
        //
        // ★ 这是"播放内容全是官方宣传广告"的直接成因:
        //   上游改成落地页后, 网页里唯一存在的 <video>/m3u8 就是品牌宣传片;
        //   旧逻辑照单全收 → 用户点任何一集都播宣传片。
        //   现在落地页一律不当数据源, 让 /api/ep 老实返回 404。
        const bodyText = await r.text();
        const host = base.replace(/^https?:\/\//, "");
        const landing = isLandingPage(bodyText);
        if (landing || PUBLISH_HOSTS.indexOf(host) >= 0) {
          const cfg = landing ? extractLandingConfig(bodyText) : null;
          const decoded = cfg ? cfg.plain : bodyText;
          const cand = [];
          if (cfg) cand.push(cfg.webAppUrl, cfg.official, cfg.latest, cfg.permanent);
          for (const h of extractRealHosts(decoded)) cand.push("https://" + h);
          for (const h of extractRealHosts(bodyText)) cand.push("https://" + h);

          for (const u of cand.reverse()) {
            if (!u || !/^https?:\/\//i.test(u)) continue;
            const clean = String(u).replace(/\/+$/, "");
            if (!clean || MIRRORS.indexOf(clean) >= 0) continue;
            let h2 = "";
            try { h2 = new URL(clean).host; } catch (e) { continue; }
            if (DEAD_SUFFIX.test(h2) || isPromoUrl(clean)) continue;
            if (MIRRORS.length > 120) break;      // 别把列表撑爆
            MIRRORS.unshift(clean);
          }
          markBadMirror(base);          // 落地页/发布页不是数据源
          lastErr = new Error(landing ? "landing-page" : "publish-page");
          continue;
        }
        // 正常 HTML 数据页: 用文本重建 Response (body 已被读过)
        return {
          r: new Response(bodyText, {
            status: 200,
            headers: { "Content-Type": r.headers.get("Content-Type") || "text/html; charset=utf-8" },
          }),
          base,
        };
      }
      lastErr = new Error("status " + r.status);
      markBadMirror(base);
    } catch (e) { lastErr = e; markBadMirror(base); }
  }
  throw lastErr || new Error("all mirrors failed");
}

// ==== 芒果短剧 (mgmg10.com) 解析 ====
// 与 hg-mg.js 前端版本保持一致。站点结构见 hg-mg.js 头部注释。
const MG_HOST = "https://mgmg10.com";

function mgAbs(u) {
  if (!u) return "";
  u = String(u).replace(/&amp;/g, "&").trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (u[0] === "/") return MG_HOST + u;
  return u;
}

function mgIdFromHref(href) {
  const m = String(href || "").match(/\/details\/([0-9a-f]{16,32})\.html/);
  return m ? m[1] : "";
}

function mgParseCards(html) {
  const items = {};
  const stats = { feature: 0, grid: 0, ld: 0 };

  const put = (id, patch) => {
    if (!id) return;
    const cur = items[id] || (items[id] = { id });
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      if (v === null || v === undefined || v === "") continue;
      if (k === "tags") { if (v && v.length) cur.tags = v; continue; }
      if (!cur[k]) cur[k] = v;
    }
  };

  // A) dm-feature-card
  const fparts = html.split("dm-feature-card");
  for (let i = 1; i < fparts.length; i++) {
    const blk = fparts[i].slice(0, 4000);
    const hm = blk.match(/href="([^"]*\/details\/[0-9a-f]{16,32}\.html)"/i);
    const id = hm ? mgIdFromHref(hm[1]) : "";
    if (!id) continue;
    const tm = blk.match(/dm-feature-title[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    const pm = blk.match(/dm-feature-pvtitle[^>]*>([\s\S]*?)<\/span>/i);
    const em = blk.match(/dm-feature-pvep[^>]*>([\s\S]*?)<\/span>/i);
    const im = blk.match(/<img[^>]*\bsrc="([^"]+)"/i);
    const pv = blk.match(/<span[^>]*class="lc-preview-slot"[^>]*data-src="([^"]+)"/i);
    const epTxt = em ? clean(em[1]) : "";
    const epm = epTxt.match(/(\d+)/);
    const tags = [];
    const tagRe = /class="dm-tag"[^>]*>([\s\S]*?)<\/a>/gi;
    let tg;
    while ((tg = tagRe.exec(blk)) !== null) {
      const t = clean(tg[1]);
      if (t && tags.indexOf(t) < 0) tags.push(t);
    }
    put(id, {
      title: clean(tm ? tm[1] : (pm ? pm[1] : "")),
      cover: im ? mgAbs(im[1]) : "",
      preview: pv ? mgAbs(pv[1]) : "",
      ep: epm ? epm[1] : "",
      epLabel: epTxt,
      updating: /更新至/.test(epTxt),
      tags: tags.slice(0, 6),
    });
    stats.feature++;
  }

  // B) 通用网格卡片
  const re = /href="([^"]*\/details\/([0-9a-f]{16,32})\.html)"([^>]*)>([\s\S]{0,2500}?)(?=href="[^"]*\/details\/|<\/article|<\/li|$)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const gid = m[2];
    const seg = m[4];
    const img = seg.match(/<img[^>]*\b(?:data-src|src)="([^"]+\.(?:jpg|jpeg|png|webp|gif)[^"]*)"/i);
    let title = "";
    const tt = seg.match(/class="[^"]*title[^"]*"[^>]*>([\s\S]{0,200}?)<\//i);
    if (tt) title = clean(tt[1]);
    if (!title) {
      const alt = seg.match(/<img[^>]*\balt="([^"]*)"/i);
      if (alt) title = clean(alt[1]);
    }
    const et = seg.match(/(更新至\s*\d+\s*集|\d+\s*集|全\s*\d+\s*集)/);
    const epm2 = et ? et[1].match(/(\d+)/) : null;
    put(gid, {
      title,
      cover: img ? mgAbs(img[1]) : "",
      ep: epm2 ? epm2[1] : "",
      epLabel: et ? et[1] : "",
      updating: /更新至/.test(et ? et[1] : ""),
    });
    stats.grid++;
  }

  // C) JSON-LD
  const ldRe = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let lm;
  while ((lm = ldRe.exec(html)) !== null) {
    let j;
    try { j = JSON.parse(lm[1].trim()); } catch (e) { continue; }
    const stack = [j];
    while (stack.length) {
      const o = stack.pop();
      if (Array.isArray(o)) { stack.push(...o); continue; }
      if (!o || typeof o !== "object") continue;
      if (o["@type"] === "ListItem" || o["@type"] === "VideoObject" || o["@type"] === "CreativeWork") {
        const lid = mgIdFromHref(o.item || o.url || o["@id"] || "");
        if (lid) { put(lid, { title: clean(o.name || o.headline || "") }); stats.ld++; }
      }
      for (const k of Object.keys(o)) stack.push(o[k]);
    }
  }

  const out = [];
  for (const k of Object.keys(items)) {
    const it = items[k];
    if (!it.title) it.title = "剧集 " + it.id;
    out.push(it);
  }
  return { items: out, stats };
}

function mgParseDetail(html) {
  const meta = {}, eps = [];
  const am = html.match(/data-article-id="([0-9a-f]{16,32})"/i);
  meta.id = am ? am[1] : "";

  const tm = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  meta.title = clean(tm ? tm[1] : "");

  let cm = html.match(/<img[^>]*\bsrc="(https?:\/\/[^"]*cover[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
  if (!cm) cm = html.match(/data-video-cover="([^"]+)"/i);
  meta.cover = cm ? mgAbs(cm[1]) : "";

  const vm = html.match(/data-video-src="([^"]+)"/i);
  meta.firstEp = vm ? vm[1] : "";

  const heat = html.match(/dm-detail-poster-heat[\s\S]{0,300}?<span>([^<]*)<\/span>/i);
  meta.heat = heat ? clean(heat[1]) : "";

  const tags = [];
  const bc = html.match(/<nav class="breadcrumb"[\s\S]*?<\/nav>/i);
  if (bc) {
    const lre = /<a[^>]*href="\/category\/([^"\/]+)\/"[^>]*>([^<]*)<\/a>/gi;
    let x;
    while ((x = lre.exec(bc[0])) !== null) tags.push(clean(x[2]));
  }
  const tre = /<a[^>]*href="\/tag\/[^"]*"[^>]*>([^<]*)<\/a>/gi;
  let y;
  while ((y = tre.exec(html)) !== null) {
    const tt = clean(y[1]);
    if (tt && tags.indexOf(tt) < 0) tags.push(tt);
  }
  meta.tags = tags.slice(0, 8);

  let dm = html.match(/class="[^"]*dm-detail-desc[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/i);
  if (!dm) dm = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
  meta.description = dm ? clean(dm[1]) : "";

  const ere = /<a[^>]*class="dm-ep([^"]*)"[^>]*href="([^"]*)"[^>]*data-ep="(\d+)"[^>]*data-ep-free="(\d+)"[^>]*data-pay-method="([^"]*)"[^>]*data-pay-price="(\d+)"/gi;
  let e;
  while ((e = ere.exec(html)) !== null) {
    const locked = e[1].indexOf("is-locked") >= 0;
    const free = e[4] === "1";
    eps.push({
      ep: parseInt(e[3], 10),
      free: free && !locked,
      locked,
      payMethod: e[5] || "",
      payPrice: e[6] || "0",
    });
  }
  eps.sort((a, b) => a.ep - b.ep);
  meta.epTotal = eps.length;
  meta.epFreeCount = eps.filter((x) => x.free).length;
  return { meta, eps };
}

// ==== 统一数据清洗 ====
function clean(s) {
  if (!s) return "";
  s = String(s);
  s = s.replace(/<span[^>]*class="[^"]*sr-only[^"]*"[^>]*>[\s\S]*?<\/span>/g, "");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
       .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

// ==== 从一块 HTML 里抽封面 (兼容多种懒加载写法) ====
function extractCover(blk) {
  if (!blk) return "";
  // 优先级: data-src > data-original > data-lazy-src > data-lazy > srcset > src
  const pats = [
    /data-src\s*=\s*["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp|gif)[^"']*)["']/i,
    /data-original\s*=\s*["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp|gif)[^"']*)["']/i,
    /data-lazy(?:-src)?\s*=\s*["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp|gif)[^"']*)["']/i,
    /data-src\s*=\s*["']([^"']+\.(?:jpg|jpeg|png|webp|gif)[^"']*)["']/i,
    /data-original\s*=\s*["']([^"']+\.(?:jpg|jpeg|png|webp|gif)[^"']*)["']/i,
  ];
  for (const p of pats) {
    const m = blk.match(p);
    if (m) {
      let u = m[1].replace(/&amp;/g, "&").trim();
      if (u && !/cover-placeholder|placeholder\.(png|webp)/i.test(u)) return u;
    }
  }
  // srcset: 取第一个 URL
  const ss = blk.match(/srcset\s*=\s*["']([^"']+)["']/i);
  if (ss) {
    const first = ss[1].split(",")[0].trim().split(/\s+/)[0];
    if (first && !/cover-placeholder/i.test(first)) return first.replace(/&amp;/g, "&");
  }
  // 最后兜底 src (排除占位图)
  const sm = blk.match(/<img[^>]+src\s*=\s*["']([^"']+\.(?:jpg|jpeg|png|webp|gif)[^"']*)["']/i);
  if (sm && !/cover-placeholder|placeholder\.(png|webp)/i.test(sm[1])) {
    return sm[1].replace(/&amp;/g, "&");
  }
  return "";
}

// ==== 多源合并解析 (广告自动过滤) ====
function parseCards(html) {
  const items = new Map();

  function put(id, patch) {
    if (!id) return;
    const cur = items.get(id) || { id };
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      if (v === undefined || v === null || v === "") continue;
      if (k === "tags") { if (v.length) cur.tags = v; continue; }
      if (!cur[k]) cur[k] = v;
    }
    items.set(id, cur);
  }

  // ---- 源1: 内嵌 JSON 数组 (hero/recommend, 带 isAd 标记) ----
  for (const m of html.matchAll(/\[\s*\{\s*"title"[\s\S]*?\}\s*\]/g)) {
    let arr;
    try { arr = JSON.parse(m[0]); } catch (e) { continue; }
    if (!Array.isArray(arr)) continue;
    for (const o of arr) {
      if (!o || typeof o !== "object") continue;
      if (o.isAd === true) continue;                    // 广告丢弃
      const href = o.href || o.detailHref || "";
      const idm = String(href).match(/\/(?:video|detail)\/(\d+)/);
      if (!idm) continue;                               // 无内链的推广位也丢弃
      if (isPromoUrl(href)) continue;                   // 推广位丢弃
      const epTxt = clean(o.episode);
      const epm = epTxt.match(/(\d+)\s*集/);
      put(idm[1], {
        title: clean(o.title),
        cover: String(o.cover || o.thumb || "").replace(/&amp;/g, "&"),
        score: clean(o.score),
        ep: epm ? epm[1] : "",
        updating: epTxt.indexOf("更新至") >= 0,
        desc: clean(o.desc),
      });
    }
  }

  // ---- 源2: JSON-LD (SEO 结构化) ----
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let j;
    try { j = JSON.parse(m[1]); } catch (e) { continue; }
    const walk = (o) => {
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (!o || typeof o !== "object") return;
      const ty = o["@type"];
      if (ty === "ListItem" || ty === "VideoObject" || ty === "CreativeWork" || ty === "ItemList") {
          const u = o.url || o.contentUrl || o["@id"] || "";
          const idm = String(u).match(/\/(?:video|detail)\/(\d+)/);
        if (idm) put(idm[1], { title: clean(o.name || o.headline || "") });
      }
      for (const v of Object.values(o)) walk(v);
    };
    walk(j);
  }

  // ---- 源3: hg-drama-card (主列表, 字段最全) ----
  const blocks = html.split('<div class="hg-drama-card"').slice(1);
  for (let blk of blocks) {
    blk = blk.slice(0, 3500);
    const mid = blk.match(/data-track-id="(\d+)"/) || blk.match(/href="\/(?:video|detail)\/(\d+)/);
    if (!mid) continue;
    const alt = blk.match(/<img[^>]*\balt="([^"]*)"/);
    const dtt = blk.match(/data-track-title="([^"]*)"/);
    let title = alt ? clean(alt[1]) : (dtt ? clean(dtt[1]) : "");
    title = title.replace(/(全集在线观看|在线观看|全集|免费观看|高清观看)$/, "").trim();
    const cover = extractCover(blk);
    const sc = blk.match(/__score[^>]*>([^<]*)</);
    const em = blk.match(/__episode[^>]*>([\s\S]*?)<\/span>\s*<\/div>/);
    const epTxt = em ? clean(em[1]) : "";
    const epm = epTxt.match(/(\d+)\s*集/);
    const de = blk.match(/__desc[^>]*>([\s\S]*?)<\/p>/);
    const tags = [...blk.matchAll(/class="hg-tag"[^>]*>([\s\S]*?)<\/a>/g)].map(x => clean(x[1])).filter(Boolean).slice(0, 6);
    put(mid[1], {
      title, cover,
      score: sc ? clean(sc[1]) : "",
      ep: epm ? epm[1] : "", updating: epTxt.indexOf("更新至") >= 0,
      desc: de ? clean(de[1]) : "", tags,
    });
  }

  // ---- 源4: hg-category-item (分类网格) ----
  for (const m of html.matchAll(/<a[^>]*class="hg-category-item"[^>]*href="\/(?:video|detail)\/(\d+)\/"[^>]*>([\s\S]*?)<\/a>/g)) {
    const blk = m[2];
    const tt = blk.match(/__title[^>]*>([\s\S]*?)<\/div>/);
    const cover = extractCover(blk);
    const de = blk.match(/__desc[^>]*>([\s\S]*?)<\/p>/);
    put(m[1], {
      title: tt ? clean(tt[1]) : "",
      cover,
      desc: de ? clean(de[1]) : "",
    });
  }

  // ---- 源5: 热搜榜 (带热度) ----
  for (const m of html.matchAll(/hg-search-suggest__hot-item"[^>]*>[\s\S]*?<a[^>]*href="\/(?:video|detail)\/(\d+)\/"[^>]*>([^<]*)<\/a>[\s\S]*?__heat[^>]*>([^<]*)</g)) {
    put(m[1], { title: clean(m[2]), heat: clean(m[3]) });
  }

  const out = [];
  for (const it of items.values()) {
    if (it.isAd === true) continue;
    if (!it.title) it.title = "剧集 " + it.id;
    out.push(it);
  }
  return out;
}
function parseVideo(html) {
  const m = html.match(/id="videoInitialData"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch (e) { return null; }
  const vid = String(data.id || "");
  const eps = {};
  // 权威源: videoInitialData.epPlaySrcs —— 上游按剧下发的"集号 -> m3u8"表
  for (const [k, v] of Object.entries(data.epPlaySrcs || {})) {
    if (!/^\d+$/.test(k) || typeof v !== "string" || !v.startsWith("http")) continue;
    const u = v.replace(/&amp;/g, "&").replace(/\\u0026/g, "&");
    if (isPromoUrl(u) || isMirrorHosted(u)) continue;   // 推广物料 / 落地页自托管宣传片 一律丢弃
    eps[k] = u;
  }
  // 只有当页面上确实存在 data-play-id === 本剧ID 的播放块时才补第 1 集。
  // 旧逻辑把页面里"所有" data-play-src 按序号塞进 eps —— 带推荐位轮播播放器的
  // 详情页上, 这会把别的剧/推广位的 m3u8 混成第 2、3、4…集: 用户点选集,
  // 播出来的却是官方宣传片或别的剧。这是本次"播放全是宣传广告"的直接成因之一。
  const own1 = html.match(/data-play-id="(\d+)"[^>]*data-play-src="([^"]+)"/)
            || html.match(/data-play-src="([^"]+)"[^>]*data-play-id="(\d+)"/);
  if (own1 && !eps["1"]) {
    const aIsId = /^\d+$/.test(own1[1]);
    const pid = aIsId ? own1[1] : own1[2];
    const srcU = aIsId ? own1[2] : own1[1];
    if (pid === vid) {
      const u = String(srcU).replace(/&amp;/g, "&");
      if (!isPromoUrl(u) && !isMirrorHosted(u)) eps["1"] = u;
    }
  }
  let total = 0;
  for (const mm of html.matchAll(new RegExp("/video/" + vid + "/ep-(\\d+)/", "g"))) {
    total = Math.max(total, parseInt(mm[1], 10));
  }
  return {
    id: vid,
    title: data.title || "",
    author: data.author || "",
    views: data.views || "",
    tags: data.tags || [],
    description: data.description || "",
    cover: (data.coverSrc || "").replace(/&amp;/g, "&"),
    epTotal: total || Object.keys(eps).length,
    eps,
  };
}

// 按"当前最佳镜像优先"排列
// 顺序: 学到的域名 > 缓存的 ACTIVE > 配置顺序
function mirrorOrder() {
  const now = Date.now();
  let usable = MIRRORS.filter((m) => !BAD_MIRRORS[m] || BAD_MIRRORS[m] < now);
  if (!usable.length) { BAD_MIRRORS = {}; usable = MIRRORS.slice(); }

  const out = [];
  if (LEARNED_MIRROR && !BAD_MIRRORS[LEARNED_MIRROR]) out.push(LEARNED_MIRROR);
  if (ACTIVE_MIRROR && (now - MIRROR_CHECKED_AT) < MIRROR_TTL
      && usable.includes(ACTIVE_MIRROR) && !out.includes(ACTIVE_MIRROR)) {
    out.push(ACTIVE_MIRROR);
  }
  for (const m of usable) if (!out.includes(m)) out.push(m);
  return out;
}

function markBadMirror(m) {
  BAD_MIRRORS[m] = Date.now() + BAD_MIRROR_TTL;
  if (ACTIVE_MIRROR === m) ACTIVE_MIRROR = null;
}

// 探测哪个镜像活着
async function detectMirror() {
  for (const base of mirrorOrder()) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(base + "/", {
        headers: { "User-Agent": UA },
        signal: ctl.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (r.status === 200) {
        ACTIVE_MIRROR = base;
        MIRROR_CHECKED_AT = Date.now();
        delete BAD_MIRRORS[base];
        return base;
      }
      markBadMirror(base);
    } catch (e) { markBadMirror(base); /* 试下一个 */ }
  }
  ACTIVE_MIRROR = null;
  return null;
}

// ==== 全量自检 (供 /api/selfcheck 与 Cron 使用) ====
async function runSelfCheck(env) {
  const report = {
    ts: new Date().toISOString(),
    mirrors: MIRRORS.slice(),
    aliveMirror: null,
    mirrorLatency: {},
    upstreamOk: false,
    listOk: false,
    listCount: 0,
    errors: [],
  };

  for (const base of mirrorOrder()) {
    const t0 = Date.now();
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(base + "/", { headers: { "User-Agent": UA }, signal: ctl.signal, redirect: "follow" });
      clearTimeout(timer);
      report.mirrorLatency[base] = Date.now() - t0;
      if (r.status === 200 && !report.aliveMirror) {
        report.aliveMirror = base;
        ACTIVE_MIRROR = base;
        MIRROR_CHECKED_AT = Date.now();
      }
    } catch (e) {
      report.mirrorLatency[base] = -1;
      report.errors.push(base + ": " + String((e && e.message) || e));
    }
  }
  report.upstreamOk = !!report.aliveMirror;

  if (report.aliveMirror) {
    try {
      const { r } = await fetchWithMirror("/", {});
      const html = await r.text();
      const items = parseCards(html);
      report.listCount = items.length;
      report.listOk = items.length > 0;
      if (!report.listOk) report.errors.push("列表解析返回 0 条 (官方可能改版)");
    } catch (e) {
      report.errors.push("列表拉取失败: " + String((e && e.message) || e));
    }
  }

  LAST_SELFCHECK = report;
  if (env && env.HG_KV) {
    try { await env.HG_KV.put("last_selfcheck", JSON.stringify(report), { expirationTtl: 86400 }); } catch (e) {}
  }
  return report;
}

// 源码文件名黑名单 (防止被 ASSETS 兜底送出)
const SOURCE_PATHS = new Set([
  "/worker.js", "/wrangler.toml", "/_worker_deploy.js",
  "/deploy.ps1", "/deploy.config.psd1", "/deploy.config.example.psd1",
  "/watch.ps1", "/doctor.ps1", "/install_watch.ps1",
  "/hg_parser.py", "/local_server.py",
  "/make_card.py", "/make_icons.py", "/make_qrcode.py", "/verify_qr.py",
]);

// 构建标记 — 用来确认线上跑的是哪一版 (改动时同步更新)
const BUILD_ID = "hg-worker-2026-10-17-v16-cg-retry";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const h = cors(request.headers.get("Origin") || "");

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: h });

    const path = url.pathname;
    const q = url.searchParams;

    // ============ 源码保护 (最优先) ============
    if (SOURCE_PATHS.has(path)) {
      return new Response("Not Found", {
        status: 404,
        headers: { ...h, "Cache-Control": "no-store", "X-Build": BUILD_ID },
      });
    }

    // ============ 图片代理 + AES 解密 ============
    // 上游对封面做了加密: AES-128-CBC / NoPadding, key/iv 明文写在它的 crypto-worker.js 里。
    // 取回来是 binary/octet-stream 的密文, 必须解密才能当图片用。
    if (path === "/img" || path === "/api/img") {
      const raw = q.get("u") || "";
      let target = "";
      try { target = decodeURIComponent(raw); } catch (e) { target = raw; }
      if (!/^https?:\/\//i.test(target)) return json({ error: "bad url" }, h, 400);

      const noDecrypt = q.get("raw") === "1";

      for (let i = 0; i < 3; i++) {
        try {
          const r = await fetch(target, {
            headers: {
              "User-Agent": UA,
              "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
              "Referer": (LEARNED_MIRROR || MIRRORS[0]) + "/",
            },
          });
          if (r.status !== 200) continue;

          const ct0 = (r.headers.get("Content-Type") || "").toLowerCase();
          const buf = await r.arrayBuffer();
          if (!buf.byteLength) continue;

          const head = new Uint8Array(buf.slice(0, 12));
          const looksEncrypted = !isImageMagic(head);

          let out = buf;
          let ct = ct0 || "image/jpeg";

          if (!noDecrypt && looksEncrypted) {
            const dec = await aesCbcNoPadDecrypt(buf);
            if (dec) {
              const dh = new Uint8Array(dec.slice(0, 12));
              if (isImageMagic(dh)) {
                out = dec;
                ct = guessImageType(dh);
              }
            }
          } else if (looksEncrypted === false && ct0.indexOf("image/") !== 0) {
            ct = guessImageType(head);
          }

          if (!out.byteLength) continue;
          return new Response(out, {
            status: 200,
            headers: {
              ...h,
              "Content-Type": ct,
              "Content-Length": String(out.byteLength),
              "Cache-Control": "public, max-age=604800, immutable",
            },
          });
        } catch (e) { /* 重试 */ }
      }
      return new Response("", { status: 302, headers: { ...h, "Location": target } });
    }

    // ============ API 路由 ============
    if (path.startsWith("/api/") || path.startsWith("/proxy/")) {
      try {
        // 构建标记 (确认线上版本)
        if (path === "/api/version") {
          const out = { build: BUILD_ID, mirrors: MIRRORS, learned: LEARNED_MIRROR, hd: HD_API_LINES };
          // ?es=1 时顺带探一次 EROSHORT 出口连通性 (部署验证用)
          if (q.get("es") === "1") {
            try {
              const ctl = new AbortController();
              const timer = setTimeout(() => ctl.abort(), 12000);
              const r = await fetch(ES_API_BASE + "/shorts?page=1&page_size=1", {
                headers: {
                  "User-Agent": UA,
                  "Accept": "application/json, text/plain, */*",
                  "Referer": "https://eroshort.net/",
                  "Origin": "https://eroshort.net",
                },
                signal: ctl.signal,
              });
              clearTimeout(timer);
              const t = await r.text();
              let j = null;
              try { j = JSON.parse(t); } catch (e) {}
              out.es = j
                ? { ok: true, http: r.status, total: (j.pagination && j.pagination.total) || (Array.isArray(j.data) ? j.data.length : 0) }
                : { ok: false, http: r.status, cf: /^\s*<(!DOCTYPE|html)/i.test(t), head: t.slice(0, 80) };
            } catch (e) {
              out.es = { ok: false, error: String((e && e.message) || e) };
            }
          }
          return json(out, h);
        }

        // ============ 品牌落地页探测 (禁果 / 橙果 / 蜜桃 / 2048 …) ============
        // 上游这些品牌与黄果同平台: 都是「APP 下载落地页 + 加密 API」, 网页侧没有剧集数据。
        // 这个接口在【服务端】把落地页取回来并解码, 返回:
        //   - 最新 / 官方 / 永久 线路
        //   - WebApp 入口
        //   - landing 标记 (true → 前端应显示"内容仅在 APP 内", 而不是塞一个空列表)
        //   - 可选: 顺手探一下同平台 API 主机能不能用
        // 关键: 访客和你自己都不直连上游 → 不暴露任何人的真实 IP。
        if (path === "/api/brand/probe") {
          const u = q.get("u") || "";
          if (!/^https?:\/\//i.test(u)) return json({ ok: false, error: "bad url" }, h, 400);
          try {
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), 12000);
            const r = await fetch(u, {
              headers: {
                "User-Agent": UA,
                "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9",
                "Accept-Encoding": "identity",
              },
              redirect: "follow",
              signal: ctl.signal,
            });
            clearTimeout(timer);
            const body = await r.text();
            const cfg = extractLandingConfig(body);
            let finalHost = "";
            try { finalHost = new URL(r.url).host; } catch (e) { /* ignore */ }
            const tm = body.match(/<title[^>]*>([\s\S]{0,120}?)<\/title>/i);
            const out = {
              ok: r.status === 200,
              http: r.status,
              url: r.url || u,
              finalHost: finalHost,
              landing: isLandingPage(body),
              title: tm ? tm[1].trim() : "",
              links: { latest: cfg.latest, official: cfg.official, permanent: cfg.permanent },
              webAppUrl: cfg.webAppUrl,
              tpl: cfg.tpl,
            };
            const guess = (q.get("apiHost") || "").trim();
            if (/^[a-z0-9\.\-]+$/i.test(guess)) {
              try {
                const c2 = new AbortController();
                const t2 = setTimeout(() => c2.abort(), 8000);
                const r2 = await fetch("https://" + guess + "/api/app/videos?page=1", {
                  headers: { "User-Agent": UA, "Accept": "application/json", "Referer": "https://hddj30.cc/" },
                  signal: c2.signal,
                });
                clearTimeout(t2);
                const t = await r2.text();
                let jj = null;
                try { jj = JSON.parse(t); } catch (e) { /* 不是 JSON */ }
                out.api = {
                  host: guess,
                  http: r2.status,
                  ok: !!(jj && jj.ok === true && Array.isArray(jj.items)),
                  total: (jj && jj.total) || 0,
                };
              } catch (e) {
                out.api = { host: guess, ok: false, error: String((e && e.message) || e) };
              }
            }
            return json(out, h);
          } catch (e) {
            return json({ ok: false, error: String((e && e.message) || e) }, h, 502);
          }
        }

        // ============ 黄果官方 JSON API (huangguoai.com) ============
        // 2026-10 实测确认: 黄果的剧集并不只在 APP 里。站方自己的 Web 前端调的就是这套公开 JSON:
        //   GET  /api/videos?page=N&cate_id=M    → {data:{items:[…], pagination:{page,pages,size,total}}}
        //   GET  /api/home                       → {data:{banners,featured,latest,cate_rec,topic_rec}}
        //   GET  /api/videos/<id>/play?ep=<n>    → {data:{video_url:"<m3u8>", duration, page_h1 …}}
        //   POST /api/media/covers               → {data:{covers:{"video:<id>":"<url>"}}}
        //   GET  /api/search?q=<词>               → {data:{engine:"vector", items:[…]}}
        //   GET  /video/<id>/                    → HTML, body[data-history] + 每集 data-ep-id
        // 主站 huangguoai.com, 另有 9 个 *.rxzfszht.cc 备用域名, 内容完全一致 (实测同一批 ID / 同一 total)。
        //
        // 【为什么坚持服务端出网 —— IP 保护】
        //   - 所有请求从 Cloudflare 的出口发出, 你的机器和访客的浏览器都不碰上游
        //   - m3u8 里的分片和 AES key 指向 tp3.drleao.cn, 由 /api/hg/media 重写为回源本站,
        //     播放器一次都不会直连 drleao.cn —— 上游 CDN 日志里只有 Cloudflare 的 IP
        if (path === "/api/hg/list") {
          const page = Math.max(1, parseInt(q.get("page") || "1", 10) || 1);
          const cate = (q.get("cate_id") || "").trim();
          const size = Math.min(40, Math.max(1, parseInt(q.get("size") || "20", 10) || 20));
          const r = await hgJson("/api/videos?page=" + page +
            (cate ? "&cate_id=" + encodeURIComponent(cate) : "") +
            (size !== 20 ? "&size=" + size : ""));
          if (!r.ok) return json({ items: [], total: 0, error: r.error }, h, 502);
          const d = (r.data && r.data.data) || {};
          const items = (d.items || []).map(hgCard);
          const pg = d.pagination || {};
          return json({
            items: items,
            total: pg.total || items.length,
            page: pg.page || page,
            pages: pg.pages || 1,
            cates: HG_CATES,
          }, h);
        }

        // 首页聚合 (banner / 精选 / 最新 / 分类推荐 / 专题)
        if (path === "/api/hg/home") {
          const r = await hgJson("/api/home");
          if (!r.ok) return json({ ok: false, error: r.error }, h, 502);
          const d = (r.data && r.data.data) || {};
          const fix = (x) => Object.assign({}, x, { cover: hgAbs(x.cover) });
          return json({
            ok: true,
            banners: (d.banners || []).map(fix),
            featured: (d.featured || []).map(hgCard),
            latest: (d.latest || []).map(hgCard),
            cate_rec: (d.cate_rec || []).map((c) => ({
              cate_id: c.cate_id, cate_name: c.cate_name,
              videos: (c.videos || []).map(hgCard),
            })),
            topic_rec: (d.topic_rec || []).map(fix),
          }, h);
        }

        // 详情: 抓 /video/<id>/ 并解析成统一结构
        if (path === "/api/hg/detail") {
          const id = (q.get("id") || "").trim();
          if (!/^\d+$/.test(id)) return json({ ok: false, error: "bad id" }, h, 400);
          const r = await hgText("/video/" + id + "/");
          if (!r.ok) return json({ ok: false, error: r.error }, h, 502);
          const html = r.text;

          let his = {};
          const hm = html.match(/<body[^>]+data-history=(["'])([\s\S]*?)\1/i);
          if (hm) { try { his = JSON.parse(hgUnesc(hm[2])); } catch (e) { his = {}; } }

          const epNums = [];
          const reEp = /data-ep-id=["'](\d+)["']/g;
          let me;
          while ((me = reEp.exec(html)) !== null) {
            const n = parseInt(me[1], 10);
            if (n > 0 && epNums.indexOf(n) < 0) epNums.push(n);
          }
          epNums.sort(function (a, b) { return a - b; });
          if (!epNums.length) {
            const lbl = String(his.episode || "");
            const mm = lbl.match(/(?:更新至|全)\s*(\d+)\s*集/);
            const n = mm ? parseInt(mm[1], 10) : (parseInt(his.total || "0", 10) || 0);
            for (let i = 1; i <= n; i++) epNums.push(i);
          }

          const t1 = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
          const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i);
          const de = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i);

          const title = String(his.title || (t1 ? hgUnesc(t1[1]).split(" - ")[0] : "")).trim();
          if (!title && !epNums.length && !his.desc) {
            return json({ ok: false, error: "上游返回的不是详情页 (可能被风控或改版)" }, h, 502);
          }

          const eps = {};
          epNums.forEach(function (n) { eps[String(n)] = ""; });

          return json({
            ok: true,
            id: id,
            title: title || ("huangguo-" + id),
            author: (his.author || his.badge || ""),
            badge: his.badge || "",
            cate: his.cat || "",
            views: his.hot || "",
            score: his.score || "",
            tags: String(his.tags || "").split(",").filter(Boolean),
            description: hgUnesc(String(his.desc || (de ? de[1] : ""))),
            cover: og ? hgUnesc(og[1]) : hgAbs(his.cover || ""),
            episodeLabel: his.episode || "",
            epTotal: epNums.length || 1,
            eps: eps,
            mirror: r.base,
          }, h);
        }

        // 取某一集的真实播放源 (上游每次返回带时效签名的 m3u8)
        if (path === "/api/hg/ep") {
          const id = (q.get("id") || "").trim();
          const ep = (q.get("ep") || "1").trim();
          if (!/^\d+$/.test(id)) return json({ ok: false, error: "bad id" }, h, 400);
          const r = await hgJson("/api/videos/" + id + "/play?ep=" + encodeURIComponent(ep));
          if (!r.ok) return json({ ok: false, url: "", error: r.error }, h, 502);
          const j = r.data || {};
          const d = j.data;
          if (j.status !== 1 || !d || !d.video_url) {
            return json({ ok: false, url: "", error: j.msg || "上游没有这一集", status: j.status }, h, 404);
          }
          // 播放地址改成走本站的媒体代理 —— 播放器的每一步都被 Cloudflare 挡住
          //
          // ★ 必须是**绝对地址**, 且 origin 取自本次请求 (不硬编码域名)。
          //   原因: 前端页面和 Worker 常常不同源 —— 页面在 GitHub Pages,
          //   API 在 Worker。此时返回相对路径 "/api/hg/media?u=…", 浏览器会把它
          //   解析成 https://<pages域名>/api/hg/media → 404 (实测),
          //   表现为"列表正常、点开播不了"。取请求自己的 origin, 在哪访问就回哪。
          const epOrigin = (function () {
            try { return new URL(request.url).origin; } catch (e) { return ""; }
          })();
          const proxied = epOrigin + "/api/hg/media?u=" + encodeURIComponent(d.video_url);
          return json({
            ok: true,
            url: proxied,
            raw: d.video_url,
            duration: d.duration || 0,
            title: d.page_og_title || "",
            ep: d.ep_num || ep,
            mirror: r.base,
          }, h);
        }

        // 搜索 (上游是向量检索)
        if (path === "/api/hg/search") {
          const kw = (q.get("q") || "").trim();
          if (!kw) return json({ items: [], total: 0 }, h);
          const r = await hgJson("/api/search?q=" + encodeURIComponent(kw));
          if (!r.ok) return json({ items: [], total: 0, error: r.error }, h, 502);
          const d = (r.data && r.data.data) || {};
          const items = (d.items || []).map(hgCard);
          return json({ items: items, total: items.length, engine: d.engine || "" }, h);
        }

        // 媒体代理: 拉 m3u8 并把分片 / key 的 URL 重写回本站
        // 这是 IP 保护的关键 —— 不重写的话, 播放器会直连 tp3.drleao.cn 并暴露访客 IP
        if (path === "/api/hg/media") {
          const raw = q.get("u") || "";
          let target = "";
          try { target = decodeURIComponent(raw); } catch (e) { target = raw; }
          if (!/^https?:\/\//i.test(target)) return json({ ok: false, error: "bad url" }, h, 400);
          let th;
          try { th = new URL(target).host.toLowerCase(); } catch (e) { th = ""; }
          if (!HG_MEDIA_HOST_RE.test(th)) {
            return json({ ok: false, error: "host not allowed: " + th }, h, 403);
          }

          const isPlaylist = /\.m3u8($|\?)/i.test(target);

          let r;
          try {
            r = await fetch(target, {
              headers: {
                "User-Agent": UA,
                "Accept": "*/*",
                "Accept-Encoding": "identity",
                "Referer": "https://huangguoai.com/",
              },
              redirect: "follow",
            });
          } catch (e) {
            return json({ ok: false, error: String((e && e.message) || e) }, h, 502);
          }
          if (!r.ok) return json({ ok: false, error: "upstream " + r.status }, h, r.status);

          if (isPlaylist) {
            const txt = await r.text();
            // ★ 用**本次请求自己的 origin** 拼绝对地址 —— 三种部署下都成立:
            //   1) 页面与 Worker 同源 (workers.dev / 自定义域名) → 分片回同源, 通
            //   2) 页面在 GitHub Pages, API 在 Worker (**不同源**) → 相对路径会被
            //      解析到 pages 域名下 → 404 (实测), 必须绝对地址
            //   3) 自定义域名 → 分片走自定义域名, 通
            //   关键: 不硬编码 workers.dev, origin 来自请求本身, 在哪访问就回哪。
            //   (2026-10-17 修正: 上一版统一用相对路径修好了同源场景, 却把
            //    "Pages 前端 + Worker API" 这个真实部署打成了 404。)
            const mediaOrigin = (function () {
              try { return new URL(request.url).origin; } catch (e) { return ""; }
            })();
            const mk = function (u) {
              let abs;
              try { abs = new URL(u, target).href; } catch (e) { return u; }
              return mediaOrigin + "/api/hg/media?u=" + encodeURIComponent(abs);
            };
            const out = txt.split("\n").map(function (line) {
              const t = line.trim();
              if (!t) return line;
              if (t.charAt(0) === "#") {
                if (t.indexOf("#EXT-X-KEY:") === 0 || t.indexOf("#EXT-X-MAP:") === 0) {
                  return t.replace(/URI="([^"]+)"/g, function (_m, u) {
                    return 'URI="' + mk(u) + '"';
                  });
                }
                return line;
              }
              return mk(t);
            }).join("\n");
            const nh = {
              "Content-Type": "application/vnd.apple.mpegurl",
              "Cache-Control": "private, no-store",
              "Access-Control-Allow-Origin": "*",
            };
            return new Response(out, { status: 200, headers: nh });
          }

          // 分片 / AES key: 直接流式转发
          const nh2 = { ...h, "Cache-Control": "private, no-store" };
          nh2["Content-Type"] = r.headers.get("Content-Type") || "application/octet-stream";
          for (const k of ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"]) {
            const v = r.headers.get(k);
            if (v) nh2[k] = v;
          }
          nh2["Accept-Ranges"] = "bytes";
          nh2["Access-Control-Expose-Headers"] = "Content-Length,Content-Range,Accept-Ranges";
          return new Response(r.body, { status: r.status, headers: nh2 });
        }

        // ★ 锚点原文必须放回 —— 这段是被替换掉的 old, 不放回来 /api/health 这条路由就消失了
        //   (实测: 打 /api/health 返回 404)。变量名改成 healthOk 是为了让 old 锚点在应用后
        //   不再匹配, 从而保证补丁可重复执行 (语义完全等价)。
        // ============ 橙果短剧 (chengguodj.com / api2.chengguodj.com) ============
        // 2026-10 实测: 站方 Web 前端走一套**加密信封** API, 已完整逆出。
        //   POST /api/v1/home                                   → {page, hot:{items}, …}
        //   POST /api/v1/channels/{code}?page=N                 → {page, hot, items:[…], pagination}
        //   POST /api/v1/dramas?page=N                          → 全部剧 (browse)
        //   POST /api/v1/dramas/{id}                            → 详情 (含 episodes[])
        //   POST /api/v1/dramas/{id}/episodes/{n}  ← 明文 JSON   → {drama, episode, media:{source_url}}
        //   POST /api/v1/search?q=<词>&page=N                    → 命中在 data.dramas (不是 items!)
        //   POST /api/v1/feed?cursor=<cursor>                    → {items, pagination:{next_cursor}}
        //   POST /api/v1/bootstrap                               → 站点配置 / 导航 / 频道
        // 频道 code: yuanchuang 橙果原创 / zhenren 真人短剧 / aiduanju AI短剧 / manju AI漫剧 / mogai AI魔改
        //
        // 【IP 保护】与黄果同一策略:
        //   - 所有请求从 Cloudflare 出口发出, 访客浏览器一次都不碰 api2.chengguodj.com
        //   - m3u8 (hls.tpbbwcc.cn) 里的分片和 AES key (mts.hhjd.mobi) 由 /api/cg/media 重写回本站,
        //     上游 CDN 日志里只有 Cloudflare 的 IP
        if (path === "/api/cg/channels") {
          return json({ ok: true, channels: CG_CHANNELS }, h);
        }

        // 首页聚合
        if (path === "/api/cg/home") {
          const r = await cgPost("/api/v1/home", {}, false);
          if (!r.ok) return json({ ok: false, error: r.error, attempts: r.attempts || 1 }, h, 502);
          const d = r.data || {};
          const hot = (d.hot && d.hot.items) || d.hot || [];
          const secs = [];
          // 首页返回多个区块, 字段名不稳定 —— 把能识别的都收进来
          for (const k of Object.keys(d)) {
            const v = d[k];
            if (v && Array.isArray(v.items) && v.items.length) {
              secs.push({
                key: k,
                title: v.title || v.name || k,
                items: v.items.map(cgCard),
              });
            }
          }
          return json({
            ok: true,
            page: d.page || {},
            hot: (Array.isArray(hot) ? hot : []).map(cgCard),
            sections: secs,
            channels: CG_CHANNELS,
          }, h);
        }

        // 频道列表 (真人 / AI短剧 / AI漫剧 / AI魔改 / 原创)
        if (path === "/api/cg/list") {
          const page = Math.max(1, parseInt(q.get("page") || "1", 10) || 1);
          const chan = (q.get("channel") || q.get("cate") || "").trim();
          let path2;
          if (chan && /^[a-z0-9_-]{1,24}$/i.test(chan)) {
            path2 = "/api/v1/channels/" + encodeURIComponent(chan) + "?page=" + page;
          } else {
            path2 = "/api/v1/dramas?page=" + page;
          }
          const r = await cgPost(path2, {}, false);
          if (!r.ok) return json({ items: [], total: 0, error: r.error, attempts: r.attempts || 1 }, h, 502);
          const d = r.data || {};
          const items = cgList(d).map(cgCard);
          const pg = d.pagination || {};
          return json({
            items: items,
            total: pg.total || items.length,
            page: pg.page || page,
            pages: pg.total_pages || 1,
            hasMore: pg.has_more === undefined ? (pg.total_pages ? page < pg.total_pages : false)
                                               : !!pg.has_more,
            channels: CG_CHANNELS,
            pageMeta: d.page || {},
          }, h);
        }

        // 详情
        if (path === "/api/cg/detail") {
          const id = (q.get("id") || "").trim();
          const slug = (q.get("slug") || "").trim();
          const key = /^\d+$/.test(id) ? id : (/^[a-z0-9_-]{1,40}$/i.test(slug) ? slug : "");
          if (!key) return json({ ok: false, error: "bad id/slug" }, h, 400);
          const r = await cgPost("/api/v1/dramas/" + encodeURIComponent(key), {}, false);
          if (!r.ok) return json({ ok: false, error: r.error, attempts: r.attempts || 1 }, h, 502);
          const d = r.data || {};
          const eps = d.episodes || [];
          const epsMap = {};
          const epList = [];
          for (let i = 0; i < eps.length; i++) {
            const e = eps[i] || {};
            const n = String(e.number || (i + 1));
            epsMap[n] = "";
            epList.push({
              n: n,
              id: e.id,
              title: e.title || n,
              duration: e.duration_seconds || 0,
              ready: e.ready_at || "",
            });
          }
          const chan = (d.channel && (d.channel.code || d.channel)) || d.channel_code || "";
          let chanName = "";
          for (let i = 0; i < CG_CHANNELS.length; i++) {
            if (CG_CHANNELS[i].code === chan) chanName = CG_CHANNELS[i].name;
          }
          return json({
            ok: true,
            id: d.id || key,
            slug: d.slug || "",
            title: d.title || "",
            channel: chan,
            channelName: chanName,
            cover: cgAbs(d.cover || (d.cover && d.cover.url) || ""),
            description: d.intro || d.description || "",
            tags: (d.tags || []).map(function (t) { return (t && t.name) || t; }).filter(Boolean),
            status: d.status || d.serial_status || "",
            views: d.heat || d.heat_7d || 0,
            likes: (d.engagement && d.engagement.likes) || d.like_count || 0,
            comments: (d.engagement && d.engagement.comments) || d.comment_count || 0,
            epTotal: eps.length || d.total_episode_count || 1,
            epList: epList,
            eps: epsMap,
          }, h);
        }

        // 单集播放源 —— 上游这个端点要**明文 JSON** (strictJsonBody), 加密反而报 422
        if (path === "/api/cg/ep") {
          const id = (q.get("id") || "").trim();
          const ep = (q.get("ep") || "1").trim();
          if (!/^\d+$/.test(id)) return json({ ok: false, error: "bad id" }, h, 400);
          if (!/^\d+$/.test(ep)) return json({ ok: false, error: "bad ep" }, h, 400);
          const r = await cgPost("/api/v1/dramas/" + id + "/episodes/" + ep, {}, true);
          if (!r.ok) return json({ ok: false, url: "", error: r.error, attempts: r.attempts || 1 }, h, 502);
          const d = r.data || {};
          const media = d.media || {};
          const src = media.source_url || media.url || "";
          if (!src) {
            return json({ ok: false, url: "", error: "上游这一集没有播放地址",
                          hasMedia: !!d.media }, h, 404);
          }
          // 播放地址改成本站媒体代理 —— 播放器每一步都被 Cloudflare 挡住
          //
          // ★ 绝对地址, origin 取自本次请求 (不硬编码域名)。
          //   页面在 GitHub Pages、API 在 Worker 时, 相对路径会被解析到 pages 域名下
          //   → 404 → "能进播放页但永远转圈"。取请求 origin 则在哪访问就回哪。
          const epOrigin = (function () {
            try { return new URL(request.url).origin; } catch (e) { return ""; }
          })();
          const proxied = epOrigin + "/api/cg/media?u=" + encodeURIComponent(src);
          return json({
            ok: true,
            url: proxied,
            raw: src,
            format: media.format || "hls",
            h265: media.h265_url || "",
            poster: cgAbs(media.poster_url || ""),
            duration: (d.episode && d.episode.duration_seconds) || 0,
            ep: (d.episode && d.episode.number) || ep,
            title: (d.drama && d.drama.title) || "",
            epTotal: (d.episodes && d.episodes.length) || 0,
            isLast: !!d.is_last_episode,
            nextRoute: d.next_route || "",
          }, h);
        }

        // 搜索 —— 命中在 data.dramas, 不在 items
        if (path === "/api/cg/search") {
          const kw = (q.get("q") || q.get("keyword") || "").trim();
          const page = Math.max(1, parseInt(q.get("page") || "1", 10) || 1);
          if (!kw) return json({ items: [], total: 0 }, h);
          const r = await cgPost("/api/v1/search?q=" + encodeURIComponent(kw) + "&page=" + page, {}, false);
          if (!r.ok) return json({ items: [], total: 0, error: r.error, attempts: r.attempts || 1 }, h, 502);
          const d = r.data || {};
          const items = cgList(d).map(cgCard);
          return json({
            items: items,
            total: (d.totals && d.totals.dramas) || items.length,
            query: d.query || kw,
            news: d.news || [],
            page: page,
          }, h);
        }

        // 推荐流 (游标翻页)
        if (path === "/api/cg/feed") {
          const cur = q.get("cursor") || "";
          const r = await cgPost("/api/v1/feed?cursor=" + encodeURIComponent(cur), {}, false);
          if (!r.ok) return json({ items: [], error: r.error, attempts: r.attempts || 1 }, h, 502);
          const d = r.data || {};
          const pg = d.pagination || {};
          return json({
            items: (d.items || []).map(cgCard),
            strategy: d.strategy || "",
            nextCursor: pg.next_cursor || "",
            hasMore: !!pg.has_more,
          }, h);
        }

        // 媒体代理: 拉 m3u8 并把分片 / AES key 的 URL 重写回本站
        // IP 保护的关键 —— 不重写的话播放器会直连 hls.tpbbwcc.cn / mts.hhjd.mobi 并暴露访客 IP
        if (path === "/api/cg/media") {
          const raw = q.get("u") || "";
          let target = "";
          try { target = decodeURIComponent(raw); } catch (e) { target = raw; }
          if (!/^https?:\/\//i.test(target)) return json({ ok: false, error: "bad url" }, h, 400);
          let th = "", tp = "";
          try { const tu = new URL(target); th = tu.host.toLowerCase(); tp = tu.pathname; } catch (e) { th = ""; }
          if (!cgMediaHostAllowed(th, tp)) {
            return json({ ok: false, error: "host not allowed: " + th }, h, 403);
          }

          const isPlaylist = /\.m3u8($|\?)/i.test(target);

          let r;
          try {
            r = await fetch(target, {
              headers: {
                "User-Agent": UA,
                "Accept": "*/*",
                "Accept-Encoding": "identity",
                "Referer": CG_SITE + "/",
              },
              redirect: "follow",
            });
          } catch (e) {
            return json({ ok: false, error: String((e && e.message) || e) }, h, 502);
          }
          if (!r.ok) return json({ ok: false, error: "upstream " + r.status }, h, r.status);

          if (isPlaylist) {
            const txt = await r.text();
            // ★ 用**本次请求自己的 origin** 拼绝对地址。
            //
            //   上一版统一写相对路径, 理由是"别把 workers.dev 钉死"。方向没错, 但代价是
            //   把"页面与 API 不同源"这种真实部署打死了:
            //     页面在 GitHub Pages, API 在 Worker → 浏览器把 "/api/cg/media" 解析成
            //     https://<pages域名>/api/cg/media → 404 → 能进播放页、永远转圈。
            //
            //   正解 = "绝对地址, 但 origin 来自请求" —— 不硬编码任何域名, 在哪访问就回哪:
            //     workers.dev      → 分片走 workers.dev
            //     自定义域名        → 分片走自定义域名
            //     Pages + Workers  → 分片走 Worker (与清单请求同一条路, 可达性自洽)
            const mediaOrigin = (function () {
              try { return new URL(request.url).origin; } catch (e) { return ""; }
            })();
            const mk = function (u) {
              let abs;
              try { abs = new URL(u, target).href; } catch (e) { return u; }
              return mediaOrigin + "/api/cg/media?u=" + encodeURIComponent(abs);
            };
            const out = txt.split("\n").map(function (line) {
              const t = line.trim();
              if (!t) return line;
              if (t.charAt(0) === "#") {
                if (t.indexOf("#EXT-X-KEY:") === 0 || t.indexOf("#EXT-X-MAP:") === 0) {
                  return t.replace(/URI="([^"]+)"/g, function (_m, u) {
                    return 'URI="' + mk(u) + '"';
                  });
                }
                return line;
              }
              return mk(t);
            }).join("\n");
            return new Response(out, {
              status: 200,
              headers: {
                "Content-Type": "application/vnd.apple.mpegurl",
                "Cache-Control": "private, no-store",
                "Access-Control-Allow-Origin": "*",
              },
            });
          }

          // 分片 / AES key: 流式转发
          const nh2 = { ...h, "Cache-Control": "private, no-store" };
          nh2["Content-Type"] = r.headers.get("Content-Type") || "application/octet-stream";
          for (const k of ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"]) {
            const v = r.headers.get(k);
            if (v) nh2[k] = v;
          }
          nh2["Accept-Ranges"] = "bytes";
          nh2["Access-Control-Expose-Headers"] = "Content-Length,Content-Range,Accept-Ranges";
          return new Response(r.body, { status: r.status, headers: nh2 });
        }

        // ★ 锚点收尾: /api/health 用第三种等价写法放回 (mirrorOk)。
        //   src 原始 = ok, 黄果补丁产出 = healthOk, 这里 = mirrorOk ——
        //   每一层都不再匹配上一层的 old, 于是补丁可以重复执行而不会重复插入。
        if (path === "/api/health") {
          const mirrorOk = await detectMirror();
          return json({ ok: !!mirrorOk, mirror: mirrorOk, mirrors: MIRRORS, cached: !!ACTIVE_MIRROR }, h);
        }




        if (path === "/api/selfcheck") {
          let rep = LAST_SELFCHECK;
          if (q.get("full") === "1" || !rep) rep = await runSelfCheck(env);
          return json({ ok: rep.upstreamOk && rep.listOk, ...rep }, h);
        }

        if (path === "/api/list") {
          const cat = (q.get("cat") || "").trim();
          const page = Math.max(1, parseInt(q.get("page") || "1", 10));
          // 关键: 列表页 /list/N/ 数据完整 (封面/简介/集数 100%)
          //       首页 / 只是推荐位, 缺封面缺简介, 不用它
          let paths;
          if (cat) {
            paths = page > 1 ? ["/" + cat + "/" + page + "/"] : ["/" + cat + "/"];
          } else {
            paths = page > 1
              ? ["/list/" + page + "/", "/list/" + page + "/1/"]
              : ["/list/1/"];
          }
          let items = [];
          let usedPath = paths[0];
          for (const p of paths) {
            try {
              const { r } = await fetchWithMirror(p, {});
              const html = await r.text();
              const got = parseCards(html);
              // 取解析最成功的那次 (封面数最多)
              const covers = got.filter((x) => x.cover).length;
              if (got.length && (covers / got.length) > 0.8) {
                items = got; usedPath = p; break;
              }
              if (got.length > items.length) { items = got; usedPath = p; }
            } catch (e) { /* 试下一个 */ }
          }
          return json({ items, page, cat, source: usedPath }, h);
        }

        if (path === "/api/search") {
          const kw = (q.get("q") || "").trim();
          if (!kw) return json({ items: [] }, h);
          const { r } = await fetchWithMirror("/search/?keyword=" + encodeURIComponent(kw), {});
          const html = await r.text();
          return json({ items: parseCards(html).slice(0, 60) }, h);
        }

        if (path === "/api/video") {
          const raw = q.get("id") || "";
          const mm = raw.match(/\d+/);
          if (!mm) return json({ error: "需要剧集ID" }, h, 400);
          const id = mm[0];
          const { r } = await fetchWithMirror("/video/" + id + "/", {});
          const html = await r.text();
          const v = parseVideo(html);
          if (!v) return json({ error: "解析失败" }, h, 502);
          if (!v.epTotal) v.epTotal = Math.max(Object.keys(v.eps).length, 1);
          // 上游反抓取 (2026-10-10 实测 8350《西游之白骨精》):
          //   epPlaySrcs 是"滑动窗口"—— 主页面只暴露 {1,2}, ep-2 页暴露 {1,2,3},
          //   ep-4 页暴露 {3,4}。仅凭详情页永远"已解析 2 个播放源", 其余集
          //   必须逐个访问 /video/{id}/ep-N/ 才能拿到。这里并发补齐缺失集,
          //   一次 /api/video 就给全, 前端不再依赖"补齐全部播放源"按钮。
          const missing = [];
          for (let n = 1; n <= v.epTotal; n++) if (!v.eps[String(n)]) missing.push(n);
          let filled = 0;
          if (missing.length) {
            const CAP = 6;   // 子请求预算: 免费版 Worker 每请求上限 50, 留足余量
            const CONC = 3;
            const todo = missing.slice(0, CAP);
            let cursor = 0;
            const grab = async () => {
              while (cursor < todo.length) {
                const n = todo[cursor++];
                try {
                  const { r: rr } = await fetchWithMirror("/video/" + id + "/ep-" + n + "/", {});
                  const hh = await rr.text();
                  const pv = parseVideo(hh);
                  if (pv && pv.id === id) {
                    for (const [k, u] of Object.entries(pv.eps)) {
                      if (!v.eps[k]) { v.eps[k] = u; filled++; }
                    }
                  }
                } catch (e) { /* 单集失败不阻塞整体, /api/ep 仍可单点补 */ }
              }
            };
            await Promise.all(Array.from({ length: Math.min(CONC, todo.length) }, grab));
          }
          // 上游锁形态: 无服务端鉴权, 但按滑动窗口分页下发。
          // 这里如实附上探测到的信息, 前端据此决定展示策略。
          const epsN = Object.keys(v.eps).length;
          v.lock = { epCount: epsN, serverSide: false, filled, missingTotal: missing.length };
          // 落点校验: /video/{id}/ 若被 301 到别的剧, 不能把那一部当成结果返回
          if (v.id && v.id !== id) v.mismatch = { want: id, got: v.id };
          if (!epsN && v.mismatch) return json({ error: "上游落点不匹配", ...v.mismatch }, h, 502);
          return json(v, h);
        }

        if (path === "/api/ep") {
          const raw = q.get("id") || "";
          const ep = parseInt(q.get("ep") || "1", 10) || 1;
          const mm = raw.match(/\d+/);
          if (!mm) return json({ error: "需要剧集ID" }, h, 400);
          const id = mm[0];

          // 滑窗现实 (2026-10-10 实测 8350): 任一集页会顺带暴露相邻集的 epPlaySrcs
          //   (ep-2 页={1,2,3}, ep-4 页={3,4}), 且单页抓取偶发失败。
          // 抓取顺序: 本集页 → 邻集页 (ep-1 / ep+1), 任一页的权威表精确命中本集即返回。
          const pages = [ep, ep - 1, ep + 1].filter((n) => n >= 1);
          let lastHtml = null;
          for (const pn of pages) {
            let html = null;
            try {
              const { r } = await fetchWithMirror("/video/" + id + (pn > 1 ? "/ep-" + pn + "/" : "/"), {});
              html = await r.text();
            } catch (e) { continue; }
            const vv = parseVideo(html);
            if (vv && vv.id === id && vv.eps && vv.eps[String(ep)] && !isPromoUrl(vv.eps[String(ep)])) {
              return json({ id, ep, url: vv.eps[String(ep)], videoId: vv.id, via: pn }, h);
            }
            if (!lastHtml && html) lastHtml = html;
          }
          // data-play 兜底: 老版页面上 data-play-id=剧ID 的播放块 (仍限本剧、非推广域)
          if (lastHtml) {
            const srcs = [];
            for (const x of lastHtml.matchAll(/data-play-id="(\d+)"[^>]*data-play-src="([^"]+)"/g)) {
              srcs.push({ pid: x[1], src: x[2].replace(/&amp;/g, "&") });
            }
            for (const x of lastHtml.matchAll(/data-play-src="([^"]+)"[^>]*data-play-id="(\d+)"/g)) {
              srcs.push({ pid: x[2], src: x[1].replace(/&amp;/g, "&") });
            }
            const own = srcs.filter((x) => x.pid === id && !isPromoUrl(x.src));
            if (own.length) return json({ id, ep, url: own[0].src, videoId: id }, h);
          }
          // (已删除) 旧 fuzzy 兜底: 返回 vv.eps[第一集] —— 拿"别的集"冒充
          //    当前集, 用户点第 4 集播出来的是第 1 集。宁可 404 让前端重试,
          //    也不放错集。
          return json({ id, ep, url: "", error: "找不到本剧播放地址" }, h, 404);
        }

        if (path.startsWith("/proxy/")) {
          const target = decodeURIComponent(path.slice(7)) + (url.search || "");

          // 按目标域自动选 Referer —— 芒果站 (mgmg10.com) 有防盗链:
          // 任何带 Origin 头的请求一律 403, 服务端侧必须补自己的 Referer。
          let ref = MIRRORS[0] + "/";
          if (/mgmg10\.com/i.test(target)) ref = "https://mgmg10.com/";
          else if (/zen-vip\.com|hddj/i.test(target)) ref = "https://hddj30.cc/";
          else if (/wrjmtnebd|fyxybiblx|tktjpm|wirqed|vchllzwu|gkudvxhjh|ngfxaxnp|bg40t53p|hn18a20s|tc41p53k|wy60j19s|huangguoju/i.test(target)) ref = (LEARNED_MIRROR || MIRRORS[0]) + "/";
          // EROSHORT: 流地址来自 eroshort.net 或其 R2 桶, 上游对热链敏感,
          // 不带原站 Referer 容易被拦; R2 桶本身不校验, 补上也无害。
          else if (/eroshort\.net/i.test(target)) ref = "https://eroshort.net/";
          else if (/r2\.dev/i.test(target)) ref = "https://eroshort.net/";

          const fwd = {
            // ★ 不透传客户端 Origin/Accept 之外的域信息, 避免触发防盗链
            "User-Agent": UA,
            "Referer": ref,
            "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9",
          };
          // m3u8/ts 段带上 Range 才能被播放器正确 seek
          const range = request.headers.get("Range");
          if (range) fwd["Range"] = range;

          // ★ POST 转发 (2026-10 加): 上游 /api/v1/playback/resolve 是 POST + JSON body,
          //   公共 CORS 中转都不转发 body, 只有这里能替前端把 POST 送到上游。
          //   没有这段, stego_hls 的 license 就永远拿不到。
          let fbody;
          if (request.method !== "GET" && request.method !== "HEAD") {
            fbody = await request.arrayBuffer();
            fwd["Content-Type"] = request.headers.get("Content-Type") || "application/json";
          }

          const r = await fetch(target, {
            method: request.method,
            headers: fwd,
            body: fbody,
            redirect: "follow",
          });

          const isPlaylist = /\.m3u8(\?|$)/i.test(target);
          const isSeg = /\.(ts|m4s|mp4)(\?|$)/i.test(target);

          let nh = { ...h };
          // 播放列表和分片: 保留 Range / 长度 / 类型, 不缓存 m3u8 (链接含时效 token)
          if (isPlaylist) {
            nh["Content-Type"] = "application/vnd.apple.mpegurl";
            nh["Cache-Control"] = "no-store";
          } else if (isSeg) {
            nh["Content-Type"] = r.headers.get("Content-Type") || "video/mp2t";
            nh["Cache-Control"] = "public, max-age=3600";
          } else {
            nh["Content-Type"] = r.headers.get("Content-Type") || "application/octet-stream";
            nh["Cache-Control"] = "public, max-age=86400";
          }
          if (r.headers.get("Content-Length")) nh["Content-Length"] = r.headers.get("Content-Length");
          if (r.headers.get("Accept-Ranges")) nh["Accept-Ranges"] = r.headers.get("Accept-Ranges");
          if (r.headers.get("Content-Range")) nh["Content-Range"] = r.headers.get("Content-Range");
          nh["Access-Control-Allow-Origin"] = "*";
          nh["Access-Control-Expose-Headers"] = "Content-Length,Content-Range,Accept-Ranges";
          return new Response(r.body, { status: r.status, headers: nh });
        }

        // (图片代理已提到 /api 块之前, 见 /img)

        // ============ 芒果短剧 (mgmg10.com) 代理 ============
        //   前端 /api/mg/list    → 首页/分类页, 服务端解析成 JSON
        //   前端 /api/mg/video   → 详情页解析
        //   前端 /api/mg/search  → 搜索页解析
        //   前端 /api/mg/ep      → 生成 /play/{id}/{n}.m3u8 代理地址
        //   前端 /api/mg/health  → 站点探活
        //
        // 注意: 芒果站不发 CORS 头 + 带 Origin 就 403, 所以前端绝不能直连,
        //       所有取数都必须经这里。m3u8 播放走 /proxy/*。
        if (path.startsWith("/api/mg")) {
          const sub = path.slice("/api/mg".length) || "/list";
          const MG_HOST = "https://mgmg10.com";
          const MG_CATS = [
            { slug: "du-jia-shuang-ju", name: "独家爽剧" },
            { slug: "ai-comic-drama", name: "AI漫剧" },
            { slug: "adult-short-drama", name: "真人短剧" },
            { slug: "ca-bian-duan-ju", name: "擦边短剧" },
            { slug: "remixed-short-drama", name: "AI魔改" },
            { slug: "masturbation-zone", name: "撸管专区" },
            { slug: "er-ci-yuan", name: "二次元" },
          ];

          const mgFetch = async (p) => {
            const r = await fetch(MG_HOST + p, {
              headers: { "User-Agent": UA, "Referer": MG_HOST + "/", "Accept": "*/*", "Accept-Language": "zh-CN,zh;q=0.9" },
            });
            return { status: r.status, html: await r.text() };
          };

          if (sub === "/health" || sub === "/probe") {
            try {
              const { status, html } = await mgFetch("/");
              const items = mgParseCards(html).items;
              return json({ ok: items.length > 0, status, count: items.length, host: MG_HOST }, h);
            } catch (e) {
              return json({ ok: false, error: String((e && e.message) || e) }, h, 502);
            }
          }

          if (sub === "/categories") return json({ ok: true, items: MG_CATS }, h);

          if (sub === "/list") {
            const cat = (q.get("cat") || q.get("category") || "").trim();
            const p = cat ? ("/category/" + encodeURIComponent(cat) + "/") : "/";
            try {
              const { status, html } = await mgFetch(p);
              if (status !== 200) return json({ ok: false, error: "upstream " + status }, h, 502);
              const r = mgParseCards(html);
              return json({ ok: true, items: r.items, stats: r.stats, category: cat, source: "mg" }, h);
            } catch (e) {
              return json({ ok: false, error: String((e && e.message) || e) }, h, 502);
            }
          }

          if (sub === "/video") {
            const id = (q.get("id") || "").trim();
            if (!/^[0-9a-f]{16,32}$/i.test(id)) return json({ ok: false, error: "bad id" }, h, 400);
            try {
              const { status, html } = await mgFetch("/series/details/" + id + ".html");
              if (status !== 200) return json({ ok: false, error: "upstream " + status }, h, 502);
              const d = mgParseDetail(html);
              return json({ ok: true, meta: d.meta, eps: d.eps, source: "mg" }, h);
            } catch (e) {
              return json({ ok: false, error: String((e && e.message) || e) }, h, 502);
            }
          }

          if (sub === "/ep") {
            const id = (q.get("id") || "").trim();
            const ep = String(Math.max(1, parseInt(q.get("ep") || "1", 10)));
            if (!/^[0-9a-f]{16,32}$/i.test(id)) return json({ ok: false, error: "bad id" }, h, 400);
            const raw = MG_HOST + "/play/" + id + "/" + ep + ".m3u8";
            // 先探一次, 把 402 (付费墙) 的情况如实返回
            try {
              const r = await fetch(raw, { headers: { "User-Agent": UA, "Referer": MG_HOST + "/" } });
              if (r.status === 402) return json({ ok: false, paid: true, ep, error: "该集需金币解锁" }, h, 402);
              if (r.status !== 200) return json({ ok: false, error: "upstream " + r.status }, h, 502);
              return json({ ok: true, ep, url: "/proxy/" + encodeURIComponent(raw), raw, source: "mg" }, h);
            } catch (e) {
              return json({ ok: false, error: String((e && e.message) || e) }, h, 502);
            }
          }

          if (sub === "/search") {
            const kw = (q.get("q") || q.get("keyword") || "").trim();
            if (!kw) return json({ ok: true, items: [], keyword: "", source: "mg" }, h);
            try {
              const { status, html } = await mgFetch("/search/?keyword=" + encodeURIComponent(kw));
              const r = mgParseCards(html);
              return json({ ok: true, keyword: kw, status, items: r.items, stats: r.stats, source: "mg" }, h);
            } catch (e) {
              return json({ ok: false, error: String((e && e.message) || e) }, h, 502);
            }
          }

          return json({ ok: false, error: "unknown mg endpoint: " + sub }, h, 404);
        }

        // ============ 海角网 (hjw01.com) 代理 ============
        //   前端 /api/hjw/list?cat=&page=  → 首页/分类/分页
        //   前端 /api/hjw/video?id=N       → 详情 (含正文 + 图片 + m3u8)
        //   前端 /api/hjw/search?q=KW      → 搜索
        //
        // 为什么要走服务端:
        //   实测 www.hjw01.com / hjw01.com **不发 Access-Control-Allow-Origin**
        //   (只有 CDN 边缘 hjw1.com 带 *, 但那台是空壳 8KB)。
        //   所以浏览器直连详情页会被 CORS 拦死 → 必须由 Worker 出网抓。
        //   图片 (pic.wlwvch.cn) 和 m3u8 CDN 都发 *, 但为统一也走这里。
        if (path.startsWith("/api/hjw")) {
          const sub = path.slice("/api/hjw".length) || "/list";
          const HJW_HOSTS = ["https://www.hjw01.com", "https://hjw01.com"];
          const HJW_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

          // 子请求缓存 —— 上游是普通站, 扛不住每次浏览都回源。
          // 列表/板块 5min, 详情 10min; 缓存键含 host 轮换无关的全部 query。
          const hjwCacheKey = (p) => new Request("https://hjw-cache.internal" + p,
                                                 { method: "GET" });
          const hjwCacheGet = async (p) => {
            try {
              const r = await caches.default.match(hjwCacheKey(p));
              if (!r) return null;
              return await r.text();
            } catch (e) { return null; }
          };
          const hjwCachePut = async (p, html, ttl, ctx) => {
            try {
              const res = new Response(html, {
                headers: { "Content-Type": "text/html; charset=utf-8",
                           "Cache-Control": "public, max-age=" + ttl },
              });
              const put = caches.default.put(hjwCacheKey(p), res);
              if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
            } catch (e) { /* 缓存失败不影响主流程 */ }
          };

          const hjwFetch = async (p, opts) => {
            const recache = opts && opts.recache;
            if (!recache) {
              const hit = await hjwCacheGet(p);
              // 空壳页很短, 不当作命中
              if (hit && hit.length > 50000) return { html: hit, host: "cache" };
            }
            let lastErr = null;
            for (let i = 0; i < HJW_HOSTS.length; i++) {
              const h = HJW_HOSTS[i];
              try {
                const r = await fetch(h + p, {
                  headers: {
                    "User-Agent": HJW_UA,
                    "Referer": h + "/",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                    "Accept-Encoding": "gzip, deflate",
                  },
                  redirect: "follow",
                });
                const body = await r.text();
                // 三重校验: 状态 / 体量 / 真是海角页
                // (上游偶尔返回 CF 挑战页或 404 页, 只比体量会误判成功)
                const isReal = r.status === 200
                  && body.length > 50000
                  && /海角|hjw|novel-title|text-content/i.test(body);
                if (isReal) {
                  await hjwCachePut(p, body, opts && opts.ttl ? opts.ttl : 300, opts && opts.ctx);
                  return { html: body, host: h };
                }
                lastErr = "HTTP " + r.status + " len=" + body.length
                  + (r.status === 200 ? " (内容非海角页)" : "");
              } catch (e) {
                lastErr = String((e && e.message) || e);
              }
              // host 轮换前留一点间隔, 避免被上游判为并发扫描
              if (i < HJW_HOSTS.length - 1) {
                await new Promise((r2) => setTimeout(r2, 300));
              }
            }
            throw new Error("海角不可达: " + lastErr);
          };

          const hjwUnesc = (s) => String(s || "")
            .replace(/\\u002F/g, "/").replace(/\\\//g, "/")
            .replace(/&quot;/g, '"').replace(/&#039;/g, "'")
            .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
          const hjwStrip = (s) => String(s || "").replace(/<[^>]*>/g, "").trim();
          const hjwCleanImg = (u) => hjwUnesc(u || "").trim()
            .replace(/^[`'"\s]+/, "").replace(/[`'"\s]+$/, "");

          // 列表页解析 (两套卡片模板统一按 /archives/N/ 切块)
          const hjwParseList = (html, base) => {
            const out = [];
            const seen = {};
            const re = /<a\s+href="\/archives\/(\d+)\/?"([^>]*)>([\s\S]{0,1800}?)<\/a>/gi;
            let m;
            while ((m = re.exec(html))) {
              const id = m[1], attrs = m[2], blk = m[3];
              if (seen[id]) continue;
              if (!/<img/i.test(blk)) continue;
              const cm = blk.match(/z-image-loader-url="([^"]*)"/i)
                || blk.match(/data-src="([^"]*)"/i)
                || blk.match(/<img[^>]+src="([^"]*)"/i);
              const cover = cm ? hjwCleanImg(cm[1]) : "";
              if (!/^https?:\/\//i.test(cover)) continue;
              let title = "";
              const tm = blk.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
              if (tm) title = hjwStrip(tm[1]);
              if (!title) {
                const am = attrs.match(/title="([^"]*)"/i);
                if (am) title = hjwUnesc(am[1]).trim();
              }
              if (!title) {
                const alt = blk.match(/alt="([^"]*)"/i);
                if (alt) title = hjwUnesc(alt[1]).replace(/\.\.\.$/, "").trim();
              }
              if (!title) continue;
              const dm = blk.match(/class="time"[^>]*>\s*([^<]+?)\s*</i);
              const pm = blk.match(/class="play"[^>]*>\s*([^<]+?)\s*</i);
              seen[id] = 1;
              out.push({
                id, title, cover,
                date: dm ? dm[1].trim() : "",
                reply: pm ? pm[1].trim() : "",
                url: base + "/archives/" + id + "/",
              });
            }
            return out;
          };

          // 详情页解析 (含正文 + 图片 + m3u8)
          const hjwParseDetail = (html, id, base) => {
            const d = { id, title: "", cover: "", m3u8: "", m3u8_h265: "",
                        catName: "", catId: "", tags: [], tagsName: [], tagsKey: [],
                        author: "", avatar: "",
                        date: "", views: "", artHtml: "", artText: "", images: [] };
            let m;
            m = html.match(/<h1[^>]*class="novel-title"[^>]*>([\s\S]*?)<\/h1>/i);
            if (m) d.title = hjwStrip(m[1]);
            if (!d.title) {
              m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
              if (m) d.title = m[1].replace(/\s*\|\s*海角网\s*$/, "").trim();
            }
            m = html.match(/data-video_type_id="([^"]*)"/i); if (m) d.catId = m[1];
            m = html.match(/data-video_type_name="([^"]*)"/i); if (m) d.catName = m[1];
            // tags 一律可读文本 (data-video_tag_name), 数字 ID 存 tagsKey。
            let tagKeys = [];
            m = html.match(/data-video_tag_key="([^"]*)"/i);
            if (m && m[1]) tagKeys = m[1].split(",").filter(Boolean);
            m = html.match(/data-video_tag_name="([^"]*)"/i);
            if (m && m[1]) d.tags = m[1].split(",").map((s) => hjwUnesc(s).trim())
                                       .filter(Boolean);
            d.tagsKey = tagKeys;
            // 图文帖没有 data-video_tag_name (那是播放器属性) —— 用 meta keywords 兜底。
            // 实测三篇样本 video 与 article 都有 keywords, 是唯一通用的标签源。
            if (!d.tags.length) {
              const km = html.match(/<meta[^>]+name="keywords"[^>]+content="([^"]*)"/i);
              if (km && km[1]) {
                d.tags = km[1].split(",")
                  .map((s) => hjwUnesc(s).trim())
                  .filter((s) => s && s.length <= 20 && !/^[a-z0-9_\-.]{1,10}$/i.test(s))
                  .slice(0, 8);
              }
            }
            if (!d.tags.length && tagKeys.length) d.tags = tagKeys.slice();
            d.tagsName = d.tags.slice();

            // 作者 + 头像
            m = html.match(/class="nav-user-avatar"[\s\S]{0,400}?z-image-loader-url="([^"]*)"/i);
            if (m) d.avatar = hjwCleanImg(m[1]);
            m = html.match(/class="nav-user"[\s\S]{0,900}?<h2[^>]*>([^<]{1,40})<\/h2>/i);
            if (m) d.author = hjwStrip(m[1]);

            m = html.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*发布/);
            if (m) d.date = m[1];
            m = html.match(/<span>\s*([\d.]+[KMW万亿]?\+?)\s*浏览<\/span>/i);
            if (m) d.views = m[1];

            // ---- m3u8: data-config 里明文 ----
            const cfgs = html.match(/data-config='([^']+)'/gi) || [];
            for (const c of cfgs) {
              const raw = hjwUnesc(c.replace(/^data-config=['"]/i, "").replace(/['"]$/, ""));
              let j = null;
              try { j = JSON.parse(raw); } catch (e) { continue; }
              if (j.video && j.video.url) {
                d.m3u8 = j.video.url;
                if (j.video.pic) d.cover = j.video.pic;
                if (j.video_h265 && j.video_h265.url) d.m3u8_h265 = j.video_h265.url;
                break;
              }
            }

            // ---- 正文 (全量, 剥掉站方地址卡) ----
            let i = html.indexOf('class="text text-content"');
            if (i < 0) i = html.indexOf("class='text text-content'");
            if (i >= 0) {
              const gt = html.indexOf(">", i);
              if (gt > 0) {
                const starts = gt + 1;
                const ends = ['class="link-wrapper"', 'class="tag', "comment-list"]
                  .map((k) => html.indexOf(k, starts)).filter((x) => x > 0);
                let seg = html.slice(starts, ends.length ? Math.min(...ends) : starts + 120000);
                const cuts = ["<!--haijiao-address-template", '<div class="text-wrap mr-bom"',
                              '<div class="addr-grid"']
                  .map((k) => seg.indexOf(k)).filter((x) => x > 0);
                if (cuts.length) seg = seg.slice(0, Math.min(...cuts));
                // 站方在正文尾部插入的「最后编辑于」不必展示
                seg = seg.replace(/<p[^>]*>\s*最后编辑于[\s\S]*?<\/p>/gi, "");
                seg = seg.replace(/最后编辑于[:：][^<]*/g, "");
                seg = seg.replace(/(?:\s*<\/div>\s*)+$/, "");
                seg = seg.replace(/<(?:div|p)[^>]*>\s*<\/(?:div|p)>\s*$/gi, "");
                seg = seg.replace(/\s+$/, "");
                seg = seg.replace(/\[hide\]([\s\S]*?)\[\/hide\]/gi, "$1");
                seg = seg.replace(/\[(?:pay|gold|vip|reply|hide)[^\]]*\]([\s\S]*?)\[\/(?:pay|gold|vip|reply|hide)\]/gi, "$1");
                d.artHtml = seg;
                const imgs = [];
                const ire = /z-image-loader-url="([^"]+)"/gi;
                let im;
                while ((im = ire.exec(seg))) {
                  const u = hjwCleanImg(im[1]);
                  if (/^https?:\/\//i.test(u)) imgs.push(u);
                }
                d.images = imgs;
                d.artText = hjwUnesc(seg
                  .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n")
                  .replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ")
                  .replace(/\n{3,}/g, "\n\n")).trim();
              }
            }
            if (!d.cover && d.images.length) d.cover = d.images[0];
            if (!d.cover) {
              m = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
              if (m) d.cover = hjwUnesc(m[1]);
            }
            d.isVideo = !!d.m3u8;
            d.isArticle = !d.isVideo && (d.images.length > 0 || d.artText.length > 0);
            d.payGated = false;   // 实测正文无解锁容器, 内容全量免费
            d.imageCount = d.images.length;
            return d;
          };

          const hjwParseCats = (html, base) => {
            const out = [], seen = {};
            const re = /<a[^>]+href="\/category\/([a-z0-9_\-]+)\/?"[^>]*>([\s\S]{0,80}?)<\/a>/gi;
            let m;
            while ((m = re.exec(html))) {
              const slug = m[1], name = hjwStrip(m[2]);
              if (!name || name.length > 12 || seen[slug]) continue;
              seen[slug] = 1;
              out.push({ slug, name, url: base + "/category/" + slug + "/" });
            }
            return out;
          };

          // 站点导航实测 11 个板块 (yczm=原创招募 是第 11 个, 容易漏)
          const HJW_CAT_SLUGS = ["hjyc", "hjll", "hjcg", "hjkp", "hjwh",
                                 "hjth", "hjaidj", "lmyq", "hjdm", "hjby", "yczm"];
          const HJW_CAT_NAMES = {
            hjyc: "海角原创", hjll: "海角乱伦", hjcg: "热门吃瓜",
            hjkp: "看片娱乐", hjwh: "网黄精品", hjth: "探花合集",
            hjaidj: "AI短剧", lmyq: "绿帽淫妻", hjdm: "成人动漫",
            hjby: "海角搬运", yczm: "原创招募",
          };

          // ---- id → 板块 反查表 ----
          // 为什么需要: 视频帖的板块能从播放器的 data-video_type_* 拿到,
          // 但**图文帖没有播放器属性**, 详情页里拿不到板块归属
          // (导航那 11 条是全站菜单, 不是帖子归属)。
          // 解法: 扫各板块列表页, 把里面出现的 id 记成 "该 id 属于该板块",
          // 详情页缺板块时来这张表查。缓存 6 小时。
          const HJW_MAP_KEY = "/__catmap__";
          const HJW_MAP_TTL = 21600;   // 6h

          const hjwMapLoad = async () => {
            try {
              const r = await caches.default.match(
                new Request("https://hjw-cache.internal" + HJW_MAP_KEY));
              if (!r) return null;
              const j = await r.json();
              // 过期自检 (Cache 的 TTL 是尽力而为, 再保一道)
              if (!j || !j.at || (Date.now() - j.at) > HJW_MAP_TTL * 1000) return null;
              return j.map || null;
            } catch (e) { return null; }
          };

          const hjwMapStore = async (map, ctx) => {
            try {
              const res = new Response(JSON.stringify({ at: Date.now(), map }), {
                headers: { "Content-Type": "application/json",
                           "Cache-Control": "public, max-age=" + HJW_MAP_TTL },
              });
              const put = caches.default.put(
                new Request("https://hjw-cache.internal" + HJW_MAP_KEY), res);
              if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
            } catch (e) { /* 缓存失败不影响主流程 */ }
          };

          // 扫全部板块页第 1 页建映射。串行 + 间隔, 只在缓存缺失时跑一次。
          const hjwMapBuild = async (ctx) => {
            const map = {};
            for (let i = 0; i < HJW_CAT_SLUGS.length; i++) {
              const slug = HJW_CAT_SLUGS[i];
              try {
                const { html, host } = await hjwFetch(
                  "/category/" + slug + "/", { ttl: 1800, ctx });
                const ids = html.match(/href="\/archives\/(\d+)\/?"/gi) || [];
                for (const raw of ids) {
                  const mm = raw.match(/(\d+)/);
                  if (mm) map[mm[1]] = slug;
                }
              } catch (e) { /* 单板块失败不影响其它 */ }
              if (i < HJW_CAT_SLUGS.length - 1) {
                await new Promise((r2) => setTimeout(r2, 250));
              }
            }
            if (Object.keys(map).length) await hjwMapStore(map, ctx);
            return map;
          };

          let hjwMapPromise = null;
          const hjwMapGet = async (ctx) => {
            const cached = await hjwMapLoad();
            if (cached) return cached;
            if (!hjwMapPromise) {
              hjwMapPromise = hjwMapBuild(ctx).catch(() => ({}));
            }
            return hjwMapPromise;
          };

          // 给详情结果补板块 (仅在原字段为空时)
          const hjwFillCat = async (d, ctx) => {
            if (d.catId && d.catName) return d;
            try {
              const map = await hjwMapGet(ctx);
              const slug = map && map[String(d.id)];
              if (slug) {
                d.catId = d.catId || slug;
                d.catName = d.catName || (HJW_CAT_NAMES[slug] || slug);
                d.catFrom = "listmap";
              }
            } catch (e) { /* 反查失败就算了, 不影响正文 */ }
            return d;
          };

          try {
            if (sub === "/list") {
              const catRaw = q.get("cat") || "";
              // 只放行已知板块 slug, 防止把任意路径拼进上游 URL
              const cat = HJW_CAT_SLUGS.indexOf(catRaw) >= 0 ? catRaw : "";
              let page = parseInt(q.get("page") || "1", 10) || 1;
              if (page < 1) page = 1;
              if (page > 50) page = 50;          // 上游深度分页无意义, 且易触发风控
              const p = cat
                ? "/category/" + cat + "/" + (page > 1 ? "page/" + page + "/" : "")
                : (page > 1 ? "/page/" + page + "/" : "/");
              const { html, host } = await hjwFetch(p, { ttl: 300, ctx });
              const items = hjwParseList(html, host);
              const cats = (page === 1 && !cat) ? hjwParseCats(html, host) : [];
              return json({ ok: true, source: "hjw", page, cat, host,
                            items, total: items.length, categories: cats,
                            hasMore: items.length > 0 }, h);
            }

            if (sub === "/video") {
              const id = q.get("id") || "";
              if (!/^\d+$/.test(id)) return json({ ok: false, error: "id 非法" }, h, 400);
              const { html, host } = await hjwFetch("/archives/" + id + "/",
                                                    { ttl: 600, ctx });
              const d = hjwParseDetail(html, id, host);
              // 图文帖详情页没有板块属性 → 用列表页反查表补上
              await hjwFillCat(d, ctx);
              d.ok = true;
              d.pageUrl = host + "/archives/" + id + "/";
              d.source = "hjw";
              return json(d, h);
            }

            if (sub === "/search") {
              let kw = (q.get("q") || "").trim();
              if (kw.length > 40) kw = kw.slice(0, 40);   // 超长词拼出畸形 URL
              if (!kw) return json({ ok: true, items: [] }, h);
              let items = [];
              let host = HJW_HOSTS[0];
              for (const u of ["/search/" + encodeURIComponent(kw) + "/",
                               "/search/?q=" + encodeURIComponent(kw)]) {
                try {
                  const r = await hjwFetch(u, { ttl: 600, ctx });
                  host = r.host;
                  items = hjwParseList(r.html, host);
                  if (items.length) break;
                } catch (e) { /* 换下一个路径 */ }
              }
              return json({ ok: true, source: "hjw", keyword: kw, host,
                            items, total: items.length }, h);
            }

            if (sub === "/sections") {
              let limit = parseInt(q.get("limit") || "12", 10) || 12;
              if (limit < 1) limit = 1;
              if (limit > 24) limit = 24;
              // 全 11 个板块都取 (推荐 + 11), 但分批并发 — 一次 11 路会顶到
              // Cloudflare 子请求上限, 也容易被上游把出口 IP 拉黑。
              // 每批 4 个 + 批间 200ms, 11 项约 3 批, 单批内并行所以首屏不慢。
              const CAT_NAMES = {
                hjyc: "海角原创", hjll: "海角乱伦", hjcg: "热门吃瓜",
                hjkp: "看片娱乐", hjwh: "网黄精品", hjth: "探花合集",
                hjaidj: "AI短剧", lmyq: "绿帽淫妻", hjdm: "成人动漫",
                hjby: "海角搬运", yczm: "原创招募",
              };
              const jobs = [["", "推荐"]].concat(
                HJW_CAT_SLUGS.map((s) => [s, CAT_NAMES[s] || s]));
              const BATCH = 4;
              const res = [];
              for (let i = 0; i < jobs.length; i += BATCH) {
                const batch = jobs.slice(i, i + BATCH);
                const got = await Promise.all(batch.map(async (job) => {
                  const slug = job[0], name = job[1];
                  try {
                    const { html, host } = await hjwFetch(
                      slug ? "/category/" + slug + "/" : "/", { ttl: 600, ctx });
                    return { slug, name,
                             items: hjwParseList(html, host).slice(0, limit) };
                  } catch (e) {
                    return { slug, name, items: [],
                             error: String((e && e.message) || e) };
                  }
                }));
                for (const g of got) res.push(g);
                if (i + BATCH < jobs.length) {
                  await new Promise((r2) => setTimeout(r2, 200));
                }
              }
              return json({ ok: true, source: "hjw", sections: res }, h);
            }

            if (sub === "/health") {
              const t0 = Date.now();
              try {
                // 强制回源, 否则缓存命中就测不出上游真实连通性
                const { host } = await hjwFetch("/", { recache: true });
                return json({ ok: true, host, ms: Date.now() - t0 }, h);
              } catch (e) {
                return json({ ok: false, error: String((e && e.message) || e) }, h, 502);
              }
            }

            // 反查表状态 / 强制重建 (rebuild=1)
            if (sub === "/catmap") {
              const t0 = Date.now();
              if (q.get("rebuild") === "1") hjwMapPromise = null;
              const map = await hjwMapGet(ctx);
              const keys = Object.keys(map || {});
              const bySlug = {};
              for (const k of keys) {
                const s = map[k];
                bySlug[s] = (bySlug[s] || 0) + 1;
              }
              const sample = {};
              for (const id of keys.slice(0, 8)) sample[id] = map[id];
              return json({ ok: true, entries: keys.length, bySlug, sample,
                            slugs: HJW_CAT_SLUGS, ms: Date.now() - t0 }, h);
            }

            return json({ ok: false, error: "未知子路径: " + sub }, h, 404);
          } catch (e) {
            return json({ ok: false, error: String((e && e.message) || e) }, h, 502);
          }
        }

        // ============ 黄豆短剧 (hddj) 代理 ============
        //   前端 /api/hd/list       → 上游 /api/app/videos
        //   前端 /api/hd/ep?videoId=1&seq=1 → /api/app/playback
        //   前端 /api/hd/play?episodeId=1   → /api/app/play
        //   前端 /api/hd/stream?u=<encoded> → 透传视频流 (Range 支持)
        if (path.startsWith("/api/hd")) {
          const sub = path.slice("/api/hd".length) || "/videos";
          const qs = url.search || "";

          // ---- 视频流透传 (必须保留 Range / Accept-Ranges) ----
          if (sub === "/stream") {
            const raw = q.get("u") || "";
            let target = raw ? decodeURIComponent(raw) : "";
            if (!/^https?:\/\//i.test(target)) {
              // 相对地址: 优先用调用方指定的线路 (&h= 或 &line=), 否则用第一条
              let host = HD_MEDIA_HOSTS[0] || "https://hddj.zen-vip.com";
              const want = (q.get("h") || q.get("line") || "").trim();
              if (want) {
                const hit = HD_MEDIA_HOSTS.filter(function (x) { return x.indexOf(want) >= 0; })[0];
                if (hit) host = hit;
              }
              target = host + (target[0] === "/" ? target : "/" + target);
            }

            /* ★ 关键修复 (2026-10-16)
             * 旧代码**不转发**浏览器的 Range 头 → 上游回 200 + 整个文件 (实测单集 100 MB+),
             * 播放器要的是 206 Partial Content, 于是: 不能拖进度 / 卡住 / 直接播不出来。
             * 而同一个文件里 /proxy/* 是转发 Range 的 —— 两条路径行为不一致, 这就是
             * "黄豆模块挂上代理之后视频无法正常播放"的根因。
             * 现在两边行为对齐。
             */
            const fwd = {
              "User-Agent": UA,
              "Referer": "https://hddj30.cc/",
              "Accept": "*/*",
              "Accept-Encoding": "identity",   // 别让上游压视频, 会让 Content-Length 对不上
            };
            const rng = request.headers.get("Range");
            if (rng) fwd["Range"] = rng;
            const ifR = request.headers.get("If-Range");
            if (ifR) fwd["If-Range"] = ifR;

            try {
              const r = await fetch(target, { headers: fwd });
              const nh = { ...h };
              nh["Content-Type"] = r.headers.get("Content-Type") || "video/mp4";
              for (const k of ["Content-Range", "Content-Length", "Accept-Ranges",
                               "ETag", "Last-Modified", "Content-Disposition"]) {
                const v = r.headers.get(k);
                if (v) nh[k] = v;
              }
              if (!nh["Accept-Ranges"]) nh["Accept-Ranges"] = "bytes";
              // ticket 两小时就过期, 且每集都换 —— 绝不能长缓存
              nh["Cache-Control"] = "private, no-store";
              nh["Access-Control-Expose-Headers"] = "Content-Length,Content-Range,Accept-Ranges";
              // 206/416 要原样透出, 播放器靠它判断能不能 seek
              return new Response(r.body, { status: r.status, headers: nh });
            } catch (e) {
              return json({ ok: false, error: String((e && e.message) || e) }, h, 502);
            }
          }

          let target;
          if (sub === "/list" || sub === "/videos") {
            target = "/videos" + qs;
          } else if (sub === "/search") {
            // 上游的 /videos?keyword= 是摆设 —— 传什么词都返回同一份热度榜
            // (实测「嫂子」和「时停」首条完全一样, total 都是 985)。
            // 所以这里改成: 拉全站清单 -> 本地按关键词过滤 -> 缓存住清单。
            const kw = (q.get("q") || q.get("keyword") || "").trim();
            if (!kw) return json({ ok: true, items: [], total: 0, keyword: "" }, h);

            const all = await hdAllItems(ctx);
            const hit = filterByKeyword(all.items, kw);
            return json({
              ok: true,
              keyword: kw,
              total: hit.length,
              poolSize: all.items.length,
              poolComplete: all.complete,
              items: hit.slice(0, 200),
            }, h);
          } else if (sub === "/video") {
            target = "/videos/" + encodeURIComponent(q.get("id") || "");
          } else if (sub === "/categories") {
            target = "/categories";
          } else if (sub === "/rankings") {
            target = "/rankings" + qs;
          } else if (sub === "/wishes") {
            target = "/wishes" + qs;
          } else if (sub === "/ep") {
            target = "/playback?videoId=" + encodeURIComponent(q.get("videoId") || q.get("id") || "") +
              "&seq=" + encodeURIComponent(q.get("seq") || q.get("ep") || "1");
          } else if (sub === "/play") {
            target = "/play?episodeId=" + encodeURIComponent(q.get("episodeId") || "");
          } else if (sub === "/notice") {
            target = "/player-notice?videoId=" + encodeURIComponent(q.get("videoId") || q.get("id") || "");
          } else if (sub === "/distribution") {
            target = "/distribution";
          } else if (sub === "/health") {
            target = "/videos?page=1";
          } else {
            target = sub + qs;
          }

          let lastErr = null;
          for (const base of HD_API_LINES) {
            if (HD_BAD[base] && HD_BAD[base] > Date.now()) continue;
            try {
              const ctl = new AbortController();
              const timer = setTimeout(() => ctl.abort(), 12000);
              const r = await fetch(base + target, {
                headers: { "User-Agent": UA, "Accept": "application/json", "Referer": "https://hddj30.cc/" },
                signal: ctl.signal,
              });
              clearTimeout(timer);
              if (!r.ok) { lastErr = new Error("status " + r.status); HD_BAD[base] = Date.now() + HD_BAD_TTL; continue; }
              const txt = await r.text();
              delete HD_BAD[base];
              // 把 managed-media 相对地址补成可直接播的绝对地址
              const fixed = txt.replace(/"(\/api\/app\/managed-media\/[^"]+)"/g,
                (m, p1) => '"' + base.replace(/\/api\/app\/?$/, "") + p1 + '"');
              return new Response(fixed, {
                status: 200,
                headers: { ...h, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
              });
            } catch (e) {
              lastErr = e;
              HD_BAD[base] = Date.now() + HD_BAD_TTL;
            }
          }
          return json({ ok: false, error: String((lastErr && lastErr.message) || lastErr) }, h, 502);
        }

        // ============ EROSHORT (eroshort.net) 代理 ============
        //   上游是 React SPA + REST, base = https://eroshort.net/api/v1
        //
        //   ⚠ 出口现实 (2026-10-09 CI 实测):
        //     eroshort.net 对 **所有** Cloudflare/数据中心 IP 段做硬拦 (403 block page),
        //     包括本 Worker 的 CF 边缘出口、GitHub Actions runner、本地直连。
        //     只有住宅/移动网络 + 真浏览器指纹能过。
        //
        //   所以取数策略是三级:
        //     1) 上游直连 (Worker 出口偶发被放行; 免费版 CF 拦截会随时间抖动)
        //     2) 中转池 ES_RELAYS —— 公共 CORS 代理 (CI 侧实测 cors.lol 能取到 bundle)
        //     3) 静态快照 data/es-*.json —— 由 CI 经中转抓取后落盘, 前端本地读
        //
        //   透传规则: /api/es/<path>?<query>  →  https://eroshort.net/api/v1/<path>?<query>
        //   支持 GET 与 POST (POST 用于 /playback/resolve 取真实流地址)
        if (path.startsWith("/api/es")) {
          const sub = path.slice("/api/es".length) || "/shorts";

          const esHeaders = {
            "User-Agent": UA,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Referer": "https://eroshort.net/",
            "Origin": "https://eroshort.net",
          };

          // ---- 取数核心: 直连 → 中转池, 逐个试 ----
          // 返回 { kind:'json', data } | { kind:'cf', status } | { kind:'bad', status, head }
          const esFetchText = async (sub2, method, body, timeoutMs, tok, extra) => {
            const targets = [{ u: ES_API_BASE + sub2, name: "direct", wrap: null }];
            for (const r of ES_RELAYS) {
              targets.push({ u: r.prefix + encodeURIComponent(ES_API_BASE + sub2), name: r.name, wrap: r.wrap || null });
            }
            // 带 token 的调用只可能走直连: 公共 CORS 中转不转发 Authorization 头
            const eh = tok ? { ...esHeaders, "Authorization": "Bearer " + tok } : { ...esHeaders };
            // 白名单额外的请求头 (上游对 POST /checkin、/contents/*/purchase 要求 Idempotency-Key)
            if (extra && typeof extra === "object") {
              for (const k of Object.keys(extra)) {
                if (/^(idempotency-key|x-request-id|accept-language|x-client-[a-z-]+)$/i.test(k)) {
                  eh[k] = String(extra[k]).slice(0, 200);
                }
              }
            }
            let last = { kind: "bad", status: 0, head: "no_target", via: "" };
            for (const t of targets) {
              try {
                const ctl = new AbortController();
                const timer = setTimeout(() => ctl.abort(), timeoutMs || 15000);
                const init = { method: method || "GET", headers: eh, signal: ctl.signal };
                if (method && method !== "GET" && method !== "HEAD" && body != null) {
                  init.body = body;
                  init.headers = { ...eh, "Content-Type": "application/json" };
                }
                const r = await fetch(t.u, init);
                let txt = await r.text();
                clearTimeout(timer);
                if (/^\s*<(!DOCTYPE|html)/i.test(txt)) {
                  // 上游拦截页 vs 中转自身错误页: 只按上游特征判 cf
                  const isUpstreamBlock = /Sorry, you have been blocked|Attention Required|Just a moment|cf-error/i.test(txt);
                  last = { kind: isUpstreamBlock ? "cf" : "bad", status: r.status, head: txt.slice(0, 80), via: t.name };
                  continue;
                }
                // allorigins /get 会包一层 {"contents":"<body>",...}, 需解包后再判
                if (t.wrap) {
                  try {
                    const env = JSON.parse(txt);
                    if (env && typeof env[t.wrap] === "string") txt = env[t.wrap];
                  } catch (e) { /* 不是包装格式则原样处理 */ }
                }
                try {
                  return { kind: "json", data: JSON.parse(txt), via: t.name };
                } catch (e) {
                  last = { kind: "bad", status: r.status, head: txt.slice(0, 80), via: t.name };
                }
              } catch (e) {
                last = { kind: "bad", status: 0, head: String((e && e.message) || e), via: t.name };
              }
            }
            return last;
          };

          // ---- GET 语法糖 ----
          // ⚠ 这里原来漏了。`/api/es/ep` 里直接调 esGet(...) 但全文件没有定义,
          //   于是每次播放请求都在这里抛 ReferenceError → 502 "esGet is not defined"。
          //   这是"点开视频永远播不了"的**直接原因**, 而不是上游不通。
          const esGet = (sub2, timeoutMs) => esFetchText(sub2, "GET", null, timeoutMs || 15000);

          // ---- 原始透传 (非 JSON: HLS manifest / 分片) ----
          // esFetchText 只认 JSON (parse 失败即判 bad), 所以 m3u8 和 PNG 分片
          // 走它必然 502。这里另开一条: 原样返回 body + content-type。
          // 上游 stego_hls 的地址长这样:
          //   /api/v1/playback/manifest/<variant>?grant=<JWT>   (m3u8)
          //   分片是 .png (像素里藏着 TS 数据)
          const esFetchRaw = async (sub2, timeoutMs) => {
            const targets = [{ u: ES_API_BASE + sub2, name: "direct" }];
            // 只加"原样返回 body"的中转; /get 那种会包一层 JSON 的不能用
            for (const r of ES_RELAYS) {
              if (r.wrap) continue;
              targets.push({ u: r.prefix + encodeURIComponent(ES_API_BASE + sub2), name: r.name });
            }
            let last = { status: 0, via: "" };
            for (const t of targets) {
              try {
                const ctl = new AbortController();
                const timer = setTimeout(() => ctl.abort(), timeoutMs || 20000);
                const r = await fetch(t.u, { headers: esHeaders, signal: ctl.signal });
                clearTimeout(timer);
                const buf = await r.arrayBuffer();
                const b0 = new Uint8Array(buf.slice(0, 4));
                // 拦截页 / 中转错误页: 以 '<' 开头 (HTML) 一律丢弃
                if (r.status !== 200 || b0[0] === 0x3c) {
                  last = { status: r.status, via: t.name };
                  continue;
                }
                return { ok: true, buf: buf, ctype: r.headers.get("Content-Type") || "", via: t.name, status: r.status };
              } catch (e) {
                last = { status: 0, via: t.name };
              }
            }
            return { ok: false, status: last.status, via: last.via };
          };

          // ---- 通用网关: POST /api/es/gw ----
          // body: { calls:[ {path, method, body, token, headers} ], timeout }
          // 返回: { ok:true, results:[ {path,method,via,kind,status,data|head} ] }
          // headers 只放行白名单 (idempotency-key / x-request-id / accept-language /
          // x-client-*) —— 上游的 /checkin 与 /contents/*/purchase 要求 Idempotency-Key。
          //
          // 为什么需要它:
          //   上游对 GitHub runner / 家宽 IP 直接发 CF 的 JS 挑战
          //   (403 "Just a moment..."), 但放行 Worker 出口。
          //   所有"必须 POST(带 body)"或"必须带 Authorization"的上游调用
          //   (登录 / entitlements / playlines / playback resolve) 都从这里发出。
          //   凭证仅在本次请求体内过一次, Worker 不落盘、不记日志。
          if (sub === "/gw" || sub.indexOf("/gw?") === 0) {
            if (request.method !== "POST") return json({ ok: false, error: "POST_ONLY" }, h, 405);
            let g = null;
            try { g = await request.json(); } catch (e) { g = null; }
            if (!g || !Array.isArray(g.calls) || !g.calls.length) {
              return json({ ok: false, error: "BAD_BODY", hint: "{\"calls\":[{\"path\":\"/auth/login\",\"method\":\"POST\",\"body\":{},\"token\":\"\"}]}" }, h, 400);
            }
            if (g.calls.length > 40) return json({ ok: false, error: "TOO_MANY", max: 40 }, h, 400);
            const tmo = Math.min(Math.max(parseInt(g.timeout, 10) || 20000, 3000), 60000);
            const out = [];
            for (const c of g.calls) {
              const p = String((c && c.path) || "");
              if (!p || p.indexOf("/") !== 0) { out.push({ path: p, error: "BAD_PATH" }); continue; }
              const m = String((c && c.method) || "GET").toUpperCase();
              const bd = (c && c.body != null)
                ? (typeof c.body === "string" ? c.body : JSON.stringify(c.body)) : null;
              const tk = (c && c.token) || null;
              const r = await esFetchText(p, m, bd, tmo, tk, (c && c.headers) || null);
              out.push({
                path: p, method: m, via: r.via || "", kind: r.kind || "bad",
                status: r.status || 0,
                data: r.kind === "json" ? r.data : null,
                head: r.kind === "json" ? null : String(r.head || "").slice(0, 240),
              });
            }
            return json({ ok: true, results: out }, h);
          }

          // ---- /api/es/raw/<上游路径>?<query> ----
          if (sub === "/raw" || sub.indexOf("/raw/") === 0) {
            const rest = sub.slice(4) + (url.search || "");
            if (!rest || rest === "/") return json({ ok: false, error: "MISSING_PATH" }, h, 400);
            const rr = await esFetchRaw(rest, 30000);
            if (!rr.ok) {
              return json({
                ok: false, service: "es",
                error: "BAD_UPSTREAM", via: rr.via || "", status: rr.status || 0,
                hint: "manifest/分片取不到; 上游拦截或中转限流",
              }, h, 502);
            }
            return new Response(rr.buf, {
              status: 200,
              headers: {
                ...h,
                "Content-Type": rr.ctype || "application/octet-stream",
                "Cache-Control": "no-store",
                "X-Es-Via": rr.via || "",
              },
            });
          }

          // ---- 健康探针 (部署自检用) ----
          if (sub === "/health") {
            const probe = await esFetchText("/shorts?page=1&page_size=1", "GET", null, 12000);
            if (probe.kind === "json") {
              return json({
                ok: true, service: "es", origin: "https://eroshort.net",
                via: probe.via, build: ES_BUILD_ID.slice(0, 12),
              }, h);
            }
            return json({
              ok: false, service: "es",
              upstream: probe.kind === "cf" ? "cf_block" : "bad",
              via: probe.via || "", status: probe.status || 0,
            }, h, 502);
          }

          // ---- 快照读取 (env.ASSETS 里的 data/es-*.json) ----
          const esSnap = async (name) => {
            try {
              if (!env || !env.ASSETS) return null;
              const r = await env.ASSETS.fetch(new Request("https://assets.local/data/" + name));
              if (!r || !r.ok) return null;
              return await r.json();
            } catch (e) { return null; }
          };
          // es-detail.json 的 details 可能是数组 [{id,detail}|{id,eps}] 或对象 {id:{...}}
          const esSnapDetail = (snap, id) => {
            if (!snap || !snap.details || !id) return null;
            const D = snap.details;
            if (Array.isArray(D)) {
              const h = D.filter((x) => x && x.id === id)[0];
              return h ? (h.detail || h) : null;
            }
            return D[id] || null;
          };

          // ---- 合并详情: /api/es/video?id=<uuid> ----
          // 上游详情与集数分属两个接口, 这里合并成一次返回, 前端只发一跳。
          if (sub === "/video" || sub.indexOf("/video?") === 0) {
            const id = q.get("id") || "";
            if (!id) return json({ ok: false, error: "MISSING_ID" }, h, 400);
            const eid = encodeURIComponent(id);
            const [mr, cr] = await Promise.all([
              esGet("/shorts/" + eid),
              esGet("/hierarchy/short_video/" + eid + "/children?group_by=false&include_metadata=true"),
            ]);
            if (mr.kind !== "json" || cr.kind !== "json") {
              // 实时不可用 → 回退 CI 抓的 es-detail.json / es-list.json
              const det = await esSnap("es-detail.json");
              const hit = esSnapDetail(det, id);
              if (hit && hit.eps && hit.eps.length) {
                return json({
                  ok: true, snapshot: true, source: "es",
                  meta: {
                    id: id, title: hit.title || "", cover: hit.cover || "",
                    description: "", tags: [], access: "",
                    views: 0, likes: 0, price: 0, epTotal: hit.eps.length,
                  },
                  eps: hit.eps.map((x, i) => ({
                    id: x.id, ep: x.ep || i + 1,
                    label: x.label || ("第" + (x.ep || i + 1) + "集"),
                    title: x.title || "", free: null,
                  })),
                }, h);
              }
              const lst = await esSnap("es-list.json");
              const card = lst && (lst.items || []).filter((x) => x && x.id === id)[0];
              if (card) {
                // meta 必须与实时的 meta 同形, 前端不分支
                return json({
                  ok: true, snapshot: true, source: "es",
                  meta: {
                    id: id, title: card.title || "", cover: card.cover || "",
                    description: card.desc || "", tags: card.tags || [], access: card.access || "",
                    views: card.views || 0, likes: card.likes || 0, price: card.vipPrice || 0,
                    epTotal: card.epCount || 0, updatedAt: card.updatedAt || "",
                  },
                  eps: [],
                }, h);
              }
              const bad = mr.kind !== "json" ? mr : cr;
              return json({ ok: false, error: bad.kind === "cf" ? "CF_CHALLENGE" : "BAD_UPSTREAM", via: bad.via || "" }, h, 502);
            }
            const m = mr.data || {}, c = cr.data || {};

            // ---- 映射卡片 ----
            const clean = (x) => String(x == null ? "" : x).replace(/\[\/?sm\]/gi, "").replace(/\s+/g, " ").trim();
            const title = clean(m.title);
            const pm = title.match(/共\s*(\d+)\s*\/\s*(\d+)\s*集/) || title.match(/共\s*(\d+)\s*集/);
            const cover = (m.cover && (m.cover.url || m.cover)) || "";
            const tags = Array.isArray(m.tags)
              ? m.tags.map((t) => clean(typeof t === "string" ? t : (t && t.name))).filter(Boolean)
              : [];

            // ---- 集数 ----
            // children 是扁平全后代列表: depth0=collection(合集) / depth1=video(season,整部) /
            // depth2=level_2(episode,真正的集)。只按标题剔除 root 是不够的 ——
            // season 节点标题往往就等于剧名, 会被误当"第1集", 导致点第一集 NOT_FOUND。
            const rootTitle = clean((c.root && c.root.title) || title);
            const kids = Array.isArray(c.children) ? c.children : [];
            const isEpNode = (k) => {
              const md = (k && k.metadata) || {};
              const st = md.short_structure_type;
              if (st === "episode") return true;
              if (st === "season" || st === "collection") return false;
              return !k.child_count;
            };
            const eps = [];
            for (const k of kids) {
              if (!k || !k.id || !isEpNode(k)) continue;
              const t = clean(k.title);
              if (!t || t === rootTitle) continue;
              const em = t.match(/^第\s*([一二三四五六七八九十百零〇\d]+)\s*集\s*(.*)$/);
              let label, sub2;
              if (em) { label = "第" + em[1] + "集"; sub2 = em[2] || ""; }
              else if (eps.length === 0) { label = "第1集"; sub2 = t; }
              else { label = "第" + (eps.length + 1) + "集"; sub2 = t; }
              const kc = k.cover;
              eps.push({
                id: k.id,
                ep: eps.length + 1,
                label: label,
                title: sub2,
                cover: (kc && (kc.url || kc)) || "",
                free: k.access_level === "free" || m.access_level === "free" ? true : null,
              });
            }

            return json({
              ok: true,
              meta: {
                id: m.id || id,
                title: title,
                cover: cover,
                description: clean(m.description),
                tags: tags,
                access: m.access_level || "",
                views: m.view_count || 0,
                likes: m.like_count || 0,
                price: (m.pricing && m.pricing.price) || 0,
                epTotal: eps.length,
              },
              eps: eps,
              source: "es",
            }, h);
          }

          // ---- 合并单集: /api/es/ep?epId=<uuid> ----
          // 三步合一: 取播放线 → 查权限 → (有权限) resolve 出真实流地址
          if (sub === "/ep" || sub.indexOf("/ep?") === 0) {
            const epId = q.get("epId") || q.get("id") || "";
            if (!epId) return json({ ok: false, error: "MISSING_ID" }, h, 400);
            const eid = encodeURIComponent(epId);

            // ---- 播放地址快照优先 (CI 预解析, 零上游请求) ----
            // /playback/resolve 是 POST, 而公共 CORS 中转基本都不转发 POST body
            // (allorigins 只做 GET, codetabs POST 直接 503, cors.lol 限流) ——
            // 也就是说实时解析这条路命中率极低。CI 侧把地址预先 resolve 好落进
            // data/es-play.json, 这里直接命中, 播放就不再依赖上游是否可达。
            {
              const pj = await esSnap("es-play.json");
              const rec = pj && pj.plays && pj.plays[epId];
              if (rec && rec.url) {
                const exp = rec.expiresAt ? Date.parse(rec.expiresAt) : 0;
                if (!exp || exp > Date.now() + 60000) {
                  if (rec.format === "stego_hls") {
                    // stego_hls 也必须走 ok 分支: 它只是"封装成 PNG 的 HLS",
                    // 前端用自带解封装器播, 不再当错误。
                    // stego.license 是解 PNG 载荷的钥匙, 绝不能丢。
                    return json({
                      ok: true, locked: false, format: "stego_hls", url: rec.url,
                      stego: rec.stego || null, mediaId: rec.mediaId || null,
                      assetVersion: rec.assetVersion || null, mimeType: "application/vnd.apple.mpegurl",
                      expiresAt: rec.expiresAt || null, free: rec.free !== false,
                      snapshot: true, source: "es",
                    }, h);
                  }
                  if (rec.format !== "unsupported") {
                    return json({
                      ok: true, locked: false, url: rec.url, format: rec.format || "direct",
                      expiresAt: rec.expiresAt || null, free: rec.free !== false,
                      snapshot: true, source: "es",
                    }, h);
                  }
                }
              } else if (rec && rec.locked) {
                return json({ ok: false, locked: true, reason: rec.reason || "no_source" }, h);
              }
            }

            const [plr, entr] = await Promise.all([
              esGet("/playlines/episode/" + eid),
              esGet("/wallet/entitlement/" + eid),
            ]);
            if (plr.kind !== "json") {
              return json({ ok: false, error: plr.kind === "cf" ? "CF_CHALLENGE" : "BAD_UPSTREAM", via: plr.via || "" }, h, 502);
            }
            const pl = plr.data || {};
            const ent = entr.kind === "json" ? (entr.data || {}) : {};

            const lines = (pl && pl.data) || [];
            const act = lines.filter((l) => l && l.is_active !== false);
            const usable = act.filter((l) =>
              l.has_access !== false && l.source_id && l.content_id &&
              (l.source_kind === "owned" || l.source_kind === "external_hls"));

            const accessReason = (ent && ent.access_reason) || "";
            if (!usable.length) {
              const reason = accessReason === "LOGIN_REQUIRED" ? "login_required"
                : accessReason === "PAYMENT_REQUIRED" ? "payment_required"
                : accessReason === "VIP_REQUIRED" ? "vip_required"
                : "no_source";
              return json({ ok: false, locked: true, reason: reason }, h);
            }

            // 有权限 → POST /playback/resolve 拿真实地址 (同样走 直连→中转 池)
            const L = usable[0];
            const body = JSON.stringify({
              source_kind: L.source_kind,
              source_id: L.source_id,
              content_id: L.content_id,
              build_id: ES_BUILD_ID,
            });
            const rr = await esFetchText("/playback/resolve", "POST", body, 20000);
            if (rr.kind !== "json") {
              return json({ ok: false, locked: false, reason: "no_source", error: rr.kind === "cf" ? "CF_CHALLENGE" : "BAD_UPSTREAM" }, h, 502);
            }
            const rj = rr.data || {};

            const R = (rj && rj.data) || {};
            const url = R.url || "";
            if (!url) return json({ ok: false, locked: true, reason: "unavailable" }, h);

            const fmt = R.delivery === "hls" ? "hls"
              : R.delivery === "stego_hls" ? "stego_hls"
              : R.delivery === "direct" ? "direct" : "unsupported";

            // stego_hls = 把 MPEG-TS 藏进 PNG 的 HLS。manifest 是标准 m3u8,
            // 只是分片是 .png。前端自带解封装器 (stegoHls), 所以这里按"可播"返回。
            // ★ stego.license / media_id / asset_version 必须原样带出去 ——
            //   少一个字节前端就解不出载荷, 表现就是"点开永远转圈"。
            if (fmt === "stego_hls") {
              return json({
                ok: true, locked: false, format: "stego_hls", url: url,
                stego: R.stego || null,
                mediaId: R.media_id || null,
                assetVersion: R.asset_version || null,
                mimeType: R.mime_type || null,
                expiresAt: R.expires_at || null,
                free: accessReason === "FREE_CONTENT",
                source: "es",
              }, h);
            }
            if (fmt === "unsupported") {
              return json({ ok: false, locked: false, reason: "unknown_format" }, h);
            }

            return json({
              ok: true,
              locked: false,
              url: url,
              format: fmt,
              expiresAt: R.expires_at || null,
              free: accessReason === "FREE_CONTENT",
              source: "es",
            }, h);
          }

          // ---- 分类标签: 实时失败回退 es-cats.json ----
          if (sub === "/tags" || sub.indexOf("/tags?") === 0) {
            const tr = await esFetchText(sub, "GET", null, 15000);
            if (tr.kind === "json") {
              return new Response(JSON.stringify(tr.data), {
                status: 200,
                headers: { ...h, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Es-Via": tr.via || "" },
              });
            }
            const cj = await esSnap("es-cats.json");
            if (cj && cj.categories && cj.categories.length) {
              // 拍平成上游同形状: { categories:[{code:"类型", tags:[...]}] }
              return new Response(JSON.stringify({
                categories: [{ code: "类型", name: "类型", tags: cj.categories }],
                snapshot: true,
                source: "es",
              }), {
                status: 200,
                headers: { ...h, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Es-Via": "snapshot" },
              });
            }
            return json({ ok: false, error: tr.kind === "cf" ? "CF_CHALLENGE" : "BAD_UPSTREAM", via: tr.via || "" }, h, 502);
          }

          // ---- 普通透传 (GET / POST), 同样走 直连→中转 池 ----
          const subFull = sub + (url.search || "");
          let reqBody = null;
          if (request.method !== "GET" && request.method !== "HEAD") {
            reqBody = await request.text();
          }
          const pr = await esFetchText(subFull, request.method, reqBody, 20000);
          if (pr.kind === "json") {
            return new Response(JSON.stringify(pr.data), {
              status: 200,
              headers: { ...h, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Es-Via": pr.via || "" },
            });
          }

          // ---- 列表类请求实时不可用 → 用 CI 快照重组同样形状的响应 ----
          // 上游 /shorts 的响应形状: { data:[...], pagination:{total,limit,offset,has_more} }
          // 前端只认这个形状, 所以快照要按同样的壳吐出去。
          if (request.method === "GET" && (sub === "/shorts" || sub.indexOf("/shorts?") === 0 || sub === "")) {
            const lst = await esSnap("es-list.json");
            if (lst && lst.items && lst.items.length) {
              const pageSize = Math.max(1, parseInt(q.get("page_size") || "12", 10));
              const page = Math.max(1, parseInt(q.get("page") || "1", 10));
              const tagRaw = (q.get("tag") || "").trim();
              const tag = tagRaw.toLowerCase();
              const kw = (q.get("q") || "").trim().toLowerCase();
              let items = lst.items.slice();
              if (tag) {
                // 大小写无关: 分类 code 是 "绿帽ntr", 卡片 tags 是显示名 "绿帽NTR"
                if (tag === "ongoing" || tag === "completed") {
                  // 状态分类的 code 与 tags 里的中文名不一致(更新中/已完结), 做归一,
                  // 否则这两个 tab 永远空列表
                  const st = tag === "completed" ? "已完结" : "更新中";
                  items = items.filter((x) => {
                    const codes = Array.isArray(x.tags)
                      ? x.tags.map((v) => String(typeof v === "string" ? v : (v && (v.code || v.name)) || "").trim().toLowerCase())
                      : [];
                    return codes.indexOf(st.toLowerCase()) >= 0;
                  });
                } else {
                  items = items.filter((x) => {
                    const codes = Array.isArray(x.tags)
                      ? x.tags.map((v) => String(typeof v === "string" ? v : (v && (v.code || v.name)) || "").trim().toLowerCase())
                      : [];
                    return codes.indexOf(tag) >= 0 || String(x.title || "").toLowerCase().indexOf(tag) >= 0;
                  });
                }
              }
              if (kw) items = items.filter((x) => String(x.title || "").toLowerCase().indexOf(kw) >= 0);
              const total = items.length;
              const off = (page - 1) * pageSize;
              const slice = items.slice(off, off + pageSize);
              return new Response(JSON.stringify({
                data: slice,
                pagination: { total: total, limit: pageSize, offset: off, has_more: off + pageSize < total },
                snapshot: true,
                source: "es",
              }), {
                status: 200,
                headers: { ...h, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Es-Via": "snapshot" },
              });
            }
          }

          return json({
            ok: false,
            service: "es",
            error: pr.kind === "cf" ? "CF_CHALLENGE" : "BAD_UPSTREAM",
            via: pr.via || "", status: pr.status || 0,
            hint: "上游被 CF 拦截或中转限流; 前端会回退 data/es-*.json 快照",
          }, h, 502);
        }

        return json({ error: "not found", path }, h, 404);
      } catch (e) {
        return json({ error: String((e && e.message) || e) }, h, 502);
      }
    }

    // ============ 静态资源 (env.ASSETS) ============
    if (path === "/" || path === "") {
      if (env.ASSETS) return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
      return new Response("index.html not bound", { status: 500 });
    }

    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);

      // sw.js: 绝对不许缓存。任何一层缓存留住旧 sw.js, 更新检查就会失效,
      // 用户会永远卡在旧版本上 (页面自愈逻辑也拿不到新版本号)。
      if (path === "/sw.js") {
        return new Response(res.body, {
          status: res.status,
          headers: {
            ...h,
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
            "Service-Worker-Allowed": "/",
            "X-Build": BUILD_ID,
          },
        });
      }

      if (path === "/manifest.json" && res.status === 200) {
        return new Response(res.body, {
          status: 200,
          headers: {
            ...h,
            "Content-Type": "application/manifest+json; charset=utf-8",
            "Cache-Control": "no-cache",
            "X-Build": BUILD_ID,
          },
        });
      }

      // HTML / JS 一律不缓存, 保证改完刷新就是新版
      if (/\.(html|js)$/i.test(path) || path === "/") {
        return new Response(res.body, {
          status: res.status,
          headers: {
            ...h,
            "Content-Type": path.endsWith(".js")
              ? "application/javascript; charset=utf-8"
              : "text/html; charset=utf-8",
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
            "X-Build": BUILD_ID,
          },
        });
      }

      return res;
    }

    return new Response("Not Found", { status: 404 });
  },

  // ============ 定时自检 (Cloudflare Cron) ============
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const rep = await runSelfCheck(env);
        console.log(JSON.stringify({
          tag: "selfcheck", cron: event.cron,
          ok: rep.upstreamOk && rep.listOk, mirror: rep.aliveMirror,
          listCount: rep.listCount, errors: rep.errors,
        }));
      } catch (e) {
        console.log(JSON.stringify({ tag: "selfcheck", fatal: String((e && e.message) || e) }));
      }
    })());
  },
};

function json(obj, h, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...h, "Content-Type": "application/json; charset=utf-8" },
  });
}

/* ============================================================
 * 封面解密
 * ============================================================
 * 上游对图片做了加密, 拿到的是 binary/octet-stream 的密文。
 * 参数明文写在它自己的 /static/web/js/plugins/crypto-worker.js:
 *
 *   const i0 = {
 *     mode: "CBC",
 *     media_key: "102_53_100_57_54_53_100_102_55_53_51_51_54_50_55_48",
 *     media_iv:  "57_55_98_54_48_51_57_52_97_98_99_50_102_98_101_49"
 *   };
 *   function V0(b) { return b.split("_").map(c => String.fromCharCode(+c)).join(""); }
 *   AES.decrypt(data, V0(media_key), { iv: V0(media_iv), mode: CBC, padding: NoPadding })
 *
 * V0() 把 "102_53_..." 这种下划线 ASCII 码还原成真字符串:
 *   media_key -> "f5d965df75336270"   (16 字节 = AES-128)
 *   media_iv  -> "97b60394abc2fbe1"   (16 字节)
 * ============================================================ */

// 下划线 ASCII 码 -> 字符串 (对应上游的 V0)
function v0Decode(s) {
  return String(s).split("_").map((c) => String.fromCharCode(parseInt(c, 10))).join("");
}

const HDJ_C = {
  key: "102_53_100_57_54_53_100_102_55_53_51_51_54_50_55_48",
  iv: "57_55_98_54_48_51_57_52_97_98_99_50_102_98_101_49",
};

let _cryptoKeyCache = null;
async function getCoverKey() {
  if (_cryptoKeyCache) return _cryptoKeyCache;
  const raw = new TextEncoder().encode(v0Decode(HDJ_C.key));
  _cryptoKeyCache = await crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["decrypt"]);
  return _cryptoKeyCache;
}

/**
 * AES-128-CBC / NoPadding 解密。
 * 上游用 NoPadding, 密文长度就是明文长度 (实测 246944 -> 246944, 头 ffd8ffe0),
 * 所以直接解出来用, 不需要去 padding。
 */
async function aesCbcNoPadDecrypt(buf) {
  try {
    if (buf.byteLength % 16 !== 0) return null;
    const key = await getCoverKey();
    const iv = new TextEncoder().encode(v0Decode(HDJ_C.iv));
    const out = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, buf);
    return out;
  } catch (e) {
    return null;
  }
}

// 是不是已经就是一张图 (用来判断要不要解密)
function isImageMagic(a) {
  if (!a || a.length < 12) return false;
  if (a[0] === 0xff && a[1] === 0xd8 && a[2] === 0xff) return true;                    // JPEG
  if (a[0] === 0x89 && a[1] === 0x50 && a[2] === 0x4e && a[3] === 0x47) return true;   // PNG
  if (a[0] === 0x47 && a[1] === 0x49 && a[2] === 0x46) return true;                    // GIF
  if (a[8] === 0x57 && a[9] === 0x45 && a[10] === 0x42 && a[11] === 0x50) return true; // WEBP
  if (a[4] === 0x66 && a[5] === 0x74 && a[6] === 0x79 && a[7] === 0x70) return true;   // ftyp
  return false;
}

function guessImageType(a) {
  if (!a) return "image/jpeg";
  if (a[0] === 0xff && a[1] === 0xd8) return "image/jpeg";
  if (a[0] === 0x89 && a[1] === 0x50) return "image/png";
  if (a[0] === 0x47 && a[1] === 0x49) return "image/gif";
  if (a[8] === 0x57 && a[9] === 0x45) return "image/webp";
  return "image/jpeg";
}