/**
 * 湟果视频 · 荔枝短剧数据源 (lz-dj.com / liz01.com)
 * =====================================================
 * 按 hg-es.js / hg-hd.js 同款模式封装, 挂到 window.HGLz
 *
 * 站点结构 (2026-10-19 实测):
 *   前端   Nuxt 3 + Vite SSR, 入口 lz-dj.com, 接口 liz01.com, 前缀 /api/v1
 *   CDN    CloudFront (站点) + videos.aifukuri.com (分片, S3 预签名)
 *   封面   www.huangguaai07.com, **AES-128-CBC 加密**, 参数明文写在首页
 *
 * API 契约 (从首页 __NUXT__.config 反解 + 线上实测):
 *   GET /api/v1/category/tree
 *        → {success,data:[{id,categoryName,slug,children:[...]}]}
 *   GET /api/v1/category/filters?page=
 *        → {data:{channels:[{id,name,categories:[...]}]}}
 *   GET /api/v1/drama/list?page=&keyword=&categoryId=&channelId=
 *        → {data:{page:{items:[...],total,hasMore}}}
 *   GET /api/v1/drama/{id}
 *        → 单部详情
 *   GET /api/v1/drama/{id}/episodes
 *        → data:[{epNo,available,episodeId,title,durationSeconds,locked,preview}]
 *   GET /api/v1/drama/{id}/ep/{epNo}
 *        → data:{playbackUrl,durationSeconds,episodeId,...}
 *   GET /api/v1/search/suggest?keyword=
 *        → data:{keywords:[],tags:[]}
 *
 * ★ 全免费
 *   抽查 6 部, locked 恒为 false, 42 集里 40 集能直接拿到 playbackUrl
 *   (另 2 集是上游自己缺源, 不是付费墙)。没有登录要求, 没有金币, 没有 VIP。
 *
 * ★ 播放链
 *   playbackUrl = /api/v1/cdn/video/{vid}/manifest.m3u8?t=&sign=
 *   - sign 必须带 (去掉即 403), 但每集都会免费发一个, 不是门槛
 *   - 清单里的分片是 S3 预签名 URL (AWS4-HMAC-SHA256, 有效期 7 天) → 直连
 *   - AES-128 密钥在 media.lizdj009.com/hls/key/{vid}?token= (JWT) → 直连
 *   所以只需代理清单, 分片与密钥交给浏览器, 与 2048/漫剧同一策略。
 *
 * ★ 封面加密
 *   上游 coverUrl 裸取是 application/octet-stream, 首字节不是图片魔数。
 *   首页 __NUXT__.config.public 里明文写着:
 *     imageAesKeyHex = ea19c21e85d768da4165f5964ab886b2
 *     imageAesIvHex  = f4d53ecbc273901e0d9cd7848233c702
 *   AES-128-CBC 解一次即得 JPEG。浏览器端不自己解 —— 交给 Worker /api/lz/img,
 *   WebCrypto 在 Worker 里跑, 前端只管 <img src>。
 */

(function (root) {
  'use strict';

  var ORIGIN = 'https://lz-dj.com';   // 前端站 (只用于 Referer / 文档)
  var API = 'https://liz01.com/api/v1';
  var PREFIX = '/api/lz';             // Worker 转发前缀

  // 兜底分类: 上游 /category/tree 拿不到时用这份 (2026-10-19 抓取)
  var CATS = [
    { id: '31', name: '荔枝原创', slug: 'lizhi-original' },
    { id: '32', name: '荔枝精选', slug: 'lizhi-jingxuan' },
  ];

  // ---------- 取数 ----------
  /* ★ 2026-10-19: API 基址必须按「页面在哪」来定。
   *
   *   翻过的车: 原来 base() 一律返回相对路径 "/api/lz", 在 Worker 域名下
   *   (huangguo-web.*.workers.dev/lz/) 没问题 —— 同源。但页面同时也发到
   *   GitHub Pages (cxykk919169-coder.github.io/huangguo-web/lz.html),
   *   那里**没有 Worker**, 相对路径会打到 github.io/api/lz/... → 404,
   *   页面能打开但列表空白、点开没内容, 就是"看不了"。
   *
   *   所以: 同源能用就用同源 (Worker 域名 / 本地 dev), 否则退回 Worker 绝对地址。
   *   判断方式不写死域名 —— 探测一下 Host 更稳, 本地/file 也一样成立。
   */
  var WORKER = 'https://huangguo-web.cxykk919169.workers.dev';

  function onWorkerHost() {
    try {
      var h = (typeof location !== 'undefined' && location.hostname) || '';
      // Worker 域名 / 本地开发 / 容器 IP 都算"自己能代理"
      return /workers\.dev$/i.test(h) ||
             /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i.test(h) ||
             /^192\.168\./i.test(h) || /^10\./i.test(h);
    } catch (e) { return false; }
  }

  function base() {
    // 手动覆盖优先 (调试用)
    if (typeof window !== 'undefined' && window.HG_API_BASE) return window.HG_API_BASE + PREFIX;
    // 在 Worker 自己域名下 → 同源相对路径
    if (onWorkerHost()) return PREFIX;
    // 在 GitHub Pages 或别处 → 走 Worker 绝对地址
    return WORKER + PREFIX;
  }

  function request(path, opts) {
    opts = opts || {};
    var url = base() + path;
    var ctl = null;
    var timer = null;
    var init = { method: opts.method || 'GET', headers: {} };
    if (typeof AbortController !== 'undefined') {
      ctl = new AbortController();
      init.signal = ctl.signal;
      timer = setTimeout(function () { ctl.abort(); }, opts.timeout || 15000);
    }
    return fetch(url, init).then(function (r) {
      if (timer) clearTimeout(timer);
      return r.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { j = null; }
        if (!j) throw new Error('非 JSON 响应 (' + r.status + ')');
        if (j.ok === false) throw new Error(j.error || '上游错误');
        return j;
      });
    }, function (e) {
      if (timer) clearTimeout(timer);
      throw e;
    });
  }

  // ---------- 归一化 ----------
  // Worker 已经吐扁平结构了, 这里只做兜底, 保证前端字段永远齐全。
  /* ★ 封面地址补全: Worker 返回的是 "/api/lz/img?..."
   *   同源页面直接用没问题, 但在 GitHub Pages 上会变成 github.io/api/lz/img → 404。
   *   这里统一过一遍 abs()。 */
  function abs(u) {
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (u.charAt(0) !== '/') return u;
    var bs = base();
    if (/^https?:\/\//i.test(bs)) return bs.replace(PREFIX, '') + u;
    return (typeof location !== 'undefined' ? location.origin : '') + u;
  }

  function mapCard(x) {
    if (!x) return null;
    return {
      id: String(x.id || ''),
      title: x.title || '',
      cover: abs(x.cover || ''),
      desc: x.desc || '',
      ep: x.epCount ? ('更新至' + x.epCount + '集') : (x.epTotal ? ('全' + x.epTotal + '集') : ''),
      epCount: Number(x.epCount) || 0,
      epTotal: Number(x.epTotal) || 0,
      tags: Array.isArray(x.tags) ? x.tags : [],
      views: x.views || '',
      hot: Number(x.hot) || 0,
      score: Number(x.score) || 0,
      likes: Number(x.likes) || 0,
      at: x.at || '',
      source: 'lz',
    };
  }

  function mapList(arr) {
    var out = [];
    (arr || []).forEach(function (x) {
      var c = mapCard(x);
      if (c && c.id) out.push(c);
    });
    return out;
  }

  // ---------- 对外 API ----------
  var api = {
    ORIGIN: ORIGIN,
    API: API,
    PREFIX: PREFIX,
    CATS: CATS,

    /** 站点健康探测 */
    probe: function () {
      return request('/list?page=1', { timeout: 10000 })
        .then(function (j) {
          var n = Array.isArray(j.items) ? j.items.length : 0;
          return { ok: n > 0, count: n, host: ORIGIN };
        })
        .catch(function (e) {
          return { ok: false, error: String((e && e.message) || e) };
        });
    },

    /**
     * 列表 / 筛选
     * @param {Object} p {page, cat, channel, keyword}
     */
    list: function (p) {
      p = p || {};
      var qs = ['page=' + (p.page || 1)];
      if (p.cat) qs.push('cat=' + encodeURIComponent(p.cat));
      if (p.channel) qs.push('channel=' + encodeURIComponent(p.channel));
      if (p.keyword) qs.push('keyword=' + encodeURIComponent(p.keyword));
      return request('/list?' + qs.join('&')).then(function (j) {
        var items = mapList(j.items);
        return {
          ok: true,
          items: items,
          total: Number(j.total) || items.length,
          page: Number(j.page) || p.page || 1,
          hasMore: !!j.hasMore,
          source: 'lz',
        };
      });
    },

    /** 分类树 → 前端统一的扁平标签数组 */
    cats: function () {
      return request('/tree', { timeout: 12000 }).then(function (j) {
        var list = Array.isArray(j.data) ? j.data : (Array.isArray(j.categories) ? j.categories : []);
        var flat = [];
        list.forEach(function (lv1) {
          (lv1.children || []).forEach(function (lv2) {
            flat.push({ code: String(lv2.id), name: lv2.name, group: lv1.name });
            (lv2.children || []).forEach(function (lv3) {
              flat.push({ code: String(lv3.id), name: lv3.name, group: lv1.name + ' · ' + lv2.name });
            });
          });
        });
        if (!flat.length) {
          CATS.forEach(function (c) { flat.push({ code: c.id, name: c.name, group: '' }); });
        }
        return flat;
      }).catch(function () {
        return CATS.map(function (c) { return { code: c.id, name: c.name, group: '' }; });
      });
    },

    /**
     * 详情: 剧信息 + 集列表
     */
    detail: function (id) {
      return request('/detail?id=' + encodeURIComponent(id)).then(function (j) {
        var eps = (j.eps || []).map(function (e) {
          return {
            ep: Number(e.ep) || 0,
            id: String(e.id || ''),
            title: e.title || ('第' + e.ep + '集'),
            dur: Number(e.dur) || 0,
            locked: !!e.locked,
            preview: !!e.preview,
            available: e.available !== false,
          };
        });
        return {
          ok: true,
          id: String(j.id || id),
          title: j.title || '',
          slug: j.slug || '',
          desc: j.desc || '',
          cover: abs(j.cover || ''),
          coverRaw: j.coverRaw || '',
          tags: Array.isArray(j.tags) ? j.tags : [],
          cate: j.cate || '',
          epTotal: Number(j.epTotal) || eps.length,
          epPublished: Number(j.epPublished) || eps.length,
          views: j.views || '',
          likes: Number(j.likes) || 0,
          freePreviewEps: Number(j.freePreviewEps) || 0,
          eps: eps,
          // 有任意一集没锁 → 这个板块就能整部看
          allFree: eps.every(function (e) { return !e.locked; }),
          source: 'lz',
        };
      });
    },

    /**
     * 播放: 拿本站清单代理地址
     * @param {String} id  剧 id
     * @param {Number} ep  集号 (从 1 开始)
     */
    play: function (id, ep) {
      return request('/play?id=' + encodeURIComponent(id) + '&ep=' + (ep || 1), { timeout: 18000 })
        .then(function (j) {
          if (!j.ok || !j.url) {
            return { ok: false, locked: !!j.locked, reason: j.reason || 'no_source', source: 'lz' };
          }
          /* Worker 回的是相对路径 (/api/lz/media?...)。
           * ★ 这里不能拼 location.origin —— 页面在 GitHub Pages 上时那样会拼成
           *   github.io/api/lz/media, 照样 404。要拼的是**实际用的 API 基址**。 */
          var u = j.url;
          if (u.charAt(0) === '/') {
            var bs = base();                       // 已是绝对地址或 /api/lz
            if (/^https?:\/\//i.test(bs)) {
              u = bs.replace(PREFIX, '') + u;
            } else if (typeof location !== 'undefined') {
              u = location.origin + u;
            }
          }
          return {
            ok: true,
            locked: false,
            url: u,
            raw: j.raw || '',
            ep: Number(j.ep) || (ep || 1),
            duration: Number(j.duration) || 0,
            title: j.title || '',
            epid: j.epid || '',
            format: 'hls',
            source: 'lz',
          };
        });
    },

    /** 搜索建议 */
    suggest: function (kw) {
      if (!kw) return Promise.resolve({ keywords: [], tags: [] });
      return request('/suggest?keyword=' + encodeURIComponent(kw), { timeout: 10000 })
        .then(function (j) {
          return { keywords: j.keywords || [], tags: j.tags || [] };
        })
        .catch(function () {
          return { keywords: [], tags: [] };
        });
    },

    /** 封面代理地址 (Worker 会解密) */
    cover: function (rawUrl) {
      if (!rawUrl) return '';
      return base() + '/img?u=' + encodeURIComponent(rawUrl);
    },
  };

  root.HGLz = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
