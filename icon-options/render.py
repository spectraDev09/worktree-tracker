"""Render icon SVGs to PNG with transparent rounded corners.

QuickLook (qlmanage) renders SVG faithfully but flattens it onto white, so the
corners outside the rx=112/512 rounded square are masked back to transparent.
Usage: python3 -I render.py <out.png> <size> <in.svg>
"""
import subprocess, sys, tempfile, os
from PIL import Image, ImageDraw

out, size, svg = sys.argv[1], int(sys.argv[2]), sys.argv[3]
with tempfile.TemporaryDirectory() as tmp:
    subprocess.run(["qlmanage", "-t", "-s", "1024", "-o", tmp, svg], check=True, capture_output=True)
    im = Image.open(os.path.join(tmp, os.path.basename(svg) + ".png")).convert("RGBA").resize((1024, 1024), Image.LANCZOS)
mask = Image.new("L", (4096, 4096), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, 4095, 4095), radius=4096 * 112 // 512, fill=255)
im.putalpha(mask.resize((1024, 1024), Image.LANCZOS))
im.resize((size, size), Image.LANCZOS).save(out)
