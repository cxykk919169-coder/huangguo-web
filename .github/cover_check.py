#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""线上封面链路自检: 抓 /api/list, 统计封面, 验证 /img 代理"""
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else ""


def get(url, raw=False, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "hg-verify/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
        return (r.status, data) if raw else (r.status, data.decode("utf-8", "replace"))


def main():
    fails = []
    print("  === 封面链路自检 ===")

    # 1. 列表
    try:
        code, body = get(BASE + "/api/list")
    except Exception as e:
        print("  [X ] /api/list 请求失败: %s" % e)
        print("  RESULT FAIL 1")
        return 1

    if code != 200:
        print("  [X ] /api/list HTTP %s" % code)
        print("  RESULT FAIL 1")
        return 1

    try:
        j = json.loads(body)
    except Exception as e:
        print("  [X ] /api/list 不是 JSON: %s" % e)
        print("  RESULT FAIL 1")
        return 1

    items = j.get("items", [])
    with_http = [x for x in items if str(x.get("cover", "")).startswith("http")]
    real = [x for x in with_http if "cover-placeholder" not in x.get("cover", "")]
    print("  [--] 列表 %d 条 / 有 http 封面 %d / 真封面 %d" % (len(items), len(with_http), len(real)))

    if not real:
        print("  [X ] 没有真实封面")
        fails.append("cover")
    else:
        print("  [OK] 封面提取正常 (%d 条真图)" % len(real))
        print("       样本: %s" % real[0]["cover"][:100])
        print("       标题: %s" % real[0].get("title", ""))

    # 2. /img 代理
    if real:
        cu = real[0]["cover"]
        enc = urllib.parse.quote(cu, safe="")
        for path in ("/img", "/api/img"):
            try:
                c2, blob = get("%s%s?u=%s" % (BASE, path, enc), raw=True)
                n = len(blob)
                magic = blob[:4]
                isimg = (magic[:3] == b"\xff\xd8\xff") or (magic[:8] == b"\x89PNG\r\n\x1a\n") or (magic[8:12] == b"WEBP") or (magic[4:8] == b"ftyp")
                if c2 == 200 and n > 2000 and isimg:
                    print("  [OK] %s 代理返回真图 (%d B, magic=%s)" % (path, n, magic.hex()))
                else:
                    print("  [X ] %s 异常 status=%s size=%d magic=%s" % (path, c2, n, magic.hex()))
                    if path == "/img":
                        fails.append("img")
            except Exception as e:
                print("  [X ] %s 请求失败: %s" % (path, e))
                if path == "/img":
                    fails.append("img")

    # 3. 坏 URL
    try:
        c3, _ = get(BASE + "/img?u=notaurl", raw=True)
        if c3 == 400:
            print("  [OK] /img 坏 URL 正确拒绝 (400)")
        else:
            print("  [--] /img 坏 URL -> %s" % c3)
    except urllib.error.HTTPError as e:
        print("  [--] /img 坏 URL -> HTTP %s" % e.code)
        c3 = e.code
    except Exception as e:
        print("  [--] /img 坏 URL 异常: %s" % e)

    # 4. 源码保护 + 请求到底有没有进 Worker
    #    X-Build 只有 Worker 自己会加, 能用来区分"Worker 返回"和"静态兜底返回"
    print("  --- 源码保护 / Worker 命中判定 ---")
    for path in ("/worker.js", "/wrangler.toml", "/_worker_deploy.js"):
        try:
            req = urllib.request.Request(BASE + path, headers={"User-Agent": "hg-verify/1.0"})
            try:
                with urllib.request.urlopen(req, timeout=25) as r:
                    code, xb, n = r.status, r.headers.get("X-Build"), len(r.read())
            except urllib.error.HTTPError as e:
                code, xb, n = e.code, e.headers.get("X-Build"), len(e.read())
            hit = "Worker" if xb else "静态兜底(没进 Worker!)"
            flag = "OK" if (code == 404 and xb) else "X "
            print("  [%s] %s -> %s  %s  %dB" % (flag, path, code, hit, n))
            if code != 404 or not xb:
                fails.append("srcguard")
        except Exception as e:
            print("  [X ] %s 请求失败: %s" % (path, e))
            fails.append("srcguard")

    # 5. 缓存头检查: sw.js / index.html 必须 no-store
    print("  --- 缓存头 (自动更新靠它) ---")
    for path in ("/sw.js", "/index.html", "/hg-direct.js"):
        try:
            req = urllib.request.Request(BASE + path, headers={"User-Agent": "hg-verify/1.0"})
            with urllib.request.urlopen(req, timeout=25) as r:
                cc = r.headers.get("Cache-Control") or ""
                xb = r.headers.get("X-Build") or ""
                good = "no-store" in cc
                print("  [%s] %-16s Cache-Control=%s  X-Build=%s" % ("OK" if good else "X ", path, cc, xb))
                if not good:
                    fails.append("cache:" + path)
        except Exception as e:
            print("  [X ] %s 失败: %s" % (path, e))
            fails.append("cache:" + path)

    print("  RESULT %s %d" % ("OK" if not fails else "FAIL", len(fails)))
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
