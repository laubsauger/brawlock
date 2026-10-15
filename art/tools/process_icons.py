"""Trim each master to its alpha bbox, center on a square with an even margin,
and write public/icons/<id>.png (256) and public/icons/128/<id>.png (128).
Usage: python -I process_icons.py [ids...]   (default: every master)"""
import os, sys
import numpy as np
from PIL import Image

ROOT = "/Users/flo/work/code/brawlock"
SRC = f"{ROOT}/art/source/icons"
FILL = 0.90  # subject's longest side as a fraction of the canvas

def process(i):
    im = Image.open(f"{SRC}/{i}.png").convert("RGBA")
    a = np.array(im)[..., 3]
    ys, xs = np.nonzero(a > 12)
    if not len(xs):
        raise SystemExit(f"{i}: no alpha content")
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    side = int(round(max(x1 - x0, y1 - y0) / FILL))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im.crop((x0, y0, x1, y1)), ((side - (x1 - x0)) // 2, (side - (y1 - y0)) // 2))
    pm = canvas.convert("RGBa")  # premultiplied resize avoids dark fringes
    for size, out in ((256, f"{ROOT}/public/icons/{i}.png"), (128, f"{ROOT}/public/icons/128/{i}.png")):
        pm.resize((size, size), Image.LANCZOS).convert("RGBA").save(out, optimize=True)
    t = (a < 8).mean() * 100
    print(f"{i}: master {im.size} bbox {x1-x0}x{y1-y0} transparent {t:.0f}%")

ids = sys.argv[1:] or sorted(f[:-4] for f in os.listdir(SRC) if f.endswith(".png"))
for i in ids:
    process(i)
