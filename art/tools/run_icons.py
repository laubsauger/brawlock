"""Run gen_icon.sh for the given ids (or all missing) with N parallel codex processes."""
import os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from icons import ICONS

ROOT = "/Users/flo/work/code/brawlock"
par = int(os.environ.get("PAR", "4"))
ids = sys.argv[1:] or [i for i in ICONS if not os.path.exists(f"{ROOT}/art/source/icons/{i}.png")]

def run(i):
    color, subject = ICONS[i]
    r = subprocess.run([f"{ROOT}/art/tools/gen_icon.sh", i, color, subject], capture_output=True, text=True)
    line = (r.stdout + r.stderr).strip()
    print(line, flush=True)
    return line

with ThreadPoolExecutor(par) as ex:
    list(ex.map(run, ids))
