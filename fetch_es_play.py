# -*- coding: utf-8 -*-
"""ERO 播放地址快照: 把每集的真实流地址提前 resolve 好, 落盘 data/es-play.json。

为什么必须做:
  播放链路是三跳实时上游请求 (playlines -> entitlement -> playback/resolve),
  而 eroshort.net 对数据中心/CF 出口硬拦, 只能走公共 CORS 中转。中转是**间歇性**可用的,
  于是"点开某集 → 502 → 播不了"就成了常态。
  列表/分类/详情都有同源快照兜底(毫秒返回), 唯独播放地址没有 —— 这是最后一个缺口。

产出 data/es-play.json:
  {
    "updatedAt": "...",
    "build": "dcdcc1...",
    "plays": {
      "<episodeId>": {"url": "...", "format": "hls|direct|stego_hls",
                      "expiresAt": <epoch|null>, "free": true, "at": <epoch>}
    }
  }

用法:
    python fetch_es_play.py                 # 只补还没解析过的
    python fetch_es_play.py --limit 30      # 只跑 30 集
    python fetch_es_play.py --refresh       # 全部重解析
"""
import json
import os
import ssl
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

API = "https://eroshort.net/api/v1"
BUILD = "dcdcc161385053f622cedf86ed610abd33dae3e034af5366a8a76a058baad118"

HDR = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Referer": "https://eroshort.net/",
    "Origin": "https://eroshort.net",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

# (名字, 前缀, 是否 allorigins /get 包一层)
RELAYS = [
    ("ao-raw", "https://api.allorigins.win/raw?url=", False),
    ("ao-get", "https://api.allorigins.win/get?url=", True),
    ("corslol", "https://api.cors.lol/?url=", False),
    ("codetabs", "https://api.codetabs.com/v1/proxy?quest=", False),
]

HERE = os.path.dirname(os.path.abspath(__file__))
DETAIL = os.path.join(HERE, "data", "es-detail.json")
PLAY = os.path.join(HERE, "data", "es-play.json")


def _one(pre, isget, path, method, body, timeout):
    try:
        u = pre + urllib.parse.quote(API + path, safe="")
        r = urllib.request.Request(u, data=body.encode() if body else None, method=method)
        for k, v in HDR.items():
            r.add_header(k, v)
        if body:
            r.add_header("Content-Type", "application/json")
        raw = urllib.request.urlopen(r, timeout=timeout, context=CTX).read().decode("utf-8", "ignore")
        if raw.lstrip()[:1] == "<":
            return None
        if isget:
            try:
                e = json.loads(raw)
                if isinstance(e, dict) and isinstance(e.get("contents"), str):
                    raw = e["contents"]
            except Exception:
                pass
        return json.loads(raw)
    except Exception:
        return None


def race(path, method="GET", body=None, rounds=3, timeout=14):
    """并发打所有中转, 谁先回来用谁。
    串行试 4 个中转 × 20s 超时 = 单次最坏 80s; 并发竞速把最坏压到 20s, 吞吐高 4 倍。"""
    for _ in range(rounds):
        with ThreadPoolExecutor(max_workers=len(RELAYS)) as ex:
            futs = [ex.submit(_one, pre, isget, path, method, body, timeout) for _, pre, isget in RELAYS]
            for f in futs:
                r = f.result()
                if r is not None:
                    return r
        time.sleep(0.8)
    return None


def resolve_ep(ep_id):
    """单集: playlines → (has_access) → resolve。返回 dict 或 None。"""
    pl = race("/playlines/episode/" + urllib.parse.quote(ep_id))
    if not pl or not isinstance(pl, dict):
        return None
    lines = pl.get("data") or []
    usable = [l for l in lines
              if isinstance(l, dict) and l.get("is_active") is not False
              and l.get("has_access") is not False and l.get("source_id") and l.get("content_id")
              and l.get("source_kind") in ("owned", "external_hls")]
    if not usable:
        # 明确没权限 / 无线路: 记一个 locked 标记, 前端就不必再打上游
        return {"locked": True, "reason": "no_source"}
    L = usable[0]
    body = json.dumps({
        "source_kind": L["source_kind"],
        "source_id": L["source_id"],
        "content_id": L["content_id"],
        "build_id": BUILD,
    })
    rr = race("/playback/resolve", "POST", body, rounds=4)
    if not rr or not isinstance(rr, dict):
        return None
    R = rr.get("data") or {}
    url = R.get("url") or ""
    if not url:
        return {"locked": True, "reason": "unavailable"}
    fmt = ("hls" if R.get("delivery") == "hls"
           else "stego_hls" if R.get("delivery") == "stego_hls"
           else "direct" if R.get("delivery") == "direct" else "unsupported")
    return {"url": url, "format": fmt, "expiresAt": R.get("expires_at"), "free": True}


def save(J, plays):
    J["plays"] = plays
    J["count"] = len(plays)
    J["updatedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
    tmp = PLAY + ".tmp"
    open(tmp, "w", encoding="utf-8").write(json.dumps(J, ensure_ascii=False, indent=1))
    os.replace(tmp, PLAY)


def main():
    limit = 0
    refresh = "--refresh" in sys.argv
    if "--limit" in sys.argv:
        try:
            limit = int(sys.argv[sys.argv.index("--limit") + 1])
        except Exception:
            pass

    if not os.path.exists(DETAIL):
        print("缺 %s" % DETAIL)
        return 1
    det = json.load(open(DETAIL, encoding="utf-8")).get("details") or {}

    J = {"build": BUILD, "plays": {}}
    if os.path.exists(PLAY) and not refresh:
        try:
            J = json.load(open(PLAY, encoding="utf-8"))
        except Exception:
            pass
    plays = J.get("plays") or {}

    todo = []
    for did, d in det.items():
        for e in (d.get("eps") or []):
            eid = e.get("id")
            if not eid:
                continue
            if not refresh and isinstance(plays.get(eid), dict) and not plays[eid].get("locked"):
                continue
            todo.append(eid)
    if limit:
        todo = todo[:limit]
    print("待解析 %d 集 (已有 %d)" % (len(todo), len(plays)), flush=True)

    got = 0
    tried = 0
    for i, eid in enumerate(todo, 1):
        r = resolve_ep(eid)
        tried += 1
        if r is None:
            print("  [%d/%d] %s FAIL" % (i, len(todo), eid[:8]), flush=True)
            # 连续失败说明这条路根本走不通 (resolve 是 POST, 公共中转不转发 body),
            # 别把 150 集 × 1 分钟全耗光 —— 早点退出, 让 workflow 去干别的。
            if tried >= 6 and got == 0:
                print("连续 %d 次全败且零产出 → 判定本站出口无法完成 POST resolve, 中止" % tried, flush=True)
                return 1
            continue
        r["at"] = int(time.time())
        plays[eid] = r
        got += 1
        tag = r.get("format") or ("locked:%s" % r.get("reason"))
        print("  [%d/%d] %s OK %s" % (i, len(todo), eid[:8], tag), flush=True)
        save(J, plays)          # 增量落盘, 中断不丢
        time.sleep(0.4)

    if not got:
        print("本轮没解析到任何地址, 不写文件 (防退化)", flush=True)
        return 1
    n_ok = len([1 for v in plays.values() if isinstance(v, dict) and v.get("url")])
    print("本轮 +%d, 累计 %d 条 (可播 %d)" % (got, len(plays), n_ok), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
