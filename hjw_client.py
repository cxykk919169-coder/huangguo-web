# -*- coding: utf-8 -*-
r"""海角网 (hjw01.com) 客户端 —— 协议复现。

站点: Typecho + Vue SPA
播放: DPlayer + hls.js
保护: 自研 AES + 签名 (无第三方 SDK, 密钥全部硬编码在前端)

协议还原 (来自 /usr/themes/haijiao3/assets/__base/js/crypto.js):

  报文加密 Encrypt(word):
      srcs      = Utf8.parse(json(word))
      cipher    = AES-CBC-Pkcs7(srcs, key, iv)          # key/iv 见下
      data      = Base64(cipher.ciphertext)
      timestamp = int(now/1000)
      sign      = getSign({data, timestamp, client:'ios'})
      body      = "client=ios&data=<b64>&sign=<md5>&timestamp=<ts>"

  签名 getSign(obj):
      text = "client=ios&data=<b64>&timestamp=<ts>" + sign_key
      sign = MD5( SHA256(text) )

  视频解密 DecryptVideo(word):
      plain = URL-safe? 不; 直接 AES-CBC-Pkcs7.decrypt(b64, media_key, media_iv) -> Utf8
      得到真实 m3u8 地址

  图片解密 DecryptImage(word):
      AES-CBC-NoPadding.decrypt(b64, media_key, media_iv) -> Base64

密钥 (全部由 charCode 数组还原):
  key        = 2acf7e91e9864673        (16B)
  iv         = 1c29882d3ddfcfd6        (16B)
  sign_key   = 5589d41f92a597d016b037ac37db243d  (32B)
  media_key  = f5d965df75336270        (16B)
  media_iv   = 97b60394abc2fbe1        (16B)
  IM:  im_key = Ksl5I9PXK63EdiJh  im_iv = fyMqKuq1a4n0PJwf

接口: https://apiv{1,2,3}.{apiDomain}/api.php
      apiDomain 从 localStorage 读 (站点自己会写), 兜底用页面里的 AI 中转域
"""
import base64
import hashlib
import json
import os
import random
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# ---------------------------------------------------------------- 密钥

KEY = b"2acf7e91e9864673"
IV = b"1c29882d3ddfcfd6"
SIGN_KEY = b"5589d41f92a597d016b037ac37db243d"
MEDIA_KEY = b"f5d965df75336270"
MEDIA_IV = b"97b60394abc2fbe1"

IM_KEY = b"Ksl5I9PXK63EdiJh"
IM_IV = b"fyMqKuq1a4n0PJwf"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


# ---------------------------------------------------------------- AES-CBC
# 不依赖 pycryptodome 的纯 Python 实现 (runner 里 pip 装包有风险, 这段代码自足)

SBOX = [
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
]
INV_SBOX = [0] * 256
for _i, _v in enumerate(SBOX):
    INV_SBOX[_v] = _i

RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36,
        0x6c, 0xd8, 0xab, 0x4d, 0x9a]


def _xtime(a):
    a <<= 1
    if a & 0x100:
        a = (a ^ 0x1b) & 0xff
    return a


def _mul(a, b):
    r = 0
    while b:
        if b & 1:
            r ^= a
        a = _xtime(a)
        b >>= 1
    return r & 0xff


def _expand_key(key):
    nk = len(key) // 4
    nr = nk + 6
    w = [list(key[4 * i:4 * i + 4]) for i in range(nk)]
    for i in range(nk, 4 * (nr + 1)):
        t = list(w[i - 1])
        if i % nk == 0:
            t = t[1:] + t[:1]
            t = [SBOX[x] for x in t]
            t[0] ^= RCON[i // nk - 1]
        elif nk > 6 and i % nk == 4:
            t = [SBOX[x] for x in t]
        w.append([w[i - nk][j] ^ t[j] for j in range(4)])
    return w, nr


def _add_round_key(s, w, rnd):
    for c in range(4):
        for r in range(4):
            s[r + 4 * c] ^= w[rnd * 4 + c][r]


def _encrypt_block(block, w, nr):
    s = list(block)
    _add_round_key(s, w, 0)
    for rnd in range(1, nr + 1):
        s = [SBOX[x] for x in s]
        # ShiftRows (state is column-major: s[r + 4c])
        t = list(s)
        for r in range(1, 4):
            row = [t[r + 4 * c] for c in range(4)]
            row = row[r:] + row[:r]
            for c in range(4):
                s[r + 4 * c] = row[c]
        if rnd != nr:
            t = list(s)
            for c in range(4):
                a = t[4 * c:4 * c + 4]
                s[4 * c + 0] = _mul(a[0], 2) ^ _mul(a[1], 3) ^ a[2] ^ a[3]
                s[4 * c + 1] = a[0] ^ _mul(a[1], 2) ^ _mul(a[2], 3) ^ a[3]
                s[4 * c + 2] = a[0] ^ a[1] ^ _mul(a[2], 2) ^ _mul(a[3], 3)
                s[4 * c + 3] = _mul(a[0], 3) ^ a[1] ^ a[2] ^ _mul(a[3], 2)
        _add_round_key(s, w, rnd)
    return bytes(s)


def _decrypt_block(block, w, nr):
    s = list(block)
    _add_round_key(s, w, nr)
    for rnd in range(nr - 1, -1, -1):
        # InvShiftRows
        t = list(s)
        for r in range(1, 4):
            row = [t[r + 4 * c] for c in range(4)]
            row = row[-r:] + row[:-r]
            for c in range(4):
                s[r + 4 * c] = row[c]
        s = [INV_SBOX[x] for x in s]
        _add_round_key(s, w, rnd)
        if rnd != 0:
            t = list(s)
            for c in range(4):
                a = t[4 * c:4 * c + 4]
                s[4 * c + 0] = (_mul(a[0], 14) ^ _mul(a[1], 11) ^
                                _mul(a[2], 13) ^ _mul(a[3], 9))
                s[4 * c + 1] = (_mul(a[0], 9) ^ _mul(a[1], 14) ^
                                _mul(a[2], 11) ^ _mul(a[3], 13))
                s[4 * c + 2] = (_mul(a[0], 13) ^ _mul(a[1], 9) ^
                                _mul(a[2], 14) ^ _mul(a[3], 11))
                s[4 * c + 3] = (_mul(a[0], 11) ^ _mul(a[1], 13) ^
                                _mul(a[2], 9) ^ _mul(a[3], 14))
    return bytes(s)


def _pkcs7_pad(data, bs=16):
    n = bs - (len(data) % bs)
    return data + bytes([n]) * n


def _pkcs7_unpad(data, bs=16):
    if not data:
        return data
    n = data[-1]
    if 1 <= n <= bs and data[-n:] == bytes([n]) * n:
        return data[:-n]
    return data


def _cbc_encrypt(plain, key, iv):
    w, nr = _expand_key(key)
    out = bytearray()
    prev = iv
    plain = _pkcs7_pad(plain)
    for i in range(0, len(plain), 16):
        blk = bytes(a ^ b for a, b in zip(plain[i:i + 16], prev))
        enc = _encrypt_block(blk, w, nr)
        out += enc
        prev = enc
    return bytes(out)


def _cbc_decrypt(cipher, key, iv, unpad=True):
    w, nr = _expand_key(key)
    out = bytearray()
    prev = iv
    for i in range(0, len(cipher), 16):
        blk = cipher[i:i + 16]
        dec = _decrypt_block(blk, w, nr)
        out += bytes(a ^ b for a, b in zip(dec, prev))
        prev = blk
    return _pkcs7_unpad(bytes(out)) if unpad else bytes(out)


# ---------------------------------------------------------------- 签名 / 报文

def get_sign(data, timestamp, client="ios"):
    """getSign: MD5( SHA256("client=..&data=..&timestamp=.." + sign_key) )"""
    text = "client=%s&data=%s&timestamp=%s" % (client, data, timestamp)
    text = text.encode() + SIGN_KEY
    return hashlib.md5(hashlib.sha256(text).hexdigest().encode()).hexdigest()


def encrypt_payload(obj):
    """Encrypt(): 返回 {"data","sign","timestamp","client"} + 串化 body"""
    word = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False,
                                                       separators=(",", ":"))
    cipher = _cbc_encrypt(word.encode("utf-8"), KEY, IV)
    b64 = base64.b64encode(cipher).decode()
    ts = int(time.time())
    sign = get_sign(b64, ts)
    # SeralizeOrdered: client & data & sign & timestamp (顺序固定)
    body = "client=ios&data=%s&sign=%s&timestamp=%s" % (
        urllib.parse.quote(b64, safe=""), sign, ts)
    return {"data": b64, "sign": sign, "timestamp": ts, "client": "ios",
            "_body": body}


def decrypt_payload(b64):
    """Decrypt()"""
    raw = base64.b64decode(b64)
    return _cbc_decrypt(raw, KEY, IV)


def decrypt_video(word):
    """DecryptVideo(): 密文 -> 真 m3u8 地址"""
    raw = base64.b64decode(word)
    return _cbc_decrypt(raw, MEDIA_KEY, MEDIA_IV).decode("utf-8", "replace")


def decrypt_image(word):
    """DecryptImage(): 密文 -> Base64(图)   (NoPadding)"""
    raw = base64.b64decode(word)
    return base64.b64encode(_cbc_decrypt(raw, MEDIA_KEY, MEDIA_IV, unpad=False)).decode()


# ---------------------------------------------------------------- HTTP

def http(url, data=None, referer=None, timeout=25, method=None, json_body=None,
         extra_headers=None):
    headers = {
        "User-Agent": UA,
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Accept-Encoding": "identity",
        "Origin": "https://www.hjw01.com",
    }
    if referer:
        headers["Referer"] = referer
    if extra_headers:
        headers.update(extra_headers)
    body = None
    if json_body is not None:
        body = json.dumps(json_body).encode()
        headers["Content-Type"] = "application/json"
    elif data is not None:
        body = data if isinstance(data, bytes) else data.encode()
        headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
    req = urllib.request.Request(url, data=body, headers=headers,
                                 method=method or ("POST" if body else "GET"))
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
            return r.getcode(), r.read().decode("utf-8", "replace"), dict(r.headers)
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read().decode("utf-8", "replace"), dict(e.headers)
        except Exception:
            return e.code, "", {}
    except Exception as e:
        return 0, "", {"_err": str(e)}


# ---------------------------------------------------------------- 站点

def read_home(host="https://www.hjw01.com"):
    """抓主页, 拿 apiDomain / AI 中转 / 文章 id"""
    st, body, hdr = http(host + "/")
    info = {"status": st, "bytes": len(body), "apiHints": [], "aiConfig": None,
            "ids": [], "title": ""}
    m = re.search(r"<title[^>]*>([^<]*)</title>", body, re.I)
    if m:
        info["title"] = m.group(1).strip()
    for m in re.finditer(r"apiDomain['\"]?\s*[:=]\s*['\"]([^'\"]+)['\"]", body):
        info["apiHints"].append(m.group(1))
    m = re.search(r"window\.__AI_TECH_CONFIG__\s*=\s*(\{[^;]*\})", body)
    if m:
        try:
            info["aiConfig"] = json.loads(m.group(1))
        except Exception:
            info["aiConfig"] = {"raw": m.group(1)[:200]}
    ids = []
    for m in re.finditer(r"/archives/(\d+)/?", body):
        if m.group(1) not in ids:
            ids.append(m.group(1))
    info["ids"] = ids
    return info, body


def guess_api_hosts(home_html, ai_cfg):
    """apiDomain 由站点 JS 写入 localStorage。我们不知道确切值, 就把候选全列出来。"""
    cands = set()
    for m in re.finditer(r"([a-z0-9][a-z0-9.\-]{4,60}\.(?:cc|com|net|top|sbs|xyz|ai|cn))", home_html, re.I):
        d = m.group(1).lower()
        if any(x in d for x in ("hjw", "haijiao", "wlwvch", "zvpxyyql")):
            cands.add(d)
    if ai_cfg:
        for k in ("domain", "jumpBaseURL"):
            v = ai_cfg.get(k) or ""
            mm = re.search(r"https?://([a-z0-9.\-]+)", v, re.I)
            if mm:
                cands.add(mm.group(1).lower())
    # 拉出所有 http(s) 域
    for m in re.finditer(r"https?://([a-z0-9][a-z0-9.\-]{4,60})", home_html, re.I):
        d = m.group(1).lower()
        if re.search(r"(hjw|haijiao|api|wlwvch|zvpxyyql)", d):
            cands.add(d)
    return sorted(cands)


def try_api(base_host, verbose=True):
    """试 api.php —— 先来个最简单的加密 PING 请求, 看什么反应"""
    results = []
    forms = ["apiv1.", "apiv2.", "apiv3.", "", "api.", "www."]
    for f in forms:
        host = f + base_host if f else base_host
        url = "https://%s/api.php" % host
        body = encrypt_payload({"type": "config"})["_body"]
        st, txt, hdr = http(url, data=body, referer="https://www.hjw01.com/", timeout=15)
        snippet = txt[:220].replace("\n", " ")
        results.append({"url": url, "status": st, "len": len(txt),
                        "snippet": snippet, "err": hdr.get("_err", "")})
        if verbose:
            print("  %-46s %s %6dB  %s" % (url, st, len(txt), snippet[:100]))
    return results


def main():
    print("=" * 74)
    print("海角网客户端自测")
    print("=" * 74)

    # ---- 1) 自测加密往返 ----
    print("\n[1] AES-CBC 往返自测")
    plain = {"test": "海角", "n": 123}
    enc = encrypt_payload(plain)
    dec = decrypt_payload(enc["data"]).decode("utf-8")
    print("    plain  :", json.dumps(plain, ensure_ascii=False))
    print("    b64    :", enc["data"][:64], "...")
    print("    sign   :", enc["sign"])
    print("    dec    :", dec)
    assert json.loads(dec) == plain, "往返失败!"
    print("    ✅ 一致")

    # ---- 2) 抓主页 ----
    print("\n[2] 抓主页")
    info, home = read_home()
    print("    status=%s bytes=%s title=%s" % (info["status"], info["bytes"], info["title"]))
    print("    AI中转:", json.dumps(info["aiConfig"], ensure_ascii=False))
    print("    文章 id: %d 个, 前 5 = %s" % (len(info["ids"]), info["ids"][:5]))
    with open("hjw_home.html", "w", encoding="utf-8") as f:
        f.write(home)

    # ---- 3) 候选 API 主机 ----
    print("\n[3] 候选 API 主机")
    cands = guess_api_hosts(home, info["aiConfig"])
    for c in cands:
        print("    ·", c)
    with open("hjw_apihosts.json", "w", encoding="utf-8") as f:
        json.dump(cands, f, ensure_ascii=False, indent=1)

    # ---- 4) 试 API ----
    print("\n[4] 试 api.php")
    allres = {}
    for c in cands[:6]:
        print("  -- base=%s" % c)
        allres[c] = try_api(c)
    with open("hjw_api_test.json", "w", encoding="utf-8") as f:
        json.dump(allres, f, ensure_ascii=False, indent=1)

    print("\n已写入 hjw_home.html / hjw_apihosts.json / hjw_api_test.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
