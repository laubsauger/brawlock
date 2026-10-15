#!/bin/zsh
# Usage: next_index.sh <dir> <prefix>
# Reserves and prints the first <prefix><n> with no <dir>/<prefix><n>.png. Reservation is atomic
# (mkdir <dir>/.<prefix><n>.lock), so parallel runs for the same name never get the same index.
# The caller removes the lock dir when done.
n=1
while true; do
  if [[ ! -e $1/$2$n.png ]] && mkdir $1/.$2$n.lock 2>/dev/null; then echo $2$n; exit 0; fi
  n=$((n+1))
done
