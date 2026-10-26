"""Regenerate the generated-art section of docs/ASSETS.md from the files on disk and the prompt lists.

Only the block between the art:begin / art:end markers is rewritten; every other section (audio,
models, ...) written by other tools or by hand is kept byte for byte. A file without markers (legacy)
is migrated once: everything before its first "## " heading is treated as the old art block."""
import os, re, sys, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from icons import ICONS
from contact_sheet_order import ORDER
from textures import TEXTURES
from write_archive_index import NOTES, PICKED

ROOT = "/Users/flo/work/code/brawlock"
SRC = "Codex CLI 0.162 built-in `image_gen`"
LIC = "Original, generated for this project"

def date(p):
    return datetime.date.fromtimestamp(os.path.getmtime(f"{ROOT}/{p}")).isoformat()

def summary(s):
    sents = re.split(r"(?<=[.])\s", s.strip())
    out = sents[0]
    if len(out) < 40 and len(sents) > 1:
        out += " " + sents[1]
    return out.rstrip(".").replace("|", "/")[:200]


rows = []
for i in ORDER:
    m = f"art/source/icons/{i}.png"
    if not os.path.exists(f"{ROOT}/{m}"):
        continue
    v = next((v for (c, n, v), (st, _) in NOTES.items() if c == "icons" and n == i and st == PICKED), "v1")
    rows.append((f"`public/icons/{i}.png`, `public/icons/128/{i}.png`", f"{SRC}, {date(m)}; master `{m}` = `art/archive/icons/{i}/{v}.png` (prompt alongside)", summary(ICONS[i][1])))

BRAND = [
    ("wordmark", "`art/brand/wordmark.png`", "\"BRAWLOCK\" in molten forged-iron lettering, transparent background, trimmed"),
    ("emblem", "`art/brand/emblem.png`", "Hooded warlock silhouette with glowing eyes over a lava-crack obsidian sigil, transparent, 1024 px"),
    ("emblem", "`art/brand/favicon-16.png`, `favicon-32.png`, `favicon-48.png`", "Emblem downscaled, transparent"),
    ("emblem", "`art/brand/apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png`", "Emblem at 84% on an opaque dark background (maskable-safe)"),
    ("splash", "`art/brand/splash.png`, `art/brand/splash.webp` (1920x1080)", "Two warlocks trading fireballs on a crumbling obsidian platform over a lava caldera, moonlit; empty sky center-top for the wordmark; no text"),
    ("splash", "`art/brand/og-image.png`, `art/brand/og-image.jpg` (1200x630)", "Composite of splash + wordmark (made in `art/tools/process_brand.py`, not generated)"),
    ("emblem", "`art/brand/lockup.png`, `art/brand/lockup.webp`", "Secondary logo: emblem with the wordmark across the lower hood (composite of emblem + wordmark made in `art/tools/process_brand.py`, not generated)"),
]
for name, path, what in BRAND:
    m = f"art/source/brand/{name}.png"
    if os.path.exists(f"{ROOT}/{m}"):
        rows.append((path, f"{SRC}, {date(m)}; master `{m}` = `art/archive/brand/{name}/v1.png` (prompt alongside)", what))

for key, (ref, tiling, mat) in TEXTURES.items():
    theme, name = key.split("/")
    flat = f"{theme}_{name}"
    m = f"art/source/textures/{flat}.png"
    if not os.path.exists(f"{ROOT}/{m}"):
        continue
    c = next(v for (cat, n, v), (st, _) in NOTES.items() if cat == "textures" and n == flat and st == PICKED)
    prompt = open(f"{ROOT}/art/archive/textures/{flat}/{c}.txt").read()
    used_ref = "Input images:" in prompt
    kinds = "albedo, normal, orm, height" if tiling else "albedo (RGBA), normal, orm"
    files = ", ".join(f"`{k.strip().split(' ')[0]}`" for k in kinds.split(","))
    src = f"{SRC}, {date(m)}; picked `art/archive/textures/{flat}/{c}.png` (prompt alongside)"
    src += f"; generated with the original mod's `{ref}.tga/jpg` attached as a loose layout reference (user-cleared)" if used_ref else "; text-only prompt"
    what = re.split(r"(?<=[.])\s", mat)[0].rstrip(".").replace("|", "/")
    what += ". Seamless offset-blend pass + derived maps (`art/tools/process_textures.py`)" if tiling else ". Decal, alpha cleaned + radial fade"
    rows.append((f"`public/textures/{theme}/{name}_*.webp` ({files})", src, what))

rows.append(("`art/source/textures/height16/*_height16.png`", "Derived from the texture masters", "16-bit height masters (the public height maps are 8-bit)"))
rows.append(("`art/contact-sheet_v2.png`", "Composite of the final icons (`art/tools/contact_sheet.py`)", "Review sheet of every current icon with its id (pass 2, spell palette colors)"))
rows.append(("`art/contact-sheet_before_after.png`", "Composite (`art/tools/before_after_sheet.py`)", "The 22 icons recolored in pass 2: pass 1 (shop-column colors) next to pass 2 (palette colors)"))
rows.append(("`art/contact-sheet.png`", "Composite (`art/tools/contact_sheet.py`)", "Pass 1 sheet (2026-10-15), kept for history"))
rows.append(("`art/previews/*`", "Composites", "Texture review: 2x2 tiling, raking-light check at 100% and 25%, height preview, and side-by-side with the original mod texture. The `_vs_original` images contain the original mod's textures for comparison only: keep them out of `public/`."))

out = ["## Generated art", "",
       "Every generated image in the repo, where it came from, and its license. Nothing here is taken from Dota 2, Valve or the original Warlock Brawl repo.",
       "",
       "All images below were generated with the Codex CLI built-in image generation (`image_gen`) from prompts written for this project, then post-processed with the scripts in `art/tools/`. License: original work generated for this project. No third-party pixels ship. One picked texture (overgrown tile top) was generated with an original-mod texture attached as a loose layout reference, which the user cleared; the original textures themselves only appear in the `art/previews/*_vs_original.png` review images.",
       "",
       "- `art/archive/`, `art/source/`, `art/previews/` and `art/brand/` are gitignored (several hundred MB). They exist only on the machine that generated them; back them up (Git LFS or external storage) before relying on them. Brand finals are wired by copying from `art/brand/` into `public/brand/`.",
       "- Style rules pasted into every icon prompt: `art/STYLE.md`.",
       "- Full prompt per image: `art/prompts/`.",
       "- Masters (raw generations, keep them): `art/source/`. Finals are derived from them by `art/tools/process_icons.py` (trim to alpha, center, 256 px and 128 px) and `art/tools/process_brand.py`.",
       "- Every generation, picked or not, is kept in `art/archive/` (see `art/archive/INDEX.md` for why each was picked or rejected). Generators never overwrite: they write the next free `v<n>`/`c<n>`. Promote one with `art/tools/pick.sh`.",
       "- New icon variant: `python3 art/tools/run_icons.py <id>` (prompts in `art/tools/icons.py`). New texture candidate: `art/tools/gen_texture.sh <theme/name> [ref.png]` (prompts in `art/tools/textures.py`).",
       "- The processors need Python with pillow and numpy (`python -I art/tools/process_*.py`); `process_textures.py` also calls `cwebp`.",
       "- Texture formats: albedo lossy WebP q90; normal (OpenGL, +Y up) and ORM (R AO, G roughness, B metalness 0) near-lossless WebP, because lossy blocks broke the seam check on these smooth maps; height 8-bit lossless WebP. All tiling maps pass a decoded wrap-seam check (edge pair <= 1.2x the interior mean, `art/tools/verify_textures.py`).",
       "",
       "| File(s) | Source | Prompt summary | License |",
       "|---|---|---|---|"]
out += [f"| {p} | {s} | {w} | {LIC} |" for p, s, w in rows]
BEGIN = "<!-- art:begin (generated by art/tools/write_assets_md.py; edit outside these markers) -->"
END = "<!-- art:end -->"
block = BEGIN + "\n" + "\n".join(out) + "\n" + END
path = f"{ROOT}/docs/ASSETS.md"
old = open(path).read() if os.path.exists(path) else ""
nb, ne = old.count(BEGIN), old.count(END)
if nb == ne == 1 and old.index(BEGIN) < old.index(END):
    pre, rest = old.split(BEGIN, 1)
    post = rest.split(END, 1)[1]
    new = pre + block + post
elif nb == ne == 0:
    m = re.search(r"^## ", old, re.M)
    post = old[m.start():] if m else ""
    new = "# Assets\n\n" + block + "\n\n" + post
    if not new.endswith("\n"):
        new += "\n"
else:
    sys.exit(f"{path}: expected exactly one {BEGIN!r} before one {END!r}; found {nb} and {ne}. Fix by hand.")
open(path, "w").write(new)
print(len(rows), "rows; preserved", len(new) - len(block), "chars outside the art block")
