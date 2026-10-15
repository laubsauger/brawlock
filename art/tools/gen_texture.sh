#!/bin/zsh
# Usage: gen_texture.sh <key theme/name> [ref.png]
# Writes the next free art/archive/textures/<theme>_<name>/c<n>.png (never overwrites).
# Promote with pick.sh or pass the archive path to process_textures.py.
set -u
KEY=$1; REF=${2:-}
ROOT=/Users/flo/work/code/brawlock
LOGDIR=${LOGDIR:-/tmp/brawlock-art-logs}
FLAT=${KEY/\//_}
OUTDIR=$ROOT/art/archive/textures/$FLAT
mkdir -p $LOGDIR $OUTDIR
C=$($ROOT/art/tools/next_index.sh $OUTDIR c)
OUT=$OUTDIR/$C.png
PROMPT=$OUTDIR/$C.txt
SPEC=$(python3 -I -B -c "
import sys; sys.path.insert(0, '$ROOT/art/tools')
from textures import TEXTURES
ref, tiling, mat = TEXTURES['$KEY']
print('TILING' if tiling else 'DECAL'); print(mat)")
MODE=${SPEC%%$'\n'*}; MAT=${SPEC#*$'\n'}
if [[ $MODE == TILING ]]; then
  TECH="Asset type: seamless tileable PBR base-color (albedo) texture for a AAA game, square.
View: perfectly top-down orthographic, flat-on to the surface, no perspective, no horizon, no vanishing lines.
Lighting: perfectly even, flat, diffuse; no baked shadows, no directional light, no specular glare or wet highlights, no vignette, no darkening toward the borders. Pure albedo.
Tiling: seamless and tileable in both directions; the surface continues across all four edges with no border, frame or edge treatment. Fill the whole canvas edge to edge with the material at uniform density (no focal point, no single large feature in the middle)."
else
  TECH="Asset type: PBR decal texture for a AAA game, square, with a genuinely transparent background (alpha channel).
View: perfectly top-down orthographic, flat-on, no perspective.
Lighting: perfectly even, flat, diffuse; no baked directional shadows or highlights."
fi
REFLINE=""
if [[ -n $REF ]]; then
  REFLINE="Input images: Image 1 is an old, low-resolution texture from a 2010s game. Use it ONLY as a loose reference for the general kind of surface and layout. Do not copy or approximate it; the result must be dramatically more detailed, modern and realistic."
fi
cat > $PROMPT <<P
Use your built-in image_gen tool to generate exactly ONE image, then copy the generated PNG file unchanged (plain cp; do not resize, convert or edit it) to the exact path $OUT. Do not create, edit or delete any other files. Do not run git. Do not generate variants. When done, print the source path of the generated file.

Image spec:
Use case: photorealistic-natural
$REFLINE
$TECH
Quality: photoreal, Unreal Engine 5 / Quixel Megascans-grade scanned surface. High-frequency micro detail, believable material breakup (chips, cracks, grime, wear, growth in crevices), rich but controlled color variation, crisp at 1024 px, and still good when repeated across a large floor.
Material: $MAT
Constraints: no text, no letters, no numbers, no logo, no watermark, no characters, no props, no UI.
P
START=$(date +%s)
if [[ -n $REF ]]; then
  /Users/flo/.local/bin/codex exec --skip-git-repo-check -s workspace-write -C $OUTDIR --image=$REF - < $PROMPT > $LOGDIR/tex_${FLAT}_$C.log 2>&1
else
  /Users/flo/.local/bin/codex exec --skip-git-repo-check -s workspace-write -C $OUTDIR - < $PROMPT > $LOGDIR/tex_${FLAT}_$C.log 2>&1
fi
RC=$?
echo "$FLAT $C rc=$RC secs=$(( $(date +%s) - START )) $(ls -la $OUT 2>/dev/null | awk '{print $5}')"
