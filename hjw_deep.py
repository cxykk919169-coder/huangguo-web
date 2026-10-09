# -*- coding: utf-8 -*-
"""海角社区 · 详情页 + AI中转 + 付费墙取证。

第二阶段: 主页只是列表, 真正的付费墙在详情页 / 播放接口。
重点抓:
  1. /archives/NNNNNN/ 详情页原文 (看有没有 videoInitialData 类似的内嵌数据)
  2. window.__AI_TECH_CONFIG__.domain (vzunjio.zvpxyyql.cc) 的接口
  3. 静态资源里的 API 端点 (app.config.js / common.js)
  4. 试播: 详情页里出现过的 m3u8 直链直接请求, 看返回
"""
import gzip
import json
import os
import re
import sys
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
BASE = "https://www.hjw01.com"


def http_get(url, referer=None, timeout=25):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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


def save(name, text):
    os.makedirs("dump2", exist_ok=True)
    with open(os.path.join("dump2", name), "w", encoding="utf-8") as f:
        f.write(text)


def main():
    report = {}

    # ---------- 1) 主页里的详情页 id ----------
    st, home, _, _ = http_get(BASE + "/")
    ids = []
    for m in re.finditer(r'/archives/(\d+)/?', home):
        if m.group(1) not in ids:
            ids.append(m.group(1))
    print("主页挖到 %d 个详情 id" % len(ids))
    report["homeIds"] = ids[:40]

    # ---------- 2) 抓 3 个详情页 ----------
    details = []
    for pid in ids[:3]:
        u = "%s/archives/%s/" % (BASE, pid)
        st, body, hdr, final = http_get(u, referer=BASE + "/")
        save("detail_%s.html" % pid, body)
        d = {"id": pid, "url": u, "status": st, "bytes": len(body),
             "final": final, "title": ""}
        m = re.search(r"<title[^>]*>([^<]*)</title>", body, re.I)
        if m:
            d["title"] = m.group(1).strip()[:120]
        # 内嵌数据
        d["winVars"] = []
        for m in re.finditer(r'window\.([A-Za-z_\$][A-Za-z0-9_\$]*)\s*=\s*([^;]{0,300})', body):
            d["winVars"].append((m.group(1), m.group(2).replace("\n", " ")[:250]))
        # m3u8 / mp4 直链
        d["m3u8"] = list(dict.fromkeys(re.findall(
            r'https?://[^\s"\'<>\\]{5,200}?\.m3u8[^\s"\'<>\\]*', body)))[:15]
        d["mp4"] = list(dict.fromkeys(re.findall(
            r'https?://[^\s"\'<>\\]{5,200}?\.mp4[^\s"\'<>\\]*', body)))[:10]
        # 付费信号
        pays = []
        for k, label in [("金币", "金币"), ("积分", "积分"), ("钻石", "钻石"),
                         ("余额", "余额"), ("VIP", "VIP"), ("开通会员", "开通会员"),
                         ("充值", "充值"), ("支付", "支付"), ("购买", "购买"),
                         ("解锁", "解锁"), ("登录后", "登录后可见"),
                         ("签到", "签到"), ("任务", "任务"), ("邀请", "邀请"),
                         ("免费", "免费字样"), ("price", "price 变量"),
                         ("paywall", "paywall"), ("isPay", "isPay"), ("needBuy", "needBuy")]:
            if k in body:
                pays.append(label)
        d["pay"] = pays
        # 关键 JS 文件
        d["scripts"] = re.findall(r'<script[^>]+src=["\']([^"\']+)["\']', body)[:25]
        details.append(d)
        print("\n[详情 %s] %s %sB title=%s" % (pid, st, len(body), d["title"]))
        print("  m3u8:", d["m3u8"][:3])
        print("  mp4 :", d["mp4"][:2])
        print("  付费:", d["pay"])
        for n, v in d["winVars"][:10]:
            print("  win.%s = %s" % (n, v[:160]))

    report["details"] = details

    # ---------- 3) AI 中转接口 ----------
    m = re.search(r'window\.__AI_TECH_CONFIG__\s*=\s*(\{[^;]*\})', home)
    ai = {}
    if m:
        try:
            ai = json.loads(m.group(1))
        except Exception:
            ai = {"raw": m.group(1)}
    report["aiConfig"] = ai
    print("\n[AI 中转] %s" % json.dumps(ai, ensure_ascii=False))

    # ---------- 4) 关键静态 JS ----------
    for path in ["/usr/themes/haijiao3/assets/__base/config/app.config.js",
                 "/usr/themes/haijiao3/assets/__base/js/crypto.js",
                 "/usr/themes/haijiao3/assets/__base/js/common.js"]:
        st, body, _, _ = http_get(BASE + path, referer=BASE + "/")
        name = path.split("/")[-1]
        save("js_" + name, body)
        print("\n[静态 %s] %s %sB" % (path, st, len(body)))
        if st == 200 and body:
            # API 端点
            eps = set(re.findall(r'["\'](/(?:api|ajax|action|index\.php)[^"\']{0,80})["\']', body))
            for e in sorted(eps)[:25]:
                print("    ep:", e)
            if name == "app.config.js":
                print("    >>> " + body[:900].replace("\n", " "))

    with open("dump2/report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print("\n已写入 dump2/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
