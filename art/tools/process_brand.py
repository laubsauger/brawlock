"""Build art/brand/* finals from art/source/brand/* masters.
Usage: python -I process_brand.py [wordmark] [emblem] [splash] [og] [lockup]   (default: all available)"""
import os, sys
import numpy as np
from PIL import Image, ImageFilter

ROOT = "/Users/flo/work/code/brawlock"
SRC, OUT = f"{ROOT}/art/source/brand", f"{ROOT}/art/brand"
BG = (16, 13, 18)

def trim(im, thr=12, pad=0.02):
    a = np.array(im)[..., 3]
    ys, xs = np.nonzero(a > thr)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    p = int(max(x1 - x0, y1 - y0) * pad)
    c = Image.new("RGBA", (x1 - x0 + 2 * p, y1 - y0 + 2 * p), (0, 0, 0, 0))
    c.paste(im.crop((x0, y0, x1, y1)), (p, p))
    return c

def square(im, fill):
    side = int(round(max(im.size) / fill))
    c = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    c.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
    return c

def rs(im, size):
    return im.convert("RGBa").resize(size, Image.LANCZOS).convert("RGBA")

def wordmark():
    w = trim(Image.open(f"{SRC}/wordmark.png").convert("RGBA"))
    w.save(f"{OUT}/wordmark.png", optimize=True)
    print("wordmark", w.size)

def emblem():
    e = square(trim(Image.open(f"{SRC}/emblem.png").convert("RGBA"), pad=0), 1.0)
    rs(e, (1024, 1024)).save(f"{OUT}/emblem.png", optimize=True)
    # small favicons: tight crop on the hood so the glowing eyes survive at 16 px
    W = e.width
    s0 = int(W * 0.66)
    x0, y0 = (W - s0) // 2, int(W * 0.47) - s0 // 2
    hood = e.crop((x0, y0, x0 + s0, y0 + s0))
    for s in (16, 32, 48):  # transparent
        rs(hood, (s, s)).save(f"{OUT}/favicon-{s}.png", optimize=True)
    for s, name in ((180, "apple-touch-icon.png"), (192, "icon-192.png"), (512, "icon-512.png")):
        bg = Image.new("RGBA", (s, s), BG + (255,))
        inner = int(s * 0.84)  # keeps the emblem inside the maskable safe zone
        ic = rs(e, (inner, inner))
        bg.alpha_composite(ic, ((s - inner) // 2, (s - inner) // 2))
        bg.convert("RGB").save(f"{OUT}/{name}", optimize=True)
    print("emblem + favicons", e.size)

def cover(im, W, H):
    s = max(W / im.width, H / im.height)
    r = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    x, y = (r.width - W) // 2, (r.height - H) // 2
    return r.crop((x, y, x + W, y + H))

def splash():
    sp = cover(Image.open(f"{SRC}/splash.png").convert("RGB"), 1920, 1080)
    sp.save(f"{OUT}/splash.png", optimize=True)
    sp.save(f"{OUT}/splash.webp", quality=88, method=6)
    print("splash", sp.size)

def og():
    W, H = 1200, 630
    bg = cover(Image.open(f"{OUT}/splash.png").convert("RGB"), W, H).convert("RGBA")
    # soft dark pool behind the wordmark for legibility
    yy, xx = np.mgrid[0:H, 0:W]
    d = np.sqrt(((xx - W / 2) / (W * 0.42)) ** 2 + ((yy - H * 0.20) / (H * 0.28)) ** 2)
    shade = (np.clip(1 - d, 0, 1) ** 1.5 * 150).astype(np.uint8)
    dark = Image.new("RGBA", (W, H), BG + (0,))
    dark.putalpha(Image.fromarray(shade))
    bg.alpha_composite(dark)
    w = Image.open(f"{OUT}/wordmark.png").convert("RGBA")
    tw = int(W * 0.56)
    w = rs(w, (tw, round(w.height * tw / w.width)))
    bg.alpha_composite(w, ((W - tw) // 2, max(16, int(H * 0.19 - w.height / 2))))
    bg.convert("RGB").save(f"{OUT}/og-image.png", optimize=True)
    bg.convert("RGB").save(f"{OUT}/og-image.jpg", quality=90)
    print("og-image", bg.size)

def lockup():
    """Secondary logo: wordmark across the emblem's lower hood. Composite of the finals, not generated."""
    e = trim(Image.open(f"{OUT}/emblem.png").convert("RGBA"), pad=0)
    # the cloak fades out under the letters so the word, not the ragged hem, ends the mark
    a = np.array(e.getchannel("A"), dtype=np.float32)
    ramp = np.clip((np.arange(e.height) / e.height - 0.74) / 0.18, 0, 1)
    e.putalpha(Image.fromarray((a * (1 - ramp ** 1.4)[:, None]).astype(np.uint8)))
    w = trim(Image.open(f"{OUT}/wordmark.png").convert("RGBA"), pad=0)
    tw = int(e.width * 1.3)
    w = rs(w, (tw, round(w.height * tw / w.width)))
    m = w.height // 2  # room for the halo
    c = Image.new("RGBA", (tw + 2 * m, e.height + 2 * m), (0, 0, 0, 0))
    c.alpha_composite(e, ((c.width - e.width) // 2, m))
    pos = (m, m + int(e.height * 0.70 - w.height / 2))
    # dark halo from the letters' alpha carves the word out of the busy disc behind it
    ha = Image.new("L", c.size, 0)
    ha.paste(w.getchannel("A"), pos)
    ha = ha.filter(ImageFilter.MaxFilter(int(w.height * 0.10) | 1)).filter(ImageFilter.GaussianBlur(w.height * 0.093))
    halo = Image.new("RGBA", c.size, BG + (0,))
    halo.putalpha(ha.point(lambda v: int(v * 0.9)))
    c.alpha_composite(halo)
    c.alpha_composite(w, pos)
    c = trim(c, thr=4, pad=0.03)
    c.save(f"{OUT}/lockup.png", optimize=True)
    c.save(f"{OUT}/lockup.webp", quality=90, method=6)
    print("lockup", c.size)

steps = {"wordmark": wordmark, "emblem": emblem, "splash": splash, "og": og, "lockup": lockup}
for k in sys.argv[1:] or steps:
    steps[k]()
