# -*- coding: utf-8 -*-
r"""海角 · 端到端验证。

结论预判 (已在本地从 dump 里看到):
  详情页 `data-config` 属性里 **明文** 写着 video.url —— 真 m3u8，带 auth_key。
  不需要登录、不需要金币、不需要解密。

本轮要做:
  1. 抓详情页 -> 抠出 data-config -> 拿 m3u8
  2. 真机请求 m3u8，验证 200 + #EXTM3U
  3. 拉一个 ts 分片，验证 200 + 有字节
  4. 抠全部元数据 (标题/分类/标签/封面/作者/时间)
  5. 抓详情页里的"下载/解锁"区块，看要金币的是什么
  6. 全量列表抓取 (翻页) 验证可枚举
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hjw_client import http, read_home

BASE = "https://www.hjw01.com"
REF = BASE + "/"


def parse_detail(html):
    """从一个详情页 HTML 抽出全部可用信息。"""
    d = {
        "title": "", "category": "", "tags": [], "tagsName": [],
        "typeId": "", "typeName": "", "mediaId": "",
        "cfg": None, "m3u8": "", "m3u8_h265": "", "pic": "",
        "author": "", "date": "", "views": "", "likes": "",
        "coins": [], "locked": False, "raw_cfg_len": 0,
    }
    m = re.search(r"<title[^>]*>([^<]*)</title>", html, re.I)
    if m:
        d["title"] = m.group(1).replace("| 海角网", "").strip()
    for k, pat in [
        ("typeId", r'data-video_type_id="([^"]*)"'),
        ("typeName", r'data-video_type_name="([^"]*)"'),
        ("mediaId", r'data-media_id="([^"]*)"'),
        ("tags", r'data-video_tag_key="([^"]*)"'),
        ("tagsName", r'data-video_tag_name="([^"]*)"'),
    ]:
        mm = re.search(pat, html)
        if mm:
            d[k] = mm.group(1)
    if d["tags"]:
        d["tags"] = [x for x in d["tags"].split(",") if x]
    if d["tagsName"]:
        d["tagsName"] = [x for x in d["tagsName"].split(",") if x]

    # data-config -> 明文 m3u8
    cfgs = re.findall(r"data-config='([^']+)'", html)
    if not cfgs:
        cfgs = re.findall(r'data-config="([^"]+)"', html)
    for c in cfgs:
        try:
            j = json.loads(c.replace("\\/", "/").replace("&quot;", '"'))
        except Exception:
            continue
        v = j.get("video") or {}
        if v.get("url"):
            d["cfg"] = j
            d["raw_cfg_len"] = len(c)
            d["m3u8"] = v["url"]
            d["pic"] = v.get("pic") or ""
            d["m3u8_h265"] = (j.get("video_h265") or {}).get("url", "")
            break

    # 兜底: 页面里裸的 m3u8
    if not d["m3u8"]:
        mm = re.search(r"(https?://[^\s\"'<>\\]+\.m3u8[^\s\"'<>\\]*)", html)
        if mm:
            d["m3u8"] = mm.group(1).replace("\\/", "/")

    # 作者 / 日期 / 统计
    for k, pat in [
        ("author", r'class="[^"]*author[^"]*"[^>]*>\s*<[^>]*>([^<]{1,40})<'),
        ("date", r'(\d{4}-\d{2}-\d{2})'),
        ("views", r'(\d[\d,\.]*)\s*(?:次播放|播放|观看)'),
        ("likes", r'(\d[\d,\.]*)\s*(?:点赞|喜欢)'),
    ]:
        mm = re.search(pat, html)
        if mm:
            d[k] = mm.group(1).strip()

    # 金币 / 付费遗迹
    for kw in ("金币", "积分", "解锁", "购买", "付费", "VIP", "开通会员",
               "签到", "打赏", "赞助"):
        if kw in html:
            d["coins"].append(kw)
    # 真锁: 有解锁按钮且没 m3u8
    if d["coins"] and not d["m3u8"]:
        d["locked"] = True
    return d


def main():
    os.makedirs("verify", exist_ok=True)
    report = {"steps": []}

    # ---------- 1) 主页拿 id ----------
    info, home = read_home()
    print("[主页] %s %sB  ids=%d" % (info["status"], info["bytes"], len(info["ids"])))
    ids = info["ids"][:8]
    report["homeIds"] = info["ids"]
    report["homeIdCount"] = len(info["ids"])

    # ---------- 2/3) 详情 + m3u8 实测 ----------
    print("\n[详情 + m3u8 实测]")
    ok = 0
    for pid in ids:
        u = "%s/archives/%s/" % (BASE, pid)
        st, html, hdr = http(u, referer=REF, timeout=25)
        d = parse_detail(html)
        rec = {"id": pid, "status": st, "bytes": len(html), "m3u8": d["m3u8"][:200],
               "title": d["title"][:80], "typeName": d["typeName"],
               "tagsName": d["tagsName"][:6], "coins": d["coins"],
               "locked": d["locked"]}
        # m3u8 实测
        if d["m3u8"]:
            st2, body2, hdr2 = http(d["m3u8"], referer=u, timeout=25)
            rec["m3u8_status"] = st2
            rec["m3u8_bytes"] = len(body2)
            rec["m3u8_is_hls"] = "#EXTM3U" in body2
            rec["m3u8_head"] = body2[:200]
            print("  %-8s %s  标题=%s" % (pid, "✅" if rec["m3u8_is_hls"] else "❌",
                                          d["title"][:40]))
            print("           m3u8 %s %sB hls=%s" % (st2, len(body2), rec["m3u8_is_hls"]))
            if rec["m3u8_is_hls"]:
                ok += 1
                # 拉第一个分片
                seg = None
                for line in body2.splitlines():
                    line = line.strip()
                    if line and not line.startswith("#"):
                        seg = line
                        break
                if seg:
                    if seg.startswith("http"):
                        seg_url = seg
                    else:
                        base = d["m3u8"].rsplit("/", 1)[0]
                        seg_url = base + "/" + seg
                    st3, body3, _ = http(seg_url, referer=d["m3u8"], timeout=25)
                    rec["seg_url"] = seg_url[:200]
                    rec["seg_status"] = st3
                    rec["seg_bytes"] = len(body3)
                    print("           分片 %s %sB" % (st3, len(body3)))
        else:
            print("  %-8s ⚠ 无 m3u8  标题=%s  付费字样=%s" % (pid, d["title"][:40], d["coins"]))
        report["steps"].append(rec)

    print("\n[结果] %d/%d 详情页直取 m3u8 成功" % (ok, len(ids)))
    report["ok"] = ok
    report["total"] = len(ids)

    # ---------- 4) 翻页枚举验证 ----------
    print("\n[翻页枚举]")
    pages = []
    for p in (2, 3):
        st, html, _ = http("%s/page/%d/" % (BASE, p), referer=REF, timeout=25)
        found = []
        for m in re.finditer(r"/archives/(\d+)/?", html):
            if m.group(1) not in found:
                found.append(m.group(1))
        pages.append({"page": p, "status": st, "ids": len(found), "sample": found[:5]})
        print("  /page/%d/ %s  新 id %d 个  %s" % (p, st, len(found), found[:4]))
    report["pages"] = pages

    with open("verify/report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print("\n已写入 verify/report.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
