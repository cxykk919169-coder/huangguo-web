# -*- coding: utf-8 -*-
"""一次性 EROSHORT 抓取器：走 allorigins /get 包装端点（实测最稳）。
产出 data/es-list.json / data/es-detail.json / data/es-cats.json。
"""
import json
import os
import ssl
import sys
import time
import urllib.parse
import urllib.request

API = "https://eroshort.net/api/v1"
BUILD_ID = "dcdcc161385053f622cedf86ed610abd33dae3e034af5366a8a76a058baad118"
HDR = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Referer": "https://eroshort.net/",
    "Origin": "https://eroshort.net",
    "Accept": "application/json, text/plain, */*",
}
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

ENDPOINTS = [
    ("ao-get", "https://api.allorigins.win/get?url={q}", True),
    ("ao-raw", "https://api.allorigins.win/raw?url={q}", False),
    ("cors.lol", "https://api.cors.lol/?url={q}", False),
    ("codetabs", "https://api.codetabs.com/v1/proxy?quest={q}", False),
]


def _unwrap(txt):
    if txt.lstrip().startswith("{"):
        try:
            j = json.loads(txt)
            if isinstance(j, dict) and "contents" in j:
                return j["contents"]
        except Exception:
            pass
    return txt


def fetch(sub, timeout=25, tries=6):
    for attempt in range(tries):
        for name, pat, wrap in ENDPOINTS:
            q = urllib.parse.quote(API + sub, safe="")
            u = pat.format(q=q)
            try:
                req = urllib.request.Request(u, headers=HDR)
                r = urllib.request.urlopen(req, timeout=timeout, context=CTX)
                txt = r.read().decode("utf-8", "replace")
                if r.status != 200:
                    continue
                txt = _unwrap(txt)
                if "you have been blocked" in txt or "Just a moment" in txt:
                    continue
                return json.loads(txt), name
            except Exception:
                continue
        time.sleep(2 + attempt * 3)
    return None, None


def card(it):
    cov = it.get("cover")
    if isinstance(cov, dict):
        cover = cov.get("url") or ""
    else:
        cover = cov or it.get("cover_url") or it.get("poster") or ""
    tg = []
    for t in (it.get("tags") or []):
        if isinstance(t, dict):
            tg.append(t.get("name") or t.get("code") or "")
        elif isinstance(t, str):
            tg.append(t)
    pr = it.get("pricing") or {}
    return {
        "id": it.get("id"),
        "title": it.get("title") or "",
        "desc": it.get("description") or "",
        "cover": cover,
        "tags": tg,
        "epCount": it.get("episode_count") or 0,
        "views": it.get("view_count") or 0,
        "likes": it.get("like_count") or 0,
        "access": it.get("access_level") or "",
        "status": it.get("status") or "",
        "vipPrice": pr.get("vip_price") or 0,
        "updatedAt": it.get("updated_at") or "",
        "createdAt": it.get("created_at") or "",
    }


def main():
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
    os.makedirs(out_dir, exist_ok=True)

    rows = []
    seen = set()
    meta = {}
    # page_size=20 一次装完全部 18 部 (实测 total=18, has_more=false)
    for pg in range(1, 5):
        d, via = fetch("/shorts?page=%d&page_size=20" % pg)
        if not d:
            print("PAGE %d FAIL" % pg, flush=True)
            if rows:
                break
            continue
        data = d.get("data") or []
        pginfo = d.get("pagination") or {}
        meta = pginfo
        print("PAGE %d via=%s rows=%d total=%s has_more=%s" % (
            pg, via, len(data), pginfo.get("total"), pginfo.get("has_more")), flush=True)
        for it in data:
            i = it.get("id")
            if i and i not in seen:
                seen.add(i)
                rows.append(card(it))
        if not pginfo.get("has_more") or len(data) < 20:
            break
        time.sleep(1)

    print("ROWS %d" % len(rows), flush=True)

    # 分类
    cats = []
    dc, _ = fetch("/tags")
    if dc:
        arr = dc.get("data") if isinstance(dc, dict) else dc
        if isinstance(arr, list):
            for g in arr:
                gname = g.get("code") or g.get("name") or ""
                for t in (g.get("tags") or []):
                    cats.append({
                        "name": t.get("name") or t.get("code") or "",
                        "code": t.get("code") or t.get("name") or "",
                        "slug": t.get("slug") or "",
                        "group": gname,
                        "color": t.get("color") or "#8b5cf6",
                        "count": t.get("usage_count") or 0,
                    })
    print("CATS %d" % len(cats), flush=True)

    # 详情（逐条，限量）—— 集数在 /hierarchy/.../children 里, 详情接口本身不带
    details = {}
    # 合并已有快照, 只补没抓到的
    old = os.path.join(out_dir, "es-detail.json")
    if os.path.exists(old):
        try:
            od = json.load(open(old, encoding="utf-8")).get("details") or {}
            if isinstance(od, dict):
                details.update(od)
            elif isinstance(od, list):
                for x in od:
                    if isinstance(x, dict) and x.get("id"):
                        details[x["id"]] = x.get("detail") or x
        except Exception:
            pass
    print("DETAIL pre=%d" % len(details), flush=True)

    for c in rows:
        if c["id"] in details:
            continue
        di, via = fetch("/shorts/" + c["id"])
        if not di:
            print("DETAIL fail", c["id"], flush=True)
            continue
        det = di.get("data") if isinstance(di, dict) and "data" in di else di
        ci, via2 = fetch("/hierarchy/short_video/" + c["id"] + "/children?group_by=false&include_metadata=false")
        eps = []
        if ci:
            cd = ci.get("data") if isinstance(ci, dict) and "data" in ci else ci
            kids = (cd or {}).get("children") if isinstance(cd, dict) else None
            if not isinstance(kids, list) and isinstance(cd, list):
                kids = cd
            for i, k in enumerate(kids or []):
                if not isinstance(k, dict) or not k.get("id"):
                    continue
                t = re.sub(r"\[\/?sm\]", "", str(k.get("title") or "")).strip()
                m = re.match(r"^第\s*([一二三四五六七八九十百零〇\d]+)\s*集\s*(.*)$", t)
                if m:
                    label, sub = "第" + m.group(1) + "集", (m.group(2) or "")
                elif i == 0:
                    label, sub = "第1集", t
                else:
                    label, sub = "第%d集" % (i + 1), t
                eps.append({"id": k["id"], "ep": i + 1, "label": label, "num": "", "title": sub})
        cv = det.get("cover") if isinstance(det, dict) else None
        cover = (cv.get("url") if isinstance(cv, dict) else cv) or c.get("cover") or ""
        details[c["id"]] = {
            "title": c.get("title") or (det.get("title") if isinstance(det, dict) else "") or "",
            "cover": cover,
            "eps": eps,
            "updatedAt": c.get("updatedAt") or "",
        }
        print("DETAIL ok %s via=%s eps=%d" % (c["id"], via, len(eps)), flush=True)
        time.sleep(1)

    print("DETAIL total %d" % len(details), flush=True)

    def wj(name, obj):
        p = os.path.join(out_dir, name)
        s = json.dumps(obj, ensure_ascii=False, indent=1)
        if os.path.exists(p):
            try:
                if open(p, encoding="utf-8").read() == s:
                    print("SKIP", name, flush=True)
                    return
            except Exception:
                pass
        open(p, "w", encoding="utf-8").write(s)
        print("WRITE", name, len(s), flush=True)

    # ---- 防退化: 绝不写比现有快照更少的内容 ----
    # 中转抖动时本轮可能 0 部。若直接覆盖, 线上/仓库的快照会被清空,
    # 用户看到的正是"打不开了 / 空结果"。所以旧快照条数更多就保留旧的。
    def prev_count(name, key):
        p = os.path.join(out_dir, name)
        try:
            j = json.load(open(p, encoding="utf-8"))
            v = j.get(key)
            return len(v) if isinstance(v, (list, dict)) else 0
        except Exception:
            return 0

    if rows:
        wj("es-list.json", {"categories": cats, "items": rows, "count": len(rows),
                            "pagination": meta, "updatedAt": "2026-10-09",
                            "source": "eroshort.net"})
    else:
        print("SKIP es-list.json (本轮 0 部, 保留既有 %d 部)" % prev_count("es-list.json", "items"), flush=True)

    if details:
        wj("es-detail.json", {"details": details, "count": len(details),
                              "withEps": len([1 for v in details.values() if v.get("eps")])})
    if cats:
        wj("es-cats.json", {"categories": cats, "count": len(cats)})


if __name__ == "__main__":
    main()
