# -*- coding: utf-8 -*-
"""
湟果视频 · EROSHORT (eroshort.net) 同步器
==========================================
上游 eroshort.net 挂 Cloudflare 人机校验:
  * 裸直连 /api/v1/*  →  403 "Sorry, you have been blocked"
  * 但这套校验对 **GitHub Actions 出口 IP** 是放行的 (实测 200 + JSON)

所以抓取放在 Actions 里跑, 产物落 data/*.json, 前端离线兜底用。

输出:
  data/es-list.json    EROSHORT 全站剧集清单 (含分类标签)
  data/es-cats.json    分类表 (上游 /tags 结果)
  data/es-detail.json  剧集 → 集数表映射 (用于离线详情页)

用法:
  python sync_es.py            # 常规同步
  python sync_es.py --dry      # 只打印, 不写文件
  python sync_es.py --probe    # 只探测连通性 (不写任何文件)
"""
import json
import os
import re
import ssl
import sys
import threading
import time
import urllib.parse
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")

API = "https://eroshort.net/api/v1"

# 前端 bundle 里的构建号, POST /playback/resolve 必须带
BUILD_ID = "dcdcc161385053f622cedf86ed610abd33dae3e034af5366a8a76a058baad118"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE

HEADERS = {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": "https://eroshort.net/",
    "Origin": "https://eroshort.net",
}


# ---------------------------------------------------------------- 通用

def clean(s):
    """去掉上游正文里的 [sm] 标记与多余空白。"""
    t = str(s if s is not None else "")
    t = re.sub(r"\[/?sm\]", "", t, flags=re.I)
    return re.sub(r"\s+", " ", t).strip()


# 公共 CORS 中转池 —— 上游对 CI runner 出口也返回 403, 必须经中转
# ⚠ 按本地实测可用性排序: allorigins 最稳 (大包才会截), cors.lol 易 429,
#   codetabs 常年 522, whateverorigin 只做 JSONP 包装且易 500。
RELAYS = [
    # allorigins /get 包装端点: 2026-10-09 本机实测唯一稳定 200 的通道, 置顶
    ("allorigins-get", "https://api.allorigins.win/get?url=", True),   # 返回 {contents: "..."}
    ("allorigins-raw", "https://api.allorigins.win/raw?url=", False),
    ("cors.lol", "https://api.cors.lol/?url=", False),
    ("codetabs", "https://api.codetabs.com/v1/proxy?quest=", False),
    ("whateverorigin", "https://whateverorigin.org/get?url=", True),
]
RELAY_RETRIES = 3
RELAY_BACKOFF = (3, 6, 10)    # 通道少且抖, 多轮慢退; 单通道内部不重试
REQ_TIMEOUT = 22              # 单次请求上限 (公共中转 22s+ 基本就是废请求)

# 运行期统计, 决定当前哪个中转可用
RELAY_STAT = {}


def _raw_fetch(url, method="GET", body=None, timeout=None):
    if timeout is None:
        timeout = REQ_TIMEOUT
    req = urllib.request.Request(url, method=method, data=body)
    for k, v in HEADERS.items():
        req.add_header(k, v)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout, context=_CTX) as r:
        raw = r.read()
        if raw[:2] == b"\x1f\x8b":
            import gzip
            raw = gzip.decompress(raw)
        return r.status, raw.decode("utf-8", "ignore")


def _classify(status, txt):
    if txt and re.match(r"^\s*<(!DOCTYPE|html)", txt, re.I):
        if re.search(r"Sorry, you have been blocked|Attention Required|Just a moment|cf-error", txt, re.I):
            return False, None, "CF_CHALLENGE"
        return False, None, "HTML_RESPONSE"
    if status != 200:
        return False, None, "HTTP_%s" % status
    try:
        return True, json.loads(txt), ""
    except Exception as e:
        return False, None, "BAD_JSON:%s" % e


def api_get(path, timeout=None, retries=None, quiet=False):
    """GET /api/v1<path>, 直连失败自动走中转池。

    返回 (ok, data_or_none, info)
    info: {via, http, cf, bytes, error, tried}
    """
    if retries is None:
        retries = RELAY_RETRIES
    if timeout is None:
        timeout = REQ_TIMEOUT
    full = API + path
    tried = []

    # 1) 直连 (CF 硬拦时秒失败, 不浪费重试)
    try:
        st, txt = _raw_fetch(full, "GET", None, timeout)
        ok, data, err = _classify(st, txt)
        tried.append({"via": "direct", "http": st, "err": err})
        if ok:
            return True, data, {"via": "direct", "http": st, "cf": False, "bytes": len(txt), "error": "", "tried": tried}
    except Exception as e:
        tried.append({"via": "direct", "http": 0, "err": str(e)[:60]})

    # 2) 中转池 —— 逐通道、逐次退避
    #    公共中转限流是常态: 打成 429/520/522 不代表路径不通, 换通道再试。
    enc = urllib.parse.quote(full, safe="")
    for name, prefix, is_jsonp in RELAYS:
        for attempt in range(retries):
            try:
                st, txt = _raw_fetch(prefix + enc, "GET", None, timeout)
                if is_jsonp:
                    try:
                        txt = json.loads(txt).get("contents") or ""
                        st = 200
                    except Exception:
                        tried.append({"via": name, "http": st, "err": "JSONP_PARSE"})
                        break
                ok, data, err = _classify(st, txt)
                tried.append({"via": name, "http": st, "err": err, "len": len(txt)})
                if ok:
                    RELAY_STAT[name] = RELAY_STAT.get(name, 0) + 1
                    return True, data, {"via": name, "http": st, "cf": False,
                                        "bytes": len(txt), "error": "", "tried": tried}
            except Exception as e:
                tried.append({"via": name, "http": 0, "err": str(e)[:60]})
            if attempt < retries - 1:
                time.sleep(RELAY_BACKOFF[min(attempt, len(RELAY_BACKOFF) - 1)])
    err = tried[-1]["err"] if tried else "no_channel"
    return False, None, {"via": "", "http": 0, "cf": err == "CF_CHALLENGE", "bytes": 0,
                         "error": err, "tried": tried}


def api_post(path, payload, timeout=40):
    """POST /api/v1<path>; 中转池按 POST 转发 (cors.lol / allorigins 支持 POST 直通)。"""
    full = API + path
    body = json.dumps(payload).encode()
    try:
        st, txt = _raw_fetch(full, "POST", body, timeout)
        ok, data, err = _classify(st, txt)
        if ok:
            return True, data, {"via": "direct", "error": ""}
    except Exception as e:
        pass
    for name, prefix, _ in RELAYS:
        try:
            st, txt = _raw_fetch(prefix + urllib.parse.quote(full, safe=""), "POST", body, timeout)
            ok, data, err = _classify(st, txt)
            if ok:
                return True, data, {"via": name, "error": ""}
        except Exception:
            continue
    return False, None, {"via": "", "error": "no_channel"}


def write_json_if_changed(path, obj):
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


CN_NUM = "一二三四五六七八九十百零〇"


def parse_ep_title(t):
    """'第12集 交换' → (12, '交换'); 解不出返回 (None, None)。"""
    m = re.match(r"^第\s*([%s\d]+)\s*集\s*(.*)$" % CN_NUM, t or "")
    if not m:
        return None, None
    return m.group(1), m.group(2)


def card(it):
    """上游 /shorts 条目 → 前端卡片字段 (与 hg-es.js toCard / es-list.json 对齐)。"""
    title_raw = clean(it.get("title"))
    title = _tidy_title(title_raw)
    cover = it.get("cover") or ""
    if isinstance(cover, dict):
        cover = cover.get("url") or ""
    tags = []
    for t in (it.get("tags") or []):
        n = clean(t if isinstance(t, str) else (t or {}).get("name") or (t or {}).get("code"))
        if n:
            tags.append(n)
    pm = re.search(r"共\s*(\d+)\s*/\s*(\d+)\s*集", title_raw) or re.search(r"共\s*(\d+)\s*集", title_raw)
    ep_total = 0
    if pm:
        ep_total = int(pm.group(2)) if (pm.lastindex and pm.lastindex >= 2) else int(pm.group(1))
    pricing = it.get("pricing") or {}
    return {
        "id": it.get("id") or "",
        "title": title,
        "titleRaw": title_raw,
        "desc": clean(it.get("description"))[:160],
        "cover": cover,
        "tags": tags,
        # epCount 是前端到处在用的字段名; epTotal 是历史遗留, 两个都给, 避免再对不上
        "epCount": ep_total,
        "epTotal": ep_total,
        "price": pricing.get("vip_price") or pricing.get("price") or 0,
        "vipPrice": pricing.get("vip_price") or 0,
        "access": it.get("access_level") or "",
        "views": it.get("view_count") or 0,
        "likes": it.get("like_count") or 0,
        "status": it.get("status") or "",
        "createdAt": it.get("created_at") or "",
        "updatedAt": it.get("updated_at") or "",
        "source": "es",
    }


def _tidy_title(t):
    """剥掉标题里塞的运营文案, 只留剧名。"""
    t = clean(t)
    t = re.sub(r"\s*共\s*\d+\s*(?:/\s*\d+)?\s*集.*$", "", t)
    t = re.sub(r"\s*已完结.*$", "", t)
    t = re.sub(r"\s*(?:可)?整部(?:解锁更优惠|购买).*$", "", t)
    t = re.sub(r"\s*每周.*$", "", t)
    return t.strip()


# ---------------------------------------------------------------- 各接口

def fetch_tags():
    """上游 /tags 是**两层**结构:
       { categories: [ { code:"类型", tags:[ {code:"漫改", name, usage_count}, ... ] },
                       { code:"状态", tags:[ ... ] } ] }

    拍平成一维标签表 —— 前端 SITES.es 的分类条只吃一维。
    """
    ok, j, info = api_get("/tags?schema=short_video&only_with_content=true")
    if not ok:
        return None, info
    groups = j.get("categories") if isinstance(j, dict) else None
    if groups is None:
        groups = j.get("data") if isinstance(j, dict) else j
    cats = []
    seen = set()
    for g in (groups or []):
        if not isinstance(g, dict):
            continue
        gname = clean(g.get("code") or g.get("name") or "")
        for t in (g.get("tags") or []):
            if not isinstance(t, dict):
                continue
            code = clean(t.get("code") or "")
            name = clean(t.get("name") or code)
            if not name or name in seen:
                continue
            seen.add(name)
            cats.append({
                "name": name,
                "code": code or name,
                "slug": code or name,
                "group": gname,
                "color": t.get("color") or "",
                "count": t.get("usage_count") or t.get("content_count") or 0,
            })
    return cats, info


def _fetch_page(pg, page_size):
    """抓单页, 返回 (pg, rows_or_None, info)。线程安全: 只读全局常量。"""
    ok, j, info = api_get("/shorts?page=%d&page_size=%d" % (pg, page_size))
    if not ok:
        return pg, None, info
    rows = j.get("data") if isinstance(j, dict) else j
    pg_info = j.get("pagination") if isinstance(j, dict) else None
    return pg, (rows or []), {
        "via": info.get("via", ""), "http": info.get("http", 0),
        "cf": info.get("cf", False), "bytes": info.get("bytes", 0),
        "error": info.get("error", ""), "has_more": bool(pg_info.get("has_more")) if pg_info else None,
    }


def fetch_all_shorts(page_size=20, max_pages=40, seed=None, concurrency=3):
    """翻页抓全站 /shorts —— 并发分批 + 失败页重试, 断点续抓。

    page_size: 默认 20。
      2026-10-09 实测修正: 之前认为"大响应必被中转截断所以只能 4~8"是错的。
      换到 allorigins /get 包装端点后, page_size=20 (≈21KB) 稳定 200,
      而 page_size=4 反而时常 500/522 —— 成败取决于通道抖动, 不取决于体积。
      上游总量很小 (total=18), 一页 20 直接装完, 省掉 5 轮翻页 = 少 5 次抖动机会。

    ⚠ 并发而不是逐页阻塞:
      中转限流时单页可能耗掉 30s+。逐页串行 → 一页卡住整轮就废。
      这里每批并发 concurrency 页, 失败的记下来下一轮重试 (最多 3 轮)。
      id 去重, 乱序/重复无害。

    seed: 已有快照 items —— 限流期不至于把抓到的丢掉 (断点续抓)。
    """
    store = {}
    for it in (seed or []):
        if isinstance(it, dict) and it.get("id"):
            store[it["id"]] = it

    infos = []
    pending = list(range(1, max_pages + 1))
    ok_pages = set()

    for rnd in range(3):
        if not pending:
            break
        batch, pending = pending, []
        for i in range(0, len(batch), concurrency):
            chunk = batch[i:i + concurrency]
            out = []
            lock = threading.Lock()

            def worker(pg, _out=out, _lock=lock):
                r = _fetch_page(pg, page_size)
                with _lock:
                    _out.append(r)

            threads = [threading.Thread(target=worker, args=(pg,), daemon=True) for pg in chunk]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=120)

            for pg, rows, info in out:
                infos.append({"page": pg, "round": rnd + 1, "via": info.get("via", ""),
                              "http": info.get("http", 0), "cf": info.get("cf", False),
                              "bytes": info.get("bytes", 0), "error": info.get("error", "")})
                if rows is None:
                    pending.append(pg)
                    continue
                if not rows:
                    ok_pages.add(pg)
                    continue
                ok_pages.add(pg)
                for it in rows:
                    if isinstance(it, dict) and it.get("id") and it["id"] not in store:
                        store[it["id"]] = card(it)
                # 末页判定: 返回条数 < page_size 说明到底了
                if len(rows) < page_size:
                    pending = [x for x in pending if x < pg]
                    break

        if rnd < 2:
            time.sleep(3)

    items = list(store.values())
    err = "" if ok_pages else ((infos[-1]["error"] if infos else "") or "no_page_ok")
    return items, len(ok_pages), infos, err


def _is_episode_node(k):
    """只认真正的"集"。children 是全后代扁平表: collection / season / episode 混在一起。
    不筛的话 season 节点会被当成第 1 集, 点进去 /playlines/episode/{seasonId} 返 NOT_FOUND。"""
    md = k.get("metadata") or {}
    st = md.get("short_structure_type")
    if st == "episode":
        return True
    if st in ("season", "collection"):
        return False
    return not k.get("child_count")


def fetch_children(vid):
    """集数表: /hierarchy/short_video/{id}/children"""
    ok, j, info = api_get("/hierarchy/short_video/%s/children?group_by=false&include_metadata=true"
                          % urllib.parse.quote(str(vid)))
    if not ok:
        return None, info
    root = clean((j.get("root") or {}).get("title") or "")
    eps = []
    for k in (j.get("children") or []):
        if not isinstance(k, dict) or not k.get("id"):
            continue
        if not _is_episode_node(k):
            continue
        t = clean(k.get("title"))
        if not t or t == root:
            continue
        num, sub = parse_ep_title(t)
        if not num:
            num = str(len(eps) + 1)
            sub = t
        cov = k.get("cover")
        cov = (cov.get("url") if isinstance(cov, dict) else cov) or ""
        item = {"id": k["id"], "ep": len(eps) + 1, "num": num, "label": "第%s集" % num, "title": sub}
        if cov:
            item["cover"] = cov
        eps.append(item)
    return eps, info


# ---------------------------------------------------------------- 主流程

def probe():
    """只探连通性。返回 dict, 供 Actions 日志 / 版本探针使用。"""
    out = {}
    ok, j, info = api_get("/shorts?page=1&page_size=1")
    out["shorts"] = {"ok": ok, "via": info.get("via", ""), "http": info.get("http", 0),
                     "cf": info.get("cf", False), "bytes": info.get("bytes", 0),
                     "error": info.get("error", "")}
    if ok and isinstance(j, dict):
        out["shorts"]["total"] = (j.get("pagination") or {}).get("total")
    ok2, j2, i2 = api_get("/tags?schema=short_video&only_with_content=true")
    out["tags"] = {"ok": ok2, "via": i2.get("via", ""), "http": i2.get("http", 0),
                   "cf": i2.get("cf", False), "error": i2.get("error", "")}
    if ok2:
        out["tags"]["count"] = len((j2.get("data") if isinstance(j2, dict) else j2) or [])
    out["buildId"] = BUILD_ID[:12]
    out["relayStat"] = dict(RELAY_STAT)
    out["reachable"] = bool(out["shorts"]["ok"] or out["tags"]["ok"])
    return out


def sync(max_pages=40):
    t0 = time.time()
    res = {"items": [], "_errors": [], "_elapsed": 0}

    # 断点续抓: 读旧快照当种子, 限流期抓到的不会被下一轮丢掉
    seed_items, seed_details = [], {}
    try:
        p_old = os.path.join(DATA_DIR, "es-list.json")
        if os.path.exists(p_old):
            with open(p_old, encoding="utf-8") as f:
                seed_items = (json.load(f) or {}).get("items") or []
            print("  [seed] 旧快照 %d 部" % len(seed_items))
    except Exception:
        pass
    try:
        p_det = os.path.join(DATA_DIR, "es-detail.json")
        if os.path.exists(p_det):
            with open(p_det, encoding="utf-8") as f:
                seed_details = (json.load(f) or {}).get("details") or {}
            print("  [seed] 旧详情 %d 部" % len(seed_details))
    except Exception:
        pass
    res["_seed"] = len(seed_items)

    cats, info = fetch_tags()
    if cats is None:
        # 分类也回退旧快照
        try:
            with open(os.path.join(DATA_DIR, "es-cats.json"), encoding="utf-8") as f:
                cats = (json.load(f) or {}).get("categories") or []
            if cats:
                print("  [tags] 上游失败, 用旧快照 %d 个分类" % len(cats))
        except Exception:
            cats = []
        if not cats:
            res["_errors"].append("tags: %s" % ((info or {}).get("error") or "fail"))
    if cats:
        print("  [tags] %d 个分类 (via %s)" % (len(cats), (info or {}).get("via", "")))

    items, pages, infos, err = fetch_all_shorts(max_pages=max_pages, seed=seed_items)

    # 【防退化】种子比新抓的还全 → 保留种子。
    # 中转抖动时可能只成功 2~3 页, 若直接覆盖, 快照会从 18 部掉到 12 部,
    # 用户就会看到"内容变少了"。宁可保留旧的完整快照。
    if seed_items and len(items) < len(seed_items):
        print("  [guard] 新抓 %d 部 < 旧快照 %d 部 → 保留旧快照, 不覆盖" % (len(items), len(seed_items)))
        items = seed_items
        res["_degraded"] = True
    else:
        # 新旧合并: 新版字段优先, 旧版补空缺 (title/cover 别丢)
        merged = {x["id"]: x for x in seed_items if isinstance(x, dict) and x.get("id")}
        for x in items:
            if isinstance(x, dict) and x.get("id"):
                old = merged.get(x["id"]) or {}
                for k, v in old.items():
                    if not x.get(k) and v:
                        x[k] = v
                merged[x["id"]] = x
        if merged:
            items = list(merged.values())

    if err:
        res["_errors"].append("shorts: %s" % err)
    res["items"] = items
    print("  [shorts] %d 部 (成功 %d 页)" % (len(items), pages))
    for i in infos[:4]:
        print("    r%d page%d via=%s http=%s cf=%s bytes=%s %s"
              % (i["round"], i["page"], i["via"], i["http"], i["cf"], i["bytes"], i["error"]))

    # 剧集 → 集数表 (只抓还没抓过的, 控制耗时)
    #
    # 注意: build_es_snapshot.py 会把详情归一成 {id,title,cover,desc,eps,epTotal,
    # access,views,updatedAt}。这里如果只写 title/cover/eps, 归一后 meta 会缺字段,
    # 详情页的简介/播放量/标签就是空的。所以从列表卡片把 meta 一并带上。
    details = dict(seed_details or {})
    by_id = {c["id"]: c for c in items if isinstance(c, dict) and c.get("id")}
    # 两类都要抓:
    #   1. 完全没条目的新剧
    #   2. 有条目但 eps 为空的 (早期抓失败留下的, 不补就永远是空的)
    todo = [c for c in items[:60]
            if c["id"] not in details or not (details.get(c["id"]) or {}).get("eps")]
    for c in todo:
        eps, einfo = fetch_children(c["id"])
        if eps is None:
            continue
        details[c["id"]] = {
            "id": c["id"],
            "title": c.get("title") or "",
            "cover": c.get("cover") or "",
            "desc": c.get("desc") or "",
            "tags": c.get("tags") or [],
            "access": c.get("access") or "",
            "views": c.get("views") or 0,
            "epTotal": len(eps),
            "updatedAt": c.get("updatedAt") or "",
            "eps": eps,
        }
        time.sleep(0.6)

    # 补齐已有条目缺失的 meta (早期版本只写了 title/cover/eps)
    for k, v in details.items():
        c = by_id.get(k)
        if not c:
            continue
        v.setdefault("id", k)
        for f in ("desc", "access", "updatedAt"):
            if not v.get(f) and c.get(f):
                v[f] = c[f]
        if not v.get("tags") and c.get("tags"):
            v["tags"] = c["tags"]
        if not v.get("views") and c.get("views"):
            v["views"] = c["views"]
        if not v.get("epTotal") and (v.get("eps") or []):
            v["epTotal"] = len(v["eps"])

    print("  [detail] %d 部有集数表 (本轮新增 %d)" % (len(details), len(details) - len(seed_details or {})))

    res["_cats"] = cats or []
    res["_details"] = details
    res["_elapsed"] = round(time.time() - t0, 1)
    return res


def main():
    dry = "--dry" in sys.argv

    if "--probe" in sys.argv:
        p = probe()
        print(json.dumps(p, ensure_ascii=False, indent=1))
        return 0 if p.get("reachable") else 1

    # --pages N: 限制翻页数 (一次性种子抓取用, 避免在限流通道上磨太久)
    max_pages = 40
    for i, a in enumerate(sys.argv):
        if a == "--pages" and i + 1 < len(sys.argv):
            try:
                max_pages = max(1, int(sys.argv[i + 1]))
            except Exception:
                pass

    print("[sync] es (eroshort.net) ... (max_pages=%d)" % max_pages)
    res = sync(max_pages=max_pages)
    items = res["items"]
    cats = res.get("_cats") or []
    details = res.get("_details") or {}

    print("  → %d 部剧, %d 个分类, %d 部有集数表, 耗时 %ss"
          % (len(items), len(cats), len(details), res["_elapsed"]))
    for e in res["_errors"]:
        print("  !! %s" % e)

    if dry:
        print("  [dry] 不写文件")
        return 0 if items else 1

    os.makedirs(DATA_DIR, exist_ok=True)
    w = []
    if items:
        _lw = {"categories": cats, "items": items, "count": len(items),
               "pagination": {"total": len(items), "limit": len(items), "offset": 0, "has_more": False},
               "updatedAt": time.strftime("%Y-%m-%d"),
               "source": "eroshort.net"}
        if write_json_if_changed(os.path.join(DATA_DIR, "es-list.json"), _lw):
            w.append("es-list.json")
    if cats:
        if write_json_if_changed(os.path.join(DATA_DIR, "es-cats.json"), {"categories": cats, "count": len(cats)}):
            w.append("es-cats.json")
    if details:
        if write_json_if_changed(os.path.join(DATA_DIR, "es-detail.json"),
                                 {"details": details, "count": len(details),
                                  "withEps": len([1 for v in details.values() if v.get("eps")])}):
            w.append("es-detail.json")

    print("  写入: %s" % (", ".join(w) if w else "无变化"))
    return 0 if items else 1


if __name__ == "__main__":
    sys.exit(main())
