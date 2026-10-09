# -*- coding: utf-8 -*-
r"""海角社区 · 站点结构 + 付费墙取证探测器。

海角社区 (hjw01.com / haijiao.ai / hjw1.com) 和黄果/芒果不是一类站:
  黄果/芒果 = 短剧列表站 (卡片 → 详情页 → m3u8 全集字典)
  海角      = UGC 内容社区 (视频/图文/论坛 + 金币会员体系)

所以不能套现成的解析器。这个脚本只干两件事:
  1. 摸清站点结构: 首页有哪些板块 / 列表怎么组织 / 详情页 URL 形态 / 数据注入方式
  2. 付费墙取证: 找到视频页 → 试播 → 看返回什么 (401/402/403? 跳登录? 试看N秒?)

用法:
  python hjw_probe.py                       # 探默认地址
  python hjw_probe.py hjw01.com haijiao.ai  # 指定
  python hjw_probe.py --out hjw.json        # 落盘
"""
import gzip
import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.request

_ctx = ssl.create_default_context()
_ctx.check_hostname = False
_ctx.verify_mode = ssl.CERT_NONE

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

HDR = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    "Upgrade-Insecure-Requests": "1",
}

DEFAULT_HOSTS = ["hjw01.com", "haijiao.ai", "hjw1.com", "hjw02.com",
                 "hjw2.com", "hjw.cc", "haijiao01.com"]

# 视频/内容页 URL 形态的常见套路
DETAIL_HINTS = [
    r"/post/(\d+)", r"/thread-(\d+)", r"/video/(\d+)", r"/v/(\d+)",
    r"/read-(\d+)", r"/article/(\d+)", r"/topic/(\d+)", r"/detail/(\d+)",
    r"/watch/(\d+)", r"/play/(\d+)", r"/media/(\d+)",
]

# 付费墙信号 (比短剧站丰富: 社区站通常是 积分/金币/会员/等级)
PAY_SIGNS = [
    ("金币", "金币"), ("积分", "积分"), ("钻石", "钻石"), ("余额", "余额"),
    ("开通会员", "开通会员"), ("VIP", "VIP"), ("充值", "充值"),
    ("付费", "付费"), ("解锁", "解锁"), ("购买", "购买"),
    ("签到", "签到(可能有白嫖路径)"), ("任务", "任务系统(可能有白嫖路径)"),
    ("邀请", "邀请系统(可能有白嫖路径)"), ("推广", "推广返利"),
    ("权限", "权限不足"), ("等级", "等级限制"), ("游客", "游客限制"),
    ("登录后", "登录后可见"), ("注册后", "注册后可见"),
]

# 播放器 / 媒体信号
MEDIA_SIGNS = [
    ("m3u8", "HLS m3u8"), (".mp4", "MP4"), ("#EXTM3U", "m3u8 正文"),
    ("dplayer", "DPlayer"), ("artplayer", "ArtPlayer"), ("plyr", "plyr"),
    ("videojs", "video.js"), ("ckplayer", "ckplayer"), ("hls.js", "hls.js"),
    ("<video", "原生 video 标签"), ("source src", "video source"),
    ("xgplayer", "西瓜播放器"), ("prismplayer", "阿里云播放器"),
]

# 社区/CMS 特征
CMS_SIGNS = [
    ("xiuno", "Xiuno BBS"), ("discuz", "Discuz!"), ("phpwind", "PHPWind"),
    ("flarum", "Flarum"), ("nodebb", "NodeBB"), ("carbonforum", "Carbon Forum"),
    ("__NEXT_DATA__", "Next.js SSR"), ("__NUXT__", "Nuxt SSR"),
    ("window.__INITIAL_STATE__", "SPA INITIAL_STATE"),
    ("laravel", "Laravel"), ("django", "Django"), ("csrf-token", "Laravel/CSRF"),
    ("dujiaoka", "独角数卡"), ("easypay", "易支付"),
]


def http_get(url, referer=None, timeout=20, retries=2, extra=None):
    h = dict(HDR)
    if referer:
        h["Referer"] = referer
    if extra:
        h.update(extra)
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=timeout, context=_ctx) as r:
                raw = r.read()
                enc = (r.headers.get("Content-Encoding") or "").lower()
                if "gzip" in enc:
                    try:
                        raw = gzip.decompress(raw)
                    except Exception:
                        pass
                elif "deflate" in enc:
                    try:
                        import zlib
                        raw = zlib.decompress(raw, -zlib.MAX_WBITS)
                    except Exception:
                        pass
                return (r.status, raw.decode("utf-8", "replace"),
                        r.geturl(), dict(r.headers))
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", "replace")[:6000]
            except Exception:
                pass
            return e.code, body, url, dict(e.headers or {})
        except Exception as e:
            last = e
            if i < retries - 1:
                time.sleep(1.0 + i)
    return 0, "", url, {"_error": str(last)}


def detect(text, table):
    hit = []
    for k, label in table:
        if k.lower() in text.lower():
            hit.append(label)
    return hit


def find_links(html, host):
    """挖出页面里的内链 —— 用来摸清板块结构。"""
    out = []
    seen = set()
    for m in re.finditer(r'href=["\']([^"\']+)["\']', html):
        u = m.group(1)
        if u.startswith(("#", "javascript:", "mailto:", "tel:")):
            continue
        # 只留站内路径
        if u.startswith("http"):
            if host not in u:
                continue
            u = re.sub(r"^https?://[^/]+", "", u)
        if not u.startswith("/"):
            continue
        u = u.split("?")[0].rstrip("/")
        if not u or u == "/":
            continue
        if len(u) > 60:
            continue
        if u in seen:
            continue
        # 跳过静态资源
        if re.search(r"\.(js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|map)$", u, re.I):
            continue
        seen.add(u)
        out.append(u)
    return out


def top_paths(paths, limit=40):
    """按第一段分组, 统计出现次数 —— 看哪些是主要板块。"""
    cnt = {}
    for p in paths:
        seg = p.strip("/").split("/")[0]
        cnt[seg] = cnt.get(seg, 0) + 1
    ranked = sorted(cnt.items(), key=lambda x: -x[1])
    return ranked[:limit]


def probe(host, deep=True, verbose=True):
    if not host.startswith("http"):
        host = "https://" + host
    host = host.rstrip("/")
    dom = re.sub(r"^https?://", "", host)
    r = {"host": host, "domain": dom,
         "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

    st, txt, final, hdrs = http_get(host + "/")
    r["status"] = st
    r["finalUrl"] = final
    r["bytes"] = len(txt)
    r["server"] = hdrs.get("Server", "")
    r["poweredBy"] = hdrs.get("X-Powered-By", "")
    r["setCookie"] = bool(hdrs.get("Set-Cookie"))
    if st == 0:
        r["ok"] = False
        r["error"] = hdrs.get("_error", "network")
        if verbose:
            print("  %-22s 不可达: %s" % (dom, r["error"][:100]))
        return r
    r["ok"] = (st == 200)
    r["title"] = ""
    m = re.search(r"<title[^>]*>([\s\S]{0,200}?)</title>", txt, re.I)
    if m:
        r["title"] = re.sub(r"\s+", " ", m.group(1)).strip()

    r["cms"] = detect(txt, CMS_SIGNS)
    r["media"] = detect(txt, MEDIA_SIGNS)
    r["payHome"] = detect(txt, PAY_SIGNS)

    if verbose:
        print("  %-22s %s  %dB  %r" % (dom, st, len(txt), r["title"][:44]))
        if r["finalUrl"].rstrip("/") != host:
            print("      重定向 -> %s" % r["finalUrl"])
        if r["server"] or r["poweredBy"]:
            print("      服务器: %s %s" % (r["server"], r["poweredBy"]))
        if r["cms"]:
            print("      CMS: %s" % ", ".join(r["cms"]))
        if r["media"]:
            print("      媒体: %s" % ", ".join(r["media"]))
        if r["payHome"]:
            print("      付费字样: %s" % ", ".join(r["payHome"]))

    if st != 200 or not deep:
        return r

    # ---- 板块结构 ----
    links = find_links(txt, dom)
    r["linkCount"] = len(links)
    r["sections"] = [{"seg": s, "n": n} for s, n in top_paths(links)]
    if verbose:
        print("      内链 %d 条, 主要板块:" % len(links))
        for s, n in top_paths(links, 14):
            print("        /%-22s x%d" % (s, n))

    # ---- 找详情页候选 ----
    ids = {}
    for pat in DETAIL_HINTS:
        for m in re.finditer(pat, txt):
            key = pat
            ids.setdefault(key, [])
            if m.group(1) not in ids[key]:
                ids[key].append(m.group(1))
    r["detailPatterns"] = {k: v[:5] for k, v in ids.items() if v}
    if verbose and r["detailPatterns"]:
        print("      详情页候选:")
        for k, v in list(r["detailPatterns"].items())[:6]:
            print("        %-22s %s" % (k, v))
    return r


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    deep = "--shallow" not in sys.argv
    out = None
    if "--out" in sys.argv:
        i = sys.argv.index("--out")
        out = sys.argv[i + 1]
        if out in args:
            args.remove(out)
    hosts = args or DEFAULT_HOSTS

    print("=" * 76)
    print("海角社区 · 结构 + 付费墙探测")
    print("=" * 76)
    res = []
    for h in hosts:
        print("\n[%s]" % h)
        try:
            res.append(probe(h, deep=deep))
        except Exception as e:
            print("   !! 异常:", e)
            res.append({"host": h, "ok": False, "error": str(e)})

    print("\n" + "=" * 76)
    print("汇总")
    print("=" * 76)
    print("%-24s %-6s %-9s %-26s %s" % ("host", "状态", "大小", "CMS", "付费字样数"))
    print("-" * 100)
    for r in res:
        print("%-24s %-6s %-9s %-26s %s" % (
            r.get("domain", "?")[:24],
            str(r.get("status") or r.get("error", "?"))[:6],
            ("%dB" % r["bytes"]) if r.get("bytes") else "-",
            (", ".join(r.get("cms") or []) or "-")[:26],
            len(r.get("payHome") or []),
        ))

    if out:
        with open(out, "w", encoding="utf-8") as f:
            json.dump(res, f, ensure_ascii=False, indent=1)
        print("\nJSON -> %s" % out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
