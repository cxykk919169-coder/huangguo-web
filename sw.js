/* 湟果视频 · Service Worker
 * ==========================================
 * 策略 (v5 重写, 修掉"更新后还是旧页面"的坑):
 *   - HTML/JS/CSS : 网络优先 (永不返回旧版), 断网回退缓存
 *   - /api/*      : 网络优先, 失败回退缓存
 *   - 图片        : 缓存优先 (封面不常变, 省流量)
 *
 * 更新: 改 VERSION 号即可让所有客户端拉新缓存
 *       构建时可用 __BUILD__ 占位符替换
 *
 * 【重要教训】v4 的写法是"页面骨架缓存优先", 结果改了 index.html 后
 * 用户刷新看到的还是旧的 (因为缓存里那份没被替换)。v5 改成网络优先。
 */

const VERSION = 'hg-v18-20261009';
const SHELL = ['/', '/index.html', '/hls.min.js', '/hg-direct.js', '/hg-hd.js', '/hg-es.js', '/hg-stego.js', '/hg-hjw.js', '/crypto-js.min.js', '/manifest.json', '/favicon.png', '/data/hg-lock.json', '/data/es-list.json', '/data/es-cats.json', '/data/es-detail.json', '/data/es-play.json'];

// 需要"永远拿最新"的资源 (不能缓存优先)
const NEVER_CACHE_FIRST = /\.(html|js|css|json|webmanifest)$/i;

// sw.js 自身绝不能被缓存, 否则更新检查永远拿到旧版本号
const NEVER_CACHE = /\/sw\.js$/i;


self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 允许页面主动要求跳过等待
self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }

  // 只处理同源请求; 跨域 (上游镜像 / 图片站 / Cloudflare API) 交给浏览器
  if (url.origin !== self.location.origin) return;

  // ---- sw.js 自己: 彻彻底底不缓存, 保证版本检查永远拿到真东西 ----
  // 之前的坑: sw.js 走的是下面的"网络优先"分支, 断网时会回退到缓存里的旧 sw.js,
  // 于是版本号永远是旧的, 自愈逻辑形同虚设。
  if (NEVER_CACHE.test(url.pathname)) {
    e.respondWith(fetch(req, { cache: 'no-store' }).catch(() => caches.match(req)));
    return;
  }

  // ---- API: 网络优先, 断网回退缓存 ----
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(req)
        .then((r) => {
          if (r && r.status === 200) {
            const clone = r.clone();
            caches.open(VERSION).then((c) => c.put(req, clone)).catch(() => {});
          }
          return r;
        })
        .catch(() => caches.match(req).then((hit) => hit || new Response(
          JSON.stringify({ error: 'offline', offline: true }),
          { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        )))
    );
    return;
  }

  // ---- 图片 / 图标: 缓存优先 (封面不常变) ----
  if (/\.(png|jpe?g|webp|gif|svg|ico)$/i.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((r) => {
        if (r && r.status === 200) {
          const clone = r.clone();
          caches.open(VERSION).then((c) => c.put(req, clone)).catch(() => {});
        }
        return r;
      }).catch(() => hit))
    );
    return;
  }

  // ---- HTML / JS / CSS: 网络优先! (v4 的坑就出在这里) ----
  // 保证改了 index.html / hg-direct.js 后刷新立刻生效
  if (NEVER_CACHE_FIRST.test(url.pathname) || req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((r) => {
          if (r && r.status === 200) {
            const clone = r.clone();
            const key = req.mode === 'navigate' ? '/index.html' : req;
            caches.open(VERSION).then((c) => c.put(key, clone)).catch(() => {});
          }
          return r;
        })
        .catch(() => caches.match(req).then((hit) =>
          hit || (req.mode === 'navigate'
            ? caches.match('/index.html').then((h2) => h2 || caches.match('/'))
            : undefined)
        ))
    );
    return;
  }

  // ---- 其他静态: 缓存优先, 回退网络 ----
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).catch(() => caches.match('/index.html')))
  );
});
