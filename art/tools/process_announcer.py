# Announcer pack: pick the best take per line, then trim / arena space / loudness / encode with ffmpeg.
# Usage: python3 -I art/tools/process_announcer.py
# Raw takes: art/archive/audio/announcer/<voice>/<line>_take<n>.mp3 (kept forever, never deleted).
# Picks + reasons: art/archive/audio/announcer/<voice>/picks.json. Shipped: public/audio/announcer/.
import glob, json, os, re, subprocess

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SRC = os.path.join(ROOT, 'art/archive/audio/announcer')
OUT = os.path.join(ROOT, 'public/audio/announcer')
LINES = ['first_blood', 'double_kill', 'triple_kill', 'multi_kill', 'mega_kill', 'ultra_kill', 'monster_kill',
         'killing_spree', 'rampage', 'unstoppable', 'godlike']
TARGET_LUFS = -16
# light arena: early reflections off the stands and a short tail (the bed's reverb adds the rest)
SPACE = 'apad=pad_dur=0.45,aecho=0.85:0.6:38|71|113:0.24|0.15|0.09'

def ff(args):
  r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-y', *args], capture_output=True, text=True)
  if r.returncode: raise RuntimeError(r.stderr[-600:])
  return r.stderr

def measure(path):
  e = ff(['-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'])
  i = float(re.findall(r'I:\s+(-?[\d.]+) LUFS', e)[-1])
  pk = float(re.findall(r'Peak:\s+(-?[\d.]+) dBFS', e)[-1])
  dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], capture_output=True, text=True).stdout)
  return {'lufs': i, 'peak': pk, 'dur': dur}

def pick(voice):
  picks = {}
  for line in LINES:
    takes = sorted(glob.glob(os.path.join(SRC, voice, f'{line}_take*.mp3')))
    m = {os.path.basename(t): measure(t) for t in takes}
    clean = {k: v for k, v in m.items() if v['peak'] < 0} or m
    # more energy first, then the punchier (shorter) delivery
    best = max(clean, key=lambda k: (round(clean[k]['lufs'], 0), -clean[k]['dur']))
    why = 'only take' if len(m) == 1 else ('others clip; ' if len(clean) < len(m) else '') + 'loudest clean delivery (ties: shorter)'
    picks[line] = {'take': best, 'reason': why, 'measured': m}
  with open(os.path.join(SRC, voice, 'picks.json'), 'w') as f: json.dump(picks, f, indent=1)
  return picks

def process(voice, picks):
  os.makedirs(OUT, exist_ok=True)
  tmp = os.path.join(OUT, '_tmp.wav')
  for line in LINES:
    src = os.path.join(SRC, voice, picks[line]['take'])
    trim = ('silenceremove=start_periods=1:start_threshold=-45dB,areverse,'
            'silenceremove=start_periods=1:start_threshold=-50dB,areverse')
    ff(['-i', src, '-af', f'aformat=channel_layouts=mono,aresample=48000,{trim},{SPACE},'
        'silenceremove=stop_periods=-1:stop_threshold=-60dB:stop_duration=0.2,afade=t=in:d=0.004', '-c:a', 'pcm_s16le', tmp])
    i = float(re.findall(r'I:\s+(-?[\d.]+) LUFS', ff(['-i', tmp, '-af', 'ebur128', '-f', 'null', '-']))[-1])
    dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', tmp], capture_output=True, text=True).stdout)
    post = f'volume={TARGET_LUFS - i:.2f}dB,alimiter=limit=0.89:level=false,afade=t=out:st={max(0, dur - 0.12):.3f}:d=0.12'
    ff(['-i', tmp, '-af', post, '-c:a', 'libopus', '-b:a', '96k', '-vbr', 'on', '-application', 'audio', os.path.join(OUT, f'{voice}_{line}.ogg')])
    ff(['-i', tmp, '-af', post, '-c:a', 'aac_at', '-b:a', '96k', os.path.join(OUT, f'{voice}_{line}.m4a')])
  os.remove(tmp)

def ab(voices, lines, out):
  parts, fc = [], []
  for v in voices:
    for line in lines:
      parts += ['-i', os.path.join(OUT, f'{v}_{line}.ogg')]
  n = len(voices) * len(lines)
  for k in range(n):
    gap = 1.1 if (k + 1) % len(lines) == 0 else 0.45
    fc.append(f'[{k}:a]apad=pad_dur={gap}[a{k}]')
  fc.append(''.join(f'[a{k}]' for k in range(n)) + f'concat=n={n}:v=0:a=1[out]')
  ff([*parts, '-filter_complex', ';'.join(fc), '-map', '[out]', '-c:a', 'aac_at', '-b:a', '128k', out])

if __name__ == '__main__':
  voices = [v for v in ('maverick', 'arena') if os.path.isdir(os.path.join(SRC, v))]
  for v in voices:
    picks = pick(v)
    process(v, picks)
    print(v, {k: p['take'] for k, p in picks.items()})
  if len(voices) == 2:
    out = os.path.join(SRC, 'ab_maverick_vs_arena.m4a')
    ab(voices, ['first_blood', 'double_kill', 'rampage', 'godlike'], out)
    print('A/B:', out)
