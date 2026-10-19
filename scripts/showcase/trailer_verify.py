# Checks each recorded trailer take against the Node cue sheet: the cast sequence must match,
# else the browser's bot match diverged from the one the shot was planned on.
#   python3 -I scripts/showcase/trailer_verify.py [shot,shot]
import json, os, sys
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
cues = json.load(open(os.path.join(root, 'media/trailer/cues.json')))
only = set(sys.argv[1].split(',')) if len(sys.argv) > 1 else None
bad = []
for sid in sorted(cues):
    if only and sid not in only:
        continue
    f = os.path.join(root, f'media/trailer/shots/{sid}.json')
    if not os.path.exists(f):
        print(f'{sid:14} not recorded')
        continue
    d = json.load(open(f))
    rec = [e[2] for e in d['events'] if e[1] == 'cast'][:12]
    cue = [e[2] for e in cues[sid]['events'] if e[1] == 'cast'][:12]
    if rec != cue:
        bad.append(sid)
    print(f"{sid:14} {'ok' if rec == cue else 'DIVERGED'}")
print('diverged:', ','.join(bad) or 'none')
