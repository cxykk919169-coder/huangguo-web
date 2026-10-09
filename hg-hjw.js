/* ============================================================================
 * 海角网 (hjw01.com) 前端直连模块
 * ============================================================================
 *
 * 【为什么海角能直连】
 *   - 站点发 Access-Control-Allow-Origin: *        → 浏览器 fetch 不拦
 *   - 详情页 data-config 里 **明文** 写着 video.url  → 不需要解密
 *   - 视频帖无需登录 / 无需金币                     → 第 1 集就能播
 *   （对比芒果: 不发 CORS + 带 Origin 就 403 + 金币校验在服务端）
 *
 * 【页面结构】
 *   列表页  每张卡: <a href="/archives/194846/">
 *                      <div class="img"><img z-image-loader-url="封面"></div>
 *                      <div class="text"><h3>标题</h3></div>
 *                      <div class="flex"><div class="time">2026-09-09</div>
 *                                   <div class="play">16评论</div></div>
 *                   </a>
 *   详情页  <div data-video_type_id="21923" data-video_type_name="海角乱伦"
 *                data-video_tag_key="20062,20265" data-video_tag_name="人妻,家庭乱伦"
 *                data-config='{"video":{"url":"https://hls.xxx/yyy.m3u8?auth_key=..",
 *                                "type":"hls"},"video_h265":{"url":".."}}'>
 *
 * 【付费墙实况】（2026-10 实测）
 *   GOLD_PAYMENT_ENABLED = true —— 金币体系存在, 但只作用于
 *   **图文帖作者自设的"隐藏可见"段落**。视频帖正文 + m3u8 全明文。
 *   站点自己在 schema.org 里写着 "isAccessibleForFree": true。
 *
 * 【鉴权】
 *   无。不需要 token / cookie / 登录。
 *   m3u8 带 auth_key=<到期时间戳>-<随机>-0-<签名>, 每次访问详情页重新签发,
 *   所以**每次播放都要重新拉一次详情页**取新 m3u8（不能缓存死链）。
 * ============================================================================ */
(function (win) {
  'use strict';

  var HJW = {};

  /* ---------------------------------------------------------------- 配置 */

  // 主站 + 备用入口。站点域名常换, 按顺序探活。
  HJW.HOSTS = [
    'https://www.hjw01.com',
    'https://hjw01.com',
    'https://hjw1.com'
  ];

  // 实测可用的活域（运行时被 buildHostList 覆盖）
  HJW.ALIVE = null;

  // m3u8 / 图片必须走 Worker 代理: CDN 域 (hls.*, mts.*, tx.*) 不保证发 CORS 头
  HJW.PROXY = null;   // 由外部注入 worker 地址

  /* ------------------------------------------------------------- 小工具 */

  function abs(u, base) {
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (u.charAt(0) === '/') return base + u;
    return base + '/' + u;
  }

  function unesc(s) {
    return String(s || '')
      .replace(/\\u002F/g, '/')
      .replace(/\\\//g, '/')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }

  /**
   * 清洗图片地址。
   * 站点的新模板把 URL 包在反引号里:
   *   z-image-loader-url="`https://pic.wlwvch.cn/....jpeg`"
   * 不剥掉反引号, 浏览器会把 ` 当成路径的一部分 → 图片 404。
   * 另外还要去掉首尾空白和可能的成对引号。
   */
  function cleanImgUrl(u) {
    u = unesc(u || '').trim();
    u = u.replace(/^[`'"\s]+/, '').replace(/[`'"\s]+$/, '');
    return u;
  }

  function stripTags(s) {
    return String(s || '').replace(/<[^>]*>/g, '').trim();
  }

  /** 从一段 HTML 里抠某个 class 的 div 内容尾巴 */
  function afterClass(html, cls, len) {
    var i = html.indexOf(cls);
    if (i < 0) return '';
    return html.slice(i, i + (len || 600));
  }

  /* --------------------------------------------------------------- 探活 */

  /** 依次试 HJW.HOSTS, 返回第一个 200 的。结果缓存。 */
  HJW.pickHost = function () {
    if (HJW.ALIVE) return Promise.resolve(HJW.ALIVE);
    var i = 0;
    function next() {
      if (i >= HJW.HOSTS.length) return Promise.reject(new Error('海角所有入口都不可达'));
      var h = HJW.HOSTS[i++];
      return fetch(h + '/', { cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text().then(function () { HJW.ALIVE = h; return h; });
        })
        .catch(next);
    }
    return next();
  };

  /* ----------------------------------------------------------- 页面抓取 */

  /** 抓 HTML —— 先试直连, 失败走 Worker 代理 */
  function getHTML(url) {
    return fetch(url, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .catch(function () {
        if (!HJW.PROXY) throw new Error('直连失败且无代理');
        return fetch(HJW.PROXY + '/proxy/' + encodeURIComponent(url))
          .then(function (r) {
            if (!r.ok) throw new Error('proxy HTTP ' + r.status);
            return r.text();
          });
      });
  }

  /* ------------------------------------------------------------- 列表页 */

  /**
   * 解析列表页。返回 [{ id, title, cover, date, reply, url }]
   *
   * 首页混用 **两套卡片模板**:
   *
   *  A) 老模板 (div.list, 带日期/评论)
   *       <div class="list"><a href="/archives/193379/">
   *         <div class="img"><img z-image-loader-url="https://..."></div>
   *         <div class="text"><h3>标题</h3></div>
   *         <div class="flex"><div class="time">2026-09-09</div>
   *                          <div class="play">10评论</div></div>
   *       </a></div>
   *
   *  B) 新模板 (无日期, 封面 URL 被反引号包住)
   *       <a href="/archives/194924/" title="标题">
   *         <div class="xqbj-list-rows-image-title ..."><h3>标题</h3></div>
   *         <div class="xqbj-list-rows-placard-item">
   *           <img z-image-loader-url="`https://...`" alt="标题...">
   *         </div>
   *       </a>
   *
   * 还有 C) 侧栏纯文字链接 —— 无封面, 不收。
   */
  HJW.parseList = function (html, base) {
    var out = [], seen = {}, m;

    var re = /<a\s+href="\/archives\/(\d+)\/?"([^>]*)>([\s\S]{0,1800}?)<\/a>/gi;
    while ((m = re.exec(html))) {
      var id = m[1], attrs = m[2], blk = m[3];
      if (seen[id]) continue;
      if (!/<img/i.test(blk)) continue;   // 没封面 → 侧栏链接, 跳过

      // 封面 (反引号清洗)
      var cm = blk.match(/z-image-loader-url="([^"]*)"/i)
        || blk.match(/data-src="([^"]*)"/i)
        || blk.match(/<img[^>]+src="([^"]*)"/i);
      var cover = cm ? cleanImgUrl(cm[1]) : '';
      if (!cover || !/^https?:\/\//i.test(cover)) continue;

      // 标题: h3 优先, 再退到 <a title="">, 再退到 alt
      var tm = blk.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
      var title = tm ? stripTags(tm[1]) : '';
      if (!title) {
        var am = attrs.match(/title="([^"]*)"/i);
        if (am) title = unesc(am[1]).trim();
      }
      if (!title) {
        var alt = blk.match(/alt="([^"]*)"/i);
        if (alt) title = unesc(alt[1]).replace(/\.\.\.$/, '').trim();
      }
      if (!title) continue;

      // 日期 / 评论 (老模板才有)
      var dm = blk.match(/class="time"[^>]*>\s*([^<]+?)\s*</i);
      var pm = blk.match(/class="play"[^>]*>\s*([^<]+?)\s*</i);

      seen[id] = 1;
      out.push({
        id: id, title: title, cover: cover,
        date: dm ? dm[1].trim() : '',
        reply: pm ? pm[1].trim() : '',
        url: (base || '') + '/archives/' + id + '/'
      });
    }
    return out;
  };

  /** 首页 / 分页列表 */
  HJW.list = function (params) {
    var page = parseInt((params && params.page) || '1', 10) || 1;
    return HJW.pickHost().then(function (h) {
      var url = page <= 1 ? h + '/' : h + '/page/' + page + '/';
      return getHTML(url).then(function (html) {
        var items = HJW.parseList(html, h);
        // 分类导航也一起抽出来（首次调用才用得上）
        var cats = HJW.parseCats(html, h);
        return {
          ok: true, source: 'hjw', page: page,
          items: items, total: items.length, categories: cats,
          hasMore: items.length > 0
        };
      });
    });
  };

  /** 抽分类导航 (href="/category/xxx/") */
  HJW.parseCats = function (html, base) {
    var out = [], seen = {};
    var re = /<a[^>]+href="\/category\/([a-z0-9_\-]+)\/?"[^>]*>([\s\S]{0,80}?)<\/a>/gi;
    var m;
    while ((m = re.exec(html))) {
      var slug = m[1];
      var name = stripTags(m[2]);
      if (!name || seen[slug]) continue;
      // 过滤掉明显不是分类名的
      if (name.length > 12) continue;
      seen[slug] = 1;
      out.push({ slug: slug, name: name, url: (base || '') + '/category/' + slug + '/' });
    }
    return out;
  };

  /** 分类列表 */
  HJW.cat = function (params) {
    var slug = (params && params.slug) || '';
    var page = parseInt((params && params.page) || '1', 10) || 1;
    if (!slug) return HJW.list(params);
    return HJW.pickHost().then(function (h) {
      var url = h + '/category/' + slug + '/' + (page > 1 ? 'page/' + page + '/' : '');
      return getHTML(url).then(function (html) {
        var items = HJW.parseList(html, h);
        return { ok: true, source: 'hjw', slug: slug, page: page,
                 items: items, total: items.length, hasMore: items.length > 0 };
      });
    });
  };

  /* ------------------------------------------------------------- 详情页 */

  /**
   * 解析详情页。返回:
   *   { id, title, cover, m3u8, m3u8_h265, catId, catName, tags, tagsName,
   *     author, date, isVideo, payGated }
   *
   * m3u8 直接来自 data-config 的 video.url —— 明文, 无需解密。
   */
  HJW.parseDetail = function (html, id, base) {
    var d = {
      id: id, title: '', cover: '', m3u8: '', m3u8_h265: '',
      catId: '', catName: '', tags: [], tagsName: [], tagsKey: [],
      author: '', date: '', views: '', isVideo: false, payGated: false,
      // ---- 图文帖正文 ----
      artHtml: '', artText: '', images: [], imageCount: 0,
      source: 'hjw'
    };

    var m;
    m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (m) d.title = m[1].replace(/\s*\|\s*海角网\s*$/, '').trim();

    m = html.match(/data-video_type_id="([^"]*)"/i);    if (m) d.catId = m[1];
    m = html.match(/data-video_type_name="([^"]*)"/i);  if (m) d.catName = m[1];

    // 站方给了两套标签:
    //   data-video_tag_key  = 纯数字 ID (20062,20265...) —— 不是给人看的
    //   data-video_tag_name = 可读文本 (人妻,家庭乱伦...,) —— 展示用这个
    // 界面上 tags 一律是可读文本, 数字 ID 存到 tagsKey 备用。
    var tagKeys = [];
    m = html.match(/data-video_tag_key="([^"]*)"/i);
    if (m && m[1]) tagKeys = m[1].split(',').filter(Boolean);
    m = html.match(/data-video_tag_name="([^"]*)"/i);
    if (m && m[1]) d.tags = m[1].split(',').map(function (s) {
      return unesc(s).trim();
    }).filter(Boolean);
    d.tagsKey = tagKeys;

    // 图文帖没有 data-video_tag_name (那是播放器属性), 用 meta keywords 兜底 ——
    // 实测视频/图文两类页面都带 keywords, 是唯一通用标签源。
    if (!d.tags.length) {
      m = html.match(/<meta[^>]+name="keywords"[^>]+content="([^"]*)"/i);
      if (m && m[1]) {
        d.tags = m[1].split(',')
          .map(function (s) { return unesc(s).trim(); })
          .filter(function (s) {
            return s && s.length <= 20 && !/^[a-z0-9_\-.]{1,10}$/i.test(s);
          })
          .slice(0, 8);
      }
    }
    // 兜底 2: 万一 name 字段也没有, 用数字 key 撑住长度 (至少不为空)
    if (!d.tags.length && tagKeys.length) d.tags = tagKeys.slice();
    d.tagsName = d.tags.slice();

    // ---- 核心: data-config 里的明文 m3u8 ----
    var cfgs = html.match(/data-config='([^']+)'/gi)
      || html.match(/data-config="([^"]+)"/gi) || [];
    for (var i = 0; i < cfgs.length; i++) {
      var raw = unesc(cfgs[i].replace(/^data-config=['"]/i, '').replace(/['"]$/, ''));
      var j = null;
      try { j = JSON.parse(raw); } catch (e) { continue; }
      var v = j.video || {};
      if (v.url) {
        d.m3u8 = v.url;
        if (v.pic) d.cover = v.pic;
        if (j.video_h265 && j.video_h265.url) d.m3u8_h265 = j.video_h265.url;
        break;
      }
    }

    // ---- 兜底: 页面里裸的 m3u8 ----
    if (!d.m3u8) {
      m = html.match(/(https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*)/i);
      if (m) d.m3u8 = unesc(m[1]);
    }

    // ---- 封面兜底 ----
    if (!d.cover) {
      m = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)
        || html.match(/z-image-loader-url="(https?:\/\/[^"]+)"/i);
      if (m) d.cover = unesc(m[1]);
    }

    // ---- 作者 / 日期 / 浏览 ----
    m = html.match(/class="nav-user"[\s\S]{0,600}?<h2[^>]*>([^<]{1,40})<\/h2>/i);
    if (m) d.author = stripTags(m[1]);
    if (!d.author) {
      m = html.match(/class="[^"]*author[^"]*"[^>]*>[\s\S]{0,200}?<[^>]*>([^<]{1,30})</i);
      if (m) d.author = stripTags(m[1]);
    }
    m = html.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*发布/);
    if (!m) m = html.match(/(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?)/);
    if (m) d.date = m[1];
    m = html.match(/<span>\s*([\d.]+[KMW万亿]?\+?)\s*浏览<\/span>/i);
    if (m) d.views = m[1];

    // ---- 图文帖正文 (全量, 无付费门槛) ----
    var art = HJW.parseArticle(html);
    if (art.found) {
      d.artHtml = art.html;
      d.artText = art.text;
      d.images = art.images;
      d.imageCount = art.images.length;
      if (!d.cover && art.images.length) d.cover = art.images[0];
    }

    // ---- 正文全量可见, 无解锁容器 → 不判付费 ----
    // 站点 schema.org 自己写着 "isAccessibleForFree": true。
    // GOLD_PAYMENT_ENABLED 只是个金币充值入口的开关, 不代表内容被锁。
    // 实测正文里没有 [hide] / 付费可见 / 购买后可见 任何标记。
    // 所以这里恒为 false —— 内容全部是免费的, 没有需要绕过的门。
    d.payGated = false;

    d.isVideo = !!d.m3u8;
    d.isArticle = !d.isVideo && (d.imageCount > 0 || d.artText.length > 0);
    return d;
  };

  /** 详情 (按 id) */
  HJW.detail = function (params) {
    var id = (params && (params.id || params.vid)) || '';
    if (!id) return Promise.reject(new Error('缺 id'));
    return HJW.pickHost().then(function (h) {
      var url = h + '/archives/' + id + '/';
      return getHTML(url).then(function (html) {
        var d = HJW.parseDetail(html, id, h);
        d.ok = true;
        d.pageUrl = url;
        // 集数: 视频帖 1 集; 站点也有多集连载 (标题带 3-4 这种)
        d.epCount = 1;
        d.eps = d.m3u8 ? { '1': d.m3u8 } : {};
        // 相关推荐 (页面底部的同类卡片)
        try { d.related = HJW.parseRelated(html, h, id); } catch (e) { d.related = []; }
        // 图文帖详情页没有板块属性 → 用反查表补 (异步, 不阻塞返回)
        return HJW.fillCat(d, h).then(function () { return d; });
      });
    });
  };

  /* --------------------------------------------- 图文帖板块反查 (id → slug) */
  /**
   * 视频帖的板块能从播放器 data-video_type_* 拿到,
   * 但图文帖没有播放器属性, 详情页里拿不到板块归属
   * (导航那 11 条是全站菜单, 不是帖子归属)。
   *
   * 解法: 扫各板块列表页, 把里面出现的 id 记成「属于该板块」。
   * 映射存 localStorage, 24h 有效, 避免每次刷新都重扫 11 个页面。
   */
  var CATMAP_KEY = 'hjwCatMap';
  var CATMAP_TTL = 86400000;   // 24h
  var catMapPromise = null;

  function catMapRead() {
    try {
      var raw = (typeof localStorage !== 'undefined')
        && localStorage.getItem(CATMAP_KEY);
      if (!raw) return null;
      var j = JSON.parse(raw);
      if (!j || !j.at || (Date.now() - j.at) > CATMAP_TTL) return null;
      return j.map || null;
    } catch (e) { return null; }
  }

  function catMapWrite(map) {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(CATMAP_KEY,
        JSON.stringify({ at: Date.now(), map: map }));
    } catch (e) { /* 配额满/隐私模式, 忽略 */ }
  }

  // 降级: 用同步脚本产出的静态快照 data/hjw-catmap.json
  function catMapStatic() {
    if (typeof fetch !== 'function') return Promise.resolve({});
    return fetch('data/hjw-catmap.json', { cache: 'force-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var map = (j && j.map) || {};
        if (Object.keys(map).length) catMapWrite(map);
        return map;
      })
      .catch(function () { return {}; });
  }

  HJW.catMap = function (host) {
    var cached = catMapRead();
    if (cached) return Promise.resolve(cached);
    if (catMapPromise) return catMapPromise;
    var h = host;
    catMapPromise = (function () {
      var map = {};
      var list = HJW.HOME_SECTIONS.filter(function (s) { return s.slug; });
      // 分 3 个一批, 批间 200ms — 12 路并发容易被判为扫描
      var BATCH = 3;
      var progressed = false;
      function runBatch(i) {
        if (i >= list.length) {
          if (Object.keys(map).length) catMapWrite(map);
          // 一条没扫到 → 上游多半拦了, 退回静态快照
          if (!progressed) return catMapStatic();
          return Promise.resolve(map);
        }
        var batch = list.slice(i, i + BATCH);
        return Promise.all(batch.map(function (s) {
          return getHTML(h + '/category/' + s.slug + '/')
            .then(function (html) {
              var re = /href="\/archives\/(\d+)\/?"/gi, m;
              while ((m = re.exec(html))) { map[m[1]] = s.slug; progressed = true; }
            }).catch(function () { /* 单板块失败不影响其它 */ });
        })).then(function () {
          if (i + BATCH >= list.length) {
            if (Object.keys(map).length) catMapWrite(map);
            if (!progressed) return catMapStatic();
            return map;
          }
          return new Promise(function (r) { setTimeout(r, 200); })
            .then(function () { return runBatch(i + BATCH); });
        });
      }
      return runBatch(0);
    })().catch(function () { return catMapStatic(); });
    return catMapPromise;
  };

  /** 给详情结果补板块 (仅在原字段为空时) */
  HJW.fillCat = function (d, host) {
    if (!d || (d.catId && d.catName)) return Promise.resolve(d);
    return HJW.catMap(host).then(function (map) {
      var slug = map && map[String(d.id)];
      if (slug) {
        d.catId = d.catId || slug;
        for (var i = 0; i < HJW.HOME_SECTIONS.length; i++) {
          if (HJW.HOME_SECTIONS[i].slug === slug) {
            d.catName = d.catName || HJW.HOME_SECTIONS[i].name;
            break;
          }
        }
        if (!d.catName) d.catName = slug;
        d.catFrom = 'listmap';
      }
      return d;
    });
  };

  /* ----------------------------------------------------- 图文帖正文解析 */

  /**
   * 抽图文帖正文。
   *
   * 正文容器:  <div class="text text-content"> ... </div>
   * 结束标记:  紧随其后的 <div class="link-wrapper"> (分享条)
   *
   * 正文里的图片 **全部是明文直链**, 形如:
   *   <div class="defaultimg">
   *     <img z-image-loader-url="https://pic.wlwvch.cn/upload_01/....jpeg"
   *          alt="标题1" data-image-preview="true">
   *   </div>
   *
   * 关于"金币解锁":
   *   站点的 GOLD_PAYMENT_ENABLED 恒为 true, 但实测正文里 **不存在**
   *   任何解锁/付费可见/购买后可见的段落标记。所谓付费帖 = 作者在正文里
   *   自己写"评论送金币"之类的话 (探测脚本按关键词误判)。
   *   换言之: 正文全量可见, 没有需要破解的门。
   *   为稳妥, 这里做一层保险: 若正文里真的出现 [hide]..[/hide] 之类的
   *   短代码包裹, 直接剥壳把内容露出来 (内容本身就在 HTML 里, 服务端没删)。
   */
  HJW.parseArticle = function (html) {
    var out = { text: '', html: '', images: [''], found: false };
    var i = html.indexOf('class="text text-content"');
    if (i < 0) i = html.indexOf("class='text text-content'");
    if (i < 0) return out;
    var gt = html.indexOf('>', i);
    if (gt < 0) return out;
    var start = gt + 1;

    // 终点: 最近的分享条 / 标签区 / 评论容器
    var ends = [];
    ['class="link-wrapper"', 'class="tag', 'comment-list',
     'class="comment-container"', 'id="comment"'].forEach(function (kw) {
      var k = html.indexOf(kw, start);
      if (k > 0) ends.push(k);
    });
    var end = ends.length ? Math.min.apply(null, ends) : start + 120000;

    var body = html.slice(start, end).replace(/\s+$/, '');

    // 正文与后续功能区之间夹着站方的「地址发布页卡片」。
    // 它有两种形式的起始标记, 都以它为准切:
    //   <!--haijiao-address-template:after:v1-->
    //   <div class="text-wrap mr-bom">
    // 再退一步用 addr-grid 兜底。
    var cut = -1;
    ['<!--haijiao-address-template', '<div class="text-wrap mr-bom"',
     '<div class="addr-grid"'].forEach(function (kw) {
      var k = body.indexOf(kw);
      if (k > 0 && (cut < 0 || k < cut)) cut = k;
    });
    if (cut > 0) body = body.slice(0, cut);

    // 站方在正文尾部插入的「最后编辑于」不属于正文
    body = body.replace(/<p[^>]*>\s*最后编辑于[\s\S]*?<\/p>/gi, '');
    body = body.replace(/最后编辑于[:：][^<]*/g, '');

    // 砍掉尾部散落的空 div / 闭合标签
    body = body.replace(/(?:\s*<\/div>\s*)+$/, '');
    body = body.replace(/<(?:div|p)[^>]*>\s*<\/(?:div|p)>\s*$/gi, '');
    body = body.replace(/(?:\s*<\/div>\s*)+$/, '');
    body = body.replace(/\s+$/, '');

    // 保险: 剥掉可能存在的隐藏短代码, 把里面内容露出来
    body = body.replace(/\[hide\]([\s\S]*?)\[\/hide\]/gi, '$1');
    body = body.replace(/\[(?:pay|gold|vip|reply|hide)[^\]]*\]([\s\S]*?)\[\/(?:pay|gold|vip|reply|hide)\]/gi,
      '$1');

    out.html = body;
    out.found = true;

    // 正文图片 (明文直链)
    var imgs = [], m;
    var re = /z-image-loader-url="([^"]+)"/gi;
    while ((m = re.exec(body))) {
      var u = cleanImgUrl(m[1]);
      if (/^https?:\/\//i.test(u)) imgs.push(u);
    }
    if (!imgs.length) {
      var re2 = /<img[^>]+src="(https?:\/\/[^"]+)"/gi;
      while ((m = re2.exec(body))) imgs.push(unesc(m[1]));
    }
    out.images = imgs;

    // 纯文本
    var t = body
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    out.text = unesc(t);

    return out;
  };

  /**
   * 从详情页抽首页/侧栏那类"更多推荐"卡片 (页面底部有相关推荐位)。
   * 没有就返回空数组 —— 详情页照样能用。
   */
  HJW.parseRelated = function (html, base, selfId) {
    var out = HJW.parseList(html, base);
    return out.filter(function (x) { return String(x.id) !== String(selfId); }).slice(0, 12);
  };

  /** 单集播放地址 —— 每次重新拉详情页, 因为 auth_key 有时效 */
  HJW.ep = function (params) {
    var id = (params && (params.id || params.vid)) || '';
    var n = String((params && params.ep) || '1');
    return HJW.detail({ id: id }).then(function (d) {
      if (!d.m3u8) {
        return { ok: false, ep: n, id: id, gated: false, article: d.isArticle,
                 error: d.isArticle ? '该帖为图文内容, 无视频' : '该帖不含视频' };
      }
      return {
        ok: true, id: id, ep: n, source: 'hjw',
        raw: d.m3u8,
        url: HJW.proxied(d.m3u8)
      };
    });
  };

  /* ----------------------------------------------------------- 首页聚合 */

  /**
   * 一次拿首页全部板块 —— 站点首页按分类分区平铺,
   * 复刻它的"分区楼层"布局需要按分类分别取。
   * 这里并发抓首页 + 若干分类页, 合并去重。
   */
  HJW.HOME_SECTIONS = [
    { slug: '', name: '推荐' },
    { slug: 'hjyc', name: '海角原创' },
    { slug: 'hjll', name: '海角乱伦' },
    { slug: 'hjcg', name: '热门吃瓜' },
    { slug: 'hjkp', name: '看片娱乐' },
    { slug: 'hjwh', name: '网黄精品' },
    { slug: 'hjth', name: '探花合集' },
    { slug: 'hjaidj', name: 'AI短剧' },
    { slug: 'lmyq', name: '绿帽淫妻' },
    { slug: 'hjdm', name: '成人动漫' },
    { slug: 'hjby', name: '海角搬运' },
    { slug: 'yczm', name: '原创招募' }
  ];

  /** 并发抓多个板块, 返回 [{name, slug, items}] */
  HJW.sections = function (limit) {
    limit = limit || 12;
    return HJW.pickHost().then(function (h) {
      var jobs = HJW.HOME_SECTIONS.map(function (s) {
        return { name: s.name, slug: s.slug };
      });
      // 12 个板块一次性并发容易被上游判为扫描 (也会把访客出口 IP 拉黑)。
      // 分 4 个一批, 批内并行 → 首屏快, 又不至于触发风控。
      var BATCH = 4;
      var out = [];
      var runBatch = function (i) {
        if (i >= jobs.length) return Promise.resolve(out);
        var batch = jobs.slice(i, i + BATCH);
        return Promise.all(batch.map(function (s) {
          var url = s.slug ? h + '/category/' + s.slug + '/' : h + '/';
          return getHTML(url).then(function (html) {
            return { name: s.name, slug: s.slug,
                     items: HJW.parseList(html, h).slice(0, limit) };
          }).catch(function () {
            return { name: s.name, slug: s.slug, items: [] };
          });
        })).then(function (got) {
          for (var k = 0; k < got.length; k++) out.push(got[k]);
          if (i + BATCH >= jobs.length) return out;
          return new Promise(function (res) { setTimeout(res, 200); })
            .then(function () { return runBatch(i + BATCH); });
        });
      };
      return runBatch(0);
    });
  };

  /* --------------------------------------------------------------- 搜索 */

  /**
   * 搜索。海角自带 /search/ 页:
   *   /search/<kw>/        或   /search/?q=<kw>
   * 两种都试。
   */
  HJW.search = function (kw) {
    kw = String(kw || '').trim();
    if (!kw) return Promise.resolve({ ok: true, items: [], keyword: '' });
    return HJW.pickHost().then(function (h) {
      var tries = [
        h + '/search/' + encodeURIComponent(kw) + '/',
        h + '/search/?q=' + encodeURIComponent(kw)
      ];
      function next(i) {
        if (i >= tries.length) return { ok: true, items: [], keyword: kw };
        return getHTML(tries[i]).then(function (html) {
          var items = HJW.parseList(html, h);
          if (items.length) {
            return { ok: true, source: 'hjw', keyword: kw, items: items,
                     total: items.length };
          }
          return next(i + 1);
        }).catch(function () { return next(i + 1); });
      }
      return next(0);
    });
  };

  /* ----------------------------------------------------------- 播放代理 */

  /** m3u8 直链 → Worker 代理地址 (CDN 不一定发 CORS 头) */
  HJW.proxied = function (raw) {
    if (!raw) return '';
    if (!HJW.PROXY) return raw;   // 没注入 Worker 就先用原链赌一把
    return HJW.PROXY + '/proxy/' + encodeURIComponent(raw);
  };

  /* ---------------------------------------------------------------- 导出 */

  HJW.setProxy = function (base) { HJW.PROXY = base; };
  HJW.reset = function () { HJW.ALIVE = null; };

  /** 图片统一走代理 (CDN 不保证发 CORS) */
  HJW.img = function (u) {
    if (!u) return '';
    return HJW.proxied(u);
  };

  win.HJWW = HJW;
  if (typeof module !== 'undefined' && module.exports) module.exports = HJW;

})(typeof window !== 'undefined' ? window : globalThis);
