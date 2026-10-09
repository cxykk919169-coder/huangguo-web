# -*- coding: utf-8 -*-
"""海角空列表诊断 (Actions runner 视角): Worker 端点 + 上游直连"""
import json
import re
import ssl
import urllib.request

W = "https://huangguo-web.cxykk919169.workers.dev"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
            return r.status, r.read()
    except Exception as e:
        code = getattr(e, "code", None)
        return (code or 0), str(e).encode()[:200]


print("## Worker 诊断\n")

print("### 1) /api/version")
st, body = get(W + "/api/version", 20)
print("- http=%s body=`%s`" % (st, body[:300].decode("utf-8", "replace")))

print("\n### 2) /api/hjw/list?page=1")
st, body = get(W + "/api/hjw/list?page=1", 90)
print("- http=%s bytes=%s" % (st, len(body)))
try:
    d = json.loads(body.decode("utf-8", "replace"))
    items = d.get("items") or []
    print("- ok=%s items=%s categories=%s" % (
        d.get("ok"), len(items), len(d.get("categories") or [])))
    for x in items[:3]:
        print("  - %s %s" % (x.get("id"), str(x.get("title"))[:24]))
    if not items:
        print("- RAW: `%s`" % json.dumps(d, ensure_ascii=False)[:300])
except Exception as e:
    print("- parse fail: %s / head: `%s`" % (e, body[:200].decode("utf-8", "replace")))

print("\n### 3) /api/hjw/sections?limit=14")
st, body = get(W + "/api/hjw/sections?limit=14", 120)
print("- http=%s bytes=%s" % (st, len(body)))
try:
    d = json.loads(body.decode("utf-8", "replace"))
    secs = d.get("sections") or []
    print("- ok=%s sections=%s" % (d.get("ok"), len(secs)))
    for s in secs:
        print("  - %s -> %s" % (s.get("name"), len(s.get("items") or [])))
    if not secs:
        print("- RAW: `%s`" % json.dumps(d, ensure_ascii=False)[:300])
except Exception as e:
    print("- parse fail: %s / head: `%s`" % (e, body[:200].decode("utf-8", "replace")))

print("\n### 4) Worker /proxy/ 图片透传 (挂代理场景图走这条)")
u = "https://pic.wlwvch.cn/upload_01/xiao/20261007/2026100716410039330.jpeg"
st, body = get(W + "/proxy/" + urllib.request.quote(u, safe=""), 30)
head = body[:120].decode("utf-8", "replace")
print("- http=%s bytes=%s head=`%s`" % (st, len(body), head if st != 200 and len(body) < 40000 else head[:60]))

print("\n### 5) 上游直连 (runner 视角)")
for u in ("https://www.hjw01.com/",
          "https://hjw01.com/",
          "https://www.hjw01.com/category/yczm/",
          "https://www.hjw01.com/category/hjyc/"):
    st, body = get(u, 25)
    n = len(re.findall(r"archives/\d+", body.decode("utf-8", "replace"))) if st == 200 else 0
    print("- %s -> http=%s bytes=%s archivesLinks=%s" % (u, st, len(body), n))
