#!/bin/zsh
# Usage: gen_env.sh <name>   reads art/prompts/env_<name>.txt, writes the next free
# art/archive/env/<name>/v<n>.png (never overwrites). Environment concept sheets.
set -u
NAME=$1
ROOT=/Users/flo/work/code/brawlock
OUTDIR=$ROOT/art/archive/env/$NAME
mkdir -p $OUTDIR
V=$($ROOT/art/tools/next_index.sh $OUTDIR v)
LOGDIR=${LOGDIR:-/tmp/brawlock-art-logs}
mkdir -p $LOGDIR
SPEC=$ROOT/art/prompts/env_$NAME.txt
FULL=$OUTDIR/$V.txt
{
  echo "Use your built-in image_gen tool to generate exactly ONE image, then copy the generated PNG file unchanged (plain cp; do not resize, convert or edit it) to the exact path $OUTDIR/$V.png. Do not create, edit or delete any other files. Do not run git. Do not generate variants. When done, print the source path of the generated file and its pixel size."
  echo
  echo "Image spec:"
  cat $SPEC
} > $FULL
START=$(date +%s)
/Users/flo/.local/bin/codex exec -s workspace-write -C $OUTDIR - < $FULL > $LOGDIR/env_${NAME}_$V.log 2>&1
RC=$?
echo "$NAME $V rc=$RC secs=$(( $(date +%s) - START )) $(ls -la $OUTDIR/$V.png 2>/dev/null | awk '{print $5, $6, $7, $8}')"
