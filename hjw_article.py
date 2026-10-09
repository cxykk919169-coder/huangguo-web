# -*- coding: utf-8 -*-
"""海角图文帖专项验证 —— 在 GitHub runner 上跑 (本机被代理拦)。

验证三件事:
  1. 站点是否真的发 Access-Control-Allow-Origin (决定前端能否直连)
  2. 详情页正文容器 <div class="text text-content"> 能否稳定抽出
  3. 正文里 z-image-loader-url 的图片是否为明文直链、能否 200 下载

同时把「金币解锁段落」的真实形态挖出来 —— 之前的 locked 判定疑似误报。
"""
import gzip
import json
import os
import re
import sys
import urllib.request

HOSTS = ["https://www.hjw01.com", "https://hjw01.com", "https://hjw1.com"]

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def get(url, referer=None, origin=None, timeout=25, raw=False):
    """返回 (status, body_or_bytes, headers)。"""
    h = {
        "User-Agent": UA,
        "Accept": ("text/html,application/xhtml+xml,application/xml;q=0.9,"
                   "image/avif,image/webp,*/*;q=0.8"),
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate",
    }
    if referer:
        h["Referer"] = referer
    if origin:
        h["Origin"] = origin
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
            enc = (r.headers.get("Content-Encoding") or "").lower()
            if "gzip" in enc:
                try:
                    data = gzip.decompress(data)
                except Exception:
                    pass
            if raw:
                return r.getcode(), data, dict(r.headers)
            return r.getcode(), data.decode("utf-8", "replace"), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, (b"" if raw else ""), dict(e.headers or {})
    except Exception as e:
        return 0, (b"" if raw else ""), {"_err": str(e)}


def cors_of(hdr):
    keys = {k.lower(): v for k, v in hdr.items()}
    return {
        "acao": keys.get("access-control-allow-origin", ""),
        "acac": keys.get("access-control-allow-credentials", ""),
        "acah": keys.get("access-control-allow-headers", ""),
        "server": keys.get("server", ""),
        "ctype": keys.get("content-type", ""),
    }


def clean_img(u):
    u = (u or "").strip()
    return re.sub(r'^[`\'"\s]+|[`\'"\s]+$', "", u)


def extract_article(html):
    """从详情页抽正文。返回 {html, text, images, endMark}"""
    out = {"html": "", "text": "", "images": [], "endMark": "", "found": False}
    i = html.find('class="text text-content"')
    if i < 0:
        i = html.find("class='text text-content'")
    if i < 0:
        return out
    # 起点: 该 div 的 '>' 之后
    gt = html.find(">", i)
    if gt < 0:
        return out
    start = gt + 1

    # 终点: 最近的 link-wrapper / 标签区 / 评论容器
    ends = []
    for kw in ['class="link-wrapper"', 'class="tag', 'comment-list',
               'class="comment-container"', 'id="comment"']:
        k = html.find(kw, start)
        if k > 0:
            ends.append(k)
    end = min(ends) if ends else start + 120000
    out["endMark"] = "link-wrapper" if (ends and end == min(ends)) else "heuristic"

    body = html[start:end]
    # 去掉最外层残留的 </div>
    body = re.sub(r"</div>\s*$", "", body.strip())
    out["html"] = body
    out["found"] = True

    # 正文纯文本
    t = re.sub(r"<br\s*/?>", "\n", body)
    t = re.sub(r"</p>", "\n", t)
    t = re.sub(r"<[^>]*>", "", t)
    t = re.sub(r"&nbsp;", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t).strip()
    out["text"] = t

    # 正文图片 (明文的 z-image-loader-url)
    imgs = []
    for m in re.finditer(r'z-image-loader-url="([^"]+)"', body):
        u = clean_img(m.group(1))
        if u.startswith("http"):
            imgs.append(u)
    # 兜底: 普通 src
    if not imgs:
        for m in re.finditer(r'<img[^>]+src="(https?://[^"]+)"', body):
            imgs.append(m.group(1))
    out["images"] = imgs
    return out


def main():
    os.makedirs("verify2", exist_ok=True)
    rep = {"cors": [], "articles": [], "lockedTruth": [], "ok": 0}

    # ---------- 1) CORS ----------
    base = None
    for h in HOSTS:
        st, body, hdr = get(h + "/", origin="https://example.com")
        c = cors_of(hdr)
        c.update({"host": h, "status": st, "bytes": len(body)})
        rep["cors"].append(c)
        print("[CORS] %-24s st=%s bytes=%s acao=%r" %
              (h, st, len(body), c["acao"]))
        if st == 200 and len(body) > 50000 and not base:
            base = h
    if not base:
        print("!! 没有可用入口")
        json.dump(rep, open("verify2/report.json", "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
        return 1
    print("base =", base)

    # ---------- 2) 从首页拿一批 id ----------
    st, html, _ = get(base + "/")
    ids = []
    seen = set()
    for m in re.finditer(r'href="/archives/(\d+)/?"', html):
        if m.group(1) not in seen:
            seen.add(m.group(1))
            ids.append(m.group(1))
    print("首页 id:", len(ids))

    # ---------- 3) 抓详情页, 分类 图文/视频 ----------
    arts, vids = [], []
    for pid in ids[:14]:
        st, h2, _ = get(base + "/archives/%s/" % pid, referer=base + "/")
        if st != 200:
            continue
        a = extract_article(h2)
        cfg = ""
        m = re.search(r"data-config='([^']+)'", h2)
        if m:
            try:
                j = json.loads(m.group(1).replace("\\/", "/").replace("&quot;", '"'))
                cfg = ((j.get("video") or {}).get("url") or "")
            except Exception:
                pass
        kind = "video" if cfg else ("article" if a["found"] else "unknown")

        # 金币解锁段落的真实标记探测
        gold = {
            "id": pid, "kind": kind,
            "GOLD_PAYMENT_ENABLED_true": bool(
                re.search(r'GOLD_PAYMENT_ENABLED["\']?\s*:\s*true', h2)),
            "has_金币_word": "金币" in h2,
            "has_解锁_word": "解锁" in h2,
            "has_付费可见": "付费可见" in h2,
            "has_需支付": "需支付" in h2,
            "has_vip_only": bool(re.search(r'vip[_\-]?only|is_vip|vip_visible', h2, re.I)),
            "article_images": len(a["images"]),
            "article_chars": len(a["text"]),
        }
        # 在正文里找解锁/付费相关容器
        corp = a["html"]
        gold["body_has_pay_kw"] = bool(re.search(
            r"解锁|付费可见|购买后|支付|打赏|金币查看|回复可见|隐藏内容", corp))
        rep["lockedTruth"].append(gold)
        print("[%s] id=%s imgs=%d chars=%d paykw=%s" %
              (kind.upper(), pid, gold["article_images"],
               gold["article_chars"], gold["body_has_pay_kw"]))

        if kind == "article":
            arts.append({"id": pid, "title": "", "images": a["images"],
                         "text": a["text"][:400], "chars": len(a["text"])})
            # 验证第 1 张图能否下载
            if a["images"]:
                st2, data, hd2 = get(a["images"][0], referer=base + "/", raw=True)
                arts[-1]["img0_status"] = st2
                arts[-1]["img0_bytes"] = len(data)
                arts[-1]["img0_cors"] = cors_of(hd2)["acao"]
                print("      img0 -> %s %sB acao=%r" %
                      (st2, len(data), arts[-1]["img0_cors"]))
            m = re.search(r"<title[^>]*>([^<]*)</title>", h2)
            if m:
                arts[-1]["title"] = m.group(1).split("|")[0].strip()
        else:
            vids.append({"id": pid, "m3u8": cfg[:120]})

    rep["articles"] = arts
    rep["videoCount"] = len(vids)
    rep["articleCount"] = len(arts)
    rep["ok"] = len(arts)
    json.dump(rep, open("verify2/report.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("\n图文帖 %d 篇 / 视频帖 %d 篇" % (len(arts), len(vids)))
    print("已写 verify2/report.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
