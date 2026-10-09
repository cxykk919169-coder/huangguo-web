# -*- coding: utf-8 -*-
"""给 data/es-detail.json 里【缺条目】的剧补 meta + 集数。

fetch_es_eps.py 只能补"已有 meta 但 eps 为空"的,
而列表里有几部详情快照从来没有过 (校园成人礼 / 漂亮干姐姐),
需要先建条目。这里直接打 children 接口, 顺带从列表卡片取 meta。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_es_eps import fetch, kids_of, norm_eps, save, DETAIL  # noqa

HERE = os.path.dirname(os.path.abspath(__file__))
LIST = os.path.join(HERE, "data", "es-list.json")


def main():
    L = json.load(open(LIST, encoding="utf-8"))
    cards = {x["id"]: x for x in (L.get("items") or [])}
    J = json.load(open(DETAIL, encoding="utf-8"))
    det = J.get("details") or {}

    missing = [k for k in cards if k not in det]
    if not missing:
        print("没有缺条目的剧")
        return 0

    print("缺条目 %d 部:" % len(missing))
    got = 0
    for n, k in enumerate(missing, 1):
        c = cards[k]
        # 先建一个 meta 条目 (从列表卡片取)
        det.setdefault(k, {
            "id": k,
            "title": c.get("title") or "",
            "cover": c.get("cover") or "",
            "desc": c.get("desc") or "",
            "tags": c.get("tags") or [],
            "access": c.get("access") or "",
            "views": c.get("views") or 0,
            "epTotal": 0,
            "updatedAt": c.get("updatedAt") or "",
            "eps": [],
        })
        ci = fetch("/hierarchy/short_video/%s/children?group_by=false&include_metadata=true" % k)
        if not ci:
            print("  [%d/%d] %s (%s) FAIL" % (n, len(missing), c.get("title"), k[:8]), flush=True)
            continue
        eps = norm_eps(kids_of(ci))
        if eps:
            det[k]["eps"] = eps
            det[k]["epTotal"] = len(eps)
            got += 1
            print("  [%d/%d] %s OK %d集" % (n, len(missing), c.get("title"), len(eps)), flush=True)
        else:
            print("  [%d/%d] %s 无子集" % (n, len(missing), c.get("title")), flush=True)
        save(J, det)

    print("本轮补 %d 部" % got)
    return 0


if __name__ == "__main__":
    sys.exit(main())
