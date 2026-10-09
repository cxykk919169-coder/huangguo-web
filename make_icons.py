# -*- coding: utf-8 -*-
"""生成 PWA 图标 (192 / 512)"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "app")
os.makedirs(OUT, exist_ok=True)

BG = (14, 14, 16)
ACCENT = (255, 122, 24)
PURPLE = (160, 40, 200)


def find_cjk_font():
    cands = [
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\msyhbd.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
        r"C:\Windows\Fonts\simsun.ttc",
    ]
    for c in cands:
        if os.path.exists(c):
            return c
    return None


def make_icon(size):
    img = Image.new("RGBA", (size, size), BG + (255,))
    d = ImageDraw.Draw(img)

    # 圆角渐变底
    pad = int(size * 0.06)
    r = int(size * 0.22)
    # 渐变: 从上到下 橙 -> 紫
    grad = Image.new("RGBA", (size, size))
    gd = ImageDraw.Draw(grad)
    for y in range(size):
        t = y / max(1, size - 1)
        cr = int(ACCENT[0] * (1 - t) + PURPLE[0] * t)
        cg = int(ACCENT[1] * (1 - t) + PURPLE[1] * t)
        cb = int(ACCENT[2] * (1 - t) + PURPLE[2] * t)
        gd.line([(0, y), (size, y)], fill=(cr, cg, cb, 255))

    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([pad, pad, size - pad, size - pad], radius=r, fill=255)
    img.paste(grad, (0, 0), mask)

    # 中间画一个播放三角 (白色)
    cx, cy = size / 2, size / 2
    tri = size * 0.20
    d.polygon(
        [(cx - tri * 0.55, cy - tri), (cx - tri * 0.55, cy + tri), (cx + tri * 0.85, cy)],
        fill=(255, 255, 255, 245),
    )

    # 底部小字
    fp = find_cjk_font()
    if fp:
        try:
            fs = int(size * 0.13)
            f = ImageFont.truetype(fp, fs)
            txt = "黄果"
            bb = d.textbbox((0, 0), txt, font=f)
            tw = bb[2] - bb[0]
            d.text((size / 2 - tw / 2, size * 0.72), txt, font=f, fill=(255, 255, 255, 235))
        except Exception as e:
            print("  文字绘制失败:", e)

    return img


for s in (192, 512):
    im = make_icon(s)
    p = os.path.join(OUT, f"icon-{s}.png")
    im.save(p)
    print(f"icon-{s}.png -> {p}  {os.path.getsize(p)} 字节")

# 顺手做个 favicon
im = make_icon(64)
im.save(os.path.join(OUT, "favicon.png"))
print("favicon.png 完成")
