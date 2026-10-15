"""Decode every public/textures/**.webp and check: 1024x1024, seam ratio <= 1.2 on tiling maps,
alpha present and zero at the borders on the decal. Exit 1 on any failure."""
import glob, os, sys
import numpy as np
from PIL import Image

ROOT = "/Users/flo/work/code/brawlock"
bad = 0
for f in sorted(glob.glob(f"{ROOT}/public/textures/*/*.webp")):
    im = Image.open(f)
    a = np.asarray(im).astype(np.float64)
    rel = os.path.relpath(f, ROOT)
    if im.size != (1024, 1024):
        print("FAIL size", rel, im.size); bad += 1; continue
    if "decal" in f:
        if "albedo" in f:
            ok = im.mode == "RGBA" and a[..., 3][[0, -1], :].max() == 0 and a[..., 3][:, [0, -1]].max() == 0
            print(("ok  " if ok else "FAIL"), rel, im.mode, "border alpha 0" if ok else "border alpha != 0")
            bad += not ok
        else:
            print("ok  ", rel, im.mode)
        continue
    sx = np.abs(a[:, 0] - a[:, -1]).mean() / np.abs(a[:, 1:] - a[:, :-1]).mean()
    sy = np.abs(a[0] - a[-1]).mean() / np.abs(a[1:] - a[:-1]).mean()
    ok = sx <= 1.2 and sy <= 1.2
    bad += not ok
    print(("ok  " if ok else "FAIL"), rel, im.mode, f"seam x={sx:.2f} y={sy:.2f}", f"{os.path.getsize(f)//1024} KB")
sys.exit(1 if bad else 0)
