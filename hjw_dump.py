# -*- coding: utf-8 -*-
"""直接把 hjw01.com 的原始响应抓下来存盘分析的 GitHub Actions 任务。
放到 workflow 里跑, 因为本机被代理拦。
"""
import gzip
import os
import re
import sys
import json
import urllib.request

HOSTS = ["https://www.hjw01.com/", "https://hjw01.com/", "https://hjw1.com/",
         "https://hjw02.com/", "https://haijiao.ai/"]


def http_get(url, referer=None, timeout=25):
    req = urllib.request.Request(url, headers={
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/131.0.0.0 Safari/537.36"),
        "Accept": ("text/html,application/xhtml+xml,application/xml;q=0.9,"
                   "image/avif,image/webp,*/*;q=0.8"),
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate",
    })
    if referer:
        req.add_header("Referer", referer)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            enc = (r.headers.get("Content-Encoding") or "").lower()
            if "gzip" in enc:
                try:
                    raw = gzip.decompress(raw)
                except Exception:
                    pass
            return r.getcode(), raw.decode("utf-8", "replace"), dict(r.headers), r.geturl()
    except Exception as e:
        return 0, "", {}, str(e)


def main():
    os.makedirs("dump", exist_ok=True)
    report = []
    for u in HOSTS:
        st, body, hdr, final = http_get(u)
        name = re.sub(r"[^a-z0-9]+", "_", u.lower()) + ".html"
        with open(os.path.join("dump", name), "w", encoding="utf-8") as f:
            f.write(body)
        info = {
            "url": u, "status": st, "final": final, "bytes": len(body),
            "server": hdr.get("Server", ""), "title": "",
            "scripts": [], "cssLinks": [], "allUrls": [], "metaRefresh": "",
            "setCookie": hdr.get("Set-Cookie", "")[:200],
        }
        m = re.search(r"<title[^>]*>([^<]*)</title>", body, re.I)
        if m:
            info["title"] = m.group(1).strip()
        info["scripts"] = re.findall(r'<script[^>]+src=["\']([^"\']+)["\']', body, re.I)[:30]
        info["cssLinks"] = re.findall(r'<link[^>]+href=["\']([^"\']+\.css[^"\']*)["\']', body, re.I)[:20]
        info["metaRefresh"] = " | ".join(re.findall(
            r'<meta[^>]+http-equiv=["\']refresh["\'][^>]*>', body, re.I))[:300]
        # 所有 URL / 路径
        urls = set()
        for m in re.finditer(r'https?://[a-zA-Z0-9][a-zA-Z0-9.\-]{2,80}(?:/[^\s"\'<>\\]*)?', body):
            urls.add(m.group(0)[:200])
        for m in re.finditer(r'["\'](/[a-zA-Z0-9/_\-\.]{2,80})["\']', body):
            urls.add(m.group(1))
        info["allUrls"] = sorted(urls)[:200]
        report.append(info)
        print("=" * 70)
        print(u, "->", st, len(body), "B", "final=%s" % final)
        print("  title:", info["title"])
        print("  server:", info["server"], "| setCookie:", bool(info["setCookie"]))
        print("  metaRefresh:", info["metaRefresh"][:200])
        print("  scripts:", len(info["scripts"]))
        for s in info["scripts"][:15]:
            print("    -", s[:140])
        print("  urls(前 60):")
        for x in info["allUrls"][:60]:
            print("    ·", x[:150])

    with open("dump/index.json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print("\n已写入 dump/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
