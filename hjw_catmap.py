# -*- coding: utf-8 -*-
"""分类页结构探测 —— 确认「列表页卡片里有没有板块归属」。

背景:
    海角图文帖的**详情页**没有 data-video_type_* (那是播放器属性),
    所以拿不到板块。若**分类页的卡片**带板块 slug, 就能靠反查补上。

产出: verify3/report.json
    {
      "cats": [{slug, status, bytes, cards, hasSlugInCard, sample}],
      "conclusion": "..."
    }
"""
import gzip
import io
import json
import os
import re
import ssl
import time
import urllib.request

HOSTS = ["https://www.hjw01.com", "https://hjw01.com"]
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
CATS = [("hjyc", "海角原创"), ("hjll", "海角乱伦"), ("hjcg", "热门吃瓜"),
        ("hjkp", "看片娱乐"), ("hjwh", "网黄精品"), ("hjth", "探花合集"),
        ("hjaidj", "AI短剧"), ("lmyq", "绿帽淫妻"), ("hjdm", "成人动漫"),
        ("hjby", "海角搬运"), ("yczm", "原创招募")]
OUT = os.environ.get("OUT_DIR", "verify3")

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def get(url, timeout=40):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Referer": url.rsplit("/", 2)[0] + "/",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Accept-Encoding": "gzip, deflate",
    })
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
        raw = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return r.status, raw.decode("utf-8", "ignore")


def pick_host():
    for h in HOSTS:
        try:
            st, html = get(h + "/")
            if st == 200 and len(html) > 50000:
                print("  host ok: %s (%dB)" % (h, len(html)))
                return h
        except Exception as e:
            print("  host fail: %s %s" % (h, e))
    return None


def main():
    os.makedirs(OUT, exist_ok=True)
    rep = {"cats": [], "conclusion": ""}
    host = pick_host()
    if not host:
        rep["conclusion"] = "海角不可达"
        json.dump(rep, open(os.path.join(OUT, "report.json"), "w",
                            encoding="utf-8"), ensure_ascii=False, indent=1)
        return

    for slug, name in CATS:
        url = "%s/category/%s/" % (host, slug)
        rec = {"slug": slug, "name": name, "url": url}
        try:
            st, html = get(url)
            rec["status"] = st
            rec["bytes"] = len(html)

            # 卡片: <a href="/archives/N/">
            ids = re.findall(r'href="/archives/(\d+)/?"', html)
            rec["cardCount"] = len(set(ids))

            # 关键: 卡片块里有没有出现本板块的 slug 或「板块名」
            # 方式 A: 卡片块内含 /category/<slug>/
            # 方式 B: 卡片块内含板块中文名
            blocks = []
            for m in re.finditer(
                    r'<a\s+href="/archives/(\d+)/?"([^>]*)>([\s\S]{0,1800}?)</a>',
                    html, re.I):
                blocks.append((m.group(1), m.group(3)))
            hit_slug = 0
            hit_name = 0
            sample = None
            for iid, blk in blocks:
                if ("/category/%s/" % slug) in blk:
                    hit_slug += 1
                if name in blk:
                    hit_name += 1
                if sample is None:
                    sample = {"id": iid,
                              "blkLen": len(blk),
                              "blk": re.sub(r"\s+", " ", blk)[:700]}
            rec["blocks"] = len(blocks)
            rec["hitSlugInCard"] = hit_slug
            rec["hitNameInCard"] = hit_name
            rec["sampleCard"] = sample

            # 反查可行性判定: 若本页出现的 id 都属于本板块, 就可建 id→slug 映射
            rec["canMap"] = len(set(ids)) > 0

            # 也看看分类页里有没有 data-video_type_* (可能比详情页多)
            rec["hasVideoTypeAttr"] = "data-video_type_name" in html

            print("  %-8s %-6s %dB  cards=%-4d slug命中=%-4d name命中=%-4d"
                  % (slug, st, len(html), rec["cardCount"],
                     hit_slug, hit_name))
            time.sleep(1.2)
        except Exception as e:
            rec["error"] = str(e)[:200]
            print("  %-8s ERR %s" % (slug, e))
        rep["cats"].append(rec)

    # ---- 结论 ----
    usable = [c for c in rep["cats"] if c.get("cardCount")]
    slug_hit = sum(1 for c in usable if c.get("hitSlugInCard"))
    name_hit = sum(1 for c in usable if c.get("hitNameInCard"))
    if len(usable) >= 8:
        rep["conclusion"] = (
            "分类页可反查: %d/%d 个板块页有卡片。"
            "卡片内含板块 slug 的: %d; 含板块中文名的: %d。"
            % (len(usable), len(CATS), slug_hit, name_hit))
    else:
        rep["conclusion"] = "分类页可用性不足 (%d/%d)" % (len(usable), len(CATS))

    json.dump(rep, open(os.path.join(OUT, "report.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("\n结论:", rep["conclusion"])


if __name__ == "__main__":
    main()
