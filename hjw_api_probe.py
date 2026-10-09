# -*- coding: utf-8 -*-
r"""海角网 API 真机探通 (GitHub runner)。

已知:
  apiDomain = vmdiaosj.cc           (从详情页 localStorage.setItem 拿到)
  API       = https://apiv{1,2,3}.vmdiaosj.cc/api.php
  body      = client=ios&data=<AES-B64>&sign=<MD5(SHA256(..+sign_key))>&timestamp=<ts>

目标:
  1. 打通 apiv1/2/3 —— 哪些活着
  2. 摸清接口动作名 (type/action 参数)
  3. 拿到一条详情页对应视频, 解密出真 m3u8, 验证能不能直取
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hjw_client import (encrypt_payload, decrypt_payload, decrypt_video, http,
                        read_home)

API_DOMAIN = "vmdiaosj.cc"
API_HOSTS = ["apiv1.%s" % API_DOMAIN, "apiv2.%s" % API_DOMAIN,
             "apiv3.%s" % API_DOMAIN, API_DOMAIN]
REF = "https://www.hjw01.com/"

# 常见接口动作名 —— 一次全试, 看哪个回 data
ACTIONS = [
    "config", "index", "home", "video", "videoList", "video_list", "list",
    "detail", "detailInfo", "getVideo", "get_video", "getDetail",
    "vod", "vodList", "post", "postList", "article", "articleList",
    "archives", "feed", "recommend", "hot", "new", "search",
    "play", "playUrl", "getPlayUrl", "getPlay", "videoInfo",
    "rank", "category", "categoryList", "tag", "tags",
]

PARAM_SETS = [
    {},
    {"id": "194845"},
    {"vid": "194845"},
    {"post_id": "194845"},
    {"article_id": "194845"},
    {"aid": "194845"},
    {"ids": "194845"},
    {"page": "1"},
    {"page": "1", "limit": "20"},
    {"page": "1", "size": "20"},
    {"id": "194845", "page": "1"},
]


def call(host, payload, timeout=20):
    url = "https://%s/api.php" % host
    p = encrypt_payload(payload)
    st, txt, hdr = http(url, data=p["_body"], referer=REF, timeout=timeout)
    return st, txt, url


def parse_resp(txt):
    """服务端回包可能也是加密的, 也可能是 JSON。两种都拆。"""
    out = {"raw_head": txt[:200], "kind": "unknown", "json": None,
           "decrypted": None}
    txt = txt.strip()
    if not txt:
        out["kind"] = "empty"
        return out
    if txt[0] in "{[":
        out["kind"] = "json"
        try:
            out["json"] = json.loads(txt)
        except Exception:
            pass
        return out
    # 尝试 base64 解密
    try:
        dec = decrypt_payload(txt)
        s = dec.decode("utf-8", "replace").strip()
        out["decrypted"] = s[:600]
        if s and s[0] in "{[":
            out["kind"] = "aes-json"
            try:
                out["json"] = json.loads(s)
            except Exception:
                pass
        else:
            out["kind"] = "aes-text"
    except Exception as e:
        out["kind"] = "unknown"
        out["err"] = str(e)[:120]
    return out


def main():
    # 注意: 不复用模块级名字, 否则 Python 会把模块常量当局部变量
    # (上一版就踩了 UnboundLocalError)
    api_domain = API_DOMAIN
    api_hosts = list(API_HOSTS)
    report = {"apiDomain": api_domain, "hosts": {}, "probe": []}

    print("=" * 74)
    print("海角 API 真机探通 — apiDomain=%s" % api_domain)
    print("=" * 74)

    # ---------- 1) 先看主页确认还活着 ----------
    info, home = read_home()
    print("\n[主页] %s %sB  title=%s  ids=%d"
          % (info["status"], info["bytes"], info["title"], len(info["ids"])))
    m = re.search(r"localStorage\.setItem\(['\"]apiDomain['\"]\s*,\s*['\"]([^'\"]+)['\"]", home)
    live_domain = m.group(1) if m else None
    print("[主页 apiDomain] %s" % live_domain)
    report["liveDomain"] = live_domain
    if live_domain:
        api_domain = live_domain
        api_hosts = ["apiv1.%s" % api_domain, "apiv2.%s" % api_domain,
                     "apiv3.%s" % api_domain, api_domain]
        report["apiDomain"] = api_domain

    # ---------- 2) 探 host 存活 ----------
    print("\n[2] 探 API host")
    alive = []
    for h in api_hosts:
        st, txt, url = call(h, {"config": 1}, timeout=12)
        ok = st == 200 and len(txt) > 0
        print("  %-32s %s %6dB  %s" % (h, st, len(txt), txt[:90].replace("\n", " ")))
        report["hosts"][h] = {"status": st, "len": len(txt), "head": txt[:200]}
        if ok:
            alive.append(h)
    report["alive"] = alive
    print("  存活: %s" % (alive or "无"))

    if not alive:
        print("\n!! 所有 apivN 都不通, 看看裸域和 www")
        for h in [api_domain, "www." + api_domain, "api." + api_domain]:
            st, txt, url = call(h, {"config": 1}, timeout=12)
            print("  %-32s %s %6dB  %s" % (h, st, len(txt), txt[:90].replace("\n", " ")))
            report["hosts"][h] = {"status": st, "len": len(txt), "head": txt[:200]}
            if st == 200 and txt:
                alive.append(h)
        report["alive"] = alive

    if not alive:
        with open("hjw_api_report.json", "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=1)
        print("\n!! 依然不通。可能 apiDomain 是页面级随机, 或需 cookie。")
        return 1

    host = alive[0]
    print("\n[3] 用 %s 摸动作名" % host)

    # ---------- 3) 摸动作名 ----------
    hits = []
    for act in ACTIONS:
        payload = {"type": act}
        st, txt, url = call(host, payload, timeout=15)
        pr = parse_resp(txt)
        mark = ""
        if pr["kind"] == "aes-json":
            d = pr["json"] or {}
            code = d.get("code", d.get("status", "?"))
            mark = "★ code=%s msg=%s" % (code, str(d.get("msg", ""))[:40])
            hits.append({"action": act, "payload": payload, "kind": pr["kind"],
                         "code": code, "resp": pr["json"]})
        elif pr["kind"] == "json":
            mark = "json keys=%s" % list((pr["json"] or {}).keys())[:6]
        elif pr["kind"] == "aes-text":
            mark = "aes-text: %s" % (pr["decrypted"] or "")[:70]
        else:
            mark = "%s %s" % (pr["kind"], (pr.get("raw_head") or "")[:60])
        print("  %-16s %s %6dB  %s" % (act, st, len(txt), mark[:120]))
        report["probe"].append({"action": act, "status": st, "len": len(txt),
                                "kind": pr["kind"], "mark": mark[:200],
                                "resp": pr.get("json")})
    report["hits"] = hits

    # ---------- 4) 拿详情 ----------
    print("\n[4] 拿详情 (第 1 篇)")
    if info["ids"]:
        pid = info["ids"][0]
        for act in ("detail", "videoInfo", "getVideo", "detailInfo", "post", "archives"):
            for pset in ({"id": pid}, {"vid": pid}, {"post_id": pid}, {"aid": pid}):
                payload = {"type": act}
                payload.update(pset)
                st, txt, url = call(host, payload, timeout=15)
                pr = parse_resp(txt)
                if pr["kind"] in ("aes-json", "json"):
                    print("  ★ %s %s -> %s" % (act, pset, json.dumps(
                        pr["json"], ensure_ascii=False)[:220]))
                    report.setdefault("detailHits", []).append(
                        {"action": act, "params": pset, "resp": pr["json"]})
                    break

    with open("hjw_api_report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print("\n已写入 hjw_api_report.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
