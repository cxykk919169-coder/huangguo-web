#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""搜索功能全链路诊断: 黄果 + 黄豆 的 Worker 代理与前端回退"""
import json
import sys
import urllib.parse
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else ""

KWS = ["权臣", "嫂子", "少妇", "时停", "重生"]


def get(url, timeout=40):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
        "Accept": "application/json, */*",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return None, str(e)


def count_items(txt):
    try:
        j = json.loads(txt)
    except Exception:
        return None, txt[:150]
    for key in ("items", "list", "data", "videos", "results"):
        v = j.get(key)
        if isinstance(v, list):
            return len(v), None
        if isinstance(v, dict):
            for k2 in ("list", "items", "data"):
                if isinstance(v.get(k2), list):
                    return len(v[k2]), None
    return None, json.dumps(j, ensure_ascii=False)[:150]


print("  ================ 搜索功能诊断 ================")

print("\n  === A. 黄果: /api/search ===")
for k in KWS[:3]:
    u = "%s/api/search?q=%s" % (BASE, urllib.parse.quote(k))
    s, t = get(u)
    n, err = count_items(t)
    if n is None:
        print("    [%s] %-8s -> 解析失败/无 items: %s" % (s, k, err))
    else:
        print("    [%s] %-8s -> %d 条" % (s, k, n))

print("\n  === B. 黄豆: /api/hd/search ===")
for k in KWS:
    u = "%s/api/hd/search?q=%s&page=1" % (BASE, urllib.parse.quote(k))
    s, t = get(u)
    n, err = count_items(t)
    if n is None:
        print("    [%s] %-8s -> 解析失败: %s" % (s, k, err))
    else:
        print("    [%s] %-8s -> %d 条" % (s, k, n))

print("\n  === C. 黄豆原厂 API 直接搜 (前端 hd-direct 回退用的) ===")
for k in KWS[:3]:
    u = "https://hddj.zen-vip.com/api/app/videos?keyword=%s&page=1" % urllib.parse.quote(k)
    s, t = get(u)
    n, err = count_items(t)
    if n is None:
        print("    [%s] %-8s -> 解析失败: %s" % (s, k, err))
    else:
        print("    [%s] %-8s -> %d 条" % (s, k, n))

print("\n  === D. 黄豆 /api/hd/search 的原始返回 (看结构) ===")
u = "%s/api/hd/search?q=%s&page=1" % (BASE, urllib.parse.quote("嫂子"))
s, t = get(u)
print("    status=%s  长度=%d" % (s, len(t)))
print("    " + t[:600])
