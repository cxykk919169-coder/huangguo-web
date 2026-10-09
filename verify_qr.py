# -*- coding: utf-8 -*-
"""解码验证二维码内容是否正确"""
import cv2
import numpy as np
import os

HERE = os.path.dirname(os.path.abspath(__file__))
EXPECT = "https://huangguo-web.cxykk919169.workers.dev"

for f in ["qrcode.png", "qrcode_color.png"]:
    p = os.path.join(HERE, f)
    if not os.path.exists(p):
        print(f"{f}: 不存在")
        continue
    # 用 imdecode 绕过中文路径问题
    buf = np.fromfile(p, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        print(f"{f}: 无法读取")
        continue
    h, w = img.shape[:2]
    d = cv2.QRCodeDetector()
    data, pts, _ = d.detectAndDecode(img)
    ok = "OK 内容正确" if data == EXPECT else f"内容不符! 期望 {EXPECT}"
    print(f"{f}: {w}x{h}  解码=[{data}]  {ok}")
