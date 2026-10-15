# Brawlock icon style bible

Pasted verbatim into every icon prompt so the set stays consistent.

## Base style (all icons)

Premium dark-fantasy game inventory icon, as in modern AAA RPG/MOBA inventories. One hero object or effect, centered, slight 3/4 view, painterly-rendered 3D look. Crisp silhouette that reads at 48 px. Strong rim light, rich material detail, glow where magical. Subject fills about 80% of the canvas with a small even margin. Transparent background. No text, no letters, no numbers, no border or frame, no UI chrome, no drop-shadow box, no ground plane, no vignette.

## Color language (rim light / magic color)

Spells use their own identity color from `src/render/vfx/palette.ts` (`SPELL_PALETTE`): the
`accent` is the dominant rim / trail color of the icon and the `core` is the hot center, the same
pair the in-game effect uses, so icon and effect read as one spell. Both hex values go into the
prompt (see `art/tools/icons.py`, pass 2). Neighbors in the shop must differ in hue or value side by
side; only Fireball (and Rush, Meteor as their palette says) may look like fire.

| Group | Color |
|---|---|
| Spells, Redirector, Pact | palette accent + core (see above) |
| Items without a palette entry | forged bronze and steel, subtle ember accents |
| Masteries | engraved rune sigils on a dark stone-and-iron medallion (gold / cyan / crimson) |

Pass 1 (2026-10-15) colored by shop column (column 1 red-orange, 2 cyan, 3 molten gold, 4 violet,
5 gold-white, 6 green). Too many icons ended up the same fiery orange, so pass 2 (2026-10-16)
switched to the per-spell palette; pass 1 variants are kept in `art/archive/icons/<id>/v1.png`.

## Readability

The mechanic must be obvious at a glance. One idea per icon. Avoid busy backgrounds and tiny details that vanish at 48 px.

## Pipeline

1. Codex `image_gen` renders a square master (1254x1254 RGBA) with a native transparent background.
2. `art/tools/process_icons.py` trims to the alpha bounding box, centers on a square with an even margin, and writes 256 px and 128 px PNGs with alpha.
3. Masters stay in `art/source/icons/<id>.png`. Finals go to `public/icons/<id>.png` and `public/icons/128/<id>.png`.
