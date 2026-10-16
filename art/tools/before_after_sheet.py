"""Before/after pairs on a dark background.
Usage: python -I before_after_sheet.py <out.png> <before_dir> <after_dir> <pairs_per_row> id ...
(before_dir can be rebuilt from art/archive/icons/<id>/v1.png with process_icons.py logic)"""
import sys
from PIL import Image, ImageDraw, ImageFont

out, bdir, adir, per = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
ids = sys.argv[5:]
cell, pad, label, gap = 200, 12, 30, 28
pw = 2 * cell + pad  # one pair
rows = (len(ids) + per - 1) // per
W = per * (pw + gap) - gap + 2 * pad
H = rows * (cell + label + pad) + pad + 30
sheet = Image.new("RGB", (W, H), (18, 16, 20))
d = ImageDraw.Draw(sheet)
f = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 18)
fs = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 14)
d.text((pad, 6), "left: pass 1 (shop-column colors)   right: pass 2 (spell palette colors)", fill=(200, 190, 180), font=fs)
for n, i in enumerate(ids):
    x = pad + (n % per) * (pw + gap)
    y = 30 + pad + (n // per) * (cell + label + pad)
    for k, dd in enumerate((bdir, adir)):
        xx = x + k * (cell + pad)
        d.rounded_rectangle((xx, y, xx + cell, y + cell), 12, fill=(32, 29, 36), outline=(60, 55, 66))
        ic = Image.open(f"{dd}/{i}.png").convert("RGBA").resize((cell, cell), Image.LANCZOS)
        sheet.paste(ic, (xx, y), ic)
    tw = d.textlength(i, font=f)
    d.text((x + (pw - tw) / 2, y + cell + 5), i, fill=(220, 210, 200), font=f)
sheet.save(out)
print(out, sheet.size)
