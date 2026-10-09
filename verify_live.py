# -*- coding: utf-8 -*-
"""线上端点连通性验证 —— 在 runner 上直连 Worker 域名。

为什么需要这个:
    deploy.yml 的健康检查把 FAIL 只当 warning, 所以 /api/* 全 404 时
    Deploy 仍显示 success。这个脚本独立跑, 把真实响应打出来。

用法:
    python verify_live.py <base_url>
    例: python verify_live.py https://huangguo-web.cxykk919169.workers.dev
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def probe(base, path, timeout=45):
    url = base.rstrip("/") + path
    t0 = time.time()
    req = urllib.request.Request(url, headers={"User-Agent": UA,
                                               "Accept": "*/*"})
    rec = {"path": path, "url": url}
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
            rec["status"] = r.status
            rec["bytes"] = len(body)
            rec["xbuild"] = r.headers.get("X-Build") or ""
            rec["ctype"] = (r.headers.get("Content-Type") or "")[:60]
            txt = body.decode("utf-8", "ignore")
            rec["head"] = txt[:400]
            # 试着当 JSON 解析
            try:
                j = json.loads(txt)
                rec["json"] = True
                if isinstance(j, dict):
                    rec["keys"] = sorted(j.keys())[:14]
                    for k in ("ok", "error", "build", "mirror", "source",
                              "entries", "total", "isVideo", "title",
                              "imageCount", "catName", "tags"):
                        if k in j:
                            v = j[k]
                            rec["k_" + k] = (str(v)[:120] if not isinstance(v, list)
                                             else "list[%d]" % len(v))
            except Exception:
                rec["json"] = False
            # 是不是 HTML? (说明落到静态资源了)
            rec["isHtml"] = ("<html" in txt[:400].lower()
                             or "<!doctype" in txt[:200].lower())
    except urllib.error.HTTPError as e:
        rec["status"] = e.code
        try:
            b = e.read()
            rec["bytes"] = len(b)
            rec["head"] = b.decode("utf-8", "ignore")[:300]
        except Exception:
            pass
    except Exception as e:
        rec["status"] = 0
        rec["error"] = str(e)[:200]
    rec["ms"] = int((time.time() - t0) * 1000)
    return rec


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("BASE_URL", "")
    if not base:
        print("用法: python verify_live.py <base_url>")
        return 1

    os.makedirs("verify3", exist_ok=True)
    targets = [
        ("/api/version",              "Worker 版本指纹 (最重要)"),
        ("/api/health",               "黄果健康"),
        ("/api/hjw/health",           "海角健康"),
        ("/api/hjw/list?page=1",      "海角列表"),
        ("/api/hjw/video?id=193379",  "海角图文帖"),
        ("/api/hjw/video?id=194846",  "海角视频帖"),
        ("/api/hjw/catmap",           "海角 id→板块反查表"),
        ("/api/hd/list?page=1",       "黄豆列表 (对照)"),
        ("/worker.js",                "源码保护 (期望 404)"),
        ("/data/hjw-cats.json",       "海角分类快照"),
        ("/data/hjw-catmap.json",     "海角反查表快照"),
        ("/hg-hjw.js",                "前端模块"),
    ]
    out = []
    for path, desc in targets:
        r = probe(base, path)
        r["desc"] = desc
        out.append(r)
        flag = "OK " if r.get("status") == 200 else "!! "
        if path == "/worker.js":
            flag = "OK " if r.get("status") == 404 else "!! "
        print("%s%-34s %-5s %7sB %6sms  %s"
              % (flag, path, r.get("status"), r.get("bytes", 0),
                 r.get("ms"), desc))
        # Worker 自证: 有 X-Build 就是进了 Worker
        if r.get("xbuild"):
            print("      X-Build: %s" % r["xbuild"])
        if r.get("keys"):
            print("      keys: %s" % ", ".join(r["keys"]))
        for k in ("k_ok", "k_error", "k_build", "k_entries", "k_total",
                  "k_isVideo", "k_title", "k_imageCount", "k_catName"):
            if k in r:
                print("      %-14s %s" % (k[2:] + ":", r[k]))
        if r.get("isHtml"):
            print("      [注意] 返回的是 HTML → 请求落到静态资源, Worker 没拦住")
        print()

    json.dump({"base": base, "results": out},
              open("verify3/report.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    # ---- 结论 ----
    wk = [r for r in out if r["path"].startswith("/api/")]
    alive = [r for r in wk if r.get("status") == 200]
    # X-Build 只加在静态路径, API 路径用 /api/version 的 build 字段当指纹
    ver = next((r for r in out if r["path"] == "/api/version"), None)
    build_ok = bool(ver and ver.get("status") == 200 and ver.get("json")
                    and ver.get("k_build"))
    worker_guard = next((r for r in out if r["path"] == "/worker.js"), None)
    guard_ok = bool(worker_guard and worker_guard.get("status") == 404)
    print("=" * 58)
    print("API 端点: %d/%d 返回 200" % (len(alive), len(wk)))
    print("/api/version 指纹: %s" % (ver.get("k_build") if build_ok else "拿不到"))
    print("源码保护 /worker.js: %s" % (worker_guard.get("status") if worker_guard else "?"))
    if build_ok and guard_ok and len(alive) >= len(wk) - 1:
        print(">>> 判定: Worker 正常工作")
    elif build_ok:
        print(">>> 判定: Worker 在跑, 但个别端点异常 (见上)")
    elif guard_ok:
        print(">>> 判定: 异常 —— Worker 被旁路 (run_worker_first 未生效)")
    else:
        print(">>> 判定: Worker 完全没有被调用 (run_worker_first 未生效)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
