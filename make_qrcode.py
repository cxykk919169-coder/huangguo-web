# -*- coding: utf-8 -*-
"""生成黄果客户端分享二维码"""
import qrcode
from qrcode.image.styledpil import StyledPilImage
from qrcode.image.styles.moduledrawers.pil import RoundedModuleDrawer
from qrcode.image.styles.colormasks import RadialGradiantColorMask
import os

URL = "https://huangguo-web.cxykk919169.workers.dev"
HERE = os.path.dirname(os.path.abspath(__file__))

# 1. 基础版 (最适合打印/分享, 容错高)
qr = qrcode.QRCode(
    version=None,
    error_correction=qrcode.constants.ERROR_CORRECT_H,  # 30% 容错, 脏了也能扫
    box_size=12,
    border=4,
)
qr.add_data(URL)
qr.make(fit=True)
img = qr.make_image(fill_color="black", back_color="white")
p1 = os.path.join(HERE, "qrcode.png")
img.save(p1)
print("[1] 基础版 ->", p1, os.path.getsize(p1), "字节")

# 2. 彩色版 (圆角+渐变, 好看点)
qr2 = qrcode.QRCode(
    error_correction=qrcode.constants.ERROR_CORRECT_H,
    box_size=12,
    border=4,
)
qr2.add_data(URL)
qr2.make(fit=True)
try:
    img2 = qr2.make_image(
        image_factory=StyledPilImage,
        module_drawer=RoundedModuleDrawer(),
        color_mask=RadialGradiantColorMask(
            back_color=(255, 255, 255),
            center_color=(255, 122, 24),   # 橙
            edge_color=(160, 40, 200),     # 紫
        ),
    )
    p2 = os.path.join(HERE, "qrcode_color.png")
    img2.save(p2)
    print("[2] 彩色版 ->", p2, os.path.getsize(p2), "字节")
except Exception as e:
    print("[2] 彩色版失败:", e)

# 3. 带白边的方形版 (适合贴到图里)
print("URL:", URL)
