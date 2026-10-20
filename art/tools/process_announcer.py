# Announcer pack: pick the best take per line, then trim / arena space / loudness / encode with ffmpeg.
# Usage: python3 -I art/tools/process_announcer.py [--pack 2] [--voice maverick] [--keep-picks]
# Raw takes: art/archive/audio/announcer/<voice>/<line>_take<n>.mp3 (kept forever, never deleted).
# Picks + reasons: art/archive/audio/announcer/<voice>/picks.json. Shipped: public/audio/announcer/.
# --pack processes one pack's lines only (earlier picks stay in picks.json); lines without takes
# are skipped. New lines are appended to the announcer block of src/audio/assets.ts.
import glob, json, os, re, subprocess

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SRC = os.path.join(ROOT, 'art/archive/audio/announcer')
OUT = os.path.join(ROOT, 'public/audio/announcer')
PACKS = {
  1: ['first_blood', 'double_kill', 'triple_kill', 'multi_kill', 'mega_kill', 'ultra_kill', 'monster_kill',
      'killing_spree', 'rampage', 'unstoppable', 'godlike'],
  2: ['round_one', 'round_two', 'round_three', 'round_four', 'round_five', 'round_six', 'round_seven', 'round_eight',
      'round_nine', 'fight', 'final_round', 'match_point', 'round_won', 'draw', 'victory', 'defeat', 'arena_shrinks',
      'shutdown', 'revenge', 'denied', 'close_call', 'last_standing', 'ace'],
}
ASSETS_TS = os.path.join(ROOT, 'src/audio/assets.ts')
# every announcer line shares the ElevenLabs credit entry
ANNOUNCER_CREDIT = 45
TARGET_LUFS = -16
# Keep the consonants readable while taking the edge off a close, forceful delivery.
TONE = 'highpass=f=65,equalizer=f=3000:t=q:w=0.8:g=-2.5,highshelf=f=6000:g=-1.8'
DYNAMICS = 'acompressor=threshold=0.16:ratio=1.6:attack=4:release=80:knee=2.5'
# Restrained early reflections and a short tail; no long hall wash over the next call.
SPACE = 'apad=pad_dur=0.35,aecho=0.9:0.7:37|71|113|167|229|293:0.23|0.17|0.12|0.085|0.055|0.035'
PROCESSING_DOC = 'trimmed, softened upper mids/highs, short dark arena reflections, -16 LUFS, Opus 96 kbps + AAC 96 kbps'

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

def pick(voice, lines, keep_picks=False):
  path = os.path.join(SRC, voice, 'picks.json')
  picks = json.load(open(path)) if os.path.exists(path) else {}
  if keep_picks:
    for line in lines:
      if line not in picks or not os.path.isfile(os.path.join(SRC, voice, picks[line]['take'])):
        raise RuntimeError(f'{voice}/{line}: selected original is missing; cannot preserve this take')
    return picks, lines
  done = []
  for line in lines:
    takes = sorted(glob.glob(os.path.join(SRC, voice, f'{line}_take*.mp3')))
    if not takes: continue
    done.append(line)
    m = {os.path.basename(t): measure(t) for t in takes}
    clean = {k: v for k, v in m.items() if v['peak'] < 0} or m
    # more energy first, then the punchier (shorter) delivery
    best = max(clean, key=lambda k: (round(clean[k]['lufs'], 0), -clean[k]['dur']))
    why = 'only take' if len(m) == 1 else ('others clip; ' if len(clean) < len(m) else '') + 'loudest clean delivery (ties: shorter)'
    picks[line] = {'take': best, 'reason': why, 'measured': m}
  with open(path, 'w') as f: json.dump(picks, f, indent=1)
  return picks, done

def process(voice, picks, lines):
  os.makedirs(OUT, exist_ok=True)
  tmp = os.path.join(OUT, '_tmp.wav')
  durations = {}
  for line in lines:
    src = os.path.join(SRC, voice, picks[line]['take'])
    trim = ('silenceremove=start_periods=1:start_threshold=-45dB,areverse,'
            'silenceremove=start_periods=1:start_threshold=-50dB,areverse')
    ff(['-i', src, '-af', f'aformat=channel_layouts=mono,aresample=48000,{trim},{TONE},{DYNAMICS},{SPACE},'
        'silenceremove=stop_periods=-1:stop_threshold=-60dB:stop_duration=0.2,afade=t=in:d=0.004', '-c:a', 'pcm_s16le', tmp])
    i = float(re.findall(r'I:\s+(-?[\d.]+) LUFS', ff(['-i', tmp, '-af', 'ebur128', '-f', 'null', '-']))[-1])
    dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', tmp], capture_output=True, text=True).stdout)
    durations[line] = dur
    # Oversample the limiter and leave encoder headroom for short, sharp consonants.
    post = (f'volume={TARGET_LUFS - i:.2f}dB,aresample=192000,alimiter=limit=0.8:level=false,aresample=48000,'
            f'afade=t=out:st={max(0, dur - 0.12):.3f}:d=0.12')
    ff(['-i', tmp, '-af', post, '-c:a', 'libopus', '-b:a', '96k', '-vbr', 'on', '-application', 'audio', os.path.join(OUT, f'{voice}_{line}.ogg')])
    ff(['-i', tmp, '-af', post, '-c:a', 'aac_at', '-b:a', '96k', os.path.join(OUT, f'{voice}_{line}.m4a')])
  if os.path.exists(tmp): os.remove(tmp)
  return durations

def add_assets(entries):
  """Update processed durations and append new announcer lines in src/audio/assets.ts."""
  src = open(ASSETS_TS).read()
  updated = 0
  for (voice, line), duration in entries:
    pattern = rf"('announcer/{voice}_{line}': \{{ loop: false, duration: )[\d.]+"
    src, count = re.subn(pattern, lambda m: m[1] + str(round(duration, 3)), src)
    updated += count
  end = src.index('} satisfies Record<string, AudioAsset>')
  new = [f"  'announcer/{v}_{line}': {{ loop: false, duration: {round(d, 3)}, credit: {ANNOUNCER_CREDIT} }},\n"
         for (v, line), d in entries if f"'announcer/{v}_{line}'" not in src]
  if new or updated:
    open(ASSETS_TS, 'w').write(src[:end] + ''.join(new) + src[end:])
  return len(new) + updated

VOICE_DOC = {'maverick': 'Maverick (`V33LkP9pVLdcjeB2y5Na`)', 'arena': 'Daniel (Arena) (`onwK4e9ZLuTAKqWW03F9`)'}
ASSETS_MD = os.path.join(ROOT, 'docs/ASSETS.md')

def add_doc_rows(rows):
  """Append docs/ASSETS.md table rows for shipped lines not listed yet (after the last announcer row)."""
  doc = open(ASSETS_MD).read()
  new = []
  for v, line, picked in rows:
    path = f'public/audio/announcer/{v}_{line}.ogg'
    if path in doc:
      lines = doc.splitlines(keepends=True)
      for i, row in enumerate(lines):
        if row.startswith(f'| `{path}`, `.m4a` |'):
          head, _, tail = row.rsplit(' | ', 2)
          lines[i] = head + ' | ' + PROCESSING_DOC + ' | ' + tail
      doc = ''.join(lines)
      continue
    new.append(f"| `{path}`, `.m4a` | ElevenLabs text-to-speech, voice {VOICE_DOC[v]}, `eleven_multilingual_v2`, stability 0.4, style 0.7; "
               f"picked `art/archive/audio/announcer/{v}/{picked['take']}` ({picked['reason']}) | {PROCESSING_DOC} | "
               "Generated for this project with ElevenLabs on the user's account |\n")
  if new:
    lines = doc.splitlines(keepends=True)
    last = max(i for i, l in enumerate(lines) if l.startswith('| `public/audio/announcer/'))
    open(ASSETS_MD, 'w').write(''.join(lines[:last + 1] + new + lines[last + 1:]))
  else:
    open(ASSETS_MD, 'w').write(doc)
  return len(new)

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
  import argparse
  parser = argparse.ArgumentParser()
  parser.add_argument('--pack', type=int, choices=sorted(PACKS))
  parser.add_argument('--voice', choices=['maverick', 'arena'])
  parser.add_argument('--keep-picks', action='store_true', help='reprocess selected originals without changing any take choices')
  args = parser.parse_args()
  pack = args.pack
  lines = PACKS[pack] if pack else [l for p in sorted(PACKS) for l in PACKS[p]]
  voices = [args.voice] if args.voice else [v for v in ('maverick', 'arena') if os.path.isdir(os.path.join(SRC, v))]
  entries = []
  doc_rows = []
  for v in voices:
    picks, done = pick(v, lines, args.keep_picks)
    durations = process(v, picks, done)
    entries += [((v, l), durations[l]) for l in done]
    doc_rows += [(v, l, picks[l]) for l in done]
    print(v, {k: picks[k]['take'] for k in done})
    missing = [l for l in lines if l not in done]
    if missing: print(v, 'no takes yet:', ', '.join(missing))
  print('assets.ts: updated', add_assets(entries), 'entries; ASSETS.md: added', add_doc_rows(doc_rows), 'rows (existing processing descriptions refreshed)')
  if len(voices) == 2 and pack in (None, 1):
    out = os.path.join(SRC, 'ab_maverick_vs_arena.m4a')
    ab(voices, ['first_blood', 'double_kill', 'rampage', 'godlike'], out)
    print('A/B:', out)
  ab2 = ['fight', 'final_round', 'victory', 'shutdown', 'last_standing']
  if len(voices) == 2 and pack in (None, 2) and all(os.path.exists(os.path.join(OUT, f'{v}_{l}.ogg')) for v in voices for l in ab2):
    out = os.path.join(SRC, 'ab_pack2_maverick_vs_arena.m4a')
    ab(voices, ab2, out)
    print('A/B:', out)
