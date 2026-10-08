#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 PWA 图标（纯标准库，无需 Pillow）。用法：python gen_icons.py"""
import zlib
import struct
import os

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")


def write_png(path, w, h, rgba):
    def chunk(typ, data):
        body = typ + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8-bit RGBA
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter type 0
        raw.extend(rgba[y * w * 4:(y + 1) * w * 4])
    idat = zlib.compress(bytes(raw), 9)
    with open(path, "wb") as f:
        f.write(sig)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", idat))
        f.write(chunk(b"IEND", b""))


def build(size):
    s = size
    bg = (37, 99, 235)
    fg = (255, 255, 255)
    buf = bytearray(s * s * 4)

    def in_cloud(x, y):
        # 归一化坐标
        nx, ny = x / s, y / s
        # 三个圆 + 底部椭圆，近似云朵
        def disc(cx, cy, r):
            return (nx - cx) ** 2 + (ny - cy) ** 2 <= r * r
        def ell(cx, cy, rx, ry):
            return ((nx - cx) / rx) ** 2 + ((ny - cy) / ry) ** 2 <= 1
        return (
            disc(0.38, 0.58, 0.20)
            or disc(0.52, 0.48, 0.24)
            or disc(0.66, 0.58, 0.20)
            or ell(0.52, 0.66, 0.31, 0.11)
        )

    for y in range(s):
        for x in range(s):
            i = (y * s + x) * 4
            c = fg if in_cloud(x, y) else bg
            buf[i], buf[i + 1], buf[i + 2], buf[i + 3] = c[0], c[1], c[2], 255
    return buf


for sz in (192, 512):
    out = os.path.join(STATIC, f"icon-{sz}.png")
    write_png(out, sz, sz, build(sz))
    print("generated", out)
