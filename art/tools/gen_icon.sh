#!/bin/zsh
# Usage: gen_icon.sh <id> <color> <subject>
# Generates the next free art/archive/icons/<id>/v<n>.png (never overwrites).
# Promote a variant with pick.sh, then run process_icons.py.
set -u
ID=$1; COLOR=$2; SUBJECT=$3
ROOT=/Users/flo/work/code/brawlock
OUTDIR=$ROOT/art/archive/icons/$ID
mkdir -p $OUTDIR
V=$($ROOT/art/tools/next_index.sh $OUTDIR v)
LOGDIR=${LOGDIR:-/tmp/brawlock-art-logs}
mkdir -p $LOGDIR
PROMPT=$OUTDIR/$V.txt
cat > $PROMPT <<P
Use your built-in image_gen tool to generate exactly ONE image, then copy the generated PNG file unchanged (plain cp; do not resize, convert or edit it) to the exact path $OUTDIR/$V.png. Do not create, edit or delete any other files. Do not run git. Do not generate variants. When done, print the source path of the generated file.

Image spec:
Use case: stylized-concept
Asset type: game inventory spell/item icon, square
Style: Premium dark-fantasy game inventory icon, as in modern AAA RPG/MOBA inventories. One hero object or effect, centered, slight 3/4 view, painterly-rendered 3D look. Crisp silhouette that reads at 48 px. Strong rim light, rich material detail, glow where magical. Subject fills about 80% of the canvas with a small even margin.
Background: genuinely transparent background (alpha channel), nothing behind the subject.
Color language: $COLOR
Subject: $SUBJECT
Constraints: no text, no letters, no numbers, no border or frame, no UI chrome, no drop-shadow box, no ground plane, no vignette, no background scene.
P
START=$(date +%s)
/Users/flo/.local/bin/codex exec -s workspace-write -C $OUTDIR - < $PROMPT > $LOGDIR/${ID}_$V.log 2>&1
RC=$?
END=$(date +%s)
echo "$ID $V rc=$RC secs=$((END-START)) $(ls -la $OUTDIR/$V.png 2>/dev/null | awk '{print $5, $6, $7, $8}')"
