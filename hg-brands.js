/**
 * 湟果视频 · 多品牌短剧模块 (hg-brands.js)
 * ============================================================
 * 支持: 禁果 / 橙果 / 蜜桃 / 2048 —— 以及以后任何"同平台"新品牌。
 *
 * 【两个世代, 两种取数方式】
 *   一、落地页世代 (禁果 9vgz2.com / 蜜桃 mtdjgw.com)
 *       下载落地页 → 解码 <script id="landing-payload"> → window.appConfig
 *       落地页里 **没有剧集数据**, 只有一个品牌宣传片。
 *       剧集走 app 内置的加密接口 (POST /api/v1/*, {"errcode":0,"data":"<AES>"+sign+timestamp}),
 *       网页端拿不到密钥 → 只能给官方地址 + 下载入口。
 *
 *   二、真站世代 (橙果 chengguodj.com)  ★ 2026-10-16 新发现
 *       Nuxt SSR 站, 229KB 服务端渲染 HTML, 带完整目录:
 *       推荐 / 橙果原创 / AI短剧 / 真人短剧 / AI魔改 / AI漫剧 / 热播榜 / 心愿榜
 *       前端配置里直接写着后端地址: window.__NUXT__.config.public.apiBaseURL
 *       = https://api2.chengguodj.com
 *
 *       ★ 2026-10 再次突破: 这套接口的**加密信封已经完整还原** ——
 *         密钥就在站点公开的前端 bundle (/_nuxt/BIb7tDp8.js) 里:
 *           key="2acf7e91e9864673"  iv="1c29882d3ddfcfd6"
 *           sign_key="5589d41f92a597d016b037ac37db243d"
 *           AES-128-CBC / Pkcs7 / _ver=v0 / client=ios
 *         所以橙果**不是只能给下载入口** —— 目录、详情、逐集播放源全部可取,
 *         而且实测解出的分片是真的 MPEG-TS (188 字节对齐同步字 40/40)。
 *         解密/签名只在 Worker 里做, 浏览器只跟本站 /api/cg/* 说话。
 *         → 走 /api/cg/* 适配器 (worker-cg-helpers.js / worker-cg-routes.js)。
 *
 *   注意: chengguodi.com (用户最初给的域名) 全变体实测一律 502 / 不解析,
 *         真站是 **chengguodj.com** (多一个 j)。
 *
 * 【IP 保护】
 *   探测一律走 Worker /api/brand/probe, 由 Cloudflare 出口出网。
 *   访客的浏览器和你的机器都不直连上游。
 *
 * 挂到 window.HGBrands
 * ============================================================
 */
(function (root) {
  'use strict';

  /* ===================== 品牌表 =====================
   * landings : 该品牌的官网 / 落地页入口 (多个 = 多个兜底)
   * apiHosts : 后端 API 主机 (第一个是首选)
   * kind     : 'landing' = 只有下载落地页 / 'nuxt' = 真站, 有内容接口
   * ================================================ */
  var BRANDS = {
    jg: {
      key: 'jg', name: '禁果短剧', short: '禁果', color: '#ff4d6d',
      kind: 'landing',
      desc: '官方落地页 · 内容在 APP 内',
      landings: ['https://9vgz2.com'],
      apiHosts: ['jgdj.zen-vip.com', 'jg.zen-vip.com'],
    },
    cg: {
      key: 'cg', name: '橙果短剧', short: '橙果', color: '#ff9f1c',
      kind: 'nuxt',
      desc: '完整可播 · 加密接口已还原',
      // 实测 2026-10-16: chengguodi.com 的 8 个后缀变体一律 502;
      // 真站是 chengguodj.com, 后端 api2.chengguodj.com。
      // 备用入口 chengguo1.com (同一批内容)。
      landings: ['https://chengguodj.com', 'https://www.chengguodj.com', 'https://chengguo1.com'],
      apiHosts: ['api2.chengguodj.com'],
      channels: [
        { code: 'yuanchuang', name: '橙果原创' },
        { code: 'zhenren',    name: '真人短剧' },
        { code: 'aiduanju',   name: 'AI短剧' },
        { code: 'manju',      name: 'AI漫剧' },
        { code: 'mogai',      name: 'AI魔改' },
      ],
    },
    mt: {
      key: 'mt', name: '蜜桃短剧', short: '蜜桃', color: '#f472b6',
      kind: 'landing',
      desc: '官方落地页 · 内容在 APP 内',
      landings: ['https://mtdjgw.com'],
      apiHosts: ['mtdj.zen-vip.com', 'mt.zen-vip.com'],
    },
    b2048: {
      key: 'b2048', name: '2048成人短剧', short: '2048', color: '#38bdf8',
      kind: 'landing',
      desc: '待补官方入口 · 内容在 APP 内',
      landings: [],                       // ← 待用户提供官方域名
      apiHosts: ['2048dj.zen-vip.com', 'dj2048.zen-vip.com'],
    },
  };

  var CACHE = {};        // { key: { at, data } }
  var CACHE_TTL = 10 * 60 * 1000;

  /**
   * 解析 Worker 基址 (所有品牌板块的取数与探测都要用它)。
   *
   * 【为什么旧写法一定会挂 —— 就是"禁果提示未配置"的根因】
   *   index.html 里是这样声明的:
   *       const DEFAULT_API = 'https://…workers.dev';
   *       let API = localStorage.getItem('hg_api') || DEFAULT_API;
   *   顶层 `let` / `const` 属于**脚本作用域**, 不会成为 window 的属性
   *   (只有顶层 `var` 和裸赋值才会)。而本文件拿的是 `root.API` (= window.API),
   *   于是它**永远是 undefined** → apiBase() 恒返回 '' →
   *   probe() 走 `reason: 'no-worker'` 分支 → 界面显示
   *   "未配置 Worker 地址, 无法在服务端探测。请先在「服务器设置」里填 Worker。"
   *
   *   修法: 不再依赖"全局变量一定挂到 window"这个不成立的假设, 改成显式解析链,
   *   顺序与 index.html 保持一致 (用户覆盖 > 页面注入 > 全局 > 同源兜底)。
   */
  function apiBase() {
    var v = '';
    try {
      // 1) 用户在「服务器设置」里的覆盖值 —— 与 index.html 的优先级一致
      if (root.localStorage) v = root.localStorage.getItem('hg_api') || '';
      // 2) index.html 显式注入的解析结果 (见 window.HG_API_BASE = API)
      if (!v) v = root.HG_API_BASE || '';
      // 3) 兼容用 var 声明 API 的老页面
      if (!v && typeof root.API === 'string') v = root.API;
      // 4) 兜底: 页面本身由 Worker 提供 (自定义域名 / workers.dev) → 用同源
      if (!v && root.location && /^https?:$/i.test(root.location.protocol || '')) {
        v = root.location.origin;
      }
    } catch (e) {}
    return String(v || '').replace(/\/+$/, '');
  }

  function brand(key) {
    return BRANDS[key] || null;
  }

  function list() {
    return Object.keys(BRANDS).map(function (k) { return BRANDS[k]; });
  }

  /* ===================== 探测 (服务端) ===================== */
  /**
   * 走 Worker 的 /api/brand/probe, 由 Cloudflare 出口去取落地页。
   * 这样做的好处:
   *   - 不暴露访客 IP (浏览器从不直连上游)
   *   - 也不暴露你自己的 IP (同样不直连)
   *   - 落地页解码逻辑只在 Worker 里维护一份
   */
  function probe(key, force) {
    var b = brand(key);
    if (!b) return Promise.reject(new Error('未知品牌: ' + key));

    var c = CACHE[key];
    if (!force && c && (Date.now() - c.at) < CACHE_TTL) return Promise.resolve(c.data);

    var base = apiBase();
    var landings = b.landings || [];
    if (!base || !landings.length) {
      return Promise.resolve({
        ok: false, key: key, brand: b,
        reason: !base ? 'no-worker' : 'no-landing',
        notice: !base
          ? '未配置 Worker 地址, 无法在服务端探测。请先在「服务器设置」里填 Worker。'
          : '该品牌还没有登记官方入口, 请把域名补进 hg-brands.js 的 landings。',
        links: {}, api: { ok: false },
      });
    }

    function tryOne(i) {
      if (i >= landings.length) {
        return Promise.resolve({
          ok: false, key: key, brand: b, reason: 'all-landings-failed',
          notice: '所有官方入口都打不开 (可能被墙 / 换域名了)。',
          links: {}, api: { ok: false },
        });
      }
      var u = base + '/api/brand/probe?u=' + encodeURIComponent(landings[i]) +
              (b.apiHosts && b.apiHosts[0] ? '&apiHost=' + encodeURIComponent(b.apiHosts[0]) : '');
      var ctl = ('AbortController' in root) ? new root.AbortController() : null;
      var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);
      var opts = { method: 'GET', credentials: 'omit' };
      if (ctl) opts.signal = ctl.signal;

      return fetch(u, opts).then(function (r) {
        clearTimeout(timer);
        return r.ok ? r.json() : null;
      }).then(function (j) {
        if (!j || !j.ok) throw new Error('probe failed');
        j.key = key;
        j.brand = b;
        j.landingUrl = landings[i];
        // 公开 API 通了 → 这个品牌可以当完整内容板块用
        j.hasContentApi = !!(j.api && j.api.ok);
        j.notice = j.hasContentApi
          ? ''
          : ('「' + b.name + '」剧集只在其 APP 内提供 (网页侧接口加密 + 需登录)。' +
             '这里给你的是当前官方地址与下载入口。');
        CACHE[key] = { at: Date.now(), data: j };
        return j;
      }).catch(function () {
        clearTimeout(timer);
        return tryOne(i + 1);
      });
    }
    return tryOne(0);
  }

  /* ===================== 同平台公开 API 适配器 =====================
   * 与 hg-hd.js 的 HDHd 完全一致的取数方式 —— 黄豆实测可用。
   * 任何品牌只要 probe 到 hasContentApi=true, 就自动套这个适配器。
   * ============================================================ */
  function Api(brandKey) {
    var b = brand(brandKey);
    var host = (b && b.apiHosts && b.apiHosts[0]) || '';
    var prefix = 'https://' + host + '/api/app';

    function get(path) {
      var ctl = ('AbortController' in root) ? new root.AbortController() : null;
      var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 12000);
      var opts = {
        method: 'GET', credentials: 'omit', mode: 'cors',
        headers: { 'Accept': 'application/json' },
      };
      if (ctl) opts.signal = ctl.signal;
      return fetch(prefix + path, opts).then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (j) {
        if (!j || j.ok !== true) throw new Error((j && j.message) || '返回异常');
        return j;
      });
    }

    return {
      prefix: prefix,
      list: function (page, cat, sort) {
        var qs = '?page=' + (page || 1);
        if (cat) qs += '&category=' + encodeURIComponent(cat);
        if (sort) qs += '&sort=' + encodeURIComponent(sort);
        return get('/videos' + qs);
      },
      video: function (id) { return get('/videos/' + encodeURIComponent(id)); },
      categories: function () { return get('/categories'); },
      rankings: function (page) { return get('/rankings?page=' + (page || 1)); },
      episode: function (videoId, seq) {
        return get('/playback?videoId=' + encodeURIComponent(videoId) + '&seq=' + encodeURIComponent(seq || 1));
      },
      play: function (episodeId) { return get('/play?episodeId=' + encodeURIComponent(episodeId)); },
      notice: function (videoId) { return get('/player-notice?videoId=' + encodeURIComponent(videoId)); },
      distribution: function () { return get('/distribution'); },
    };
  }

  /* ===================== 橙果适配器 =====================
   * chengguodj.com 是 Nuxt SSR, 后端 api2.chengguodj.com。
   *
   * ★ 2026-10 关键突破: 橙果的接口是**加密信封**, 但密钥在整个站点公开的
   *   前端 bundle (/_nuxt/BIb7tDp8.js) 里写着, 已完整还原:
   *
   *      key = "2acf7e91e9864673"   iv = "1c29882d3ddfcfd6"
   *      sign_key = "5589d41f92a597d016b037ac37db243d"
   *      AES-128-CBC / Pkcs7 / _ver=v0 / client=ios
   *
   *   所以橙果**不再需要登录、不再需要 APP**, 全站目录 + 播放源都能取。
   *   解密和签名只在 Worker 里做 (patches/worker-cg-helpers.js),
   *   浏览器只跟本站 /api/cg/* 说话 —— 访客 IP 不会落到 api2.chengguodj.com。
   *
   *   频道: yuanchuang 橙果原创 / zhenren 真人短剧 / aiduanju AI短剧
   *         manju AI漫剧 / mogai AI魔改
   * ============================================================ */
  function CgApi() {
    function get(path, params) {
      var base = apiBase();
      if (!base) return Promise.reject(new Error('Worker 未配置'));
      var qs = params ? '?' + new URLSearchParams(params).toString() : '';
      return fetch(base + path + qs, { method: 'GET', credentials: 'omit' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j && j.ok === false) throw new Error(j.error || '上游失败');
          return j;
        });
    }
    return {
      /** 频道目录 (真人 / AI短剧 / AI漫剧 / AI魔改 / 原创) */
      channels: function () { return get('/api/cg/channels'); },
      /** 频道列表 — channel 留空 = 全部 */
      list: function (page, channel) {
        return get('/api/cg/list', { page: page || 1, channel: channel || '' });
      },
      /** 推荐流 (游标翻页) */
      feed: function (cursor) { return get('/api/cg/feed', { cursor: cursor || '' }); },
      home: function () { return get('/api/cg/home'); },
      /** 详情 — id 或 slug 都行 */
      video: function (id) { return get('/api/cg/detail', { id: id }); },
      detail: function (id, slug) {
        return get('/api/cg/detail', slug ? { slug: slug } : { id: id });
      },
      /** 单集播放源 — 返回本站 /api/cg/media?u=… 代理地址 */
      ep: function (id, ep) { return get('/api/cg/ep', { id: id, ep: ep }); },
      search: function (q, page) { return get('/api/cg/search', { q: q, page: page || 1 }); },
    };
  }

  root.HGBrands = {
    BRANDS: BRANDS,
    all: list,
    get: brand,
    probe: probe,
    Api: Api,
    CgApi: CgApi,
    clearCache: function (k) { if (k) delete CACHE[k]; else CACHE = {}; },
    /** 探测结果 → 可以直接喂给 index.html 的卡片渲染 */
    toCard: function (j) {
      if (!j) return null;
      return {
        id: j.key,
        title: j.brand ? j.brand.name : j.key,
        cover: '',
        desc: (j.links && (j.links.official || j.links.latest || j.links.permanent)) || j.landingUrl || '',
        notice: j.notice || '',
      };
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
