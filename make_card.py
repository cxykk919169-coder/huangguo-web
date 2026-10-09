# -*- coding: utf-8 -*-
"""生成分享卡片: 二维码 + 使用说明, 适合发群/朋友圈"""
import os
from PIL import Image, ImageDraw, ImageFont
import qrcode

HERE = os.path.dirname(os.path.abspath(__file__))
URL = "https://huangguo-web.cxykk919169.workers.dev"

W, H = 900, 1200
BG = (14, 14, 16)
WHITE = (255, 255, 255)
GRAY = (150, 150, 160)
ACCENT = (255, 122, 24)


def font(size, bold=False):
    cands = [r"C:\Windows\Fonts\msyhbd.ttc" if bold else r"C:\Windows\Fonts\msyh.ttc",
             r"C:\Windows\Fonts\simhei.ttf", r"C:\Windows\Fonts\simsun.ttc"]
    for c in cands:
        if os.path.exists(c):
            try:
                return ImageFont.truetype(c, size)
            except Exception:
                continue
    return ImageFont.load_default()


img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# 顶部渐变条
for y in range(8):
    t = y / 7
    d.line([(0, y), (W, y)], fill=(int(255 * (1 - t) + 160 * t), int(122 * (1 - t) + 40 * t), int(24 * (1 - t) + 200 * t)))

# 标题
f_title = font(64, True)
t = "黄果短剧"
bb = d.textbbox((0, 0), t, font=f_title)
d.text(((W - (bb[2] - bb[0])) / 2, 90), t, font=f_title, fill=WHITE)

# 副标题
f_sub = font(30)
s = "打开就能看 · 不用安装"
bb = d.textbbox((0, 0), s, font=f_sub)
d.text(((W - (bb[2] - bb[0])) / 2, 180), s, font=f_sub, fill=GRAY)

# 二维码
qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_H, box_size=10, border=3)
qr.add_data(URL)
qr.make(fit=True)
qimg = qr.make_image(fill_color="black", back_color="white").convert("RGB")
qs = 520
qimg = qimg.resize((qs, qs), Image.LANCZOS)

# 二维码白底圆角
qx = (W - qs) // 2
qy = 270
card = Image.new("RGB", (qs + 40, qs + 40), (255, 255, 255))
img.paste(card, (qx - 20, qy - 20))
img.paste(qimg, (qx, qy))

# 步骤说明
f_step = font(28)
f_stepb = font(30, True)
steps = [
    ("1", "用手机扫上面这个码"),
    ("2", "打开后点浏览器菜单"),
    ("3", "选「添加到主屏幕」"),
    ("4", "桌面出现图标，点开就能用"),
]
y = 850
for num, txt in steps:
    # 圆形序号
    cx, cy, r = 120, y + 16, 22
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ACCENT)
    nb = d.textbbox((0, 0), num, font=f_stepb)
    d.text((cx - (nb[2] - nb[0]) / 2, cy - (nb[3] - nb[1]) / 2 - nb[1]), num, font=f_stepb, fill=(20, 20, 20))
    d.text((165, y), txt, font=f_step, fill=WHITE)
    y += 62

# 底部网址
f_url = font(22)
bb = d.textbbox((0, 0), URL, font=f_url)
d.text(((W - (bb[2] - bb[0])) / 2, y + 30), URL, font=f_url, fill=(90, 90, 100))

p = os.path.join(HERE, "share_card.png")
img.save(p)
print(f"分享卡片 -> {p}  {os.path.getsize(p)} 字节  {W}x{H}")
