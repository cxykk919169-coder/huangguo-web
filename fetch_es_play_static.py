# -*- coding: utf-8 -*-
"""ERO 静态播放快照生成器 (国内直连可用)

为什么需要:
    eroshort.net 的播放必须先 POST /api/v1/playback/resolve 拿授权 + manifest,
    而这一步只有 Cloudflare Worker 的出口能过 (上游对数据中心/国内 IP 硬拦)。

    但是 —— *.workers.dev 在国内被 DNS 污染 + SNI 封禁, 浏览器根本够不到 Worker。
    更糟的是授权 (license) 和 manifest 里的 grant 只有 5 分钟寿命, 没法"预先生成"。

    实测发现两个关键事实, 让静态快照成为可行方案:
      1) 分片所在的 R2 公共桶 **根本不校验 grant** ——
         https://pub-ee9ee....r2.dev/media/<media>/versions/<variant>/segment000000-<hash>.png
         不带授权也能 200, 而且 r2.dev 国内可达。
      2) license 里的内容密钥是**按 key_id 静态**的 ——
         license 的 exp 只是客户端自己的时间窗校验; 密码学上, 同一个 key_id 的
         license 任何时候解出来都是同一把 AES 内容密钥。
         (上游自己的 build-profile chunk 里明文带着 X25519 静态私钥, 也就是说
          这套封装在设计上就是公开的。)

    于是: CI 侧 (能到 Worker) 把每集的 manifest + license 抓下来落盘 →
    浏览器读同源静态文件 → 本地解出内容密钥 → 直连 r2.dev 拉分片 → 解码播放。
    全程 0 次实时上游请求, 国内直连可用。

产出:
    data/es-play/<dramaId>.json
    {
      "title": "...", "updatedAt": "...", "build": "<ES build id>",
      "eps": { "<episodeId>": {
          "ep": 1, "format": "stego_hls",
          "mediaId": "...", "variantId": "...",
          "license": "seji-20260923-v1....",
          "m3u8": "#EXTM3U\n...#EXTINF:4.000000,\n<无 grant 的分片 URL>\n..."
      } }
    }

用法:
    python fetch_es_play_static.py                # 全部剧
    python fetch_es_play_static.py --only 01a0f6  # 只做 id 前缀匹配的剧
    python fetch_es_play_static.py --limit 3      # 只做前 3 部
    python fetch_es_play_static.py --workers 6    # 并发
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
OUTDIR = os.path.join(DATA, "es-play")
DETAIL = os.path.join(DATA, "es-detail.json")

WORKER = (os.environ.get("ES_WORKER") or "https://huangguo-web.cxykk919169.workers.dev").rstrip("/")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")


def get(url, timeout=60, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA, "Accept": "*/*", "Accept-Language": "zh-CN,zh;q=0.9"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.read()
        except Exception as e:
            last = e
            time.sleep(1.2 * (i + 1))
    raise last


def jget(url, timeout=60, tries=3):
    st, b = get(url, timeout, tries)
    return json.loads(b.decode("utf-8", "ignore"))


def strip_grant(m3u8):
    """把分片 URL 的 ?grant=... 去掉 —— R2 桶不校验, 去掉后链接永不过期"""
    out = []
    for line in m3u8.splitlines():
        s = line.strip()
        if s and not s.startswith("#"):
            s = s.split("?")[0]
        out.append(s)
    return "\n".join(out) + "\n"


def probe_ep(ep_id):
    """经 Worker 拿某一集的播放信息"""
    j = jget("%s/api/es/ep?epId=%s" % (WORKER, urllib.parse.quote(ep_id)))
    return j


def fetch_manifest(rel_url):
    """rel 形如 /api/v1/playback/manifest/<variant>?grant=...  → 走 Worker 原始透传"""
    if rel_url.startswith("/api/v1/"):
        path = rel_url[len("/api/v1/"):]
    elif rel_url.startswith("/api/"):
        path = rel_url[len("/api/"):]
    else:
        return None
    st, b = get("%s/api/es/raw/%s" % (WORKER, path), timeout=90, tries=3)
    txt = b.decode("utf-8", "ignore")
    return txt if txt.startswith("#EXTM3U") else None


def do_ep(rec):
    ep_id, ep_no = rec
    try:
        j = probe_ep(ep_id)
    except Exception as e:
        return ep_id, None, "probe:" + str(e)[:60]
    if not j or not j.get("ok"):
        return ep_id, None, "locked:" + str(j.get("reason") or j.get("error") or "?")[:40]
    if j.get("format") != "stego_hls":
        return ep_id, None, "nondelivery:" + str(j.get("format"))[:20]
    st = j.get("stego") or {}
    if not st.get("license"):
        return ep_id, None, "nolicense"
    rel = j.get("url") or ""
    try:
        m3u8 = fetch_manifest(rel)
    except Exception as e:
        return ep_id, None, "manifest:" + str(e)[:60]
    if not m3u8:
        return ep_id, None, "manifest_empty"
    item = {
        "ep": ep_no,
        "format": "stego_hls",
        "mediaId": j.get("mediaId") or st.get("media_id") or "",
        "variantId": j.get("assetVersion") or st.get("variant_id") or "",
        "license": st["license"],
        "m3u8": strip_grant(m3u8),
    }
    return ep_id, item, ""


def save(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)
    return os.path.getsize(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="drama id 前缀过滤")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=5)
    ap.add_argument("--skip-done", action="store_true", help="已有且非空的剧跳过")
    args = ap.parse_args()

    if not os.path.exists(DETAIL):
        print("!! 缺少", DETAIL, "(先跑 fetch_es_eps_worker.py / sync)")
        return 1
    det = json.load(open(DETAIL, encoding="utf-8"))
    details = det.get("details") or {}
    print("[es-play] 剧数 %d  源 %s" % (len(details), WORKER))

    ok_dramas = ok_eps = 0
    for did, d in details.items():
        if args.only and not did.startswith(args.only):
            continue
        if args.limit and ok_dramas >= args.limit:
            break
        eps = d.get("eps") or []
        if not eps:
            continue
        outpath = os.path.join(OUTDIR, did + ".json")
        if args.skip_done and os.path.exists(outpath) and os.path.getsize(outpath) > 200:
            ok_dramas += 1
            continue

        t0 = time.time()
        got, miss = {}, []
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
            futs = {ex.submit(do_ep, (e["id"], e.get("ep") or i + 1)): e["id"]
                    for i, e in enumerate(eps)}
            for f in as_completed(futs):
                eid, item, why = f.result()
                if item:
                    got[eid] = item
                else:
                    miss.append((eid, why))

        # 与旧文件合并, 不丢已有成果
        old = {}
        if os.path.exists(outpath):
            try:
                old = (json.load(open(outpath, encoding="utf-8")).get("eps") or {})
            except Exception:
                old = {}
        merged = dict(old)
        merged.update(got)

        obj = {
            "id": did,
            "title": d.get("title") or "",
            "cover": d.get("cover") or "",
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "build": "dcdcc161385053f622cedf86ed610abd33dae3e034af5366a8a76a058baad118",
            "epTotal": len(eps),
            "epOk": len(merged),
            "eps": merged,
        }
        size = save(outpath, obj)
        ok_dramas += 1
        ok_eps += len(got)
        print("  %-14s %2d/%2d 集  %6dB  %4.1fs  %s" % (
            (d.get("title") or did)[:14], len(got), len(eps), size,
            time.time() - t0, ("缺: " + ", ".join(w for _, w in miss[:3])) if miss else ""))

    # 索引
    idx = {"updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "dramas": sorted(os.path.splitext(f)[0] for f in os.listdir(OUTDIR) if f.endswith(".json"))} \
        if os.path.isdir(OUTDIR) else {"dramas": []}
    save(os.path.join(DATA, "es-play-index.json"), idx)
    print("[es-play] 完成: %d 部 / %d 集  ->  data/es-play/" % (ok_dramas, ok_eps))
    return 0


if __name__ == "__main__":
    sys.exit(main())
