/**
 * 湟果视频 · 黄豆短剧数据源
 * =============================
 * 黄豆短剧 (hddj) 的公开 API 封装 —— 全部端点实测可用。
 *
 *   Base:  https://hddj.zen-vip.com/api/app
 *
 *   列表    GET /videos?page=1[&category=<slug>][&keyword=x][&sort=heat|latest][&featured=true]
 *   详情    GET /videos/{id}
 *   分类    GET /categories                    (8 顶级 + 子类)
 *   排行    GET /rankings?page=1
 *   求剧    GET /wishes?page=1
 *   播放①   GET /playback?videoId={id}&seq={ep}   → episodeId / lockKind / fullPlayable
 *   播放②   GET /play?episodeId={episodeId}       → playUrl + playbackLines(多线路)
 *   片头提示 GET /player-notice?videoId={id}
 *   线路    GET /distribution                     → apiLines / portalLines
 *
 * 播放链路 (无需登录, lockKind:"none" 时全片可播):
 *   /playback → episodeId → /play?episodeId → managed-media/{uuid}?ticket=...  → video/mp4
 *
 * 挂到 window.HDHd
 */
(function (root) {
  'use strict';

  // API 线路 (会从 /distribution 动态刷新)
  var API_LINES = ['https://hddj.zen-vip.com/api/app'];
  var ACTIVE = null, ACTIVE_AT = 0, TTL = 5 * 60 * 1000;
  var BAD = {}, BAD_TTL = 90 * 1000;

  // 视频流镜像 (managed-media 也能走这些域)
  var MEDIA_HOSTS = ['', 'https://hdv1.zen-vip.com', 'https://hdv2.zen-vip.com',
    'https://hdv4.zen-vip.com', 'https://hdv5.zen-vip.com'];
  var API_HOST = 'https://hddj.zen-vip.com';

  // H5 入口线路
  var H5_LINES = ['https://hddj30.cc'];

  function lineOrder() {
    var now = Date.now();
    var usable = API_LINES.filter(function (u) { return !BAD[u] || BAD[u] < now; });
    if (!usable.length) { BAD = {}; usable = API_LINES.slice(); }
    if (ACTIVE && (now - ACTIVE_AT) < TTL && usable.indexOf(ACTIVE) >= 0) {
      return [ACTIVE].concat(usable.filter(function (u) { return u !== ACTIVE; }));
    }
    return usable;
  }

  function markBad(u) { BAD[u] = Date.now() + BAD_TTL; if (ACTIVE === u) ACTIVE = null; }

  /** 带线路切换的 GET */
  function apiGet(path, timeoutMs) {
    var order = lineOrder(), i = 0, tmo = timeoutMs || 9000;

    function tryNext(lastErr) {
      if (i >= order.length) return Promise.reject(lastErr || new Error('全部线路不可用'));
      var base = order[i++];
      var ctl = ('AbortController' in root) ? new root.AbortController() : null;
      var timer = setTimeout(function () { if (ctl) ctl.abort(); }, tmo);
      var opts = { method: 'GET', headers: { 'Accept': 'application/json' }, mode: 'cors', credentials: 'omit' };
      if (ctl) opts.signal = ctl.signal;
      return fetch(base + path, opts).then(function (r) {
        clearTimeout(timer);
        if (!r.ok) {
          // 404 是"地址不对", 换线路也没用, 但可能是路由不同 —— 先换
          markBad(base);
          throw new Error('HTTP ' + r.status);
        }
        return r.json();
      }).then(function (j) {
        if (!j || j.ok !== true) {
          // ok:false 是业务应答, 不换线路
          if (j && j.ok === false && j.message) { ACTIVE = base; ACTIVE_AT = Date.now(); throw new Error(j.message); }
          markBad(base);
          throw new Error('返回异常');
        }
        ACTIVE = base; ACTIVE_AT = Date.now(); delete BAD[base];
        return j;
      }).catch(function (e) {
        clearTimeout(timer);
        if (/不存在|未配置|尚未/.test(String(e.message))) throw e;
        markBad(base);
        return tryNext(e);
      });
    }
    return tryNext(null);
  }

  // ---------- 数据规整 ----------

  function toCard(v) {
    if (!v) return null;
    var cat = v.category || {};
    var acc = v.accessSummary || {};
    return {
      id: String(v.id),
      title: v.title || '',
      cover: v.cover || '',
      desc: v.description || '',
      ep: v.episodeCount ? String(v.episodeCount) : '',
      epTotal: v.episodeCount || 0,
      remarks: v.remarks || '',
      heat: v.heat || '',
      heatNum: parseInt(v.heat, 10) || 0,
      tags: String(v.tags || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      year: v.year || 0,
      isEnded: !!v.isEnded,
      badge: v.badge || '',
      featured: !!v.featured,
      updatedAt: v.updatedAt || '',
      cat: cat.name || '',
      catSlug: cat.slug || '',
      catId: cat.id || 0,
      free: acc.free || 0,
      vip: acc.vip || 0,
      coin: acc.coin || 0,
      aspect: (cat.aspects === 'tall' || !cat.aspects) ? 'tall' : String(cat.aspects),
      src: 'hd',
    };
  }

  function toCards(items) { return (items || []).map(toCard).filter(Boolean); }

  /** 统一分页应答 */
  function normList(j, page) {
    return {
      items: toCards(j.items),
      total: j.total || 0,
      hasMore: j.hasMore !== false && (j.items || []).length > 0,
      page: page || 1,
    };
  }

  // ---------- 对外接口 ----------

  /**
   * 列表
   * @param {{page?:number, cat?:string, keyword?:string, sort?:string, featured?:boolean}} o
   *   cat 传 slug (如 'magic-picked'), 不是 id
   */
  function list(o) {
    o = o || {};
    var qs = ['page=' + (o.page || 1)];
    if (o.cat) qs.push('category=' + encodeURIComponent(o.cat));
    if (o.keyword) qs.push('keyword=' + encodeURIComponent(o.keyword));
    if (o.sort) qs.push('sort=' + encodeURIComponent(o.sort));
    if (o.featured) qs.push('featured=true');
    return apiGet('/videos?' + qs.join('&')).then(function (j) { return normList(j, o.page); });
  }

  function search(kw, page) { return list({ keyword: kw, page: page || 1 }); }
  function heat(page) { return list({ sort: 'heat', page: page || 1 }); }
  function featured() { return list({ featured: true, page: 1 }); }

  /** 详情 */
  function video(id) {
    return apiGet('/videos/' + encodeURIComponent(id)).then(function (j) {
      var v = j.item || j;
      var card = toCard(v);
      if (!card) throw new Error('剧集数据异常');
      card.h5 = h5Url(v.id);
      card.raw = v;
      return card;
    });
  }

  /** 分类树 —— 保留 slug (筛选要用它) */
  function categories() {
    return apiGet('/categories').then(function (j) {
      var all = j.items || [];
      var tops = all.filter(function (c) { return !c.parentId; });
      return tops.map(function (t) {
        return {
          id: t.id,
          slug: t.slug,
          name: t.name,
          children: all.filter(function (c) { return c.parentId === t.id; })
            .map(function (c) { return { id: c.id, slug: c.slug, name: c.name }; }),
        };
      });
    });
  }

  function rankings(page) {
    return apiGet('/rankings?page=' + (page || 1)).then(function (j) { return normList(j, page); });
  }

  function wishes(page) {
    return apiGet('/wishes?page=' + (page || 1)).then(function (j) {
      return { items: j.items || [], total: j.total || 0, page: page || 1 };
    });
  }

  function playerNotice(id) {
    return apiGet('/player-notice?videoId=' + encodeURIComponent(id)).then(function (j) {
      return (j.item && j.item.enabled) ? j.item : null;
    }).catch(function () { return null; });
  }

  // ---------- 播放链路 ----------

  /**
   * 取剧集播放信息 (第 1 步)
   * @returns {Promise<{episodeId,lockKind,coinCost,fullPlayable,title,cover}>}
   */
  function episode(videoId, seq) {
    return apiGet('/playback?videoId=' + encodeURIComponent(videoId) + '&seq=' + encodeURIComponent(seq))
      .then(function (j) {
        var it = j.item;
        if (!it || !it.episodeId) throw new Error('该集未找到');
        return it;
      });
  }

  /**
   * 取播放地址 (第 2 步)
   * @returns {Promise<{playUrl,lines:[{id,label,url}]}>}
   */
  function play(episodeId) {
    return apiGet('/play?episodeId=' + encodeURIComponent(episodeId)).then(function (j) {
      var raw = j.playbackLines || [];
      var lines = raw.filter(function (L) { return L && L.playUrl; }).map(function (L) {
        return { id: L.id || 'default', label: L.label || '线路', url: abs(L.playUrl) };
      });
      var main = abs(j.playUrl || '');
      // 主线路排第一 (保持 service worker / 缓存友好)
      if (main) {
        lines = [{ id: 'default', label: lines[0] ? lines[0].label : '线路1', url: main }]
          .concat(lines.filter(function (L) { return L.url !== main; }));
      }
      if (!lines.length) throw new Error(j.message || '没有可用播放地址');
      return { playUrl: main || lines[0].url, lines: lines, raw: j };
    });
  }

  /**
   * 一步到位: 拿某一集的播放地址
   * @param {string|number} videoId
   * @param {string|number} seq  第几集
   */
  function playEp(videoId, seq) {
    return episode(videoId, seq).then(function (info) {
      if (info.lockKind && info.lockKind !== 'none' && !info.fullPlayable) {
        var e = new Error('该集需要解锁（' + (info.lockKind === 'coin' ? info.coinCost + ' 金币' : '会员') + '）');
        e.locked = true; e.info = info;
        throw e;
      }
      return play(info.episodeId).then(function (p) {
        p.info = info;
        p.seq = String(seq);
        return p;
      });
    });
  }

  /** 相对路径补全域名 */
  function abs(u) {
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    return API_HOST + (u[0] === '/' ? u : '/' + u);
  }

  /** 线路 */
  function distribution() {
    return apiGet('/distribution').then(function (j) {
      var item = j.item || {};
      var apis = (item.apiLines || []).filter(function (l) { return l.enabled; })
        .map(function (l) { return l.url; }).filter(Boolean);
      var h5s = (item.portalLines || [])
        .filter(function (l) { return l.enabled && l.kind === 'h5'; })
        .map(function (l) { return l.url; }).filter(Boolean);
      if (apis.length) API_LINES = apis.concat(API_LINES).filter(function (v, i, a) { return a.indexOf(v) === i; });
      if (h5s.length) H5_LINES = h5s;
      return { apiLines: API_LINES.slice(), h5Lines: H5_LINES.slice() };
    });
  }

  function probe() {
    return apiGet('/videos?page=1', 7000).then(function (j) {
      var n = (j.items || []).length;
      if (!n) throw new Error('列表为空');
      return { ok: true, count: n, total: j.total || 0 };
    });
  }

  function h5Url(id) {
    var base = (H5_LINES[0] || 'https://hddj30.cc').replace(/\/+$/, '');
    return base + '/h5/#/pages/drama/detail/index?id=' + encodeURIComponent(id);
  }

  root.HDHd = {
    name: '黄豆短剧',
    list: list,
    search: search,
    heat: heat,
    featured: featured,
    video: video,
    categories: categories,
    rankings: rankings,
    wishes: wishes,
    playerNotice: playerNotice,
    episode: episode,
    play: play,
    playEp: playEp,
    distribution: distribution,
    probe: probe,
    h5Url: h5Url,
    abs: abs,
    toCard: toCard,
    get apiLines() { return API_LINES.slice(); },
    get h5Lines() { return H5_LINES.slice(); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
