# -*- coding: utf-8 -*-
r"""海角 · 前端 JS 挖接口。

上一轮探到:
  - apiDomain 每次请求都变 (vmdiaosj.cc -> xuutslmz.cc), 是页面级动态下发
  - apivN.<domain> 回 404 "File not found" -> 域名活, 路径不对
  - localStorage.setItem('apiDomain', X) 在页面里, X 是主站 api 域

本轮:
  1. 抓 common1/common2 bundle + DPlayer player.min.js + IM sdk
  2. 从里面挖出所有 URL / 路径 / 接口动作名
  3. 找 axios 实例的 baseURL 拼接方式
  4. 找播放接口的动作名 (getPlayUrl / play 之类)
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hjw_client import http

BASE = "https://www.hjw01.com"
REF = BASE + "/"

ASSETS = [
    "/usr/themes/haijiao3/assets/__base/js/min/common1.bundle.min.js",
    "/usr/themes/haijiao3/assets/__base/js/min/common2.bundle.min.js",
    "/usr/themes/haijiao3/assets/__base/js/min/image.0821.js",
    "/usr/plugins/DPlayer/assets/player.min.v.1.0.5.js",
    "/usr/plugins/DPlayer/assets/player-ext.min.v.1.0.0.js",
    "/usr/plugins/DPlayer/plugin/h265.min.v.1.0.7.js",
    "/usr/themes/haijiao3/assets/__base/config/css.config.js",
    "/usr/plugins/Im/assets/__base/js/im/tjim_index.js",
]

# 关注的关键词
KW = ["api.php", "baseURL", "apiDomain", "type:", "action", "type =",
      "m3u8", "playUrl", "videoUrl", "vodUrl", "decrypt", "Decrypt",
      "encrypt", "$CryptoData", "getVideo", "detail", "vod", "post"]


def main():
    os.makedirs("dump3", exist_ok=True)
    report = {"files": {}, "apiPaths": [], "types": [], "urls": []}

    all_paths = set()
    all_types = set()
    all_urls = set()
    all_bases = set()

    for path in ASSETS:
        st, body, hdr = http(BASE + path, referer=REF, timeout=30)
        name = path.rsplit("/", 1)[-1]
        with open(os.path.join("dump3", name), "w", encoding="utf-8") as f:
            f.write(body)
        print("=" * 74)
        print("[%s] %s %sB" % (path, st, len(body)))
        report["files"][path] = {"status": st, "bytes": len(body)}
        if st != 200 or not body:
            continue

        # baseURL / apiDomain
        for m in re.finditer(r'baseURL\s*[:=]\s*([^,;\n]{0,120})', body):
            all_bases.add(m.group(1).strip()[:120])
        # api.php 附近
        for m in re.finditer(r'.{90}api\.php.{160}', body, re.S):
            print("  [apiphp] ...%s..." % m.group(0).replace("\n", " ")[:260])
        # 路径形如 '/xxx/yyy'
        for m in re.finditer(r'["\'](/(?:api|ajax|action|index\.php|vod|video|post|user|play)[a-zA-Z0-9_/.\-]{0,60})["\']', body):
            all_paths.add(m.group(1))
        # type: 'xxx'
        for m in re.finditer(r'type\s*[:=]\s*["\']([a-zA-Z_][a-zA-Z0-9_]{1,40})["\']', body):
            all_types.add(m.group(1))
        # 所有 http url
        for m in re.finditer(r'https?://([a-zA-Z0-9.\-]{4,60})(/[a-zA-Z0-9_/.\-]{0,60})?', body):
            all_urls.add(m.group(0)[:140])

    print("\n" + "=" * 74)
    print("baseURL 候选:")
    for b in sorted(all_bases)[:30]:
        print("   ", b)
    report["baseURL"] = sorted(all_bases)

    print("\n路径候选 (前 80):")
    for p in sorted(all_paths)[:80]:
        print("   ", p)
    report["apiPaths"] = sorted(all_paths)

    print("\ntype 候选 (前 120):")
    for t in sorted(all_types)[:120]:
        print("   ", t)
    report["types"] = sorted(all_types)

    print("\n外链域 (前 60):")
    for u in sorted(all_urls)[:60]:
        print("   ", u)
    report["urls"] = sorted(all_urls)

    with open("dump3/report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print("\n已写入 dump3/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
