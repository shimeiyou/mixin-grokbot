#!/usr/bin/env python3
"""Pad an image to a card-cover ratio (letterbox, whole image visible) and print the APP_CARD "cover" fields.
usage: card-cover.py <in> <out.png> [--ratio 16:9] [--max-w 1024] [--bg auto|#ffffff]
Prints JSON {"width","height","mime_type","thumbnail"} (thumbnail = blurhash); add "url" after uploading.
Android only shows covers 64..1024 px on each side, so the default max width is 1024."""
import sys, json, math, argparse
from PIL import Image
ap = argparse.ArgumentParser(); ap.add_argument('src'); ap.add_argument('out'); ap.add_argument('--ratio', default='16:9'); ap.add_argument('--max-w', type=int, default=1024); ap.add_argument('--bg', default='auto')
a = ap.parse_args(); rw, rh = (float(x) for x in a.ratio.split(':')); R = rw / rh
im = Image.open(a.src).convert('RGB')
bg = im.getpixel((2, 2)) if a.bg == 'auto' else tuple(int(a.bg.lstrip('#')[i:i + 2], 16) for i in (0, 2, 4))
W = a.max_w; H = round(W / R)
s = min(W / im.width, H / im.height); nw, nh = round(im.width * s), round(im.height * s)
im2 = im.resize((nw, nh), Image.LANCZOS); canvas = Image.new('RGB', (W, H), bg); canvas.paste(im2, ((W - nw) // 2, (H - nh) // 2)); canvas.save(a.out, optimize=True)
# --- blurhash (reference algorithm), 4x3 components on a 64px-wide sample ---
CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~'
def b83(v, n): return ''.join(CH[(v // 83 ** (n - 1 - i)) % 83] for i in range(n))
def lin(c): c /= 255; return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
def srgb(v): v = max(0, min(1, v)); return round((v * 12.92 if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055) * 255)
def sp(v, e): return math.copysign(abs(v) ** e, v)
sm = canvas.resize((64, max(1, round(64 * H / W)))); w, h = sm.size; px = [[tuple(lin(c) for c in sm.getpixel((x, y))) for x in range(w)] for y in range(h)]
cx, cy = 4, 3; f = []
for j in range(cy):
  for i in range(cx):
    n = 1 if i == j == 0 else 2; r = g = b = 0
    for y in range(h):
      for x in range(w):
        k = n * math.cos(math.pi * i * x / w) * math.cos(math.pi * j * y / h); p = px[y][x]; r += k * p[0]; g += k * p[1]; b += k * p[2]
    sc = 1 / (w * h); f.append((r * sc, g * sc, b * sc))
dc, ac = f[0], f[1:]; out = b83((cx - 1) + (cy - 1) * 9, 1)
mx = max(abs(v) for c in ac for v in c) if ac else 0; q = max(0, min(82, math.floor(mx * 166 - 0.5))) if ac else 0; mv = (q + 1) / 166 if ac else 1
out += b83(q, 1) + b83((srgb(dc[0]) << 16) + (srgb(dc[1]) << 8) + srgb(dc[2]), 4)
for c in ac: out += b83(sum(max(0, min(18, math.floor(sp(v / mv, 0.5) * 9 + 9.5))) * m for v, m in zip(c, (361, 19, 1))), 2)
print(json.dumps({'width': W, 'height': H, 'mime_type': 'image/png', 'thumbnail': out}))
