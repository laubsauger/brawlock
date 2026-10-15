#!/bin/zsh
# Usage: next_index.sh <dir> <prefix>  -> prints the first <prefix><n> with no <dir>/<prefix><n>.png
n=1; while [[ -e $1/$2$n.png ]]; do n=$((n+1)); done; echo $2$n
