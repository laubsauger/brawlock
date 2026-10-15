"""Generate texture candidates in parallel. Args: key[:ref] ...  (ref = tile1|tile2|tile3, read from $SCRATCH/refs)"""
import os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
ROOT = "/Users/flo/work/code/brawlock"
SP = os.environ["SCRATCH"]
par = int(os.environ.get("PAR", "5"))

def run(job):
    parts = job.split(":")
    key = parts[0]
    ref = f"{SP}/refs/{parts[1]}.png" if len(parts) > 1 else ""
    args = [f"{ROOT}/art/tools/gen_texture.sh", key] + ([ref] if ref else [])
    r = subprocess.run(args, capture_output=True, text=True)
    print((r.stdout + r.stderr).strip(), flush=True)

with ThreadPoolExecutor(par) as ex:
    list(ex.map(run, sys.argv[1:]))
