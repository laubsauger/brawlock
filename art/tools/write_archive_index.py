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
    ("icons", "rockpillar", "v2"): (PICKED, "One solid column, reads clearly at 48 px."),
    ("icons", "cluster", "v1"): (PICKED, "Fan reads well; shows 3 bolts although the prompt asked for 4."),
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
           "Status: **picked** = in use; alt = good alternative; rejected = has a defect (see note).", ""]
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
