/**
 * 湟果视频 · 多品牌短剧模块 (hg-brands.js)
 * ============================================================
 * 现存板块: 心动传媒 (xindongcm.com) / 蜜月传媒 (amiyue.com)
 *
 * 【它们为什么能直接播】
 *   Nuxt SSR 前台 + FastAPI 后端, 而接口是**完全公开**的:
 *   根路径就自报 {"app":"xindongcm","docs":"/docs"}, /openapi.json 敞着,
 *   内容面全在 /api/site/* —— 零登录 / 零签名 / 零 AES 信封。
 *   详情接口直接回 episodes[].video_url (m3u8 直链), 而且是**明文流**:
 *   无 EXT-X-KEY, 分片是真 MPEG-TS (首字节 0x47, 188 字节对齐)。
 *   两站是同一套 CMS, 只有 title 不同 → 共用一份实现, 由 xdFamily 区分。
 *
 * 【IP 保护】
 *   取数与媒体全部由 Worker 从 Cloudflare 出口走 (见 worker.js 的 XD_SITES),
 *   访客浏览器一次都不碰 api.xindongcm.com / file.amiyue.com。
 *
 * [已下线] 禁果 9vgz2.com / 橙果 chengguodj.com / 蜜桃 mtdjgw.com / 2048 madouai.xyz
 *   这四个是「下载落地页 + APP 内加密接口」形态 —— 网页侧没有一集剧集数据,
 *   板块里能给的只有官方地址与 APP 下载入口, 等价于"去官网看", 已于 v19 整体移除。
 *   橙果那套 AES 信封当时确实还原过、也能播, 但按"只留网页侧能自洽取数与播放的
 *   板块"这条原则一并下线; 解密细节留在 docs/经验记录.md, 需要时可回查。
 *
 * 挂到 window.HGBrands
 * ============================================================
 */
(function (root) {
  'use strict';

  /* ===================== 品牌表 =====================
   * v19 起表里只剩心动 / 蜜月。
   *   landings : 官方入口 (多个 = 多个兜底)
   *   apiHosts : 上游 API 主机 (第一个是首选)
   *   xdFamily : 决定走 Worker 的 /api/xd/* 还是 /api/my/*
   * 禁果/橙果/蜜桃/2048 四个登记项随板块下线一并删除 —— 它们走的是
   * "landing 探测", 而探测端点和调用方都已经不存在了。
   * ================================================ */
  var BRANDS = {
    /* ===== 心动传媒 / 蜜月传媒 (2026-10-18 新增) =====
     * 与禁果/蜜桃的"只有落地页"不同 —— 这两个是**完整可播的内容板块**。
     *   Nuxt SSR 前台 + FastAPI 后端, /openapi.json 敞着, 内容面全在 /api/site/*,
     *   零登录 / 零签名 / 零 AES 信封; 详情接口直接回 video_url (m3u8 直链),
     *   而且是**明文流**(无 EXT-X-KEY), 分片不需要解密。
     *   取数与媒体都由 Worker 从 Cloudflare 出口走, 访客浏览器不碰上游。
     * 两站同一套 CMS, 因此共用一份 Worker 实现 (XD_SITES 参数化)。
     * ================================================ */
    xd: {
      key: 'xd', name: '心动传媒', short: '心动', color: '#a78bfa',
      kind: 'xd',
      desc: '完整可播 · 公开 JSON 接口 · 明文切片免解密',
      landings: ['https://xindongcm.com', 'https://www.xindongcm.com'],
      apiHosts: ['api.xindongcm.com'],
      xdFamily: 'xd',
    },
    my: {
      key: 'my', name: '蜜月传媒', short: '蜜月', color: '#fb923c',
      kind: 'xd',
      desc: '完整可播 · 公开 JSON 接口 · 明文切片免解密',
      landings: ['https://amiyue.com', 'https://www.amiyue.com'],
      apiHosts: ['api.amiyue.com'],
      xdFamily: 'my',
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

  /* ===================== 心动传媒 / 蜜月传媒 适配器 =====================
   * 与黄果/橙果一致: 浏览器只跟本站 /api/xd/*、/api/my/* 说话。
   * 上游是公开 FastAPI (api.xindongcm.com / api.amiyue.com), 取数在 Worker 侧完成。
   *
   * 为什么不需要解密:
   *   上游 m3u8 是**明文** (无 EXT-X-KEY), 分片是真 MPEG-TS。
   *   实测: seg_00000.ts -> 200 video/mp2t 776440B, 首字节 0x47, 188 字节对齐。
   *   (黄果/橙果是 AES-128-CBC 加密流, 这两个不是 —— 别把它们的假设套过来。)
   *
   * 分页参数是 page + size, 不是 page_size (上游对 page_size 不认账, 实测仍回 12 条)。
   * ============================================================ */
  function XdApi(brandKey) {
    var b = brand(brandKey);
    var fam = (b && b.xdFamily) || brandKey || 'xd';
    var P = '/api/' + fam;

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
      family: fam,
      /** 频道目录 */
      channels: function () { return get(P + '/categories'); },
      /** 首页分组 */
      home: function () { return get(P + '/home'); },
      /** 列表 — cat 是上游 category_id, 留空 = 全部 */
      list: function (page, cat, size) {
        return get(P + '/list', { page: page || 1, cat: cat || '', size: size || 24 });
      },
      /** 详情 (含 episodes[], 每条自带 video_url) */
      detail: function (id) { return get(P + '/detail', { id: id }); },
      video: function (id) { return get(P + '/detail', { id: id }); },
      /** 单集播放源 — 返回本站 /api/xdm/media?u=… 代理地址 */
      ep: function (id, ep) { return get(P + '/ep', { id: id, ep: ep }); },
      /** 搜索 (复用上游 /api/site/series 的 keyword 参数) */
      search: function (q, page) { return get(P + '/list', { q: q || '', page: page || 1, size: 24 }); },
      /** 热搜词 */
      hot: function (limit) { return get(P + '/hot', { limit: limit || 10 }); },
    };
  }

  root.HGBrands = {
    BRANDS: BRANDS,
    all: list,
    get: brand,
    XdApi: XdApi,
    clearCache: function (k) { if (k) delete CACHE[k]; else CACHE = {}; },
  };
})(typeof window !== 'undefined' ? window : globalThis);
