# Brawlock icon style bible

Pasted verbatim into every icon prompt so the set stays consistent.

## Base style (all icons)

Premium dark-fantasy game inventory icon, as in modern AAA RPG/MOBA inventories. One hero object or effect, centered, slight 3/4 view, painterly-rendered 3D look. Crisp silhouette that reads at 48 px. Strong rim light, rich material detail, glow where magical. Subject fills about 80% of the canvas with a small even margin. Transparent background. No text, no letters, no numbers, no border or frame, no UI chrome, no drop-shadow box, no ground plane, no vignette.

## Color language (rim light / magic color)

| Group | Color |
|---|---|
| Starting kit + column 1 Knockout | fiery red-orange |
| Column 2 Transport | arcane cyan-blue |
| Column 3 Damage | molten orange-gold |
| Column 4 Devastator | violet-magenta |
| Column 5 Defense | radiant gold-white |
| Column 6 Knockbackless | eldritch green |
| Items | forged bronze and steel, subtle ember accents |
| Masteries | engraved rune sigils on a dark stone or metal disc |

Starting kit and active items: Fireball and Scourge follow column 1 (red-orange; Scourge leans blood-red). Redirector and Pact are active items: forged metal with a red-orange magic accent.

## Readability

The mechanic must be obvious at a glance. One idea per icon. Avoid busy backgrounds and tiny details that vanish at 48 px.

## Pipeline

1. Codex `image_gen` renders a square master (1254x1254 RGBA) with a native transparent background.
2. `art/tools/process_icons.py` trims to the alpha bounding box, centers on a square with an even margin, and writes 256 px and 128 px PNGs with alpha.
3. Masters stay in `art/source/icons/<id>.png`. Finals go to `public/icons/<id>.png` and `public/icons/128/<id>.png`.
