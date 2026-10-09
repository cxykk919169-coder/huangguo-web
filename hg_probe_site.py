# -*- coding: utf-8 -*-
"""短剧站批量探测器 —— 判断一个站: 能不能用 / 是什么结构 / 有没有付费墙。

用法:
    python hg_probe_site.py relang02.cc yeguodj.com
    python hg_probe_site.py --file candidates.txt
    python hg_probe_site.py relang02.cc --deep      # 深挖: 抓详情页 + 试播第1/2集

设计目标:
  1. 首页可直达? 还是 302 到发布页 / 换域名?
  2. 结构识别: 列表卡片 class / 剧集 id 形态 / 详情页数据注入方式
  3. 付费墙取证: 第 1 集 vs 第 2 集 —— 哪个开始 402/403
  4. 输出 JSON, 便于喂给 sync_upstream.py 当新源配置

纯标准库, 无依赖。
"""
import gzip
import json
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request

socket.setdefaulttimeout(20)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

HDR = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Upgrade-Insecure-Requests": "1",
}

_ctx = ssl.create_default_context()
_ctx.check_hostname = False
_ctx.verify_mode = ssl.CERT_NONE


def http_get(url, referer=None, timeout=20, retries=2):
    """返回 (status, text, final_url, headers_dict)。status 为 0 表示网络错误。"""
    h = dict(HDR)
    if referer:
        h["Referer"] = referer
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
                txt = raw.decode("utf-8", "replace")
                return r.status, txt, r.geturl(), dict(r.headers)
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", "replace")[:4000]
            except Exception:
                pass
            return e.code, body, url, dict(e.headers or {})
        except Exception as e:
            last = e
            if i < retries - 1:
                time.sleep(1.0 + i)
    return 0, "", url, {"_error": str(last)}


# ---------------------------------------------------------------- 结构识别

# 各家的列表卡片特征 —— 命中哪个就说明是什么 CMS/模板
CARD_SIGNS = [
    ("hg-drama-card", "黄果系 (huangguo)"),
    ("data-track-id", "黄果系 (data-track-id)"),
    ("v-item", "芒果系 (mgmg)"),
    ("module-item", "苹果CMS (maccms)"),
    ("public-list", "苹果CMS v10"),
    ("stui-vodlist", "苹果CMS stui 模板"),
    ("vodlist", "苹果CMS 变体"),
    ("myui-vodlist", "苹果CMS myui"),
    ("ewave-vodlist", "苹果CMS ewave"),
    ("hl-vodlist", "海螺CMS"),
    ("fed-vodlist", "飞飞CMS"),
    ("dplayer", "DPlayer 播放器"),
    ("artplayer", "ArtPlayer 播放器"),
    ("plyr", "plyr 播放器"),
]

# 详情页数据注入特征
DETAIL_SIGNS = [
    ("videoInitialData", "内嵌 #videoInitialData JSON (黄果式, 无服务端鉴权)"),
    ("epPlaySrcs", "epPlaySrcs 全量集字典 (黄果式)"),
    ("player_aaaa", "苹果CMS player_aaaa 全局变量"),
    ("mac_player", "苹果CMS mac_player"),
    ("__NUXT__", "Nuxt SSR (数据在 window.__NUXT__)"),
    ("__NEXT_DATA__", "Next.js SSR"),
    ("window.__INITIAL_STATE__", "SPA INITIAL_STATE"),
    ("playlist", "playlist 字段"),
]

# 付费墙信号
PAYWALL_SIGNS = [
    ("金币", "金币计价"),
    ("充值", "充值入口"),
    ("会员", "会员制"),
    ("VIP", "VIP 制"),
    ("解锁", "解锁制"),
    ("付费", "付费字样"),
    ("need_coin", "need_coin (服务端金币校验)"),
    ("no-permission", "no-permission (服务端权限校验)"),
    ("积分", "积分制"),
]

# 视频站点聚合 / 发布页特征 (不是真剧站)
PUBLISH_SIGNS = [
    ("transfer-nav", "地址发布页 (transfer-nav)"),
    ("地址发布", "地址发布页"),
    ("收藏本站", "地址发布页"),
    ("永久域名", "地址发布页"),
    ("发布页", "地址发布页"),
    ("请收藏", "地址发布页"),
]


def detect(text, table):
    hit = []
    for key, label in table:
        if key in text:
            hit.append(label)
    return hit


def extract_eps(text):
    """从详情页 HTML 里抽 {集号: m3u8}。多路兜底。"""
    eps = {}
    # 1) videoInitialData JSON
    m = re.search(r'id="videoInitialData"[^>]*>([\s\S]*?)</script>', text)
    if m:
        try:
            data = json.loads(m.group(1))
            for k, v in (data.get("epPlaySrcs") or {}).items():
                if re.fullmatch(r"\d+", str(k)) and isinstance(v, str) and v.startswith("http"):
                    eps[str(k)] = v.replace("&amp;", "&")
        except Exception:
            pass
    # 2) player_aaaa (苹果CMS)
    m = re.search(r'player_aaaa\s*=\s*(\{[\s\S]*?\})\s*</script>', text)
    if m:
        try:
            data = json.loads(m.group(1))
            url = data.get("url") or ""
            if isinstance(url, str) and url.startswith("http"):
                eps.setdefault("1", url)
        except Exception:
            pass
    # 3) data-play-src 属性
    for mm in re.finditer(r'data-play-src="([^"]+\.m3u8[^"]*)"', text):
        u = mm.group(1).replace("&amp;", "&")
        if u not in eps.values():
            eps.setdefault(str(len(eps) + 1), u)
    # 4) 裸 m3u8 URL
    if not eps:
        for mm in re.finditer(r'https?://[^\s"\'<>]+?\.m3u8[^\s"\'<>]*', text):
            u = mm.group(0).replace("&amp;", "&")
            eps.setdefault(str(len(eps) + 1), u)
            if len(eps) >= 30:
                break
    return eps


def guess_ids(text, limit=6):
    """抽几个剧集 id，用于拼详情页 URL。"""
    ids = []
    for pat in (r'data-track-id="(\d+)"',
                r'/video/(\d+)',
                r'/voddetail/(\d+)',
                r'/index\.php/vod/detail/id/(\d+)',
                r'/detail/(\d+)',
                r'/watch/details/(\d+)',
                r'id="(\d{3,7})"'):
        for m in re.finditer(pat, text):
            v = m.group(1)
            if v not in ids:
                ids.append(v)
            if len(ids) >= limit:
                return ids
    return ids


def guess_detail_paths(text, vid):
    """按识别到的模板猜详情页 URL 模板。"""
    cands = []
    if "/video/" in text:
        cands.append("/video/%s/" % vid)
    if "/voddetail/" in text:
        cands.append("/voddetail/%s/" % vid)
    if "index.php/vod/detail" in text:
        cands.append("/index.php/vod/detail/id/%s.html" % vid)
    if "/watch/details/" in text:
        cands.append("/watch/details/%s.html" % vid)
    if "/detail/" in text:
        cands.append("/detail/%s.html" % vid)
    cands.append("/video/%s/" % vid)
    cands.append("/voddetail/%s/" % vid)
    out = []
    for c in cands:
        if c not in out:
            out.append(c)
    return out


# ---------------------------------------------------------------- 发现器模式

# 从页面里找「同类站入口」—— 发布页/友链/导航里的外链域名
_FRIEND_RE = re.compile(r"https?://([a-z0-9][a-z0-9-]{1,40}\.[a-z0-9-]{2,20}\.[a-z]{2,10})", re.I)
_BARE_RE = re.compile(r"\b([a-z0-9][a-z0-9-]{2,20}\.(?:cc|com|net|top|xyz|vip|sbs|lol|icu|fun|site|online|art|shop|club|live|info|biz|org|co|cyou|buzz|monster|link|pro|store))\b", re.I)

# 噪音: 统计/广告/CDN/社交/工具站, 一律不要
_NOISE = re.compile(
    r"google|gstatic|googleapis|yandex|baidu|bing|cloudflare|cloudfront|akamai|"
    r"jsdelivr|unpkg|cdnjs|bootcdn|staticfile|fontawesome|jquery|bootstrap|"
    r"facebook|twitter|x\.com|t\.co|youtube|tiktok|telegram|whatsapp|line\.me|"
    r"umeng|cnzz|51\.la|gtag|googletagmanager|doubleclick|adsystem|"
    r"w3\.org|schema\.org|github|gitlab|npmjs|python|php\.net|apache|nginx|"
    r"wikipedia|zhihu|weibo|qq\.com|wechat|tencent|alibaba|aliyun|qcloud|"
    r"unsplash|placeholder|bootstrapcdn|fontawesome|sentry|datadog|"
    r"\.js$|\.css$|\.png$|\.jpg$|\.svg$|\.ico$|\.woff",
    re.I,
)


def find_related(text):
    """从页面里挖「同类站」域名 —— 发布页导航、友情链接、跳转按钮。"""
    found = []
    for m in _FRIEND_RE.finditer(text):
        h = m.group(1).lower()
        if _NOISE.search(h):
            continue
        if h not in found:
            found.append(h)
    for m in _BARE_RE.finditer(text):
        h = m.group(1).lower()
        if _NOISE.search(h):
            continue
        if h not in found:
            found.append(h)
    return found


def discover_related(seed, rounds=2, verbose=True):
    """从种子站出发, 滚雪球式扩线。

    每轮: 抓种子首页 + 发布页 → 挖出所有外链域名 → 下一轮以它们为种子。
    返回 (visited, related) —— related 是去重后的候选池。
    """
    visited = set()
    related = []
    frontier = [seed] if isinstance(seed, str) else list(seed)
    for rnd in range(max(1, rounds)):
        nxt = []
        for host in frontier:
            h = host if host.startswith("http") else "https://" + host
            key = h.rstrip("/").lower()
            if key in visited:
                continue
            visited.add(key)
            st, txt, final, _ = http_get(h + "/", timeout=15, retries=1)
            if st != 200 or not txt:
                continue
            # 挖外链
            for d in find_related(txt):
                if d not in related:
                    related.append(d)
                    nxt.append(d)
            # 再试几个常见的发布页路径
            for p in ("/transfer", "/dz", "/url", "/links", "/friendlink"):
                st2, t2, _, _ = http_get(h + p, timeout=10, retries=1)
                if st2 == 200 and t2:
                    for d in find_related(t2):
                        if d not in related:
                            related.append(d)
                            nxt.append(d)
            if verbose:
                print("  [%d] %s -> 累计候选 %d" % (rnd + 1, key, len(related)))
            time.sleep(0.3)
        frontier = nxt[:40]
        if not frontier:
            break
    return sorted(visited), related


# ---------------------------------------------------------------- 主探测

def probe(host, deep=True, verbose=True):
    if not host.startswith("http"):
        host = "https://" + host
    host = host.rstrip("/")
    r = {"host": host, "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

    st, txt, final, hdrs = http_get(host + "/")
    r["status"] = st
    r["finalUrl"] = final
    r["bytes"] = len(txt)
    r["redirected"] = bool(final.rstrip("/") != host.rstrip("/"))
    r["server"] = hdrs.get("Server", "")
    if st == 0:
        r["ok"] = False
        r["error"] = hdrs.get("_error", "network")
        if verbose:
            print("  %s -> 不可达: %s" % (host, r["error"][:120]))
        return r
    if st != 200:
        r["ok"] = False
        r["error"] = "HTTP %s" % st
        if verbose:
            print("  %s -> HTTP %s" % (host, st))
        return r

    r["ok"] = True
    r["title"] = ""
    m = re.search(r"<title[^>]*>([\s\S]{0,200}?)</title>", txt, re.I)
    if m:
        r["title"] = re.sub(r"\s+", " ", m.group(1)).strip()

    r["cards"] = detect(txt, CARD_SIGNS)
    r["publish"] = detect(txt, PUBLISH_SIGNS)
    r["paywallHome"] = detect(txt, PAYWALL_SIGNS)

    if verbose:
        print("  %s -> 200  %dB  title=%r" % (host, len(txt), r["title"][:60]))
        if r["redirected"]:
            print("     重定向到: %s" % final)
        print("     列表特征: %s" % (", ".join(r["cards"]) or "未识别"))
        if r["publish"]:
            print("     ⚠ 发布页特征: %s" % ", ".join(r["publish"]))
        if r["paywallHome"]:
            print("     首页付费字样: %s" % ", ".join(r["paywallHome"]))

    if not deep or r["publish"]:
        return r

    ids = guess_ids(txt)
    r["sampleIds"] = ids
    if verbose:
        print("     样本 id: %s" % (ids[:6] or "无"))

    if not ids:
        return r

    # 找详情页
    det = None
    for vid in ids[:3]:
        for path in guess_detail_paths(txt, vid):
            st2, t2, f2, _ = http_get(host + path, referer=host + "/")
            if st2 == 200 and len(t2) > 2000:
                det = {"vid": vid, "url": host + path, "html": t2, "len": len(t2)}
                break
        if det:
            break
    if not det:
        r["detail"] = None
        if verbose:
            print("     详情页: 没找到可用模板")
        return r

    r["detailUrl"] = det["url"]
    r["detailBytes"] = det["len"]
    r["detailSigns"] = detect(det["html"], DETAIL_SIGNS)
    r["paywallDetail"] = detect(det["html"], PAYWALL_SIGNS)
    eps = extract_eps(det["html"])
    r["epCount"] = len(eps)

    if verbose:
        print("     详情页: %s (%dB)" % (det["url"], det["len"]))
        print("     数据注入: %s" % (", ".join(r["detailSigns"]) or "未识别"))
        print("     抓到集数: %d" % len(eps))

    # 试播第 1 / 2 / 3 集 —— 这是判付费墙的铁证
    play = {}
    for k in ("1", "2", "3"):
        if k not in eps:
            continue
        st3, body, _, h3 = http_get(eps[k], referer=host + "/")
        ok = (st3 == 200 and "#EXTM3U" in body)
        play[k] = {
            "status": st3,
            "ok": ok,
            "deny": h3.get("X-Play-Deny", ""),
            "denyReason": h3.get("X-Play-Deny-Reason", ""),
        }
        if verbose:
            extra = ""
            if play[k]["deny"]:
                extra = "  X-Play-Deny=%s reason=%s" % (play[k]["deny"], play[k]["denyReason"])
            print("     第 %s 集: HTTP %s  %s%s"
                  % (k, st3, "可播" if ok else "不可播", extra))
    r["play"] = play

    # 结论
    if play:
        ok1 = play.get("1", {}).get("ok")
        ok2 = play.get("2", {}).get("ok")
        if ok1 and ok2:
            r["verdict"] = "全免费 (第1、2集都能直取)"
        elif ok1 and not ok2:
            r["verdict"] = "付费墙 (第1集免费, 第2集起拦)"
        elif not ok1:
            r["verdict"] = "第1集就拦 (可能有防盗链, 需 Referer 调优)"
        else:
            r["verdict"] = "未知"
    else:
        r["verdict"] = "没抓到集 (可能是跳转型播放, 需抓接口)"

    if verbose:
        print("     >>> 结论: %s" % r["verdict"])
    return r


def main():
    args = [a for a in sys.argv[1:]]
    if not args or "--help" in args or "-h" in args:
        print(__doc__)
        return 0
    deep = True
    if "--no-deep" in args:
        deep = False
        args.remove("--no-deep")
    if "--shallow" in args:
        deep = False
        args.remove("--shallow")

    # ---- 发现器模式: 从种子站滚雪球扩线 ----
    if "--discover" in args:
        args.remove("--discover")
        rounds = 2
        if "--rounds" in args:
            i = args.index("--rounds")
            rounds = int(args[i + 1])
            del args[i:i + 2]
        out_json = None
        if "--out" in args:
            i = args.index("--out")
            out_json = args[i + 1]
            del args[i:i + 2]
        if "--file" in args:
            i = args.index("--file")
            with open(args[i + 1], encoding="utf-8") as f:
                args += [l.split("#")[0].strip() for l in f
                         if l.strip() and not l.strip().startswith("#")]
            del args[i:i + 2]
        if not args:
            print("需要至少一个种子域名")
            return 1
        print("=" * 70)
        print("发现器: 种子 %s, %d 轮" % (args, rounds))
        print("=" * 70)
        visited, related = discover_related(args, rounds=rounds)
        print("\n访问过: %d 个" % len(visited))
        print("挖出候选: %d 个" % len(related))
        for d in related:
            print("   ", d)
        if out_json:
            with open(out_json, "w", encoding="utf-8") as f:
                json.dump({"visited": sorted(visited), "related": related},
                          f, ensure_ascii=False, indent=1)
            print("\n已写入 %s" % out_json)
        return 0

    out_json = None
    if "--out" in args:
        i = args.index("--out")
        out_json = args[i + 1]
        del args[i:i + 2]
    emit = None
    if "--emit-config" in args:
        i = args.index("--emit-config")
        emit = args[i + 1] if i + 1 < len(args) and not args[i + 1].startswith("-") else "-"
        if emit != "-":
            del args[i:i + 2]
        else:
            del args[i]
    if "--file" in args:
        i = args.index("--file")
        fp = args[i + 1]
        del args[i:i + 2]
        with open(fp, encoding="utf-8") as f:
            # 支持行尾注释: "mgmg10.com   # 芒果短剧"
            args += [l.split("#")[0].strip() for l in f
                     if l.strip() and not l.strip().startswith("#")]

    if not args:
        print(__doc__)
        return 1

    results = []
    print("=" * 70)
    print("探测 %d 个站点 (deep=%s)" % (len(args), deep))
    print("=" * 70)
    for h in args:
        print("\n[%s]" % h)
        try:
            results.append(probe(h, deep=deep))
        except Exception as e:
            print("   !! 异常: %s" % e)
            results.append({"host": h, "ok": False, "error": str(e)})

    print("\n" + "=" * 70)
    print("汇总")
    print("=" * 70)
    for r in results:
        st = "OK " if r.get("ok") else "FAIL"
        print("%-5s %-30s %-22s %s" % (
            st, r.get("host", "")[:30],
            (", ".join(r.get("cards", [])) or "-")[:22],
            r.get("verdict", r.get("error", ""))[:44]))

    if out_json:
        with open(out_json, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=1)
        print("\nJSON 已写入 %s" % out_json)

    # ---- 产出可接入配置: 只挑「探通 + 无付费墙」的站 ----
    if emit:
        usable = []
        for r in results:
            if not r.get("ok"):
                continue
            if r.get("publish"):
                continue                      # 发布页不是剧站
            play = r.get("play") or {}
            ok1 = play.get("1", {}).get("ok")
            ok2 = play.get("2", {}).get("ok")
            if not (ok1 and ok2):
                continue                      # 第 1、2 集不能都直取 → 有墙
            if not r.get("epCount"):
                continue
            usable.append({
                "host": r["host"],
                "epCount": r["epCount"],
                "cards": r.get("cards", []),
                "title": r.get("title", ""),
            })
        cfg = {
            "_note": "hg_probe_site.py --emit-config 自动产出: 仅收录 第1、2集均可直取 的站",
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "usable": usable,
            "mirrors": [u["host"] for u in usable],
        }
        txt = json.dumps(cfg, ensure_ascii=False, indent=1)
        if emit == "-":
            print("\n" + "=" * 70)
            print("可接入配置 (无付费墙的站)")
            print("=" * 70)
            print(txt)
        else:
            with open(emit, "w", encoding="utf-8") as f:
                f.write(txt)
            print("\n可接入配置已写入 %s (%d 个站)" % (emit, len(usable)))
            for u in usable:
                print("   + %s (%d 集)" % (u["host"], u["epCount"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
