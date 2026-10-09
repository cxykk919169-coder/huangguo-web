# -*- coding: utf-8 -*-
"""走线上 Worker 重建集数表 (CI 侧跑)。

为什么走 Worker 而不是中转:
  · eroshort.net 对**本机/CI runner** 的出口是硬拦的, 只能蹭公共 CORS 中转,
    而中转是间歇性可用 → 18 部要磨半小时, 还经常失败。
  · 线上 Worker 的出口**实测是放行的** (探针 /api/es/health 返回 via="direct")。
  · worker.dev 从本机不可达, 但 **GitHub Actions runner 可达**。
  ⇒ 于是"用 runner 调 Worker, 让 Worker 去抓上游"是又快又稳的一条路。

集数层级 (踩过的坑):
  /hierarchy/short_video/{id}/children 返回**扁平全后代表**:
      depth0 collection (合集)
      depth1 video      (metadata.short_structure_type="season")  ← 整部/季, 不是集
      depth2 level_2    (metadata.short_structure_type="episode") ← 真正的集
  早先把整张表当集 → eps[0] 是 season 节点, /playlines/episode/{seasonId} 返 NOT_FOUND,
  点开任意一集都播不了。这里必须只取 episode 层。

用法:
    ES_WORKER=https://xxx.workers.dev python fetch_es_eps_worker.py
    python fetch_es_eps_worker.py --limit 5
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

WORKER = os.environ.get("ES_WORKER", "https://huangguo-web.cxykk919169.workers.dev")
HERE = os.path.dirname(os.path.abspath(__file__))
DETAIL = os.path.join(HERE, "data", "es-detail.json")
LIST = os.path.join(HERE, "data", "es-list.json")


def clean(s):
    import re
    return re.sub(r"\s+", " ", re.sub(r"\[/?sm\]", "", str(s or ""))).strip()


def is_episode_node(k):
    md = k.get("metadata") or {}
    st = md.get("short_structure_type")
    if st == "episode":
        return True
    if st in ("season", "collection"):
        return False
    return not k.get("child_count")


def get_json(path, timeout=60, tries=3):
    url = WORKER + path
    last = ""
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "Accept": "application/json",
                "User-Agent": "huangguo-ci/1.0",
            })
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8", "ignore"))
        except Exception as e:
            last = str(e)[:100]
            time.sleep(2)
    print("    ERR %s" % last, flush=True)
    return None


def norm_eps(tree):
    kids = tree.get("children") if isinstance(tree, dict) else None
    if not isinstance(kids, list):
        return []
    out = []
    for k in kids:
        if not isinstance(k, dict) or not k.get("id") or not is_episode_node(k):
            continue
        t = clean(k.get("title"))
        import re
        m = re.match(r"^第\s*([一二三四五六七八九十百零〇\d]+)\s*集\s*(.*)$", t)
        if m:
            label, sub = "第" + m.group(1) + "集", (m.group(2) or "")
        elif out:
            label, sub = "第%d集" % (len(out) + 1), t
        else:
            label, sub = "第1集", t
        cov = k.get("cover")
        cov = (cov.get("url") if isinstance(cov, dict) else cov) or ""
        item = {"id": k["id"], "ep": len(out) + 1, "label": label, "num": "", "title": sub}
        if cov:
            item["cover"] = cov
        out.append(item)
    return out


def save(J, det):
    J["details"] = det
    J["count"] = len(det)
    J["withEps"] = len([1 for v in det.values() if v.get("eps")])
    J["updatedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
    tmp = DETAIL + ".tmp"
    open(tmp, "w", encoding="utf-8").write(json.dumps(J, ensure_ascii=False, indent=1))
    os.replace(tmp, DETAIL)


def main():
    limit = 0
    if "--limit" in sys.argv:
        try:
            limit = int(sys.argv[sys.argv.index("--limit") + 1])
        except Exception:
            pass

    # 剧 id 列表: 优先用 es-list.json (列表永远最全)
    ids = []
    if os.path.exists(LIST):
        try:
            ids = [x["id"] for x in (json.load(open(LIST, encoding="utf-8")).get("items") or [])
                   if isinstance(x, dict) and x.get("id")]
        except Exception:
            ids = []
    if not ids:
        print("es-list.json 里没有 id, 退出")
        return 1

    J, det = {}, {}
    if os.path.exists(DETAIL):
        J = json.load(open(DETAIL, encoding="utf-8"))
        det = J.get("details") or {}

    # 没有 meta 条目的剧先从列表卡片建个壳
    cards = {}
    if os.path.exists(LIST):
        cards = {x["id"]: x for x in (json.load(open(LIST, encoding="utf-8")).get("items") or [])
                 if isinstance(x, dict) and x.get("id")}
    for i in ids:
        if i not in det:
            c = cards.get(i) or {}
            det[i] = {"id": i, "title": c.get("title", ""), "cover": c.get("cover", ""),
                      "desc": c.get("desc", ""), "eps": []}

    todo = [i for i in ids if det[i].get("epSchema") != 2]
    if limit:
        todo = todo[:limit]
    print("走 Worker 重建: 待处理 %d 部 / 共 %d 部" % (len(todo), len(ids)), flush=True)

    got = 0
    for n, sid in enumerate(todo, 1):
        tree = get_json("/api/es/hierarchy/short_video/%s/children?group_by=false&include_metadata=true"
                        % urllib.parse.quote(sid))
        if tree is None:
            print("  [%d/%d] %s FAIL" % (n, len(todo), det[sid].get("title") or sid[:8]), flush=True)
            continue
        eps = norm_eps(tree)
        if not eps:
            print("  [%d/%d] %s 无子集" % (n, len(todo), det[sid].get("title") or sid[:8]), flush=True)
            continue
        det[sid]["eps"] = eps
        det[sid]["epTotal"] = len(eps)
        det[sid]["epCount"] = len(eps)
        det[sid]["epSchema"] = 2
        got += 1
        print("  [%d/%d] %s OK %d 集" % (n, len(todo), det[sid].get("title") or sid[:8], len(eps)), flush=True)
        save(J, det)
        time.sleep(0.3)

    if got:
        tot = sum(len(v.get("eps") or []) for v in det.values())
        print("本轮重建 %d 部; 现 %d 部有集数, 共 %d 集"
              % (got, len([1 for v in det.values() if v.get("eps")]), tot), flush=True)
    else:
        print("本轮零产出 (不写额外变更)", flush=True)
    return 0 if got else 1


if __name__ == "__main__":
    sys.exit(main())
