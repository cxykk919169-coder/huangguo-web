/* ============================================================
 * 湟果视频 · 前端直连模块 (hg-direct.js)
 * ============================================================
 * 作用: 当 Cloudflare Worker 不可达时 (workers.dev 在国内被墙),
 *       前端直接用 fetch 访问上游站点, 在浏览器本地解析。
 *
 * 前提: 上游站点和图片站都返回 Access-Control-Allow-Origin: * (已验证)
 *
 * 数据来源: 第三方公开网页, 本项目仅做索引展示, 不存储任何内容。
 * ============================================================ */

(function (global) {
  'use strict';

  // 上游镜像 (自动选第一个可用的)
  // 2026-10 更新: 老域名 2d7b2/dicw/b8ok/el22ax/zohi8/01150 全部失效,
  //   huangguo10/8 已变成"地址发布页"(不含剧集数据), 真站迁到 *.vchllzwu.cc。
  // 注意: 发布页域名必须放最后兜底 —— 它们能返回 200 但无剧集结构,
  //       放前面会导致"页面能开但没数据"。
  //
  // 这里的内置列表只是【首屏兜底】。真正的主站顺序以 site.json 的 origin/mirrors
  // 为准 (GitHub Actions 每 30 分钟刷新一次), loadSiteConfig() 会把它们插到最前。
  var MIRRORS = [
    // ---- 当前主线路 (来源: huangguo10.com 发布页 2026-10-10 11:28 线路表) ----
    "https://qazn.wrjmtnebd.cc",
    "https://ne7d.wrjmtnebd.cc",
    "https://ie70.wrjmtnebd.cc",
    // ---- 当前站群其它在线节点 ----
    "https://flq7.wrjmtnebd.cc",
    "https://b0eu.wrjmtnebd.cc",
    "https://cbl8.wrjmtnebd.cc",
    "https://g9u8.wrjmtnebd.cc",
    "https://xaq0.wrjmtnebd.cc",
    "https://b48r0.wrjmtnebd.cc",
    "https://ij2i7.wrjmtnebd.cc",
    // ---- 漫剧线 (备用结构, 解析器已兼容 /detail/) ----
    "https://b7eb5.fyxybiblx.cc",
    // ---- 地址发布页 (只用于自动发现新域名, 永不作为数据源) ----
    "https://huangguo10.com",
    "https://huangguo8.com",
    "https://huangguo9.com",
    "https://hgai1.com",
  ];

  // 死域后缀 (已整池失效) 与推广/宣传域 (播放会落到官方宣传物料)
  var DEAD_SUFFIX = /\.(?:vchllzwu|gkudvxhjh|ngfxaxnp|igjktqpd)\.[a-z]+$/i;
  var PROMO_HOST = /(?:^|\.)(?:wqgkfvxk|fakieggtv|mqahxxhp|eisees)\.|huangguoai|\/chan\//i;

  // 推广/宣传源判定 —— 命中即丢弃, 绝不当成剧集播放源
  function isPromoUrl(u) {
    if (!u) return true;
    var s = String(u);
    if (PROMO_HOST.test(s)) return true;
    if (/pages\.dev|t\.me|youtube|tiktok/i.test(s)) return true;
    return false;
  }

  // 已知的"地址发布页"主机名 —— 命中这些只用来提取新域名, 不当作数据源
  var PUBLISH_HOSTS = [
    "huangguo10.com", "huangguo8.com", "hgai1.com", "huangguo9.com",
    "huangguoai.com", "huangguoai.ai", "huangguoai.pages.dev",
  ];

  /**
   * 从 site.json 拉最新镜像列表。
   *
   * 为什么需要:
   *   GitHub Actions 每 30 分钟跑 hg_discover.py, 抓官方发布页 → 提取当前线路
   *   → 写进 site.json。前端启动时读这份配置, 就能拿到【机器人刚发现的最新域名】,
   *   而不是死等上线时硬编码的那几个。
   *
   * 读不到就静默跳过 (保留内置列表 + 发布页兜底), 不影响功能。
   */
  var SITE_LOADED = false;
  function loadSiteConfig() {
    if (SITE_LOADED) return Promise.resolve();
    SITE_LOADED = true;
    if (typeof fetch !== 'function') return Promise.resolve();
    return fetch('site.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) {
        if (!cfg) return;
        var list = (cfg.publishPages || []).concat(cfg.mirrors || []);
        // site.json 累计了几千条历史镜像 (含 1500+ 条整池失效的 vchllzwu.cc),
        // 全量塞进 MIRRORS 会让 fetchUpstream 按 3 秒/个 顺序空转十几分钟。
        // 这里只吸收"活的站群节点", 且每个后缀最多 4 条、总量封顶 24 条。
        var CAP = 24, PER_SUFFIX = 4;
        var perHost = {}, plan = [];
        for (var j = 0; j < list.length; j++) {
          var u2 = String(list[j] || '').replace(/\/+$/, '');
          if (!/^https?:\/\//.test(u2)) continue;
          var host = u2.replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
          if (DEAD_SUFFIX.test(host)) continue;      // 整池失效后缀
          if (isPromoUrl(u2)) continue;              // 推广/宣传域
          var suf = host.split('.').slice(-2).join('.');
          perHost[suf] = perHost[suf] || 0;
          if (perHost[suf] >= PER_SUFFIX) continue;
          if (plan.length >= CAP) continue;
          perHost[suf]++; plan.push(u2);
        }
        var injected = 0;
        for (var k = plan.length - 1; k >= 0; k--) {
          if (MIRRORS.indexOf(plan[k]) >= 0) continue;
          MIRRORS.unshift(plan[k]); injected++;
        }
        if (cfg.origin && MIRRORS.indexOf(cfg.origin) > 0) {
          MIRRORS.splice(MIRRORS.indexOf(cfg.origin), 1);
          MIRRORS.unshift(cfg.origin);      // 机器人认定的主站排最前
        }
        if (injected) {
          console.info('[湟果] 已从 site.json 载入 ' + injected + ' 个活动镜像 (已剔除失效/推广域)');
        }
      })
      .catch(function () { /* 读不到就用内置的 */ });
  }

  // 启动即拉一次 (不阻塞后续, 抓页时会等下)
  loadSiteConfig();

  // 从发布页 HTML 里提取真实站点域名
  function extractRealHosts(html) {
    // TLD 白名单要和 hg_discover.py 保持一致, 否则新域名 (.sbs/.icu/...) 会被漏掉
    var found = [], re = /https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:cc|com|net|xyz|vip|top|site|sbs|lol|icu|fun|cyou|buzz|monster|link|pro|online|art|shop|club|live|info|biz|org|co))\//gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var host = m[1].toLowerCase();
      if (PUBLISH_HOSTS.indexOf(host) >= 0) continue;
      if (/huangguoai|pages\.dev|yandex|google|cloudflare/.test(host)) continue;
      // 裸主域 (不带子域) 是线路的"根", 不能当站点用
      if (/^(?:vchllzwu|cname\d|gkudvxhjh|ngfxaxnp|igjktqpd)\./i.test(host)) continue;
      if (found.indexOf(host) < 0) found.push(host);
    }
    return found;
  }

  var UA_HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml,*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9'
  };

  // 记住当前可用镜像 + 失败的镜像 (临时拉黑, 避免反复重试坏域名)
  var ACTIVE = null;
  var ACTIVE_AT = 0;
  var TTL = 60 * 1000;
  var BAD = {};              // { mirror: 拉黑到期时间戳 }
  var BAD_TTL = 90 * 1000;   // 坏镜像拉黑 90 秒
  var LEARNED = null;        // 运行期学到的"最新域名"

  function mirrorOrder() {
    var now = Date.now();
    var usable = MIRRORS.filter(function (m) { return !BAD[m] || BAD[m] < now; });
    if (!usable.length) { BAD = {}; usable = MIRRORS.slice(); }   // 全坏了就重置
    var out = [];
    if (LEARNED && !BAD[LEARNED]) out.push(LEARNED);
    if (ACTIVE && (now - ACTIVE_AT) < TTL && usable.indexOf(ACTIVE) >= 0 && out.indexOf(ACTIVE) < 0) {
      out.push(ACTIVE);
    }
    usable.forEach(function (m) { if (out.indexOf(m) < 0) out.push(m); });
    return out;
  }

  function markBad(m) { BAD[m] = Date.now() + BAD_TTL; if (ACTIVE === m) ACTIVE = null; }

  // 直连抓一个路径, 返回 HTML 文本
  function fetchUpstream(path, timeoutMs) {
    var order = mirrorOrder();
    var i = 0;
    // 原来 12 秒太长, 用户会以为卡死; 现在镜像多(15 个), 单站压到 3 秒
    // 最坏情况 3s x 15 = 45s, 但并行探测只走 6 个候补, 实测 5-8 秒内出结果
    var tmo = timeoutMs || 3000;

    function tryNext(lastErr) {
      if (i >= order.length) return Promise.reject(lastErr || new Error('全部镜像不可用'));
      var base = order[i++];
      var ctl = ('AbortController' in global) ? new global.AbortController() : null;
      var timer = setTimeout(function () { if (ctl) ctl.abort(); }, tmo);
      var opts = { method: 'GET', headers: UA_HEADERS, mode: 'cors', credentials: 'omit', redirect: 'follow' };
      if (ctl) opts.signal = ctl.signal;
      return fetch(base + path, opts).then(function (r) {
        clearTimeout(timer);
        if (!r.ok) { markBad(base); throw new Error('HTTP ' + r.status); }
        // 学到新域名 (响应最终落点)
        try {
          var origin = new URL(r.url).origin;
          if (origin && origin !== base && MIRRORS.indexOf(origin) < 0) LEARNED = origin;
        } catch (e) { /* ignore */ }
        return r.text().then(function (txt) {
          // 命中"地址发布页" → 只用来提取真站域名, 永不作为数据源返回。
          // 旧逻辑在 extractRealHosts 抓不到裸域名时会把发布页 HTML 当数据源返回,
          // 于是列表为空 / 详情解析出推广物料。
          var host = base.replace(/^https?:\/\//, '');
          if (PUBLISH_HOSTS.indexOf(host) >= 0) {
            var real = extractRealHosts(txt);
            real.reverse().forEach(function (h) {
              var u = 'https://' + h;
              if (MIRRORS.indexOf(u) >= 0) return;
              if (DEAD_SUFFIX.test(h) || isPromoUrl(u)) return;
              MIRRORS.unshift(u);
            });
            markBad(base);   // 发布页不是数据源, 拉黑后再走新域名
            throw new Error('publish-page');
          }
          ACTIVE = base;
          ACTIVE_AT = Date.now();
          delete BAD[base];
          return txt;
        });
      }).catch(function (e) {
        clearTimeout(timer);
        markBad(base);
        return tryNext(e);
      });
    }
    return tryNext(null);
  }

  // ---------- 解析函数 (从 worker.js 同步而来, 保证一致) ----------
  function clean(s) {
    if (!s) return "";
    s = String(s);
    s = s.replace(/<span[^>]*class="[^"]*sr-only[^"]*"[^>]*>[\s\S]*?<\/span>/g, "");
    s = s.replace(/<[^>]+>/g, "");
    s = s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
         .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
    return s.replace(/\s+/g, " ").trim();
  }

  // 从一块 HTML 里抽封面 (兼容多种懒加载写法, 排除占位图)
  function extractCover(blk) {
    if (!blk) return "";
    var pats = [
      /data-src\s*=\s*["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp|gif)[^"']*)["']/i,
      /data-original\s*=\s*["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp|gif)[^"']*)["']/i,
      /data-lazy(?:-src)?\s*=\s*["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp|gif)[^"']*)["']/i,
      /data-src\s*=\s*["']([^"']+\.(?:jpg|jpeg|png|webp|gif)[^"']*)["']/i
    ];
    for (var i = 0; i < pats.length; i++) {
      var m = blk.match(pats[i]);
      if (m) {
        var u = m[1].replace(/&amp;/g, "&").trim();
        if (u && !/cover-placeholder|placeholder\.(png|webp)/i.test(u)) return u;
      }
    }
    var ss = blk.match(/srcset\s*=\s*["']([^"']+)["']/i);
    if (ss) {
      var first = ss[1].split(",")[0].trim().split(/\s+/)[0];
      if (first && !/cover-placeholder/i.test(first)) return first.replace(/&amp;/g, "&");
    }
    var sm = blk.match(/<img[^>]+src\s*=\s*["']([^"']+\.(?:jpg|jpeg|png|webp|gif)[^"']*)["']/i);
    if (sm && !/cover-placeholder|placeholder\.(png|webp)/i.test(sm[1])) return sm[1].replace(/&amp;/g, "&");
    return "";
  }

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
      if (isPromoUrl(u)) continue;                       // 推广/宣传物料丢弃
      eps[k] = u;
    }
    // 只有当页面上确实存在 data-play-id === 本剧ID 的播放块时才补第 1 集。
    // 旧逻辑把页面里"所有" data-play-src 按序号塞进 eps, 在带推荐位轮播播放器的
    // 页面上, 会把别的剧/推广位的 m3u8 混成第 2、3、4…集 —— 点选集就播到非本剧内容。
    const own1 = html.match(/data-play-id="(\d+)"[^>]*data-play-src="([^"]+)"/)
              || html.match(/data-play-src="([^"]+)"[^>]*data-play-id="(\d+)"/);
    if (own1 && !eps["1"]) {
      const pid = /^\d+$/.test(own1[1]) && own1[2].indexOf("http") === 0 ? own1[1] : own1[2];
      const srcU = /^\d+$/.test(own1[1]) && own1[2].indexOf("http") === 0 ? own1[2] : own1[1];
      if (pid === vid) {
        const u = String(srcU).replace(/&amp;/g, "&");
        if (!isPromoUrl(u)) eps["1"] = u;
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

  // ---------- 对外 API (与 Worker 的 /api/* 返回结构一致) ----------
  var HG = {
    /** 列表: 抓 /list/N/ 列表页 (数据最全) */
    list: function (opts) {
      opts = opts || {};
      var cat = (opts.cat || '').trim();
      var page = Math.max(1, parseInt(opts.page || 1, 10));
      var p;
      if (cat) {
        p = page > 1 ? '/' + cat + '/' + page + '/' : '/' + cat + '/';
      } else {
        p = page > 1 ? '/list/' + page + '/' : '/list/1/';
      }
      return fetchUpstream(p).then(function (html) {
        var items = parseCards(html);
        return { items: items, page: page, cat: cat, source: p, direct: true };
      });
    },

    /** 搜索 */
    search: function (kw) {
      if (!kw) return Promise.resolve({ items: [] });
      return fetchUpstream('/search/?keyword=' + encodeURIComponent(kw)).then(function (html) {
        return { items: parseCards(html).slice(0, 60), direct: true };
      });
    },

    /** 详情 */
    video: function (id) {
      var mm = String(id).match(/\d+/);
      if (!mm) return Promise.reject(new Error('需要剧集ID'));
      return fetchUpstream('/video/' + mm[0] + '/').then(function (html) {
        var v = parseVideo(html);
        if (!v) throw new Error('解析失败');
        return v;
      });
    },

    /** 某集播放地址 */
    ep: function (id, ep) {
      var mm = String(id).match(/\d+/);
      if (!mm) return Promise.reject(new Error('需要剧集ID'));
      var vid = mm[0];
      var n = parseInt(ep || 1, 10) || 1;
      var p = '/video/' + vid + (n > 1 ? '/ep-' + n + '/' : '/');
      return fetchUpstream(p).then(function (html) {
        // 关键: 上游的 data-play-id 是【剧ID】不是集号!
        //   第 1 集页面: <article data-play-id="12" data-play-src="https://...m3u8?...">
        //   集号列表用 data-ep-id 标记:
        //     <a class="hg-play__ep-item" href="/video/12/ep-2/" data-ep-id="2">02</a>
        // 所以正确做法: 找 data-play-id === 本剧ID 的播放块
        var srcs = [];
        var m;
        var reBlock = /data-play-id="(\d+)"[^>]*data-play-src="([^"]+)"/g;
        while ((m = reBlock.exec(html))) {
          srcs.push({ pid: m[1], src: m[2].replace(/&amp;/g, '&') });
        }
        var reBlock2 = /data-play-src="([^"]+)"[^>]*data-play-id="(\d+)"/g;
        while ((m = reBlock2.exec(html))) {
          srcs.push({ pid: m[2], src: m[1].replace(/&amp;/g, '&') });
        }

        // 1) 本剧权威源: videoInitialData.epPlaySrcs (按集号精确命中)
        var vv = parseVideo(html);
        if (vv && vv.id === vid && vv.eps && vv.eps[String(n)]) {
          return { src: vv.eps[String(n)], ep: n, videoId: vid };
        }

        // 2) 本剧的播放块 (data-play-id === 剧ID, 且非推广域)
        var own = srcs.filter(function (x) {
          return x.pid === vid && !isPromoUrl(x.src);
        });
        if (own.length) return { src: own[0].src, ep: n, videoId: vid };

        // 3) 本剧其它集的源 (仍属本剧, 只是集号兜底; 剧ID必须对得上)
        if (vv && vv.id === vid && vv.eps) {
          var keys = Object.keys(vv.eps);
          if (keys.length) return { src: vv.eps[keys[0]], ep: n, videoId: vid, fuzzy: true };
        }

        // 旧逻辑的第 3 步"任意 m3u8 兜底"已删除 —— 那是页面上的推荐位/推广位,
        // 取到就会播成"别人的剧 / 官方宣传物料"。
        throw new Error('找不到本剧播放地址');
      });
    },

    /** 探测哪个镜像可用 */
    probe: function () {
      return fetchUpstream('/list/1/').then(function (html) {
        return { ok: true, mirror: ACTIVE, count: parseCards(html).length };
      }).catch(function (e) {
        return { ok: false, error: String(e && e.message || e) };
      });
    },

    mirrors: MIRRORS.slice()
  };

  global.HGDirect = HG;
})(typeof window !== 'undefined' ? window : this);
