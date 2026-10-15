"""Grid of final icons on a dark background with their ids.
Usage: python -I contact_sheet.py <out.png> [cols] [ids...]"""
import os, sys
from PIL import Image, ImageDraw, ImageFont

ROOT = "/Users/flo/work/code/brawlock"
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from contact_sheet_order import ORDER
out = sys.argv[1]
cols = int(sys.argv[2]) if len(sys.argv) > 2 else 8
ids = sys.argv[3:] or [i for i in ORDER if os.path.exists(f"{ROOT}/public/icons/{i}.png")]
cell, pad, label = 256, 16, 34
rows = (len(ids) + cols - 1) // cols
W, H = cols * (cell + pad) + pad, rows * (cell + pad + label) + pad
sheet = Image.new("RGB", (W, H), (18, 16, 20))
d = ImageDraw.Draw(sheet)
try:
    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 20)
except OSError:
    font = ImageFont.load_default()
for n, i in enumerate(ids):
    x = pad + (n % cols) * (cell + pad)
    y = pad + (n // cols) * (cell + pad + label)
    d.rounded_rectangle((x, y, x + cell, y + cell), 14, fill=(32, 29, 36), outline=(60, 55, 66))
    ic = Image.open(f"{ROOT}/public/icons/{i}.png").convert("RGBA")
    sheet.paste(ic, (x, y), ic)
    tw = d.textlength(i, font=font)
    d.text((x + (cell - tw) / 2, y + cell + 6), i, fill=(220, 210, 200), font=font)
sheet.save(out)
print(out, sheet.size, len(ids), "icons")
