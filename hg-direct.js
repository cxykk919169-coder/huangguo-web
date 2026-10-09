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
    // ---- 当前主站 (site.json origin, 机器人认定) ----
    "https://th10.vchllzwu.cc",
    // ---- 当前真站候补 (vchllzwu.cc 系) ----
    "https://fo3l.vchllzwu.cc",
    "https://vqi6.vchllzwu.cc",
    "https://o092.vchllzwu.cc",
    "https://ale0.vchllzwu.cc",
    "https://s8m5.vchllzwu.cc",
    "https://s1er.vchllzwu.cc",
    "https://z5b68b.vchllzwu.cc",
    "https://bqvspv.vchllzwu.cc",
    "https://nkjl.vchllzwu.cc",
    "https://vir2.vchllzwu.cc",
    "https://e6xyzf.vchllzwu.cc",
    // ---- 地址发布页 (最后兜底: 用于自动发现新域名, 不是数据源) ----
    "https://huangguo9.com",
    "https://huangguo10.com",
    "https://huangguo8.com",
    "https://hgai1.com",
  ];

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
        var list = (cfg.mirrors || []).concat(cfg.publishPages || []);
        var injected = 0;
        // 倒序插入, 保证 site.json 里的顺序不被颠倒
        for (var i = list.length - 1; i >= 0; i--) {
          var u = String(list[i] || '').replace(/\/+$/, '');
          if (!/^https?:\/\//.test(u)) continue;
          if (MIRRORS.indexOf(u) < 0) { MIRRORS.unshift(u); injected++; }
        }
        if (cfg.origin && MIRRORS.indexOf(cfg.origin) > 0) {
          MIRRORS.splice(MIRRORS.indexOf(cfg.origin), 1);
          MIRRORS.unshift(cfg.origin);      // 机器人认定的主站排最前
        }
        if (injected) {
          console.info('[湟果] 已从 site.json 载入 ' + injected + ' 个自动发现的镜像');
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
          // 命中"地址发布页" → 提取真站域名并插到列表最前, 然后继续试下一个
          var host = base.replace(/^https?:\/\//, '');
          if (PUBLISH_HOSTS.indexOf(host) >= 0) {
            var real = extractRealHosts(txt);
            if (real.length) {
              real.reverse().forEach(function (h) {
                var u = 'https://' + h;
                if (MIRRORS.indexOf(u) < 0) MIRRORS.unshift(u);
              });
              markBad(base);   // 发布页不是数据源, 拉黑后再走新域名
              throw new Error('publish-page');
            }
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
        const idm = String(href).match(/\/video\/(\d+)/);
        if (!idm) continue;                               // 无内链的推广位也丢弃
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
          const idm = String(u).match(/\/video\/(\d+)/);
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
      const mid = blk.match(/data-track-id="(\d+)"/) || blk.match(/href="\/video\/(\d+)/);
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
    for (const m of html.matchAll(/<a[^>]*class="hg-category-item"[^>]*href="\/video\/(\d+)\/"[^>]*>([\s\S]*?)<\/a>/g)) {
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
    for (const m of html.matchAll(/hg-search-suggest__hot-item"[^>]*>[\s\S]*?<a[^>]*href="\/video\/(\d+)\/"[^>]*>([^<]*)<\/a>[\s\S]*?__heat[^>]*>([^<]*)</g)) {
      put(m[1], { title: clean(m[2]), heat: clean(m[3]) });
    }
  
    const out = [];
    for (const it of items.values()) {
      if (it.isAd === true) continue;
      if (!it.title) it.title = "鍓ч泦 " + it.id;
      out.push(it);
    }
    return out;
  }
  function parseVideo(html) {
    const m = html.match(/id="videoInitialData"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    let data;
    try { data = JSON.parse(m[1]); } catch (e) { return null; }
    const eps = {};
    for (const [k, v] of Object.entries(data.epPlaySrcs || {})) {
      if (/^\d+$/.test(k) && typeof v === "string" && v.startsWith("http")) eps[k] = v.replace(/&amp;/g, "&");
    }
    // HTML 里的 data-play-src 兜底
    for (const mm of html.matchAll(/data-play-src="([^"]+\.m3u8[^"]*)"/g)) {
      const u = mm[1].replace(/&amp;/g, "&");
      if (!Object.values(eps).includes(u)) { const n = String(Object.keys(eps).length + 1); if (!eps[n]) eps[n] = u; }
    }
    let total = 0;
    for (const mm of html.matchAll(new RegExp("/video/" + data.id + "/ep-(\\d+)/", "g"))) {
      total = Math.max(total, parseInt(mm[1], 10));
    }
    return {
      id: String(data.id || ""),
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

        // 1) 本剧的播放块 (data-play-id === 剧ID)
        var own = srcs.filter(function (x) { return x.pid === vid; });
        if (own.length) return { src: own[0].src, ep: n, videoId: vid };

        // 2) 确认本剧确实有这一集
        var hasEp = new RegExp('data-ep-id="' + n + '"').test(html);

        // 3) 任意 m3u8 兜底
        var m3 = html.match(/data-play-src="([^"]+\.m3u8[^"]*)"/);
        if (m3) {
          return { src: m3[1].replace(/&amp;/g, '&'), ep: n, videoId: vid, fuzzy: !hasEp };
        }

        // 4) 内嵌 JSON 兜底
        var vv = parseVideo(html);
        if (vv && vv.eps) {
          if (vv.eps[String(n)]) return { src: vv.eps[String(n)], ep: n, videoId: vid };
          var keys = Object.keys(vv.eps);
          if (keys.length) return { src: vv.eps[keys[0]], ep: n, videoId: vid, fuzzy: true };
        }
        throw new Error('找不到播放地址');
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
