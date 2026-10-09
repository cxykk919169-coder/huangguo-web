# -*- coding: utf-8 -*-
"""ERO 快照归并器。

把手上所有来源 (原始抓取 _p1.json / 已有 es-detail.json / 任意中间产物)
归并成一份**确定的、不再被慢速抓取覆盖**的 data/es-*.json。

用法:
    python build_es_snapshot.py            # 归并并写出
    python build_es_snapshot.py --merge f  # 额外并入某个 list/detail json
"""
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")


def clean(s):
    s = re.sub(r"\[/?sm\]", "", str(s or ""))
    s = re.sub(r"官方|无码|高清|HD|完整版", "", s)
    return re.sub(r"\s+", " ", s).strip()


def tidy_title(t):
    """剥掉标题里塞的运营文案, 只留剧名。"""
    t = clean(t)
    t = re.sub(r"\s*共\s*\d+\s*(?:/\s*\d+)?\s*集.*$", "", t)
    t = re.sub(r"\s*已完结.*$", "", t)
    t = re.sub(r"\s*(?:可)?整部(?:解锁更优惠|购买).*$", "", t)
    t = re.sub(r"\s*每周.*$", "", t)
    return t.strip()


def parse_ep(title_raw):
    m = re.search(r"共\s*(\d+)\s*/\s*(\d+)\s*集", title_raw)
    if m:
        return int(m.group(2))
    m = re.search(r"共\s*(\d+)\s*集", title_raw)
    if m:
        return int(m.group(1))
    return 0


def card(it):
    cov = it.get("cover")
    cover = (cov.get("url") if isinstance(cov, dict) else cov) or it.get("cover_url") or ""
    raw = clean(it.get("title"))
    tags = []
    for t in (it.get("tags") or []):
        if isinstance(t, dict):
            tags.append(t.get("name") or t.get("code") or "")
        elif isinstance(t, str):
            tags.append(t)
    pr = it.get("pricing") or {}
    return {
        "id": it.get("id"),
        "title": tidy_title(raw),
        "titleRaw": raw,
        "desc": clean(it.get("description")),
        "cover": cover,
        "tags": [x for x in tags if x],
        "epCount": it.get("episode_count") or parse_ep(raw),
        "views": it.get("view_count") or 0,
        "likes": it.get("like_count") or 0,
        "access": it.get("access_level") or "",
        "status": it.get("status") or "",
        "vipPrice": pr.get("vip_price") or 0,
        "updatedAt": it.get("updated_at") or "",
        "createdAt": it.get("created_at") or "",
    }


def load_json(p):
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return None


def norm_tags(v):
    """tags 可能是 ['漫改'] / [{name,code}] / 'a,b' → 统一成字符串数组。

    上游 tags 里混有前导/尾随空格 (如 ' 校园'), 不 trim 的话
    分类 tab 的 code 永远匹配不上, 那个分类点进去就是空的。
    """
    if not v:
        return []
    if isinstance(v, str):
        return [x.strip() for x in re.split(r"[,，\s]+", v) if x.strip()]
    if isinstance(v, list):
        out = []
        for t in v:
            if isinstance(t, str):
                s = t.strip()
                if s:
                    out.append(s)
            elif isinstance(t, dict):
                n = t.get("name") or t.get("code")
                if n and str(n).strip():
                    out.append(str(n).strip())
        return out
    return []


def norm_cover(v):
    """cover 可能是 str / {url,width,...} / None → 统一成 URL 字符串。

    sync_es.py 的 card() 把上游 cover 对象原样写进了快照 (url 嵌在子字段里),
    而前端 and 浏览器 <img> 需要的是纯 URL —— 不拆开的话所有卡片都没图。
    """
    if not v:
        return ""
    if isinstance(v, str):
        return v.strip()
    if isinstance(v, dict):
        return (v.get("url") or v.get("src") or "").strip()
    return ""


def slim(c):
    """清掉重型/冗余字段, 规范化 tags 与 cover。
    raw 存着完整上游对象, 会让快照从 13KB 涨到 45KB。"""
    c.pop("raw", None)
    c["tags"] = norm_tags(c.get("tags"))
    c["cover"] = norm_cover(c.get("cover"))
    return c
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return None


def collect_lists():
    """所有能提供 card 的来源, 按 id 去重, 保留字段更全的那条。"""
    by_id = {}

    def add(c):
        if not c or not c.get("id"):
            return
        c = slim(c)
        old = by_id.get(c["id"])
        if not old:
            by_id[c["id"]] = c
            return
        # 合并: 空字段用新的补, 已有值不覆盖
        for k, v in c.items():
            if not old.get(k) and v:
                old[k] = v

    # 1) 原始抓取件 (最全, 18 部)
    for f in glob.glob(os.path.join(HERE, "_p*.json")) + glob.glob(os.path.join(HERE, "_es_rows.json")):
        j = load_json(f)
        if not j:
            continue
        rows = None
        if isinstance(j, dict) and isinstance(j.get("contents"), str):
            try:
                rows = (json.loads(j["contents"]) or {}).get("data")
            except Exception:
                rows = None
        elif isinstance(j, list):
            rows = j
        elif isinstance(j, dict) and isinstance(j.get("data"), list):
            rows = j["data"]
        for it in (rows or []):
            if isinstance(it, dict):
                add(card(it) if "title" in it else None)

    # 2) 已有快照 (可能是 sync_es 写的, 字段已规范化)
    for f in ([os.path.join(DATA, "es-list.json")]
              + glob.glob(os.path.join(HERE, "_bak", "es-list*.json"))
              + glob.glob(os.path.join(HERE, "_es_list*.json"))):
        j = load_json(f)
        if not j:
            continue
        for c in (j.get("items") or []):
            if isinstance(c, dict) and c.get("id"):
                c2 = dict(c)
                c2.setdefault("titleRaw", clean(c.get("title")))
                if c2.get("title"):
                    c2["title"] = tidy_title(c2["title"])
                add(c2)

    return list(by_id.values())


def collect_details():
    """详情: dict{id:{title,cover,eps}} 或 list[{id,detail|eps}] 都吃。

    ⚠ 只收"有 eps 的", 并且按 id 合并时**保留已有的 eps**。
      sync_es.py 的 seed 会把上游 /shorts/{id} 的原始详情对象也写进 details ——
      那些对象没有 eps 字段 (集数在另一个接口)。如果无差别合并, 带集数的条目
      会被无 eps 的版本覆盖, 详情页就只剩标题没有剧集列表。
    """
    out = {}

    def put(k, v):
        if not k or not isinstance(v, dict):
            return
        old = out.get(k)
        eps = v.get("eps") or []
        if old:
            oeps = old.get("eps") or []
            # 保留有 eps 的那份; 两份都有则用新的
            if oeps and not eps:
                return
            for kk, vv in v.items():
                if not old.get(kk) and vv:
                    old[kk] = vv
            old["eps"] = eps if eps else oeps
            return
        out[k] = v

    for f in ([os.path.join(DATA, "es-detail.json")]
              + glob.glob(os.path.join(HERE, "_bak", "es-detail*.json"))
              + glob.glob(os.path.join(HERE, "_es_detail*.json"))):
        j = load_json(f)
        if not j:
            continue
        D = j.get("details")
        if isinstance(D, dict):
            for k, v in D.items():
                put(k, v)
        elif isinstance(D, list):
            for x in D:
                if isinstance(x, dict) and x.get("id"):
                    put(x["id"], x.get("detail") or x)
    return out


def collect_cats():
    for f in [os.path.join(DATA, "es-cats.json")] + glob.glob(os.path.join(HERE, "_es_cats*.json")):
        j = load_json(f)
        if j and j.get("categories"):
            return j["categories"]
    return []


def norm_eps(raw_eps):
    eps = []
    for i, k in enumerate(raw_eps or []):
        if not isinstance(k, dict) or not k.get("id"):
            continue
        t = clean(k.get("title"))
        m = re.match(r"^第\s*([一二三四五六七八九十百零〇\d]+)\s*集\s*(.*)$", t)
        if m:
            label, sub = "第" + m.group(1) + "集", (m.group(2) or "")
        elif i == 0:
            label, sub = "第1集", t
        else:
            label, sub = "第%d集" % (i + 1), t
        eps.append({"id": k["id"], "ep": i + 1, "label": label, "num": "", "title": sub})
    return eps


def norm_detail(k, v, card):
    """把任意形态的详情规整成 {id,title,cover,eps:[],epTotal}。

    sync_es.py 的 seed 会把上游 /shorts/{id} 原始对象 (含 slug/body/pricing 等
    十几号字段) 直接写进 details。那些对象没有 eps, 原样留在快照里会让详情页
    拿不到剧集列表, 而且体积虚高。这里统一抽成前端认的形状。
    """
    if not isinstance(v, dict):
        return None
    cov = norm_cover(v.get("cover"))
    title = v.get("title") or (card or {}).get("title") or ""
    raw_eps = v.get("eps") if isinstance(v.get("eps"), list) else []
    eps = norm_eps(raw_eps)
    return {
        "id": k,
        "title": tidy_title(title),
        "cover": cov or norm_cover((card or {}).get("cover")) or "",
        "desc": clean(v.get("description")),
        "eps": eps,
        "epTotal": len(eps) or (card or {}).get("epCount") or 0,
        "access": v.get("access_level") or (card or {}).get("access") or "",
        "views": v.get("view_count") or (card or {}).get("views") or 0,
        "updatedAt": v.get("updated_at") or (card or {}).get("updatedAt") or "",
    }


def main():
    merge = None
    if "--merge" in sys.argv:
        merge = sys.argv[sys.argv.index("--merge") + 1]

    items = collect_lists()
    details = collect_details()
    cats = collect_cats()

    if merge:
        mj = load_json(merge)
        if mj:
            for c in (mj.get("items") or []):
                if isinstance(c, dict) and c.get("id") and not any(x["id"] == c["id"] for x in items):
                    items.append(c)

    # 详情规范化: 统一成前端认的 {id,title,cover,eps,epTotal} 形状。
    # 上游原始对象 / 旧格式都在这步收口, 写出去的快照只有一种结构。
    idx = {x["id"]: x for x in items}
    nd = {}
    for k, v in details.items():
        d = norm_detail(k, v, idx.get(k))
        if d:
            nd[k] = d
    details = nd

    # 列表 epCount 与详情集数对齐
    for x in items:
        d = details.get(x["id"])
        if d and d["epTotal"]:
            x["epCount"] = max(x.get("epCount") or 0, d["epTotal"])

    items.sort(key=lambda x: x.get("createdAt") or "", reverse=True)

    def wj(name, obj):
        p = os.path.join(DATA, name)
        s = json.dumps(obj, ensure_ascii=False, indent=1)
        open(p, "w", encoding="utf-8").write(s)
        print("WRITE %-18s %7dB" % (name, len(s)))

    wj("es-list.json", {
        "categories": cats, "items": items, "count": len(items),
        "pagination": {"total": len(items), "limit": len(items), "offset": 0, "has_more": False},
        "updatedAt": "2026-10-09", "source": "eroshort.net",
    })
    wj("es-detail.json", {
        "details": details, "count": len(details),
        "withEps": len([1 for v in details.values() if v.get("eps")]),
    })
    if cats:
        wj("es-cats.json", {"categories": cats, "count": len(cats)})

    print()
    print("列表 %d 部 / 详情 %d 部 (含集数 %d 部) / 分类 %d 个" % (
        len(items), len(details), len([1 for v in details.values() if v.get("eps")]), len(cats)))
    print()
    for x in items:
        d = details.get(x["id"])
        ep = ("%d集" % d["epTotal"]) if d and d.get("eps") else ("%d集?" % x["epCount"] if x["epCount"] else "-")
        print("  %-12s %-6s %s" % (x["title"], ep, ",".join(norm_tags(x.get("tags")))))


if __name__ == "__main__":
    main()
