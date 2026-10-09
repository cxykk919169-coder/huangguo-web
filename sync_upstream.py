# -*- coding: utf-8 -*-
"""
湟果视频 · 上游同步器 (多源 → 静态 JSON)
==========================================
作用: 定时把上游站点最新剧集抓下来, 生成 data/*.json 落到仓库。
      前端优先读这些静态 JSON —— 站点长期开着, 不依赖 Worker 存活。

设计要点:
  * 纯标准库 (urllib), 无需 pip install, GitHub Actions 直接跑
  * 每个源独立 try/except, 一个挂了不影响其他源
  * 幂等: 输出排序稳定, 内容不变就不写文件 (避免无意义的 commit)
  * 记录 sync-meta.json: 每源条数 / 耗时 / 错误, 便于排查

输出:
  data/mg-list.json     芒果短剧全站清单
  data/mg-cats.json     芒果分类
  data/hd-list.json     黄豆短剧全站清单
  data/hg-list.json     黄果短剧清单 (站点可达时才有内容)
  data/hjw-list.json    海角网帖子清单 (视频帖 + 图文帖全收)
  data/hjw-cats.json    海角分类表
  data/hjw-catmap.json  帖 id → 板块 slug 反查表 (图文帖详情页不带板块)
  data/sync-meta.json   本轮同步元信息

用法:
  python sync_upstream.py            # 常规同步
  python sync_upstream.py --dry      # 只打印, 不写文件
  python sync_upstream.py --only mg  # 只同步芒果
"""
import json
import os
import re
import ssl
import sys
import time
import urllib.parse
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")

UA = ("Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36")

# 默认不校验证书 (上游多有自签/中间人), 只取公开页面
_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE

# ---------------------------------------------------------------- 通用

def http_get(url, referer=None, timeout=25, retries=3):
    """取文本。失败重试; 返回 (status, text)。"""
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "*/*",
                "Accept-Language": "zh-CN,zh;q=0.9",
                "Referer": referer or (urllib.parse.urlsplit(url).scheme + "://" +
                                       urllib.parse.urlsplit(url).netloc + "/"),
            })
            with urllib.request.urlopen(req, timeout=timeout, context=_CTX) as r:
                raw = r.read()
                # 手动 gzip 解码 (不依赖 Accept-Encoding 自动协商)
                if raw[:2] == b"\x1f\x8b":
                    import gzip
                    raw = gzip.decompress(raw)
                return r.status, _decode(raw)
        except Exception as e:
            last = e
            if i < retries - 1:
                time.sleep(2 + i * 2)
    return 0, ""

def _decode(raw):
    for enc in ("utf-8", "gb18030", "latin-1"):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode("utf-8", "ignore")

def clean(s):
    if not s:
        return ""
    s = str(s)
    s = re.sub(r'<span[^>]*class="[^"]*sr-only[^"]*"[^>]*>[\s\S]*?</span>', "", s)
    s = re.sub(r"<[^>]+>", "", s)
    for a, b in (("&amp;", "&"), ("&quot;", '"'), ("&#39;", "'"),
                 ("&lt;", "<"), ("&gt;", ">"), ("&nbsp;", " ")):
        s = s.replace(a, b)
    return re.sub(r"\s+", " ", s).strip()

def merge_item(store, iid, patch):
    if not iid:
        return
    cur = store.setdefault(iid, {"id": iid})
    for k, v in patch.items():
        if v is None or v == "":
            continue
        if k == "tags":
            if v:
                cur["tags"] = v
            continue
        if not cur.get(k):
            cur[k] = v

def write_json_if_changed(path, obj):
    """内容不变就不写 —— 避免每次同步都产生空 commit。"""
    txt = json.dumps(obj, ensure_ascii=False, indent=1, sort_keys=True)
    old = None
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                old = f.read()
        except Exception:
            old = None
    if old == txt:
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(txt)
    return True

# ---------------------------------------------------------------- 芒果

MG_HOST = "https://mgmg10.com"
MG_CATS = [
    ("du-jia-shuang-ju", "独家爽剧"),
    ("ai-comic-drama", "AI漫剧"),
    ("adult-short-drama", "真人短剧"),
    ("ca-bian-duan-ju", "擦边短剧"),
    ("remixed-short-drama", "AI魔改"),
    ("masturbation-zone", "撸管专区"),
    ("er-ci-yuan", "二次元"),
]

def mg_id_from_href(href):
    m = re.search(r"/details/([0-9a-f]{16,32})\.html", str(href or ""))
    return m.group(1) if m else ""

def mg_parse_cards(html):
    store = {}
    # A) dm-feature-card
    for blk in html.split("dm-feature-card")[1:]:
        blk = blk[:4000]
        hm = re.search(r'href="([^"]*/details/[0-9a-f]{16,32}\.html)"', blk, re.I)
        iid = mg_id_from_href(hm.group(1)) if hm else ""
        if not iid:
            continue
        tm = re.search(r'dm-feature-title[^>]*>\s*<a[^>]*>([\s\S]*?)</a>', blk, re.I)
        pm = re.search(r'dm-feature-pvtitle[^>]*>([\s\S]*?)</span>', blk, re.I)
        em = re.search(r'dm-feature-pvep[^>]*>([\s\S]*?)</span>', blk, re.I)
        im = re.search(r'<img[^>]*\bsrc="([^"]+)"', blk, re.I)
        pv = re.search(r'class="lc-preview-slot"[^>]*data-src="([^"]+)"', blk, re.I)
        ep_txt = clean(em.group(1)) if em else ""
        epm = re.search(r"(\d+)", ep_txt)
        tags = [clean(x) for x in re.findall(r'class="dm-tag"[^>]*>([\s\S]*?)</a>', blk, re.I)]
        tags = [t for t in tags if t][:6]
        merge_item(store, iid, {
            "title": clean(tm.group(1) if tm else (pm.group(1) if pm else "")),
            "cover": im.group(1) if im else "",
            "preview": pv.group(1) if pv else "",
            "ep": epm.group(1) if epm else "",
            "epLabel": ep_txt,
            "updating": "更新至" in ep_txt,
            "tags": tags,
        })
    # B) 通用网格
    for m in re.finditer(
            r'href="([^"]*/details/([0-9a-f]{16,32})\.html)"([^>]*)>([\s\S]{0,2500}?)(?=href="[^"]*/details/|</article|</li|$)',
            html, re.I):
        iid, seg = m.group(2), m.group(4)
        img = re.search(r'<img[^>]*\b(?:data-src|src)="([^"]+\.(?:jpg|jpeg|png|webp|gif)[^"]*)"', seg, re.I)
        title = ""
        tt = re.search(r'class="[^"]*title[^"]*"[^>]*>([\s\S]{0,200}?)<', seg, re.I)
        if tt:
            title = clean(tt.group(1))
        if not title:
            alt = re.search(r'<img[^>]*\balt="([^"]*)"', seg, re.I)
            if alt:
                title = clean(alt.group(1))
        et = re.search(r"(更新至\s*\d+\s*集|\d+\s*集|全\s*\d+\s*集)", seg)
        epm = re.search(r"(\d+)", et.group(1)) if et else None
        merge_item(store, iid, {
            "title": title,
            "cover": img.group(1) if img else "",
            "ep": epm.group(1) if epm else "",
            "epLabel": et.group(1) if et else "",
            "updating": bool(et and "更新至" in et.group(1)),
        })
    # C) JSON-LD
    for m in re.finditer(r'<script[^>]*type="application/ld\+json"[^>]*>([\s\S]*?)</script>', html, re.I):
        try:
            j = json.loads(m.group(1).strip())
        except Exception:
            continue
        stack = [j]
        while stack:
            o = stack.pop()
            if isinstance(o, list):
                stack.extend(o)
                continue
            if not isinstance(o, dict):
                continue
            if o.get("@type") in ("ListItem", "VideoObject", "CreativeWork"):
                iid = mg_id_from_href(o.get("item") or o.get("url") or o.get("@id") or "")
                if iid:
                    merge_item(store, iid, {"title": clean(o.get("name") or o.get("headline") or "")})
            stack.extend(o.values())
    out = list(store.values())
    for it in out:
        if not it.get("title"):
            it["title"] = "剧集 " + it["id"]
    out.sort(key=lambda x: x["id"])
    return out

def sync_mg():
    """芒果短剧: 首页 + 各分类, 合并去重"""
    t0 = time.time()
    store = {}
    errors = []
    pages = [("/", "首页")] + [("/category/%s/" % s, n) for s, n in MG_CATS]
    per_cat = {}
    for path, name in pages:
        st, html = http_get(MG_HOST + path, referer=MG_HOST + "/")
        if st != 200 or not html:
            errors.append("%s -> HTTP %s" % (path, st))
            continue
        items = mg_parse_cards(html)
        per_cat[name] = len(items)
        # 该页对应的分类 slug (首页无分类)
        slug = ""
        if "/category/" in path:
            slug = path.split("/category/")[1].split("/")[0]
        for it in items:
            merge_item(store, it["id"], {k: v for k, v in it.items() if k != "id"})
            if slug:
                cats = store[it["id"]].setdefault("cats", [])
                if slug not in cats:
                    cats.append(slug)
    out = list(store.values())
    for it in out:
        if not it.get("title"):
            it["title"] = "剧集 " + it["id"]
        if "cats" in it:
            it["cats"].sort()
    out.sort(key=lambda x: x["id"])
    return {
        "items": out,
        "categories": [{"slug": s, "name": n} for s, n in MG_CATS],
        "perCategory": per_cat,
        "_elapsed": round(time.time() - t0, 1),
        "_errors": errors,
    }

# ---------------------------------------------------------------- 黄豆

HD_API = "https://hddj.zen-vip.com/api/app"

def hd_get(path, params=None):
    url = HD_API + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    st, txt = http_get(url, referer="https://hddj30.cc/")
    if st != 200 or not txt:
        return None
    try:
        return json.loads(txt)
    except Exception:
        return None

def sync_hd():
    t0 = time.time()
    errors = []
    items = {}
    total = None
    page = 1
    while page <= 60:
        j = hd_get("/videos", {"page": page})
        if not j:
            errors.append("page %d 取数失败" % page)
            break
        arr = (j.get("item") or {}).get("items") if isinstance(j.get("item"), dict) else j.get("items")
        if arr is None:
            arr = j.get("data") or []
        if not isinstance(arr, list):
            arr = []
        if total is None:
            total = (j.get("item") or {}).get("total") or j.get("total") or len(arr)
        if not arr:
            break
        for o in arr:
            if not isinstance(o, dict):
                continue
            iid = str(o.get("id") or o.get("videoId") or "")
            if not iid:
                continue
            items[iid] = {
                "id": iid,
                "title": clean(o.get("title") or o.get("name") or ""),
                "cover": o.get("cover") or o.get("coverUrl") or o.get("poster") or "",
                "ep": str(o.get("episodeCount") or o.get("episodes") or o.get("totalEpisode") or ""),
                "desc": clean(o.get("description") or o.get("intro") or ""),
                "category": (o.get("category") or {}).get("name") if isinstance(o.get("category"), dict) else (o.get("categoryName") or ""),
            }
        page += 1
        if len(arr) < 20:
            break
        time.sleep(0.3)
    out = sorted(items.values(), key=lambda x: x["id"])
    return {"items": out, "total": total, "_elapsed": round(time.time() - t0, 1), "_errors": errors}

# ---------------------------------------------------------------- 黄果

HG_MIRRORS = [
    "https://s1er.vchllzwu.cc",
    "https://z5b68b.vchllzwu.cc",
    "https://bqvspv.vchllzwu.cc",
    "https://nkjl.vchllzwu.cc",
    "https://vir2.vchllzwu.cc",
    "https://e6xyzf.vchllzwu.cc",
    "https://2d7b2.gkudvxhjh.cc",
    "https://dicw.gkudvxhjh.cc",
]
HG_CATS = ["ai-duanju", "ai-manju", "ai-huanlian", "ai-mogai", "chigua"]


def hg_load_mirrors():
    """优先读 site.json 里的 mirrors —— 那是 hg_discover.py 自动发现的结果。

    发现器每轮会把最新可用域名写进 site.json, 这里读出来就能"上游换我也换"。
    读不到就退回内置常量。
    """
    try:
        with open(os.path.join(ROOT, "site.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        mirrors = cfg.get("mirrors") or []
        mirrors = [m for m in mirrors if isinstance(m, str) and m.startswith("http")]
        if mirrors:
            return mirrors
    except Exception:
        pass
    return HG_MIRRORS


def hg_probe_lock(host, vid):
    """探测某部剧的付费墙形态。

    黄果的设计 (2026-10 实测):
      详情页 HTML 内嵌 #videoInitialData, 其中 epPlaySrcs 是 {集号: m3u8} 的完整字典。
      —— 服务端一次性给全, 前端自己决定显示几集。也就是说: 没有服务端鉴权。

    这里实测第 1 集和第 2 集的 m3u8 是否都能直接 200 拿到, 用于佐证。
    返回 {"free_ok": bool, "ep2_ok": bool, "ep_count": int}
    """
    st, html = http_get("%s/video/%s/" % (host, vid), referer=host + "/", retries=1, timeout=12)
    if st != 200 or not html:
        return None
    eps = {}
    m = re.search(r'id="videoInitialData"[^>]*>([\s\S]*?)</script>', html)
    if m:
        try:
            data = json.loads(m.group(1))
            for k, v in (data.get("epPlaySrcs") or {}).items():
                if re.fullmatch(r"\d+", str(k)) and isinstance(v, str) and v.startswith("http"):
                    eps[str(k)] = v.replace("&amp;", "&")
        except Exception:
            pass
    # HTML 属性兜底
    for mm in re.finditer(r'data-play-src="([^"]+\.m3u8[^"]*)"', html):
        u = mm.group(1).replace("&amp;", "&")
        if u not in eps.values():
            n = str(len(eps) + 1)
            if n not in eps:
                eps[n] = u
    if not eps:
        return None
    free_ok = False
    ep2_ok = False
    first = eps.get("1") or list(eps.values())[0]
    st1, b1 = http_get(first, referer=host + "/", retries=1, timeout=12)
    free_ok = (st1 == 200 and "#EXTM3U" in b1)
    for k in ("2", "3"):
        if eps.get(k):
            st2, b2 = http_get(eps[k], referer=host + "/", retries=1, timeout=12)
            if st2 == 200 and "#EXTM3U" in b2:
                ep2_ok = True
            break
    return {"free_ok": free_ok, "ep2_ok": ep2_ok, "ep_count": len(eps),
            "srcs": len(eps)}


def hg_parse_cards(html):
    store = {}
    for blk in html.split('<div class="hg-drama-card"')[1:]:
        blk = blk[:3500]
        mid = re.search(r'data-track-id="(\d+)"', blk) or re.search(r'href="/video/(\d+)', blk)
        if not mid:
            continue
        alt = re.search(r'<img[^>]*\balt="([^"]*)"', blk)
        dtt = re.search(r'data-track-title="([^"]*)"', blk)
        title = clean(alt.group(1)) if alt else (clean(dtt.group(1)) if dtt else "")
        cm = re.search(r'data-src="(https?://[^"]+?)"', blk)
        em = re.search(r'__episode[^>]*>([\s\S]*?)</span>\s*</div>', blk)
        ep_txt = clean(em.group(1)) if em else ""
        epm = re.search(r"(\d+)\s*集", ep_txt)
        de = re.search(r'__desc[^>]*>([\s\S]*?)</p>', blk)
        merge_item(store, mid.group(1), {
            "title": title,
            "cover": cm.group(1).replace("&amp;", "&") if cm else "",
            "ep": epm.group(1) if epm else "",
            "updating": "更新至" in ep_txt,
            "desc": clean(de.group(1)) if de else "",
        })
    return list(store.values())

def sync_hg():
    t0 = time.time()
    items = {}
    errors = []
    ok_host = None
    mirrors = hg_load_mirrors()          # ← 动态: 优先用发现器写进 site.json 的最新域名
    for host in mirrors:
        st, html = http_get(host + "/ai-duanju/", referer=host + "/", retries=1, timeout=12)
        if st == 200 and html and "hg-drama-card" in html:
            ok_host = host
            break
        errors.append("%s -> HTTP %s" % (host, st))
    if not ok_host:
        return {"items": [], "host": None, "mirrors": mirrors[:8],
                "_elapsed": round(time.time() - t0, 1), "_errors": errors}
    for cat in HG_CATS:
        st, html = http_get(ok_host + "/%s/" % cat, referer=ok_host + "/", retries=1, timeout=12)
        if st != 200 or not html:
            errors.append("%s/%s -> HTTP %s" % (ok_host, cat, st))
            continue
        for it in hg_parse_cards(html):
            merge_item(items, it["id"], {k: v for k, v in it.items() if k != "id"})
    out = sorted(items.values(), key=lambda x: x["id"])

    # 抽样探一次付费墙形态 —— 结果写进 data/hg-lock.json, 前端据此决定要不要显示锁
    lock = None
    for it in out[:3]:
        lock = hg_probe_lock(ok_host, it["id"])
        if lock:
            lock["sampleId"] = it["id"]
            lock["host"] = ok_host
            break

    return {"items": out, "host": ok_host, "mirrors": mirrors[:8], "lock": lock,
            "_elapsed": round(time.time() - t0, 1), "_errors": errors}

# ---------------------------------------------------------------- 海角

HJW_HOSTS = ["https://www.hjw01.com", "https://hjw01.com", "https://hjw1.com"]

HJW_CATS = [
    ("hjyc", "海角原创"), ("hjll", "海角乱伦"), ("hjcg", "热门吃瓜"),
    ("hjkp", "看片娱乐"), ("hjwh", "网黄精品"), ("hjth", "探花合集"),
    ("hjaidj", "AI短剧"), ("lmyq", "绿帽淫妻"), ("hjdm", "成人动漫"),
    ("hjby", "海角搬运"), ("yczm", "原创招募"),
]
HJW_CAT_NAMES = dict(HJW_CATS)


def hjw_clean_img(u):
    u = (u or "").strip()
    return re.sub(r"^[`'\"\s]+|[`'\"\s]+$", "", u)


def hjw_parse_cards(html):
    """解析海角列表页。首页混用两套卡片模板, 统一按 <a href="/archives/N/"> 切块。"""
    store = {}
    for m in re.finditer(r'<a\s+href="/archives/(\d+)/?"([^>]*)>([\s\S]{0,1800}?)</a>', html, re.I):
        iid, attrs, blk = m.group(1), m.group(2), m.group(3)
        if iid in store:
            continue
        if "<img" not in blk.lower():
            continue                      # 没封面 → 侧栏纯文字链接
        cm = (re.search(r'z-image-loader-url="([^"]*)"', blk, re.I)
              or re.search(r'data-src="([^"]*)"', blk, re.I)
              or re.search(r'<img[^>]+src="([^"]*)"', blk, re.I))
        cover = hjw_clean_img(cm.group(1)) if cm else ""
        if not cover.startswith("http"):
            continue
        tm = re.search(r'<h3[^>]*>([\s\S]*?)</h3>', blk, re.I)
        title = clean(tm.group(1)) if tm else ""
        if not title:
            am = re.search(r'title="([^"]*)"', attrs, re.I)
            if am:
                title = clean(am.group(1))
        if not title:
            alt = re.search(r'alt="([^"]*)"', blk, re.I)
            if alt:
                title = clean(alt.group(1))[:80]
        if not title:
            continue
        dm = re.search(r'class="time"[^>]*>\s*([^<]+?)\s*<', blk, re.I)
        pm = re.search(r'class="play"[^>]*>\s*([^<]+?)\s*<', blk, re.I)
        store[iid] = {
            "id": iid, "title": title, "cover": cover,
            "date": clean(dm.group(1)) if dm else "",
            "reply": clean(pm.group(1)) if pm else "",
            "url": "/archives/%s/" % iid,
        }
    return list(store.values())


def hjw_parse_detail_slim(html, iid):
    """详情页只抽轻量元信息 —— 正文/图片体量大, 快照里只存索引需要的字段。
    实时正文由前端浏览器直连获取 (站点发 CORS), 不进快照。"""
    d = {"id": iid, "url": "/archives/%s/" % iid}
    m = re.search(r'<h1[^>]*class="novel-title"[^>]*>([\s\S]*?)</h1>', html, re.I)
    if not m:
        m = re.search(r'<title[^>]*>([^<]*)</title>', html, re.I)
    if m:
        d["title"] = clean(m.group(1)).replace(" - 海角网", "").strip()
    m = re.search(r'data-video_type_name="([^"]*)"', html)
    if m:
        d["catName"] = clean(m.group(1))
    m = re.search(r'data-video_type_id="([^"]*)"', html)
    if m:
        d["catId"] = m.group(1)
    m = re.search(r'data-video_tag_name="([^"]*)"', html)
    if m and m.group(1):
        d["tags"] = [x for x in m.group(1).split(",") if x]
    # 图文帖没有 data-video_tag_name (播放器属性), 用 meta keywords 兜底
    if not d.get("tags"):
        m = re.search(r'<meta[^>]+name="keywords"[^>]+content="([^"]*)"', html)
        if m and m.group(1):
            tag = [x.strip() for x in m.group(1).split(",")]
            d["tags"] = [x for x in tag
                         if x and len(x) <= 20
                         and not re.match(r'^[a-z0-9_\-.]{1,10}$', x, re.I)][:8]
    m = re.search(r'class="nav-user"[\s\S]{0,600}?<h2[^>]*>([^<]{1,40})</h2>', html, re.I)
    if m:
        d["author"] = clean(m.group(1))
    m = re.search(r'(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*发布', html)
    if m:
        d["date"] = m.group(1)
    m = re.search(r'<span>\s*([\d.]+[KMW万亿]?\+?)\s*浏览</span>', html)
    if m:
        d["views"] = m.group(1)
    # data-config 里的明文 m3u8 → 判断帖子类型 (只取特征, 不存全链, 因为带时效)
    m = re.search(r"data-config='([^']+)'", html)
    d["isVideo"] = bool(m and '"video"' in m.group(1) and ".m3u8" in m.group(1))
    # 正文图片数 (不存 URL, 只存数量, 供卡片角标)
    i = html.find('class="text text-content"')
    if i > 0:
        gt = html.find(">", i)
        ends = [html.find(k, gt) for k in
                ('class="link-wrapper"', 'class="tag', 'comment-list')]
        ends = [x for x in ends if x > 0]
        seg = html[gt:min(ends)] if ends else html[gt:gt + 120000]
        cuts = [seg.find(k) for k in
                ("<!--haijiao-address-template", '<div class="text-wrap mr-bom"',
                 '<div class="addr-grid"')]
        cuts = [x for x in cuts if x > 0]
        if cuts:
            seg = seg[:min(cuts)]
        d["imageCount"] = len(re.findall(r'z-image-loader-url="https?://', seg))
        # ---- 正文 HTML 进快照 (离线降级用) ----
        # workers.dev 在国内被墙时, 前端详情页靠快照兜底;
        # 正文每帖 2~8KB, 抽样 40 篇约 200KB 增量, 可接受。
        # 站方插入的「最后编辑于」与隐藏短代码一并剥掉 (与 Worker 同口径)
        seg = re.sub(r'<p[^>]*>\s*最后编辑于[\s\S]*?</p>', "", seg, flags=re.I)
        seg = re.sub(r"最后编辑于[:：][^<]*", "", seg)
        seg = re.sub(r"\[hide\]([\s\S]*?)\[/hide\]", r"\1", seg, flags=re.I)
        seg = re.sub(r"\[(?:pay|gold|vip|reply|hide)[^\]]*\]([\s\S]*?)\[/\1\]",
                     r"\1", seg, flags=re.I)
        seg = re.sub(r"(?:\s*</div>\s*)+$", "", seg).rstrip()
        d["artHtml"] = seg.strip()
        d["images"] = [m.group(1) for m in
                       re.finditer(r'z-image-loader-url="(https?://[^"]+)"', seg)]
        # 纯文本: 去标签 → 折叠空白 (chars 口径与 Worker 一致)
        txt = re.sub(r"<[^>]*>", "", seg)
        txt = txt.replace("&nbsp;", " ").replace("\xa0", " ")
        txt = re.sub(r"\n{3,}", "\n\n", txt).strip()
        d["artText"] = txt
        d["chars"] = len(txt)
    d.setdefault("imageCount", 0)
    d.setdefault("chars", 0)
    return d


def sync_hjw():
    """抓海角首页 + 各分类列表。顺带把站点的分类表也导出。"""
    t0 = time.time()
    items = {}
    errors = []
    ok_host = None
    for host in HJW_HOSTS:
        st, html = http_get(host + "/", retries=1, timeout=15)
        if st == 200 and html and "/archives/" in html:
            ok_host = host
            break
        errors.append("%s -> HTTP %s" % (host, st))
    if not ok_host:
        return {"items": [], "host": None,
                "_elapsed": round(time.time() - t0, 1), "_errors": errors}

    # 首页
    st, html = http_get(ok_host + "/", referer=ok_host + "/", retries=1, timeout=15)
    if st == 200 and html:
        for it in hjw_parse_cards(html):
            merge_item(items, it["id"], {k: v for k, v in it.items() if k != "id"})
        # 分类表
        cats = []
        seen = set()
        for m in re.finditer(r'<a[^>]+href="/category/([a-z0-9_\-]+)/?"[^>]*>([\s\S]{0,80}?)</a>', html, re.I):
            slug, nm = m.group(1), clean(m.group(2))
            if not nm or len(nm) > 12 or slug in seen:
                continue
            seen.add(slug)
            cats.append({"slug": slug, "name": nm})
    else:
        cats = []

    # 各分类 (取前 2 页) —— 同时建 id→slug 反查表
    catmap = {}
    for slug, _nm in HJW_CATS:
        for pg in (1, 2):
            url = "%s/category/%s/%s" % (ok_host, slug, "page/%d/" % pg if pg > 1 else "")
            st, html = http_get(url, referer=ok_host + "/", retries=1, timeout=15)
            if st != 200 or not html:
                if pg == 1:
                    errors.append("%s -> HTTP %s" % (url, st))
                break
            got = hjw_parse_cards(html)
            if not got:
                break
            for it in got:
                merge_item(items, it["id"], {k: v for k, v in it.items() if k != "id"})
                # 反查表: 该 id 出现在本板块页 → 记为属于本板块
                catmap[it["id"]] = slug

    out = sorted(items.values(), key=lambda x: x["id"], reverse=True)

    # ---- 用反查表补图文帖的板块 (视频帖详情页自带 data-video_type_*) ----
    for it in out:
        if not it.get("catName"):
            s = catmap.get(it["id"])
            if s:
                it["catId"] = s
                it["catName"] = HJW_CAT_NAMES.get(s, s)
                it["catFrom"] = "listmap"

    # ---- 详情抽样: 补 isVideo / imageCount / chars / author / views ----
    # 列表页拿不到帖子类型 (视频 or 图文)。抽样抓最新若干篇详情页补上,
    # 让快照也能带类型角标。数量控制在 SAMPLE 以内, 别把 runner 拖太久。
    # 120 篇 ≈ 3 分钟 (runner 抓详情 ~1.2s/篇), 快照增到 ~1.5MB。
    # 国内 workers.dev 被墙时, 最新 120 篇的图文帖离线也能看全文。
    SAMPLE = 120
    probed = 0
    for it in out[:SAMPLE]:
        st, dh = http_get(ok_host + it["url"], referer=ok_host + "/",
                          retries=1, timeout=12)
        if st != 200 or not dh:
            continue
        try:
            slim = hjw_parse_detail_slim(dh, it["id"])
            for k in ("isVideo", "imageCount", "chars", "author", "views",
                      "catName", "catId", "tags",
                      "artHtml", "artText", "images"):
                if k in slim and slim[k] not in (None, "", [], 0, False):
                    it[k] = slim[k]
                elif k == "isVideo":
                    it[k] = bool(slim.get(k))
            # 详情页没板块的 (图文帖), 仍用反查表兜住
            if not it.get("catName"):
                s = catmap.get(it["id"])
                if s:
                    it["catId"] = s
                    it["catName"] = HJW_CAT_NAMES.get(s, s)
                    it["catFrom"] = "listmap"
            probed += 1
        except Exception as e:
            errors.append("detail %s: %s" % (it["id"], e))

    out = sorted(out, key=lambda x: x["id"], reverse=True)
    return {"items": out, "host": ok_host, "categories": cats,
            "count": len(out), "probed": probed, "catmap": catmap,
            "catmapCount": len(catmap),
            "_elapsed": round(time.time() - t0, 1), "_errors": errors}

# ---------------------------------------------------------------- main

def main():
    dry = "--dry" in sys.argv
    only = None
    for i, a in enumerate(sys.argv):
        if a == "--only" and i + 1 < len(sys.argv):
            only = sys.argv[i + 1]

    os.makedirs(DATA_DIR, exist_ok=True)
    meta = {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "sources": {}, "written": []}

    # ---- 第一步: 黄果地址自动发现 (上游换域名我们就跟着换) ----
    if not only or only == "hg":
        if "--no-discover" not in sys.argv:
            print("[discover] 检查黄果发布页 ...")
            try:
                import hg_discover
                d = hg_discover.discover(rounds=3)
                changed, msg = hg_discover.apply_to_site(d)
                meta["discover"] = {
                    "changed": changed,
                    "pages": {k: v.get("status") for k, v in d["pages"].items()},
                    "candidates": d["candidates"][:12],
                    "alive": [a["host"] for a in d["alive"]],
                    "message": msg,
                }
                if changed:
                    meta["written"].append("site.json")
                print("  %s | %s" % ("发现新地址!" if changed else "无变化", msg))
            except Exception as e:
                print("  !! 发现器异常: %s" % e)
                meta["discover"] = {"error": str(e)}

    plan = [
        ("mg", "mg-list.json", sync_mg),
        ("hd", "hd-list.json", sync_hd),
        ("hg", "hg-list.json", sync_hg),
        ("hjw", "hjw-list.json", sync_hjw),
    ]

    for key, fname, fn in plan:
        if only and only != key:
            continue
        print("[sync] %s ..." % key)
        try:
            res = fn()
        except Exception as e:
            print("  !! %s 异常: %s" % (key, e))
            meta["sources"][key] = {"ok": False, "error": str(e)}
            continue
        n = len(res.get("items") or [])
        meta["sources"][key] = {
            "ok": n > 0,
            "count": n,
            "elapsed": res.get("_elapsed"),
            "errors": res.get("_errors") or [],
        }
        if key == "mg":
            res.pop("_elapsed", None)
            res.pop("_errors", None)
            res.pop("perCategory", None)
        if key == "hd":
            res.pop("_elapsed", None)
            res.pop("_errors", None)
        if key == "hg":
            res.pop("_elapsed", None)
            res.pop("_errors", None)
            # 付费墙探测结果单独落盘 —— 前端读它才知道要不要显示锁标记。
            #
            # 关键: 只要文件不存在就强制写(丢掉旧值比对)。
            # 因为「内容不变 → 不写」+「本轮别的文件也无变化 → sync.yml 跳过提交」
            # 会让这个文件在上线失败(比如 Deploy 遇到 deploy-pages 瞬时故障)之后再无
            # 机会补上去。强制兜底写一次, 保证每轮至少尝试把它推到线上。
            lock = res.pop("lock", None)
            if lock and not dry:
                lp = os.path.join(DATA_DIR, "hg-lock.json")
                first_time = not os.path.exists(lp)
                if first_time or write_json_if_changed(lp, lock):
                    if "hg-lock.json" not in meta["written"]:
                        meta["written"].append("hg-lock.json")
                    print("  [写] hg-lock.json (免费=%s 第2集=%s 共%s集)%s"
                          % (lock.get("free_ok"), lock.get("ep2_ok"),
                             lock.get("ep_count"), " [补]" if first_time else ""))
        if key == "hjw":
            res.pop("_elapsed", None)
            res.pop("_errors", None)
            # 分类表单独落盘 (前端 tab 直接用, 不用等首次列表请求)
            cats = res.pop("categories", None)
            if cats and not dry:
                cp = os.path.join(DATA_DIR, "hjw-cats.json")
                if write_json_if_changed(cp, {"categories": cats}):
                    meta["written"].append("hjw-cats.json")
                    print("  [写] hjw-cats.json (%d 个分类)" % len(cats))
            # id→板块 反查表落盘 —— 图文帖详情页不带板块, 前端用这张表补
            cmap = res.pop("catmap", None)
            if cmap and not dry:
                mp2 = os.path.join(DATA_DIR, "hjw-catmap.json")
                if write_json_if_changed(mp2, {"map": cmap, "count": len(cmap)}):
                    meta["written"].append("hjw-catmap.json")
                    print("  [写] hjw-catmap.json (%d 条 id→板块)" % len(cmap))
        print("  -> %d 条" % n)

        if not dry and n > 0:
            p = os.path.join(DATA_DIR, fname)
            if write_json_if_changed(p, res):
                meta["written"].append(fname)
                print("  [写] %s" % fname)
            else:
                print("  [同] %s 无变化" % fname)
        elif n == 0:
            print("  [跳] 无数据, 不覆盖已有文件")

    if not dry:
        mp = os.path.join(DATA_DIR, "sync-meta.json")
        write_json_if_changed(mp, meta)
        print("[meta] %s" % json.dumps(meta["sources"], ensure_ascii=False))

    print("[done] written: %s" % (meta["written"] or "无"))
    return 0

if __name__ == "__main__":
    sys.exit(main())
