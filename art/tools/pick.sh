#!/bin/zsh
# Promote an archived variant to the master used by the processors (the archive copy stays).
# Usage: pick.sh icons <id> v2 | pick.sh brand <name> v1 | pick.sh textures <theme_name> c3
set -eu
ROOT=/Users/flo/work/code/brawlock
cp $ROOT/art/archive/$1/$2/$3.png $ROOT/art/source/$1/$2.png
echo "picked art/archive/$1/$2/$3.png -> art/source/$1/$2.png; now update art/archive/INDEX.md notes and rerun the processor"
