"""Regenerate docs/ASSETS.md from the files on disk and the prompt list in icons.py."""
import os, re, sys, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from icons import ICONS
from contact_sheet_order import ORDER

ROOT = "/Users/flo/work/code/brawlock"
SRC = "Codex CLI 0.162 built-in `image_gen`"
LIC = "Original, generated for this project"

def date(p):
    return datetime.date.fromtimestamp(os.path.getmtime(f"{ROOT}/{p}")).isoformat()

def summary(s):
    s = s.split(":", 1)[1] if ":" in s.split(".")[0] else s
    first = re.split(r"(?<=[.])\s", s.strip())[0]
    return first.rstrip(".").replace("|", "/")

rows = []
for i in ORDER:
    m = f"art/source/icons/{i}.png"
    if not os.path.exists(f"{ROOT}/{m}"):
        continue
    rows.append((f"`public/icons/{i}.png`, `public/icons/128/{i}.png`", f"{SRC}, {date(m)}; master `{m}`, prompt `art/prompts/{i}.txt`", summary(ICONS[i][1])))

BRAND = [
    ("wordmark", "`art/brand/wordmark.png`", "\"BRAWLOCK\" in molten forged-iron lettering, transparent background, trimmed"),
    ("emblem", "`art/brand/emblem.png`", "Hooded warlock silhouette with glowing eyes over a lava-crack obsidian sigil, transparent, 1024 px"),
    ("emblem", "`art/brand/favicon-16.png`, `favicon-32.png`, `favicon-48.png`", "Emblem downscaled, transparent"),
    ("emblem", "`art/brand/apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png`", "Emblem at 84% on an opaque dark background (maskable-safe)"),
    ("splash", "`art/brand/splash.png`, `art/brand/splash.webp` (1920x1080)", "Two warlocks trading fireballs on a crumbling obsidian platform over a lava caldera, moonlit; empty sky center-top for the wordmark; no text"),
    ("splash", "`art/brand/og-image.png`, `art/brand/og-image.jpg` (1200x630)", "Composite of splash + wordmark (made in `art/tools/process_brand.py`, not generated)"),
]
for name, path, what in BRAND:
    m = f"art/source/brand/{name}.png"
    if os.path.exists(f"{ROOT}/{m}"):
        rows.append((path, f"{SRC}, {date(m)}; master `{m}`, prompt `art/prompts/brand_{name}.txt`", what))

rows.append(("`art/contact-sheet.png`", "Composite of the final icons (`art/tools/contact_sheet.py`)", "Review sheet of every icon with its id"))

out = ["# Assets", "",
       "Every generated image in the repo, where it came from, and its license. Nothing here is taken from Dota 2, Valve or the original Warlock Brawl repo.",
       "",
       "All images below were generated with the Codex CLI built-in image generation (`image_gen`) from prompts written for this project, then post-processed with the scripts in `art/tools/`. License: original work generated for this project; no third-party assets or references were used.",
       "",
       "- Style rules pasted into every icon prompt: `art/STYLE.md`.",
       "- Full prompt per image: `art/prompts/`.",
       "- Masters (raw generations, keep them): `art/source/`. Finals are derived from them by `art/tools/process_icons.py` (trim to alpha, center, 256 px and 128 px) and `art/tools/process_brand.py`.",
       "- Regenerate one icon: `art/tools/gen_icon.sh <id> \"<color>\" \"<subject>\"` or `python3 art/tools/run_icons.py <id>` (prompts in `art/tools/icons.py`).",
       "",
       "| File(s) | Source | Prompt summary | License |",
       "|---|---|---|---|"]
out += [f"| {p} | {s} | {w} | {LIC} |" for p, s, w in rows]
out.append("")
open(f"{ROOT}/docs/ASSETS.md", "w").write("\n".join(out))
print(len(rows), "rows")
