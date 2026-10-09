/**
 * 湟果视频 · 芒果短剧数据源 (mgmg10.com)
 * ========================================
 * 按 hg-hd.js 同款模式封装, 挂到 window.HGMg
 *
 * 站点结构 (2026-10 实测):
 *   列表    GET /                          → .dm-feature 卡片 (含 dm-feature-card)
 *   分类    GET /category/{slug}/
 *   详情    GET /series/details/{id}.html   → id 是 24 位 hex
 *   播放    GET /watch/details/{id}.html?ep={n}
 *   流      GET /play/{id}/{ep}.m3u8        → 标准 HLS (AES-128)
 *   搜索    GET /search/?keyword={q}
 *   站点地图 GET /sitemap.xml  → sitemap-home.xml / sitemap-image-N.xml
 *
 * 关键限制:
 *   1. 无 CORS 头 → 前端不能直连, 必须走 Worker 代理
 *   2. 防盗链: 任何带 Origin 头的请求返回 403
 *      → 代理转发时必须剥掉 Origin, 服务端侧再补 Referer
 *   3. 付费墙: 每部仅第 1 集免费 (data-ep-free="1"), 第 2 集起返回 402
 *      前端只展示免费集, 付费集标注"金币"并给出原站跳转
 *
 * 分类 slug (首页实测):
 *   du-jia-shuang-ju          独家爽剧
 *   ai-comic-drama            AI漫剧
 *   adult-short-drama         真人短剧
 *   ca-bian-duan-ju           擦边短剧
 *   remixed-short-drama       AI魔改短剧
 *   masturbation-zone         撸管专区
 *   er-ci-yuan                二次元
 */
(function (root) {
  'use strict';

  // 站点主机 (mgmg10.com 直连可用; 备用同族域名)
  var HOSTS = [
    'https://mgmg10.com',
  ];
  var ACTIVE = null, ACTIVE_AT = 0, TTL = 5 * 60 * 1000;
  var BAD = {}, BAD_TTL = 90 * 1000;

  var UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

  // 分类表 (slug → 中文名)
  var CATS = [
    { slug: 'du-jia-shuang-ju',     name: '独家爽剧' },
    { slug: 'ai-comic-drama',       name: 'AI漫剧' },
    { slug: 'adult-short-drama',    name: '真人短剧' },
    { slug: 'ca-bian-duan-ju',      name: '擦边短剧' },
    { slug: 'remixed-short-drama',  name: 'AI魔改' },
    { slug: 'masturbation-zone',    name: '撸管专区' },
    { slug: 'er-ci-yuan',           name: '二次元' },
  ];

  function hostOrder() {
    var now = Date.now();
    var usable = HOSTS.filter(function (h) { return !BAD[h] || BAD[h] < now; });
    if (!usable.length) { BAD = {}; usable = HOSTS.slice(); }
    if (ACTIVE && (now - ACTIVE_AT) < TTL && usable.indexOf(ACTIVE) >= 0) {
      return [ACTIVE].concat(usable.filter(function (h) { return h !== ACTIVE; }));
    }
    return usable;
  }

  function markBad(h) { BAD[h] = Date.now() + BAD_TTL; if (ACTIVE === h) ACTIVE = null; }

  /**
   * 经 Worker 代理取页面。
   * 直接 fetch 会被 CORS 拦 (站方不发 ACAO), 所以统一走 /proxy/。
   */
  function proxyUrl(host, path) {
    // Worker 侧: /proxy/<encoded-full-url>
    return '/proxy/' + encodeURIComponent(host + path);
  }

  function get(host, path, timeoutMs) {
    var tmo = timeoutMs || 12000;
    var ctl = ('AbortController' in root) ? new root.AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, tmo);
    var opts = { method: 'GET', mode: 'cors', credentials: 'omit' };
    if (ctl) opts.signal = ctl.signal;
    return fetch(proxyUrl(host, path), opts).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) { markBad(host); throw new Error('HTTP ' + r.status); }
      ACTIVE = host; ACTIVE_AT = Date.now(); delete BAD[host];
      return r.text();
    }).catch(function (e) { clearTimeout(timer); markBad(host); throw e; });
  }

  /** 带主机切换的取页 */
  function fetchPage(path, timeoutMs) {
    var order = hostOrder(), i = 0;
    function tryNext(lastErr) {
      if (i >= order.length) return Promise.reject(lastErr || new Error('芒果站不可用'));
      var h = order[i++];
      return get(h, path, timeoutMs).catch(function (e) { return tryNext(e); });
    }
    return tryNext(null);
  }

  // ---------- 工具 ----------
  function stripTags(s) {
    if (!s) return '';
    return String(s)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  function absUrl(u) {
    if (!u) return '';
    u = String(u).replace(/&amp;/g, '&').trim();
    if (/^https?:\/\//i.test(u)) return u;
    if (u.charAt(0) === '/') return 'https://mgmg10.com' + u;
    return u;
  }

  function idFromHref(href) {
    var m = String(href || '').match(/\/details\/([0-9a-f]{16,32})\.html/);
    return m ? m[1] : '';
  }

  // ---------- 列表解析 ----------
  /**
   * 解析列表页。
   * 卡片两种形态:
   *   A) 首页 hero: <div class="dm-feature-card"> ... <a class="dm-feature-playlink" href="/series/details/{id}.html">
   *   B) 网格卡片: <a href="/series/details/{id}.html" ...> 内含 img / 标题 / 集数
   * 统一按 href 切块处理。
   */
  function parseCards(html) {
    var items = {}, stats = { feature: 0, grid: 0, ld: 0 };

    function put(id, patch) {
      if (!id) return;
      var cur = items[id] || (items[id] = { id: id });
      Object.keys(patch).forEach(function (k) {
        var v = patch[k];
        if (v === null || v === undefined || v === '') return;
        if (k === 'tags') { if (v && v.length) cur.tags = v; return; }
        if (!cur[k]) cur[k] = v;
      });
    }

    // A) dm-feature-card 块
    var fparts = html.split('dm-feature-card');
    for (var i = 1; i < fparts.length; i++) {
      var blk = fparts[i].slice(0, 4000);
      var hm = blk.match(/href="([^"]*\/details\/[0-9a-f]{16,32}\.html)"/i);
      var id = hm ? idFromHref(hm[1]) : '';
      if (!id) continue;
      var tm = blk.match(/dm-feature-title[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
      var pm = blk.match(/dm-feature-pvtitle[^>]*>([\s\S]*?)<\/span>/i);
      var em = blk.match(/dm-feature-pvep[^>]*>([\s\S]*?)<\/span>/i);
      var im = blk.match(/<img[^>]*\bsrc="([^"]+)"/i);
      var pv = blk.match(/<span[^>]*class="lc-preview-slot"[^>]*data-src="([^"]+)"/i);
      var epTxt = em ? stripTags(em[1]) : '';
      var epm = epTxt.match(/(\d+)/);
      var tags = [];
      var tagRe = /class="dm-tag"[^>]*>([\s\S]*?)<\/a>/gi, tg;
      while ((tg = tagRe.exec(blk)) !== null) {
        var t = stripTags(tg[1]);
        if (t && tags.indexOf(t) < 0) tags.push(t);
      }
      put(id, {
        title: stripTags(tm ? tm[1] : (pm ? pm[1] : '')),
        cover: im ? absUrl(im[1]) : '',
        preview: pv ? absUrl(pv[1]) : '',
        ep: epm ? epm[1] : '',
        epLabel: epTxt,
        updating: /更新至/.test(epTxt),
        tags: tags.slice(0, 6),
      });
      stats.feature++;
    }

    // B) 通用网格卡片: 以 href 定位, 往前找 img, 往后找标题
    var re = /href="([^"]*\/details\/([0-9a-f]{16,32})\.html)"([^>]*)>([\s\S]{0,2500}?)(?=href="[^"]*\/details\/|<\/article|<\/li|$)/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var gid = m[2];
      var seg = m[4];
      var img = seg.match(/<img[^>]*\b(?:data-src|src)="([^"]+\.(?:jpg|jpeg|png|webp|gif)[^"]*)"/i);
      var title = '';
      var tt = seg.match(/class="[^"]*title[^"]*"[^>]*>([\s\S]{0,200}?)<\//i);
      if (tt) title = stripTags(tt[1]);
      if (!title) {
        var alt = seg.match(/<img[^>]*\balt="([^"]*)"/i);
        if (alt) title = stripTags(alt[1]);
      }
      var et = seg.match(/(更新至\s*\d+\s*集|\d+\s*集|全\s*\d+\s*集)/);
      var epm2 = et ? et[1].match(/(\d+)/) : null;
      put(gid, {
        title: title,
        cover: img ? absUrl(img[1]) : '',
        ep: epm2 ? epm2[1] : '',
        epLabel: et ? et[1] : '',
        updating: /更新至/.test(et ? et[1] : ''),
      });
      stats.grid++;
    }

    // C) JSON-LD ItemList 补 id + 标题
    var ldRe = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    var lm;
    while ((lm = ldRe.exec(html)) !== null) {
      var raw = lm[1].trim();
      var j;
      try { j = JSON.parse(raw); } catch (e) { continue; }
      var stack = [j];
      while (stack.length) {
        var o = stack.pop();
        if (Array.isArray(o)) { stack.push.apply(stack, o); continue; }
        if (!o || typeof o !== 'object') continue;
        if (o['@type'] === 'ListItem' || o['@type'] === 'VideoObject' || o['@type'] === 'CreativeWork') {
          var u = o.item || o.url || o['@id'] || '';
          var lid = idFromHref(u);
          if (lid) { put(lid, { title: stripTags(o.name || o.headline || '') }); stats.ld++; }
        }
        Object.keys(o).forEach(function (k) { stack.push(o[k]); });
      }
    }

    var out = [];
    Object.keys(items).forEach(function (k) {
      var it = items[k];
      if (!it.title) it.title = '剧集 ' + it.id;
      out.push(it);
    });
    return { items: out, stats: stats };
  }

  // ---------- 详情解析 ----------
  function parseDetail(html) {
    var meta = {}, eps = [];
    var am = html.match(/data-article-id="([0-9a-f]{16,32})"/i);
    meta.id = am ? am[1] : '';

    var tm = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    meta.title = stripTags(tm ? tm[1] : '');

    var cm = html.match(/<img[^>]*\bsrc="(https?:\/\/[^"]*cover[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
    if (!cm) cm = html.match(/data-video-cover="([^"]+)"/i);
    meta.cover = cm ? absUrl(cm[1]) : '';

    var vm = html.match(/data-video-src="([^"]+)"/i);
    meta.firstEp = vm ? vm[1] : '';

    var heat = html.match(/dm-detail-poster-heat[\s\S]{0,300}?<span>([^<]*)<\/span>/i);
    meta.heat = heat ? stripTags(heat[1]) : '';

    // 分类/标签
    var tags = [];
    var bc = html.match(/<nav class="breadcrumb"[\s\S]*?<\/nav>/i);
    if (bc) {
      var lre = /<a[^>]*href="\/category\/([^"\/]+)\/"[^>]*>([^<]*)<\/a>/gi, x;
      while ((x = lre.exec(bc[0])) !== null) tags.push(stripTags(x[2]));
    }
    var tre = /<a[^>]*href="\/tag\/[^"]*"[^>]*>([^<]*)<\/a>/gi, y;
    while ((y = tre.exec(html)) !== null) {
      var tt = stripTags(y[1]);
      if (tt && tags.indexOf(tt) < 0) tags.push(tt);
    }
    meta.tags = tags.slice(0, 8);

    // 简介
    var dm = html.match(/class="[^"]*dm-detail-desc[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/i);
    if (!dm) dm = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
    meta.description = dm ? stripTags(dm[1]) : '';

    // 集数列表
    var ere = /<a[^>]*class="dm-ep([^"]*)"[^>]*href="([^"]*)"[^>]*data-ep="(\d+)"[^>]*data-ep-free="(\d+)"[^>]*data-pay-method="([^"]*)"[^>]*data-pay-price="(\d+)"/gi;
    var e;
    while ((e = ere.exec(html)) !== null) {
      var locked = e[1].indexOf('is-locked') >= 0;
      var free = e[4] === '1';
      eps.push({
        ep: parseInt(e[3], 10),
        free: free && !locked,
        locked: locked,
        payMethod: e[5] || '',
        payPrice: e[6] || '0',
      });
    }
    eps.sort(function (a, b) { return a.ep - b.ep; });
    meta.epTotal = eps.length;
    meta.epFreeCount = eps.filter(function (x) { return x.free; }).length;
    return { meta: meta, eps: eps };
  }

  // ---------- 对外 API ----------
  var api = {
    /** 站点健康探测 */
    probe: function () {
      return fetchPage('/', 10000).then(function (html) {
        var r = parseCards(html);
        return { ok: r.items.length > 0, count: r.items.length, host: ACTIVE };
      }).catch(function (e) {
        return { ok: false, error: String(e && e.message || e) };
      });
    },

    /** 列表: path 可选分类 slug */
    list: function (params) {
      params = params || {};
      var path = params.category ? ('/category/' + params.category + '/') : '/';
      return fetchPage(path).then(function (html) {
        var r = parseCards(html);
        return { ok: true, items: r.items, stats: r.stats, source: 'mg' };
      });
    },

    /** 详情 */
    video: function (id) {
      return fetchPage('/series/details/' + id + '.html').then(function (html) {
        var r = parseDetail(html);
        return { ok: true, meta: r.meta, eps: r.eps, source: 'mg' };
      });
    },

    /** 单集播放地址 (返回 m3u8, 经代理) */
    ep: function (id, ep) {
      ep = ep || 1;
      var raw = 'https://mgmg10.com/play/' + id + '/' + ep + '.m3u8';
      return Promise.resolve({
        ok: true,
        ep: ep,
        // 前端播放器拿到的应是代理地址, 剥掉 Origin 才能过防盗链
        url: '/proxy/' + encodeURIComponent(raw),
        raw: raw,
        source: 'mg',
      });
    },

    /** 搜索 */
    search: function (kw) {
      kw = String(kw || '').trim();
      if (!kw) return Promise.resolve({ ok: true, items: [] });
      return fetchPage('/search/?keyword=' + encodeURIComponent(kw)).then(function (html) {
        var r = parseCards(html);
        return { ok: true, items: r.items, stats: r.stats, source: 'mg' };
      });
    },

    /** 分类表 */
    categories: function () { return Promise.resolve({ ok: true, items: CATS }); },

    CATS: CATS,
  };

  root.HGMg = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
