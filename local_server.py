
# -*- coding: utf-8 -*-
"""本地 Worker 模拟器: 在 8899 端口, 用 Python 复刻 worker.js 的全部接口
   目的: 让 index.html 在本地就能跑, 验证前后端全链路
   部署 Cloudflare 后, index.html 换个 API 地址即可
"""
import http.server, socketserver, urllib.request, urllib.parse, gzip, ssl, re, json, socket

UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
# 镜像以 site.json 的 origin/mirrors 为准; 下面只是首屏兜底。
# 2026-10 更新: 老 ngfxaxnp/gkudvxhjh 系已失效, 真站迁到 *.vchllzwu.cc。
MIRRORS = ["https://th10.vchllzwu.cc","https://fo3l.vchllzwu.cc","https://vqi6.vchllzwu.cc",
           "https://s1er.vchllzwu.cc","https://z5b68b.vchllzwu.cc","https://bqvspv.vchllzwu.cc"]
# EROSHORT (eroshort.net) REST 基址
ES_API_BASE = "https://eroshort.net/api/v1"
# 公共 CORS 中转池 (本地/数据中心出口被 CF 拦时走这里)
# 2026-10-09 本机实测: allorigins /get 包装端点最稳 (200 + {"contents":"..."}), 置顶。
ES_RELAYS = [
    ("allorigins-get", "https://api.allorigins.win/get?url=", True),
    ("allorigins-raw", "https://api.allorigins.win/raw?url=", False),
    ("cors.lol", "https://api.cors.lol/?url=", False),
    ("codetabs", "https://api.codetabs.com/v1/proxy?quest=", False),
]
_ctx = ssl.create_default_context(); _ctx.check_hostname=False; _ctx.verify_mode=ssl.CERT_NONE

def _es_fetch(full, hdrs):
    """直连 → 中转池。返回 (json_or_None, via)。"""
    def _try(url, wrap=False):
        req = urllib.request.Request(url, headers=hdrs)
        r = urllib.request.urlopen(req, timeout=35, context=_ctx)
        d = r.read()
        if r.headers.get("Content-Encoding") == "gzip": d = gzip.decompress(d)
        tx = d.decode("utf-8", "ignore")
        if re.match(r"^\s*<(!DOCTYPE|html)", tx, re.I): return None
        if wrap:
            try:
                env = json.loads(tx)
                if isinstance(env, dict) and isinstance(env.get("contents"), str):
                    tx = env["contents"]
            except Exception:
                pass
        if tx.lstrip()[:1] != "{": return None
        return json.loads(tx)
    try:
        j = _try(full)
        if j is not None: return j, "direct"
    except Exception:
        pass
    enc = urllib.parse.quote(full, safe="")
    for _name, _p, _wrap in ES_RELAYS:
        try:
            j = _try(_p + enc, _wrap)
            if j is not None: return j, _name
        except Exception:
            continue
    return None, ""


def raw_get(base, path):
    req = urllib.request.Request(base+path, headers={
        "User-Agent":UA,"Accept":"text/html,*/*","Accept-Language":"zh-CN,zh;q=0.9","Referer":base+"/"})
    r = urllib.request.urlopen(req, timeout=30, context=_ctx)
    d = r.read()
    if r.headers.get("Content-Encoding")=="gzip": d = gzip.decompress(d)
    return d.decode("utf-8","ignore")

def get(path):
    last=None
    for b in MIRRORS:
        try: return raw_get(b, path)
        except Exception as e: last=e
    raise last or Exception("all mirrors failed")

# ---- 统一解析器 (五源合并, 自动过滤广告) ----
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
try:
    from hg_parser import parse_cards as _parse_cards, parse_video as _parse_video, parse_ep as _parse_ep
except Exception as _e:
    raise RuntimeError("缺少 hg_parser.py, 请与 local_server.py 放在同一目录: %s" % _e)


def parse_cards(html):
    items, _stats = _parse_cards(html)
    return items


def parse_video(html):
    meta, eps = _parse_video(html)
    if not meta.get("id"):
        return None
    meta = dict(meta)
    meta["eps"] = eps
    return meta


def parse_ep(html, ep):
    return _parse_ep(html, ep)

# 静态资源目录 = 本文件所在目录 (不再硬编码到某台机器的桌面路径)
HERE = _os.path.dirname(_os.path.abspath(__file__))

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def _json(self,o):
        b=json.dumps(o,ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin","*")
        self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def _file(self, p, ct):
        try:
            b=open(p,"rb").read()
        except Exception:
            self.send_response(404); self.end_headers(); return
        self.send_response(200); self.send_header("Content-Type",ct)
        self.send_header("Access-Control-Allow-Origin","*")
        self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u=urllib.parse.urlparse(self.path); q=urllib.parse.parse_qs(u.query); p=u.path
        try:
            if p in ("/","/index.html"): return self._file(HERE+r"\index.html","text/html; charset=utf-8")
            if p=="/site.json": return self._file(HERE+r"\site.json","application/json; charset=utf-8")
            # 前端脚本 (与线上 deploy.yml 白名单一致)
            for _n in ("hls.min.js","hg-direct.js","hg-hd.js","hg-es.js","hg-hjw.js",
                       "crypto-js.min.js","sw.js","manifest.json"):
                if p == "/"+_n:
                    _ct = "application/javascript; charset=utf-8" if _n.endswith(".js") else "application/json; charset=utf-8"
                    return self._file(HERE+"\\"+_n, _ct)
            # 数据快照
            if p.startswith("/data/"):
                _rel = p[len("/data/"):]
                if re.fullmatch(r"[A-Za-z0-9_.-]+\.json", _rel or ""):
                    return self._file(HERE+"\\data\\"+_rel, "application/json; charset=utf-8")
                self.send_response(404); self.end_headers(); return
            if p=="/api/health":
                ok=None
                for m in MIRRORS:
                    try:
                        raw_get(m,"/"); ok=m; break
                    except Exception: pass
                return self._json({"ok":bool(ok),"mirror":ok,"mirrors":MIRRORS})
            if p=="/api/list":
                cat=(q.get("cat") or [""])[0].strip()
                page=max(1,int((q.get("page") or ["1"])[0]))
                path = ("/"+cat+"/" if cat else "/")
                if page>1: path = "/"+cat+"/%d/"%page
                return self._json({"items":parse_cards(get(path)),"page":page,"cat":cat})
            if p=="/api/search":
                kw=(q.get("q") or [""])[0].strip()
                if not kw: return self._json({"items":[]})
                return self._json({"items":parse_cards(get("/search/?keyword="+urllib.parse.quote(kw)))[:60]})
            if p=="/api/video":
                raw=(q.get("id") or [""])[0]; mm=re.findall(r'\d+',raw)
                if not mm: return self._json({"error":"需要剧集ID"})
                v=parse_video(get("/video/"+mm[0]+"/"))
                if not v: return self._json({"error":"解析失败"})
                if not v["epTotal"]: v["epTotal"]=max(len(v["eps"]),1)
                return self._json(v)
            if p=="/api/ep":
                raw=(q.get("id") or [""])[0]; ep=int((q.get("ep") or ["1"])[0] or 1)
                mm=re.findall(r'\d+',raw)
                if not mm: return self._json({"error":"需要剧集ID"})
                path = "/video/%s/ep-%d/"%(mm[0],ep) if ep>1 else "/video/%s/"%mm[0]
                return self._json({"id":mm[0],"ep":ep,"url":parse_ep(get(path),ep)})
            # ---- EROSHORT (eroshort.net) 转发 ----
            # eroshort.net 对数据中心/本地出口一律 CF 硬拦 (403 block page),
            # 所以本地也是 直连 → 公共 CORS 中转 的降级链, 与线上 Worker 同构。
            # 仅供前端联调: 真实可用性以线上 Worker + data/es-*.json 快照为准。
            if p.startswith("/api/es"):
                sub = p[len("/api/es"):] or "/shorts"
                if sub == "/health":
                    sub = "/shorts?page=1&page_size=1"
                qs = ("?"+u.query) if u.query else ""
                full = ES_API_BASE + sub + qs
                hdrs = {"User-Agent": UA, "Accept": "application/json, text/plain, */*",
                        "Accept-Language": "zh-CN,zh;q=0.9", "Referer": "https://eroshort.net/",
                        "Origin": "https://eroshort.net"}
                res, via = _es_fetch(full, hdrs)
                if res is not None:
                    return self._json(res)
                return self._json({"ok": False, "service": "es", "error": "CF_CHALLENGE",
                                   "via": via, "hint": "本地/数据中心出口被 CF 拦, 见 data/es-*.json 快照"})
            self.send_response(404); self.end_headers()
        except Exception as e:
            self._json({"error":str(e)})

    def do_POST(self):
        u = urllib.parse.urlparse(self.path); p = u.path
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n) if n else b""
            if p.startswith("/api/es"):
                sub = p[len("/api/es"):] or "/playback/resolve"
                qs = ("?"+u.query) if u.query else ""
                target = ES_API_BASE + sub + qs
                try:
                    req = urllib.request.Request(target, data=body, method="POST", headers={
                        "User-Agent": UA, "Accept": "application/json",
                        "Content-Type": self.headers.get("Content-Type") or "application/json",
                        "Referer": "https://eroshort.net/", "Origin": "https://eroshort.net"})
                    r = urllib.request.urlopen(req, timeout=25, context=_ctx)
                    d = r.read()
                    if r.headers.get("Content-Encoding") == "gzip": d = gzip.decompress(d)
                    tx = d.decode("utf-8", "ignore")
                    if tx.lstrip()[:1] == "<":
                        return self._json({"ok": False, "error": "CF_CHALLENGE"})
                    b = tx.encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
                    return
                except Exception as e:
                    return self._json({"ok": False, "error": str(e)})
            self.send_response(404); self.end_headers()
        except Exception as e:
            self._json({"error": str(e)})

import sys
port = int(sys.argv[1]) if len(sys.argv)>1 else 8899
ips=[]
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
try:
    s.connect(("8.8.8.8",80)); ips.append(s.getsockname()[0])
except Exception: pass
finally: s.close()
print("="*58)
print("[+] 本地 Worker 模拟器已启动 (完全复刻 worker.js)")
print("[*] 本机:  http://127.0.0.1:%d/index.html" % port)
for i in ips: print("[*] 手机:  http://%s:%d/index.html" % (i, port))
print("="*58)
socketserver.TCPServer.allow_reuse_address=True
with socketserver.ThreadingTCPServer(("0.0.0.0",port),H) as srv:
    srv.serve_forever()
