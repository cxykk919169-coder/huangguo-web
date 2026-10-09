# -*- coding: utf-8 -*-
"""只补集数表: 对 data/es-detail.json 里 eps 为空的条目抓 children 接口。

为什么单独写:
  上游 /shorts/{id} 不带集数, 集数在 /hierarchy/short_video/{id}/children。
  fetch_es_once.py 一次要抓详情+集数两个接口, 在中转抖动下很慢。
  这个脚本只打 children 一个接口, 请求量减半, 适合"已经有 meta、只想补集数"的场景。

用法:
    python fetch_es_eps.py            # 补全部缺的
    python fetch_es_eps.py --limit 4  # 只补 4 部
"""
import json
import os
import re
import ssl
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

API = "https://eroshort.net/api/v1"
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
    ("ao-raw", "https://api.allorigins.win/raw?url={q}", False),
    ("ao-get", "https://api.allorigins.win/get?url={q}", True),
    ("corslol", "https://api.cors.lol/?url={q}", False),
    ("codetabs", "https://api.codetabs.com/v1/proxy?quest={q}", False),
]

HERE = os.path.dirname(os.path.abspath(__file__))
DETAIL = os.path.join(HERE, "data", "es-detail.json")


def clean(s):
    return re.sub(r"\s+", " ", re.sub(r"\[/?sm\]", "", str(s or ""))).strip()


def _try(name, pat, isget, sub, timeout):
    u = pat.format(q=urllib.parse.quote(API + sub, safe=""))
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers=HDR),
                                   timeout=timeout, context=CTX)
        t = r.read().decode("utf-8", "replace")
        if r.status != 200 or "you have been blocked" in t:
            return None
        if isget:
            try:
                env = json.loads(t)
                if isinstance(env, dict) and isinstance(env.get("contents"), str):
                    t = env["contents"]
            except Exception:
                pass
        if t.lstrip()[:1] == "<":
            return None
        return json.loads(t)
    except Exception:
        return None


def fetch(sub, timeout=14, tries=5):
    """并发打所有中转, 谁先回谁赢。

    原来是一条条串行试 (4 中转 × 25s) → 单部最坏 100s, 18 部要半小时起。
    并发竞速把一轮压到 15s, 命中率靠**多轮**而不是**长超时**来拿。
    """
    for _ in range(tries):
        with ThreadPoolExecutor(max_workers=len(ENDPOINTS)) as ex:
            futs = [ex.submit(_try, nm, pat, isget, sub, timeout)
                    for nm, pat, isget in ENDPOINTS]
            for f in futs:
                r = f.result()
                if r is not None:
                    return r
        time.sleep(1)
    return None


def is_episode_node(k):
    """只认真正的"集"。

    /hierarchy/short_video/{id}/children 返回的是**扁平的全后代列表**, 不是只有集:
        depth0  collection  (合集, 就是 short_video 自己)
        depth1  video       (metadata.short_structure_type = "season")  ← 季/整部, 不是集
        depth2  level_2     (metadata.short_structure_type = "episode") ← 这才是集
    早先直接把 children 全当集, 于是:
        - eps[0] = 那个 season 节点 → /playlines/episode/{seasonId} 返 NOT_FOUND
        - 真正的第 1 集被挪到 eps[1], 全部错位, 最后一集丢失
    这就是"点开哪一集都播不了"的直接原因。

    判定优先级: metadata 明确标注 > 叶子节点(child_count==0)。
    """
    md = k.get("metadata") or {}
    st = md.get("short_structure_type")
    if st == "episode":
        return True
    if st in ("season", "collection"):
        return False
    return not k.get("child_count")


def norm_eps(kids):
    eps = []
    for k in (kids or []):
        if not isinstance(k, dict) or not k.get("id"):
            continue
        if not is_episode_node(k):
            continue
        t = clean(k.get("title"))
        m = re.match(r"^第\s*([一二三四五六七八九十百零〇\d]+)\s*集\s*(.*)$", t)
        if m:
            label, sub = "第" + m.group(1) + "集", (m.group(2) or "")
        elif eps:
            label, sub = "第%d集" % (len(eps) + 1), t
        else:
            label, sub = "第1集", t
        cov = k.get("cover")
        cov = (cov.get("url") if isinstance(cov, dict) else cov) or ""
        item = {"id": k["id"], "ep": len(eps) + 1, "label": label, "num": "", "title": sub}
        if cov:
            item["cover"] = cov
        if md := (k.get("metadata") or {}):
            if md.get("duration") is not None:
                item["dur"] = md.get("duration")
        eps.append(item)
    return eps


def kids_of(ci):
    cd = ci.get("data") if isinstance(ci, dict) and "data" in ci else ci
    if isinstance(cd, dict):
        k = cd.get("children")
        if isinstance(k, list):
            return k
    if isinstance(cd, list):
        return cd
    return []


def save(J, det):
    """增量落盘: 每补到一部就写一次。
    中转抖动下单部可能耗 1-2 分钟, 全攒到最后一次性写的话,
    进程被中断/超时 (CI runner 或本地) 就全军覆没 —— 之前就是这样丢的。"""
    J["details"] = det
    J["count"] = len(det)
    J["withEps"] = len([1 for v in det.values() if v.get("eps")])
    tmp = DETAIL + ".tmp"
    open(tmp, "w", encoding="utf-8").write(json.dumps(J, ensure_ascii=False, indent=1))
    os.replace(tmp, DETAIL)          # 原子替换, 避免写到一半留半截文件


def main():
    limit = 0
    rebuild = "--rebuild" in sys.argv
    if "--limit" in sys.argv:
        try:
            limit = int(sys.argv[sys.argv.index("--limit") + 1])
        except Exception:
            pass

    if not os.path.exists(DETAIL):
        print("缺 %s" % DETAIL)
        return 1

    J = json.load(open(DETAIL, encoding="utf-8"))
    det = J.get("details") or {}
    # --rebuild: 无视已有集数全部重抓。
    # 旧快照的集数取错了层级 (把 depth1 的 season 节点当成第 1 集), 必须整体重写。
    # 用 epSchema 标记版本: 抓成功才打标, 于是重跑只处理没打标的, 天然可续跑收敛。
    if rebuild:
        need = [k for k, v in det.items() if v.get("epSchema") != 2]
    else:
        need = [k for k, v in det.items() if not (v.get("eps") or [])]
    if limit:
        need = need[:limit]
    print("待补 %d 部%s" % (len(need), " (rebuild)" if rebuild else ""), flush=True)

    got = 0
    for n, k in enumerate(need, 1):
        ci = fetch("/hierarchy/short_video/%s/children?group_by=false&include_metadata=true" % k)
        if not ci:
            print("  [%d/%d] %s (%s) FAIL" % (n, len(need), det[k].get("title") or "?", k[:8]), flush=True)
            continue
        eps = norm_eps(kids_of(ci))
        if not eps:
            print("  [%d/%d] %s (%s) 无子集" % (n, len(need), det[k].get("title") or "?", k[:8]), flush=True)
            continue
        det[k]["eps"] = eps
        det[k]["epTotal"] = len(eps)
        det[k]["epCount"] = len(eps)
        det[k]["epSchema"] = 2
        got += 1
        print("  [%d/%d] %s OK %d集" % (n, len(need), det[k].get("title", k[:8]), len(eps)), flush=True)
        save(J, det)                 # 立刻落盘, 中断也不丢
        time.sleep(1)

    if not got:
        print("本轮没补到任何集数, 不写文件 (防退化)", flush=True)
        return 1

    print("本轮补 %d 部, 现 %d/%d 部有集数" % (got, J["withEps"], len(det)), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
