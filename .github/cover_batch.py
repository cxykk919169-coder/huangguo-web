#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""黄果封面批量验证: 随机抽 12 张, 全部走 /img, 校验每张都是真图"""
import json
import sys
import urllib.parse
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else ""
N = int(sys.argv[2]) if len(sys.argv) > 2 else 12


def get(url, raw=False, timeout=40):
    req = urllib.request.Request(url, headers={"User-Agent": "hg-verify/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = r.read()
        return (r.status, d) if raw else (r.status, d.decode("utf-8", "replace"))


def isimg(b):
    if b[:3] == b"\xff\xd8\xff":
        return "JPEG"
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "PNG"
    if b[8:12] == b"WEBP":
        return "WEBP"
    if b[4:8] == b"ftyp":
        return "HEIF"
    if b[:3] == b"GIF":
        return "GIF"
    return None


print("  === 黄果封面批量解密验证 ===")
try:
    _, body = get(BASE + "/api/list")
    j = json.loads(body)
except Exception as e:
    print("  [X ] 列表失败: %s" % e)
    print("  RESULT FAIL 1")
    sys.exit(1)

items = [x for x in j.get("items", []) if str(x.get("cover", "")).startswith("http")
         and "placeholder" not in x.get("cover", "")]
# 均匀取样
step = max(1, len(items) // N)
sample = items[::step][:N]
print("  列表 %d 条真封面, 抽样 %d 张" % (len(items), len(sample)))

ok = 0
bad = []
for i, it in enumerate(sample, 1):
    cu = it["cover"]
    enc = urllib.parse.quote(cu, safe="")
    try:
        c, blob = get("%s/img?u=%s" % (BASE, enc), raw=True)
        fmt = isimg(blob)
        if c == 200 and fmt and len(blob) > 3000:
            ok += 1
            print("  [OK %2d] %-6s %7dB  %s" % (i, fmt, len(blob), it.get("title", "")[:26]))
        else:
            bad.append((it.get("title", ""), c, len(blob), blob[:4].hex()))
            print("  [X  %2d] status=%s %dB magic=%s  %s" % (i, c, len(blob), blob[:4].hex(), it.get("title", "")[:26]))
    except Exception as e:
        bad.append((it.get("title", ""), "ERR", str(e)[:40], ""))
        print("  [X  %2d] %s  %s" % (i, str(e)[:60], it.get("title", "")[:26]))

print("\n  成功 %d / %d" % (ok, len(sample)))
if bad:
    print("  失败清单:")
    for t, c, n, m in bad:
        print("    %s  status=%s size=%s magic=%s" % (t[:30], c, n, m))
print("  RESULT %s" % ("OK" if ok == len(sample) and sample else "FAIL"))
sys.exit(0 if ok == len(sample) and sample else 1)
