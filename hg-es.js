/**
 * 湟果视频 · EROSHORT 数据源 (eroshort.net)
 * ========================================
 * 按 hg-hd.js / hg-mg.js 同款模式封装, 挂到 window.HGEs
 *
 * 站点结构 (2026-10 实测):
 *   前端   React SPA (Vite), 入口 /assets/index-CTzob1E2.js
 *   后端   REST, base = https://eroshort.net/api/v1
 *   封面   Cloudflare R2 公开桶 (pub-ee9ae600699a4a2da06d78a810b73f4d.r2.dev)
 *
 * API 契约 (从 bundle 反解 + 线上实测):
 *   GET  /browse/layouts/short
 *        → {data:{sections:[{slot_key:"short_carousel"|"short_for_you", items:[...]}]}}
 *   GET  /tags?schema=short_video&only_with_content=true
 *        → {categories:[{code,name,tags:[{code,name,usage_count}]}]}
 *   GET  /shorts?page=&page_size=&q=&tag=&sort=
 *        → {data:[...], pagination:{total,limit,offset,has_more}}
 *   GET  /shorts/{id}
 *        → 单部详情 (title/cover/pricing/tags/access_level/view_count/like_count)
 *   GET  /hierarchy/short_video/{id}/children?group_by=false&include_metadata=false
 *        → {children:[{id,title}], root:{...}}   集数列表 (id 即 episode content_id)
 *   GET  /playlines/episode/{epId}
 *        → {data:[{id,source_name,source_kind,source_id,content_id,has_access,episode_index,is_active}]}
 *   GET  /wallet/entitlement/{id}
 *        → {content_id,has_access,access_reason}   access_reason: FREE_CONTENT|LOGIN_REQUIRED|PAYMENT_REQUIRED
 *   POST /playback/resolve  {source_kind,source_id,content_id,build_id}
 *        → {data:{protocol_version,source_kind,delivery,url,mime_type,expires_at,stego?}}
 *
 * 播放交付形态 (delivery):
 *   "direct"    + mime video/mp4              → 直接播
 *   "hls"       + mime application/vnd.apple.mpegurl → 标准 HLS
 *   "stego_hls" + mime application/vnd.apple.mpegurl → PNG 隐写 HLS, 需专用解码器
 *
 * 关键限制:
 *   1. eroshort.net 挂 Cloudflare 人机校验, 直连 /api/* 会被拦
 *      → 前端统一走 Worker /api/es/* 转发, Worker 出口在 CF 白名单内
 *   2. 封面走 R2 公开桶, 无防盗链, 前端可直连
 *   3. 付费内容 (access_level:"pay") 需要登录 + 银币
 *      免费集 (access_reason:"FREE_CONTENT") 可直接解析播放
 */

(function (root) {
  'use strict';

  var ORIGIN = 'https://eroshort.net';
  var PREFIX = '/api/es';            // Worker 转发前缀 (本地由 local_server 模拟)
  var BUILD_ID = 'dcdcc161385053f622cedf86ed610abd33dae3e034af5366a8a76a058baad118';

  // ---------- 分类表 ----------
  // 上游 /tags?schema=short_video 是两层结构:
  //   categories:[ {code:"类型", tags:[{code,name,usage_count}]},
  //                {code:"状态", tags:[...]} ]
  // 这里只保留"类型"那一组 (丢 display_status, 更新中/已完结 前端单独做筛)。
  //
  // 硬编码一份兜底, 同时提供 refreshCats() 从快照/上游刷新 —— 上游标签会变,
  // 别让分类条卡在构建期。
  var CATS = [
    { code: '漫改',     name: '漫改' },
    { code: '群交',     name: '群交' },
    { code: '绿帽ntr',  name: '绿帽NTR' },
    { code: '乱伦',     name: '乱伦' },
    { code: '凌辱调教', name: '凌辱调教' },
    { code: '后宫',     name: '后宫' },
    { code: '巨乳',     name: '巨乳' },
    { code: '复仇',     name: '复仇' },
    { code: '猎奇',     name: '猎奇' },
    { code: '异能',     name: '异能' },
    { code: '职场',     name: '职场' },
    { code: '穿越',     name: '穿越' },
    { code: '校园',     name: '校园' },
    { code: '少妇',     name: '少妇' },
  ];

  /** 把上游两层 tags 结构拍平成一维分类表 (只取"类型"组) */
  function flattenTags(j) {
    var groups = (j && (j.categories || j.data)) || [];
    if (!Array.isArray(groups)) return [];
    var out = [], seen = {};
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (!g || typeof g !== 'object') continue;
      var gname = String(g.code || g.name || '');
      var list = g.tags || [];
      if (!Array.isArray(list)) continue;
      for (var k = 0; k < list.length; k++) {
        var t = list[k];
        if (!t || typeof t !== 'object') continue;
        var code = String(t.code || '');
        var name = String(t.name || code);
        if (!name || seen[name]) continue;
        seen[name] = 1;
        out.push({
          code: code || name,
          name: name,
          group: gname,
          color: t.color || '',
          count: t.usage_count || t.content_count || 0,
        });
      }
    }
    // 只保留"类型"组; 若上游没给组名, 全收
    var typed = out.filter(function (x) { return !x.group || x.group === '类型'; });
    return typed.length ? typed : out;
  }

  // ---------- 工具 ----------
  function enc(s) { return encodeURIComponent(String(s == null ? '' : s)); }

  /** 把 "[sm]xxx[/sm]" 之类的标记剥掉, 并压掉多余空白 */
  function clean(s) {
    if (!s) return '';
    return String(s)
      .replace(/\[\/?sm\]/gi, '')
      .replace(/\[[a-z]{1,6}\]/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 从标题里解出集数进度: "共27/30集" → {done:27,total:30} */
  function epProgress(title) {
    var m = clean(title).match(/共\s*(\d+)\s*\/\s*(\d+)\s*集/);
    if (m) return { done: parseInt(m[1], 10), total: parseInt(m[2], 10) };
    var m2 = clean(title).match(/共\s*(\d+)\s*集/);
    if (m2) return { done: null, total: parseInt(m2[1], 10) };
    return { done: null, total: null };
  }

  /** 从标题里解出"第N集 标题" */
  function epTitle(raw, index) {
    var t = clean(raw);
    var m = t.match(/^第\s*([一二三四五六七八九十百零〇\d]+)\s*集\s*(.*)$/);
    if (m) return { label: '第' + m[1] + '集', title: m[2] || '' };
    return { label: '第' + (index || '?') + '集', title: t };
  }

  function absUrl(u) {
    if (!u) return '';
    u = String(u).replace(/&amp;/g, '&').trim();
    if (/^https?:\/\//i.test(u)) return u;
    if (u.charAt(0) === '/') return ORIGIN + u;
    return u;
  }

  // ---------- 请求层 ----------
  /**
   * 统一走 Worker 转发。eroshort.net 有 CF 校验, 裸 fetch 拿不到东西。
   * 若 Worker 不可达, 由上层 api() 决定是否降级到快照。
   */
  var _token = null;                    // 登录后填 (本模块默认匿名)
  var _timeout = 15000;

  function request(path, opts) {
    opts = opts || {};
    var url = PREFIX + path;
    var ctl = ('AbortController' in root) ? new root.AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, opts.timeout || _timeout);
    var init = {
      method: opts.method || 'GET',
      mode: 'cors',
      credentials: 'omit',
      headers: { 'Accept': 'application/json' },
    };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    if (ctl) init.signal = ctl.signal;

    return fetch(url, init).then(function (r) {
      clearTimeout(timer);
      return r.text().then(function (txt) {
        var j = null;
        try { j = JSON.parse(txt); } catch (e) {}
        if (!r.ok) {
          var code = (j && j.error && j.error.code) || ('HTTP_' + r.status);
          var err = new Error(code);
          err.status = r.status;
          err.payload = j;
          throw err;
        }
        if (j === null) throw new Error('INVALID_RESPONSE');
        return j;
      });
    }).catch(function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  // ---------- 数据映射 ----------
  /**
   * 把 API 的 item 映射成前端卡片结构。
   * 与黄豆/黄果模块保持字段一致: id / title / cover / tags / ep / epLabel / updating / price / access
   */
  function toCard(it) {
    if (!it || !it.id) return null;
    var prog = epProgress(it.title);
    var tags = [];
    if (Array.isArray(it.tags)) {
      it.tags.forEach(function (t) {
        var n = typeof t === 'string' ? t : (t && t.name);
        n = clean(n);
        if (n && tags.indexOf(n) < 0) tags.push(n);
      });
    }
    var cover = it.cover;
    if (cover && typeof cover === 'object') cover = cover.url;
    var pr = it.pricing || {};
    return {
      id: it.id,
      title: clean(it.title),
      desc: clean(it.description),
      cover: absUrl(cover),
      tags: tags.slice(0, 6),
      ep: prog.done != null ? String(prog.done) : '',
      epTotal: prog.total != null ? String(prog.total) : '',
      epLabel: prog.total != null
        ? (prog.done != null ? ('更新至' + prog.done + '集 / 共' + prog.total + '集') : ('共' + prog.total + '集'))
        : '',
      updating: tags.indexOf('更新中') >= 0,
      price: pr.price || 0,
      originalPrice: pr.original_price || 0,
      access: it.access_level || '',
      views: it.view_count || 0,
      likes: it.like_count || 0,
      createdAt: it.created_at || '',
      source: 'es',
    };
  }

  function mapList(raw) {
    if (!Array.isArray(raw)) return [];
    var seen = {}, out = [];
    raw.forEach(function (it) {
      var c = toCard(it);
      if (c && !seen[c.id]) { seen[c.id] = 1; out.push(c); }
    });
    return out;
  }

  // ---------- 对外 API ----------
  var api = {
    ORIGIN: ORIGIN,
    PREFIX: PREFIX,
    BUILD_ID: BUILD_ID,
    CATS: CATS,

    /** 站点健康探测 */
    probe: function () {
      return request('/shorts?page=1&page_size=1', { timeout: 8000 })
        .then(function (j) {
          var n = Array.isArray(j.data) ? j.data.length : 0;
          return { ok: n > 0, count: n, host: ORIGIN };
        })
        .catch(function (e) {
          return { ok: false, error: String(e && e.message || e) };
        });
    },

    /**
     * 首页: 轮播 + 推荐流
     * 返回 { banners:[], featured:[] }
     */
    home: function () {
      return request('/browse/layouts/short').then(function (j) {
        var d = (j && j.data) || {};
        var sections = Array.isArray(d.sections) ? d.sections : [];
        var pick = function (key) {
          var hit = null;
          sections.forEach(function (s) { if (s && s.slot_key === key) hit = s; });
          if (!hit || !Array.isArray(hit.items)) return [];
          return mapList(hit.items.filter(function (x) {
            return !x.schema_code || x.schema_code === 'shorts' || x.schema_code === 'short_video';
          }));
        };
        return {
          ok: true,
          banners: pick('short_carousel'),
          featured: pick('short_for_you'),
          source: 'es',
        };
      });
    },

    /**
     * 列表 / 筛选
     * @param {Object} params {page, pageSize, tag, q, sort}
     *
     * ⚠ pageSize 上限压到 12: 取数要经公共 CORS 中转, 大响应体会被 520/522 截断
     *   (实测 page_size=48 全通道失败, 2~8 稳定 200)。宁可多翻几页。
     */
    list: function (params) {
      params = params || {};
      var page = Math.max(1, parseInt(params.page || 1, 10));
      var size = Math.max(1, Math.min(12, parseInt(params.pageSize || 12, 10)));
      var qs = '?page=' + page + '&page_size=' + size;
      if (params.tag) qs += '&tag=' + enc(params.tag);
      if (params.q) qs += '&q=' + enc(String(params.q).trim());
      if (params.sort) qs += '&sort=' + enc(params.sort);

      return request('/shorts' + qs).then(function (j) {
        var items = mapList(j.data);
        var pg = j.pagination || {};
        var total = typeof pg.total === 'number' ? pg.total : (typeof j.total === 'number' ? j.total : null);
        var hasMore = typeof pg.has_more === 'boolean'
          ? pg.has_more
          : (total != null ? (page * (pg.limit || size) < total) : (items.length === size));
        return { ok: true, items: items, total: total, page: page, pageSize: size, hasMore: hasMore, source: 'es' };
      });
    },

    /** 分类标签表 (静态兜底) */
    categories: function () { return Promise.resolve({ ok: true, items: CATS, source: 'es' }); },

    /**
     * 刷新分类表: 优先上游 /tags, 失败读快照 (由 sync_es.py 产出)。
     * 成功后原地更新 CATS 并返回新表, 供 renderTabs 重绘。
     */
    refreshCats: function () {
      return request('/tags?schema=short_video&only_with_content=true')
        .then(function (j) { return flattenTags(j); })
        .catch(function () {
          return fetch('data/es-cats.json', { cache: 'no-cache' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) { return flattenTags(j); })
            .catch(function () { return []; });
        })
        .then(function (list) {
          if (list && list.length) {
            CATS.length = 0;
            list.forEach(function (x) { CATS.push(x); });
          }
          return { ok: true, items: CATS, source: 'es' };
        });
    },

    /**
     * 详情 + 集数列表
     * 并发取 /shorts/{id} 与 /hierarchy/short_video/{id}/children
     */
    video: function (id) {
      id = enc(id);
      return Promise.all([
        request('/shorts/' + id),
        request('/hierarchy/short_video/' + id + '/children?group_by=false&include_metadata=true'),
      ]).then(function (arr) {
        var meta = toCard(arr[0]) || { id: id, title: '', cover: '' };
        var tree = arr[1] || {};
        var kids = Array.isArray(tree.children) ? tree.children : [];
        var rootTitle = clean((tree.root && tree.root.title) || meta.title);
        // children 是扁平全后代表: collection / season / episode 混排。
        // 只按标题剔 root 不可靠 —— season 节点标题有时与剧名不同, 会被误当第 1 集,
        // 而 /playlines/episode/{seasonId} 返 NOT_FOUND → 点开就播不了。
        function isEp(k) {
          var md = (k && k.metadata) || {};
          if (md.short_structure_type === 'episode') return true;
          if (md.short_structure_type === 'season' || md.short_structure_type === 'collection') return false;
          return !k.child_count;
        }
        var eps = [];
        kids.forEach(function (k) {
          if (!k || !k.id || !isEp(k)) return;
          var t = clean(k.title);
          if (!t || t === rootTitle) return;
          var cv = k.cover;
          cv = (cv && (cv.url || cv)) || '';
          if (/^第\s*[一二三四五六七八九十百零〇\d]+\s*集/.test(t)) {
            var p = epTitle(t, eps.length + 1);
            eps.push({ id: k.id, ep: eps.length + 1, label: p.label, title: p.title, cover: cv, free: null });
          } else if (eps.length === 0) {
            eps.push({ id: k.id, ep: 1, label: '第1集', title: t, cover: cv, free: null });
          } else {
            var p2 = epTitle(t, eps.length + 1);
            eps.push({ id: k.id, ep: eps.length + 1, label: p2.label, title: p2.title || t, cover: cv, free: null });
          }
        });
        meta.epTotal = eps.length;
        meta.epCount = eps.length;
        return { ok: true, meta: meta, eps: eps, source: 'es' };
      });
    },

    /**
     * 单集可播性 + 线路
     * @returns {ok, ep, free, playline, url, format, locked, reason}
     */
    play: function (epId) {
      epId = enc(epId);
      return Promise.all([
        request('/playlines/episode/' + epId),
        request('/wallet/entitlement/' + epId).catch(function () { return null; }),
      ]).then(function (arr) {
        var lines = (arr[0] && arr[0].data) || [];
        var ent = arr[1] || {};
        var act = lines.filter(function (l) { return l && l.is_active !== false; });
        var usable = act.filter(function (l) {
          return l.has_access !== false && l.source_id && l.content_id &&
                 (l.source_kind === 'owned' || l.source_kind === 'external_hls');
        });
        if (!usable.length) {
          var reason = 'no_source';
          var ar = ent.access_reason || '';
          if (ar === 'LOGIN_REQUIRED') reason = 'login_required';
          else if (ar === 'PAYMENT_REQUIRED') reason = 'payment_required';
          else if (ar === 'VIP_REQUIRED') reason = 'vip_required';
          return { ok: false, locked: true, reason: reason, source: 'es' };
        }
        var L = usable[0];
        return {
          ok: true,
          locked: false,
          free: ent.access_reason === 'FREE_CONTENT',
          accessReason: ent.access_reason || '',
          playline: {
            source_kind: L.source_kind,
            source_id: L.source_id,
            content_id: L.content_id,
            episode_name: clean(L.episode_name),
            episode_index: L.episode_index,
          },
          source: 'es',
        };
      });
    },

    /**
     * 解析真实流地址 (POST /playback/resolve)。
     * 返回 {ok, url, format, expiresAt}
     *  format: direct | hls | stego_hls | unsupported
     */
    resolve: function (playline) {
      if (!playline || !playline.source_id) return Promise.reject(new Error('NO_PLAYLINE'));
      return request('/playback/resolve', {
        method: 'POST',
        body: {
          source_kind: playline.source_kind,
          source_id: playline.source_id,
          content_id: playline.content_id,
          build_id: BUILD_ID,
        },
        timeout: 20000,
      }).then(function (j) {
        var R = (j && j.data) || {};
        var url = absUrl(R.url);
        if (!url) return { ok: false, reason: 'unavailable', source: 'es' };
        var expires = R.expires_at ? Date.parse(R.expires_at) : null;
        if (R.delivery === 'stego_hls') {
          return {
            ok: true, url: url, format: 'stego_hls',
            mediaId: R.media_id, assetVersion: R.asset_version,
            license: (R.stego && R.stego.license) || '',
            expiresAt: expires, source: 'es',
          };
        }
        if (R.delivery === 'hls') {
          return { ok: true, url: url, format: 'hls', expiresAt: expires, source: 'es' };
        }
        if (R.delivery === 'direct') {
          return { ok: true, url: url, format: 'direct', expiresAt: expires, source: 'es' };
        }
        return { ok: false, reason: 'unknown_format', delivery: R.delivery, source: 'es' };
      });
    },

    /** 搜索 */
    search: function (kw) {
      kw = String(kw || '').trim();
      if (!kw) return Promise.resolve({ ok: true, items: [], source: 'es' });
      return api.list({ q: kw, pageSize: 12 });
    },

    /** 封面 (R2 公开桶, 无防盗链, 直连即可) */
    cover: function (u) { return absUrl(u); },
  };

  root.HGEs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
