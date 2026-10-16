"""Regenerate art/archive/INDEX.md from the files in art/archive and the review notes below.
Every generated variant lives in art/archive/<category>/<name>/<variant>.png with its full prompt
in <variant>.txt. Add a NOTES entry whenever you review or pick a new variant."""
import os, re

ROOT = "/Users/flo/work/code/brawlock"
A = f"{ROOT}/art/archive"
PICKED = "picked"
# (category, name, variant) -> (status, note). Missing single variants default to picked.
NOTES = {
    ("icons", "rockpillar", "v1"): ("rejected", "Read as a crystal cluster, not a pillar."),
    ("icons", "rockpillar", "v2"): ("superseded", "Pass 1 pick (one solid column, green); replaced by the palette-colored pass 2."),
    ("icons", "cluster", "v1"): ("superseded", "Pass 1 pick (fiery orange, 3 bolts instead of 4); replaced in pass 2."),
    ("icons", "cluster", "v2"): ("rejected", "Explicit 'exactly four' prompt still drew 3 bolts; no better than v1."),
    ("textures", "temple_tile_top", "c1"): ("alt", "Reference-guided (tile1). Large rune circles repeat visibly when tiled."),
    ("textures", "temple_tile_top", "c2"): (PICKED, "Even slab density and subtle runes; tiles best."),
    ("textures", "temple_tile_top", "c3"): ("alt", "Good; bigger slabs, slightly busier."),
    ("textures", "volcanic_tile_top", "c1"): ("alt", "Reference-guided (tile1). Plates less defined."),
    ("textures", "volcanic_tile_top", "c2"): ("alt", "Crisp obsidian plates, almost no ember veins."),
    ("textures", "volcanic_tile_top", "c3"): (PICKED, "Faint ember veins carry the volcanic theme."),
    ("textures", "overgrown_tile_top", "c1"): (PICKED, "Reference-guided (tile1). Clear slabs with moss in the crevices."),
    ("textures", "overgrown_tile_top", "c2"): ("alt", "More uniform, slabs less distinct."),
    ("textures", "overgrown_tile_top", "c3"): ("alt", "Bigger stones and clover clumps; busier when tiled."),
    ("textures", "temple_tile_side", "c1"): ("alt", "Flatter, less breakup."),
    ("textures", "temple_tile_side", "c2"): (PICKED, "Stronger horizontal layering and wear."),
    ("textures", "volcanic_tile_side", "c1"): (PICKED, "Columns and pores read best."),
    ("textures", "volcanic_tile_side", "c2"): ("alt", "Darker, finer; less readable."),
    ("textures", "overgrown_tile_side", "c1"): (PICKED, "Moss reads clearly."),
    ("textures", "overgrown_tile_side", "c2"): ("alt", "More bare stone, less moss."),
    ("textures", "shared_cliff_rock", "c1"): (PICKED, "More contrast and depth."),
    ("textures", "shared_cliff_rock", "c2"): ("alt", "Flatter."),
    ("textures", "shared_ground_moss", "c1"): ("alt", "Reference-guided (tile2). Bright lawn-and-clover look."),
    ("textures", "shared_ground_moss", "c2"): (PICKED, "Deeper dark-fantasy green moss."),
    ("textures", "shared_lava_crust", "c1"): (PICKED, "Even breakup tiles well; dark cracks suit the emissive mix."),
    ("textures", "shared_lava_crust", "c2"): ("alt", "Large pahoehoe swirls repeat visibly."),
    ("textures", "shared_scorch_decal", "c1"): ("rejected", "Pale dust halo; low-alpha haze box."),
    ("textures", "shared_scorch_decal", "c2"): ("rejected", "Larger pale halo."),
    ("textures", "shared_scorch_decal", "c3"): ("alt", "Darker prompt; weaker shape, visible haze box."),
    ("textures", "shared_scorch_decal", "c4"): (PICKED, "Soot-only radial streaks (haze removed in processing)."),
    # pass 2 (2026-10-16): recolored to the spell palette in src/render/vfx/palette.ts
    ("icons", "lightning", "v2"): ('alt', 'Thinner channel.'),
    ("icons", "lightning", "v3"): (PICKED, 'Bolder channel, exact accent hue.'),
    ("icons", "homing", "v2"): (PICKED, 'Closest to the accent, clean trail.'),
    ("icons", "homing", "v3"): ('alt', 'Pinker.'),
    ("icons", "twin", "v2"): (PICKED, 'Cleanest convergence.'),
    ("icons", "twin", "v3"): ('alt', 'Similar, busier tips.'),
    ("icons", "boomerang", "v2"): ('alt', 'Reads as a ring more than a thrown blade.'),
    ("icons", "boomerang", "v3"): (PICKED, 'Steel blade with a red-copper return arc.'),
    ("icons", "redirector", "v2"): (PICKED, 'Clear 90-degree bend around the pivot.'),
    ("icons", "redirector", "v3"): ('alt', 'Zigzag bend, less clear.'),
    ("icons", "cluster", "v3"): ('alt', 'Four bolts, thinner.'),
    ("icons", "cluster", "v4"): (PICKED, 'Four bold amber bolts (pass 1 only managed three).'),
    ("icons", "drain", "v2"): (PICKED, 'Hand, tendrils and orb all readable; dark by palette design.'),
    ("icons", "drain", "v3"): ('alt', 'Similar, hand less defined.'),
    ("icons", "bouncer", "v2"): (PICKED, 'Clear zigzag ending in the spark orb.'),
    ("icons", "bouncer", "v3"): ('alt', 'Orb at the start; path reads backwards.'),
    ("icons", "recharge", "v2"): (PICKED, 'Purple orb inside the refresh loop.'),
    ("icons", "recharge", "v3"): ('alt', 'Near-identical.'),
    ("icons", "alteration", "v2"): (PICKED, 'Silver glass, small projectile, clear exchange arrows.'),
    ("icons", "alteration", "v3"): ('alt', 'Similar.'),
    ("icons", "gravity", "v2"): (PICKED, 'Darkest lensing core.'),
    ("icons", "gravity", "v3"): ('alt', 'Smaller core.'),
    ("icons", "warpzone", "v2"): ('alt', 'Softer ring.'),
    ("icons", "warpzone", "v3"): (PICKED, 'Frozen orb with echoes reads best.'),
    ("icons", "magnetize", "v2"): (PICKED, 'Clearest horseshoe.'),
    ("icons", "magnetize", "v3"): ('alt', 'Busier angle.'),
    ("icons", "rockpillar", "v3"): (PICKED, 'Earth-brown basalt column, strong eruption.'),
    ("icons", "rockpillar", "v4"): ('alt', 'Near-identical.'),
    ("icons", "thrust", "v2"): ('alt', 'Figure clearer, cone weaker.'),
    ("icons", "thrust", "v3"): (PICKED, 'Whitest shock cone; clearly apart from Teleport cyan.'),
    ("icons", "swap", "v2"): ('alt', 'Paler.'),
    ("icons", "swap", "v3"): (PICKED, 'Best bright/deep orb contrast.'),
    ("icons", "windwalk", "v2"): (PICKED, 'Ghostly but readable figure.'),
    ("icons", "windwalk", "v3"): ('alt', 'Figure too faint at 48 px.'),
    ("icons", "meteor", "v2"): (PICKED, 'Deep violet, separate from Splitter magenta.'),
    ("icons", "meteor", "v3"): ('alt', 'More magenta.'),
    ("icons", "snowball", "v2"): (PICKED, 'Ice blue with glow.'),
    ("icons", "snowball", "v3"): ('alt', 'Paler.'),
    ("icons", "link", "v2"): ('alt', 'Thin chain, weak at 48 px.'),
    ("icons", "link", "v3"): (PICKED, 'Bold emerald chain, cooler than Grip.'),
    ("icons", "pact", "v2"): (PICKED, 'Darkest wine-blood.'),
    ("icons", "pact", "v3"): ('alt', 'More bare parchment.'),
    ("icons", "rush", "v2"): (PICKED, 'Saturated orange-gold aura; no longer a twin of Shield.'),
    ("icons", "rush", "v3"): ('alt', 'Similar, weaker aura.'),
    ("icons", "lightning", "v1"): ("superseded", "Pass 1 shop-column color; replaced by the palette color in pass 2."),
    ("icons", "homing", "v1"): ("superseded", "Pass 1 shop-column color; replaced by the palette color in pass 2."),
    ("icons", "twin", "v1"): ("superseded", "Pass 1 shop-column color; replaced by the palette color in pass 2."),
    ("icons", "boomerang", "v1"): ("superseded", "Pass 1 shop-column color; replaced by the palette color in pass 2."),
    ("icons", "redirector", "v1"): ("superseded", "Pass 1 shop-column color; replaced by the palette color in pass 2."),
    ("icons", "drain", "v1"): ("superseded", "Pass 1 shop-column color; replaced by the palette color in pass 2."),
    ("icons", "bouncer", "v1"): ("superseded", "Pass 1 shop-column color; replaced by the palette color in pass 2."),
    ("icons", "recharge", "v1"): ("superseded", "Pass 1 shop-column color; replaced by the palette color in pass 2."),
    ("icons", "alteration", "v1"): ("superseded", "Pass 1 shop-column color; replaced by the palette color in pass 2."),
    ("icons", "gravity", "v1"): ("superseded", "Pass 1 shop-column color; replaced by the palette color in pass 2."),
    ("icons", "warpzone", "v1"): ("superseded", "Pass 1 shop-column color; replaced by the palette color in pass 2."),
    ("icons", "magnetize", "v1"): ("superseded", "Pass 1 shop-column color; replaced by the palette color in pass 2."),
    ("icons", "thrust", "v1"): ("superseded", "Pass 1 shop-column color; replaced by the palette color in pass 2."),
    ("icons", "swap", "v1"): ("superseded", "Pass 1 shop-column color; replaced by the palette color in pass 2."),
    ("icons", "windwalk", "v1"): ("superseded", "Pass 1 shop-column color; replaced by the palette color in pass 2."),
    ("icons", "meteor", "v1"): ("superseded", "Pass 1 shop-column color; replaced by the palette color in pass 2."),
    ("icons", "snowball", "v1"): ("superseded", "Pass 1 shop-column color; replaced by the palette color in pass 2."),
    ("icons", "link", "v1"): ("superseded", "Pass 1 shop-column color; replaced by the palette color in pass 2."),
    ("icons", "pact", "v1"): ("superseded", "Pass 1 shop-column color; replaced by the palette color in pass 2."),
    ("icons", "rush", "v1"): ("superseded", "Pass 1 shop-column color; replaced by the palette color in pass 2."),
}


def summary(txt):
    for key in ("Subject:", "Material:", "Text (verbatim):", "Scene:"):
        for line in txt.splitlines():
            if line.startswith(key):
                s = line[len(key):].strip()
                first = re.split(r"(?<=\.)\s", s)[0].rstrip(".")
                return first.replace("|", "/")[:140]
    return ""


def main():
    out = ["# Art archive", "",
           "Every image Codex generated for this project, picked or not. Nothing here is deleted or overwritten:",
           "new generations get the next free index (`art/tools/gen_*.sh`). Promote a variant with",
           "`art/tools/pick.sh <category> <name> <variant>`, rerun the matching `process_*.py`, and update",
           "`NOTES` in `art/tools/write_archive_index.py`. Only picked variants are copied to `art/source/` and",
           "processed into `public/`.", "",
           "Status: **picked** = in use; superseded = was in use in an earlier pass; alt = good alternative; rejected = has a defect (see note).", ""]
    for cat in ("icons", "brand", "textures"):
        out += [f"## {cat}", "", "| Name | Variant | Status | Prompt summary | Note |", "|---|---|---|---|---|"]
        for name in sorted(os.listdir(f"{A}/{cat}")):
            d = f"{A}/{cat}/{name}"
            vs = sorted((f[:-4] for f in os.listdir(d) if f.endswith(".png")), key=lambda v: int(v[1:]))
            for v in vs:
                txt = open(f"{d}/{v}.txt").read() if os.path.exists(f"{d}/{v}.txt") else ""
                status, note = NOTES.get((cat, name, v), (PICKED if len(vs) == 1 else "?", "Only variant; passed review." if len(vs) == 1 else ""))
                st = f"**{status}**" if status == PICKED else status
                out.append(f"| {name} | [{v}]({cat}/{name}/{v}.png) | {st} | {summary(txt)} | {note} |")
        out.append("")
    open(f"{A}/INDEX.md", "w").write("\n".join(out))
    print("rows:", sum(1 for l in out if l.startswith("| ") and not l.startswith("| Name")))


if __name__ == "__main__":
    main()
