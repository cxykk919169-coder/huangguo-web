# -*- coding: utf-8 -*-
r"""
黄果短剧 · 上游地址自动发现器
==============================
干一件事: 黄果换域名了, 我们自己知道, 并自动改过来。

上游的行为模式:
  1. 主站域名三天两头被墙 -> 他们不停地换 *.vchllzwu.cc 之类的短域名
  2. 固定留一个"地址发布页" (huangguo9.com / huangguo10.com / hgai1.com ...)
     发布页本身不容易被墙, 上面挂着当前可用的线路

所以我们只需要:
  抓发布页 -> 正则提线路域名 -> 实测能不能用 -> 写回 site.json

发布页有两类特征, 都覆盖:
  A. HTML 里直接印着域名   -> 如 huangguo9.com 的 "ahk4jb.vchllzwu.cc"
  B. HTML 里藏混淆的域名表 -> 一堆 atob / \x 转义后的字符串, 解码后是域名池

用法:
  python hg_discover.py            # 检查 + 打印结果 (不动文件)
  python hg_discover.py --write    # 检查 + 写回 site.json
  python hg_discover.py --json     # 只输出 JSON (给 Actions 用)
"""
import os
import re
import sys
import json
import time
import urllib.request
import urllib.error
import base64
import html as _html

ROOT = os.path.dirname(os.path.abspath(__file__))
SITE_JSON = os.path.join(ROOT, "site.json")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
UA_MOBILE = ("Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36")

# ---- 地址发布页 (黄果官方的"指路牌", 会一直存在) ----
PUBLISH_PAGES = [
    "https://huangguo9.com",
    "https://huangguo10.com",
    "https://huangguo8.com",
    "https://hgai1.com",
    "https://huangguoai.com",
    "https://huangguoai.ai",
    "https://huangguoai.pages.dev",
]

# ---- 真站线路池的"根域名" ----
# 2026-10 实测: 黄果把线路做成「随机段.根域名」的形式, 根域名会换。
# 已知出现过的根 (全部登记下来, 用来给候选打分/判裸主域):
KNOWN_ROOTS = (
    "vchllzwu.cc",     # 当前主力
    "gkudvxhjh.cc",    # 已退役
    "ngfxaxnp.cc",     # 已退役
    "igjktqpd.cc",     # 已退役
)

# 发布页混淆池里出现过的"备用根" —— 这些是主域候选, 需要前缀才算真站
# (如 e8d18cbf.cc / 1bb301.sbs / 287a26.top, 池里直接给的就是完整站名)
POOL_ROOTS = (
    "e8d18cbf.cc", "1bb301.sbs", "287a26.top", "483b974c.net",
    "243d9.xyz", "e2d43cf8.cc", "d2dda704.top", "8c20b51e.xyz",
    "c6f7c4.net", "6c866b492.sbs", "73ae7b.top",
)

# ---- 永远不是数据源的域名 (发布页自己 / CDN / 统计) ----
NEVER = re.compile(
    r"huangguo\d*\.|huangguoai|hgai\d*\.|pages\.dev|"
    r"yandex|google|gstatic|cloudflare|jsdelivr|"
    r"twitter|x\.com|t\.me|telegram|facebook|"
    r"w3\.org|schema\.org|invalid|"
    r"\.(js|css|png|jpg|jpeg|svg|ico|woff2?)$",
    re.I,
)

# ---- 裸主域 (不带子域), 这些是线路的"根", 不能当站点用 ----
BARE_DOMAINS = {
    "vchllzwu.cc", "cname3.com", "cname2.com", "cname1.com",
    "gkudvxhjh.cc", "ngfxaxnp.cc", "igjktqpd.cc",
}

# ---- 真站域名长相: 至少两段, 末段是通用 TLD ----
#   要求 "前缀.主域.TLD" 或 "主域.TLD", 但主域必须是两段
HOST_RE = re.compile(
    r"\b([a-z0-9][a-z0-9-]{1,30}\.(?:[a-z0-9-]{2,20}\.)?[a-z]{2,10})\b",
    re.I,
)

# 只认这几种 TLD, 免得把 js 里的变量名当域名
OK_TLD = {
    "cc", "top", "sbs", "xyz", "net", "com", "vip", "site",
    "lol", "icu", "fun", "cyou", "buzz", "monster", "link",
    "pro", "online", "art", "shop", "store", "club", "live",
    "info", "biz", "org", "co",
}


def http_get(url, referer=None, timeout=12):
    req = urllib.request.Request(url)
    req.add_header("User-Agent", UA)
    req.add_header("Accept", "text/html,application/xhtml+xml,*/*;q=0.8")
    req.add_header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
    # 必须显式声明, 否则服务端回 gzip 我们不接, 拿到的是二进制乱码
    req.add_header("Accept-Encoding", "gzip, deflate")
    if referer:
        req.add_header("Referer", referer)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            enc = (r.headers.get("Content-Encoding") or "").lower()
            if "gzip" in enc:
                try:
                    import gzip as _gz
                    raw = _gz.decompress(raw)
                except Exception:
                    pass
            elif "deflate" in enc:
                try:
                    import zlib
                    raw = zlib.decompress(raw, -zlib.MAX_WBITS)
                except Exception:
                    pass
            return r.getcode(), raw.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception:
        return 0, ""


def http_probe(url, timeout=10):
    """轻量探活: 只要状态码。跟 http_get 分开是为了能并发/短超时。"""
    req = urllib.request.Request(url)
    req.add_header("User-Agent", UA_MOBILE)
    req.add_header("Referer", url.rsplit("/", 2)[0] + "/")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.getcode()
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


# ---------------------------------------------------------------- 解码

def deobfuscate(html):
    """把页面里混淆的字符串解出来, 拼成一大块文本供正则扫。

    上游用两种混淆:
      1. atob("...")        -> 标准 base64
      2. "\x68\x74\x74..."  -> JS 十六进制转义
    两种都解一遍, 反正是多捞, 捞到就是赚。
    """
    chunks = [html]

    # --- 解 \xHH 转义 ---
    def _unx(m):
        try:
            return chr(int(m.group(1), 16))
        except Exception:
            return m.group(0)
    unesc = re.sub(r"\\x([0-9a-fA-F]{2})", _unx, html)
    if unesc != html:
        chunks.append(unesc)

    # --- 解 atob("...") / b64decode 风格的 base64 ---
    b64_re = re.compile(r'"([A-Za-z0-9+/]{16,}={0,2})"')
    for m in b64_re.finditer(unesc):
        s = m.group(1)
        try:
            pad = s + "=" * (-len(s) % 4)
            dec = base64.b64decode(pad).decode("utf-8", "replace")
        except Exception:
            continue
        # 解出来的必须是可打印的、像域名/URL 的东西, 不然是噪声
        if not dec or sum(ch.isprintable() for ch in dec) / max(len(dec), 1) < 0.85:
            continue
        chunks.append(dec)

    return "\n".join(chunks)


def extract_hosts(text):
    """从文本里挖出所有像真站域名的东西, 按出现顺序去重。"""
    out = []
    seen = set()
    for m in HOST_RE.finditer(text):
        h = m.group(1).lower().strip(".")
        if NEVER.search(h):
            continue
        if h in BARE_DOMAINS:
            continue
        parts = h.split(".")
        if len(parts) < 2:
            continue
        if parts[-1] not in OK_TLD:
            continue
        # 前缀太短 (单字母) 或纯数字的, 多半是噪声
        head = parts[0]
        if len(head) < 2:
            continue
        if head.isdigit() and len(parts) == 2:
            continue
        if h in seen:
            continue
        seen.add(h)
        out.append(h)
    return out


def parse_pools(text):
    """解析「域名池」—— 发布页混淆里那种 `a.cc|b.sbs|c.top` 一串。

    黄果 2026-10 的发布页把备用线路池藏成:
        "\\x65\\x38\\x64\\x31...".split("|")   →  e8d18cbf.cc|1bb301.sbs|287a26.top|...
    所以只要看到一坨用 | 分隔、每段都像域名的东西, 就整串收下。
    """
    found = []
    # 找出所有含 | 的连续域名片段
    for m in re.finditer(
        r"((?:[a-z0-9][a-z0-9.-]*\.[a-z]{2,10}\s*\|)+\s*"
        r"[a-z0-9][a-z0-9.-]*\.[a-z]{2,10})", text, re.I):
        chunk = m.group(1)
        for d in chunk.split("|"):
            d = d.strip().lower().strip(".")
            if not d or "." not in d:
                continue
            if NEVER.search(d):
                continue
            if d not in found:
                found.append(d)
    return found


def extract_urls(text):
    """挖完整的线路 URL —— 发布页里 href 直接给的就是当前可用线路。

    比域名更可靠: `https://j31l0.vchllzwu.cc/ai-duanju/` 这种是官方盖章的入口。
    返回 [(host, path), ...]
    """
    out = []
    seen = set()
    for m in re.finditer(r"https?://([a-z0-9][a-z0-9.-]{2,60})(/[^\s\"'<>)（）]*)?",
                         text, re.I):
        h = m.group(1).lower().strip(".")
        path = (m.group(2) or "/")
        if NEVER.search(h):
            continue
        parts = h.split(".")
        if len(parts) < 2 or parts[-1] not in OK_TLD:
            continue
        if h in BARE_DOMAINS:
            continue
        if h not in seen:
            seen.add(h)
            out.append((h, path))
    return out


def rank_hosts(hosts):
    """排序: 黄果的线路名是「随机段.主域.TLD」(如 z1oawp.vchllzwu.cc), 优先这种。

    评分:
      +8  三段式且主域是已知线路根 (vchllzwu.cc 等) —— 最像真站
      +6  在发布页混淆池里出现过的完整站名 (POOL_ROOTS)
      +3  三段式 (随机段.主域.TLD)
      +2  段首是字母数字混合的随机串
      -1  看起来像普通词 (纯字母且很短)
      -3  二段式普通词 (如 duanju.com / kuaikanju.com 这类抢注站)
    """
    pool = set(POOL_ROOTS)

    def key(h):
        parts = h.split(".")
        score = 0
        if len(parts) >= 3:
            score += 3
            if ".".join(parts[1:]) in KNOWN_ROOTS:
                score += 8
        if h in pool:
            score += 6
        head = parts[0]
        if re.fullmatch(r"[a-z0-9]{4,14}", head) and not head.isalpha():
            score += 2
        if len(parts) == 2 and head.isalpha() and len(head) <= 12:
            score -= 3
        return (-score, len(h))

    return sorted(hosts, key=key)


# ---------------------------------------------------------------- 主流程

def discover(rounds=3, probe=True, probe_limit=20):
    """返回 {"hosts": [...], "pages": {...}, "alive": [...]}

    rounds: 发布页每轮随机下发一组线路, 多抓几轮取并集才能把池子做厚
    probe : 是否实测每个候选域名 (本机被墙时全 0, 无害)
    """
    result = {"checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "pages": {}, "candidates": [], "alive": [], "dead": [],
              "routes": [], "pools": []}
    pool = []
    urls = []          # 完整线路 URL (发布页 href 直接给的)
    pools = []         # 混淆域名池
    routes = []        # 分类路由 (如 /ai-duanju/)

    for rnd in range(max(1, rounds)):
        for page in PUBLISH_PAGES:
            st, html = http_get(page, timeout=10)
            rec = result["pages"].setdefault(page, {"status": st, "found": []})
            if st == 200:
                rec["status"] = st
            if st != 200 or not html:
                continue

            blob = deobfuscate(html)

            # --- A. 域名 (老路子) ---
            hosts = extract_hosts(blob)
            for h in hosts:
                if h not in rec["found"]:
                    rec["found"].append(h)
            pool.extend(hosts)

            # --- B. 完整线路 URL (新: 发布页 href 是官方盖章的入口) ---
            for h, path in extract_urls(blob):
                if h not in [u[0] for u in urls]:
                    urls.append((h, path))
                if h not in pool:
                    pool.append(h)

            # --- C. 混淆域名池 (新: `a.cc|b.sbs|c.top` 这种) ---
            for d in parse_pools(blob):
                if d not in pools:
                    pools.append(d)
                if d not in pool:
                    pool.append(d)

            # --- D. 分类路由 ---
            for m in re.finditer(r'href="([^"]*?/(?:ai-[a-z]+|duanju|manju|'
                                 r'huanlian|mogai)/)"', html):
                r = m.group(1)
                if r not in routes:
                    routes.append(r)

        if rnd < rounds - 1:
            time.sleep(0.4)          # 稍微停一下, 别把发布页打急眼

    # 去重 + 排序
    uniq = []
    seen = set()
    for h in rank_hosts(list(dict.fromkeys(pool))):
        if h not in seen:
            seen.add(h)
            uniq.append(h)
    result["candidates"] = uniq
    result["routes"] = routes
    result["pools"] = pools
    result["urls"] = ["https://%s%s" % (h, p) for h, p in urls]

    if not probe:
        return result

    # 实测: 真的能打开、并且看着像剧站 (有 hg-drama-card 或至少 200)
    # 注意: 本机 / Runner 都可能连不上真站 (被墙), 所以探测失败不算错, 只是记下来
    for h in uniq[:probe_limit]:
        url = "https://" + h + "/"
        st = http_probe(url, timeout=6)
        if st == 200:
            st2, body = http_get(url, timeout=8)
            looks_like_site = ("hg-drama-card" in body or
                               "/static/web/js" in body or
                               "黄果" in body)
            result["alive"].append({
                "host": "https://" + h,
                "status": st,
                "size": len(body),
                "siteLike": looks_like_site,
            })
        else:
            result["dead"].append({"host": "https://" + h, "status": st})

    return result


def apply_to_site(discovered, path=SITE_JSON):
    """把发现结果写回 site.json。返回 (changed, summary)

    策略:
      - 探到可用真站   -> 排最前, 老的保留兜底
      - 一个都探不到   -> 仍然把候选写进 mirrors (前端会自己试, 试到哪个算哪个)
                           只在候选非空时才写, 免得把好配置改坏
      - 混淆池 / 完整线路 URL / 分类路由 一并记进 site.json, 供排查与扩展
    """
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)

    alive = [a["host"] for a in discovered["alive"] if a.get("siteLike")]
    cands = ["https://" + h if not h.startswith("http") else h
             for h in discovered["candidates"][:24]]

    if alive:
        head = alive
        note = "探到 %d 个可用真站" % len(alive)
    elif cands:
        head = cands
        note = "未探通(可能被墙), 写入 %d 个候选供前端自试" % len(cands)
    else:
        return False, "发布页无变化, 也没挖到候选, 保持原配置"

    old_origin = cfg.get("origin", "")
    old_mirrors = cfg.get("mirrors", [])

    # 新的排前面, 老的保留在后面兜底
    merged = []
    for h in head + old_mirrors:
        if h and h not in merged:
            merged.append(h)

    # ---- origin 只能在「实测探通」时才改 ----
    # 否则本机被墙时会拿一个没验证的域名当主站, 反而比原来的坏。
    # 没探通的情况下: 候选只追加到 mirrors 尾部, origin 保持不动。
    if alive:
        new_origin = merged[0]
    else:
        new_origin = old_origin or merged[0]
        # 把老 origin 顶回最前
        if new_origin in merged:
            merged.remove(new_origin)
            merged.insert(0, new_origin)

    # 顺带把挖掘到的东西记下来 (pools / urls / routes) —— 下次就知道去哪儿找
    new_pools = discovered.get("pools") or []
    new_routes = discovered.get("routes") or []
    new_urls = discovered.get("urls") or []
    old_pools = list(cfg.get("discoveredPools") or [])
    old_routes = cfg.get("discoveredRoutes") or []

    pools_changed = False
    for p in new_pools:
        if p not in old_pools:
            old_pools.append(p)
            pools_changed = True

    changed = (merged != old_mirrors) or pools_changed

    if changed:
        cfg["origin"] = new_origin
        cfg["mirrors"] = merged
        cfg["updatedAt"] = discovered["checkedAt"]
        if old_pools:
            cfg["discoveredPools"] = old_pools
        if new_routes:
            cfg["discoveredRoutes"] = new_routes
        if new_urls:
            cfg["discoveredUrls"] = new_urls[:40]
        cfg["discoverLog"] = {
            "checkedAt": discovered["checkedAt"],
            "pages": {k: v.get("status") for k, v in discovered["pages"].items()},
            "alive": alive,
            "candidates": cands[:24],
            "poolsFound": len(new_pools),
            "routesFound": len(new_routes),
            "originKept": (not alive) and bool(old_origin),
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
            f.write("\n")

    return changed, "origin %s -> %s (%s)" % (old_origin, new_origin, note)


def main():
    write = "--write" in sys.argv
    as_json = "--json" in sys.argv
    noprobe = "--no-probe" in sys.argv
    rounds = 3
    for i, a in enumerate(sys.argv):
        if a == "--rounds" and i + 1 < len(sys.argv):
            try:
                rounds = int(sys.argv[i + 1])
            except Exception:
                pass

    d = discover(rounds=rounds, probe=not noprobe)

    if as_json:
        out = {"changed": False,
               "alive": [a["host"] for a in d["alive"]],
               "candidates": ["https://" + h for h in d["candidates"][:12]],
               "pages": {k: v.get("status") for k, v in d["pages"].items()}}
        if write:
            ch, msg = apply_to_site(d)
            out["changed"] = ch
            out["message"] = msg
        print(json.dumps(out, ensure_ascii=False))
        return

    print("[discover] 发布页检查:")
    for page, info in d["pages"].items():
        fnd = info.get("found") or []
        print("  %-36s HTTP %-4s 挖到 %d 个域名" % (page, info["status"], len(fnd)))
        for h in fnd[:12]:
            print("        - %s" % h)

    print("\n[discover] 候选域名 %d 个:" % len(d["candidates"]))
    print("  " + ", ".join(d["candidates"][:30]))

    print("\n[discover] 实测存活 %d 个:" % len(d["alive"]))
    for a in d["alive"]:
        print("  %-40s HTTP %s  size=%-7d 像剧站=%s"
              % (a["host"], a["status"], a["size"], a["siteLike"]))
    if d.get("dead"):
        print("[discover] 探测失败 %d 个 (被墙/失效, 正常)" % len(d["dead"]))

    if write:
        ch, msg = apply_to_site(d)
        print("\n[discover] %s | %s" % ("已更新 site.json" if ch else "无需更改", msg))
        if ch:
            sys.exit(42)        # 用退出码 42 告诉 Actions "有变化, 该提交了"


if __name__ == "__main__":
    main()
