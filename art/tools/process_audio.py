# Trim / loop / normalize / encode the archived CC0 recordings (art/archive/audio) into public/audio with ffmpeg only.
# Usage: python3 -I art/tools/process_audio.py art/archive/audio public/audio <manifest.json out>
import glob, json, os, re, subprocess, sys
src_root, out_dir, manifest_out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out_dir, exist_ok=True)
files = {os.path.basename(f)[:8]: f for f in glob.glob(f'{src_root}/*/*.mp3')}
# name: (source id prefix, start, length, mode, extra filters, target)
#   mode 'loop' -> seamless crossfade loop (xfade = last field of target tuple), target = LUFS
#   mode 'shot' -> one-shot, fade out, target = peak dBFS
PLAN = {
  'bed_lava':     ('e1ba555a', 4.0, 12.0, 'loop', 'lowpass=f=3000', (-24, 2.0)),
  'bed_bubbles':  ('dfde54d1', 0.5, 10.0, 'loop', 'highpass=f=150', (-24, 0.8)),
  'bed_flow':     ('3f4a6098', 1.0, 10.0, 'loop', 'highpass=f=60', (-24, 0.8)),
  'fire_loop':    ('9e752748', 1.0, 8.0, 'loop', 'highpass=f=120', (-22, 0.6)),
  'zap_loop':     ('5d9cebb1', 0.5, 3.0, 'loop', '', (-24, 0.3)),
  'fan_loop':     ('70eba34c', 0.5, 3.0, 'loop', 'highpass=f=80', (-24, 0.3)),
  'rumble':       ('32db03ce', 4.0, 3.0, 'shot', 'afade=t=in:d=0.3', (-3, 0.8)),
  'coal_crackle': ('13a039a7', 0.5, 4.0, 'shot', 'highpass=f=300', (-1, 0.05)),
  'chain_clicks': ('0e59b2f3', 0.05, 1.85, 'shot', '', (-1, 0.05)),
  'fire_whoosh_a':('f9f4f88c', 0.0, 1.3, 'shot', '', (-1, 0.35)),
  'fire_whoosh_b':('d0edf5cb', 0.2, 1.05, 'shot', '', (-1, 0.25)),
  'impact_energy':('145799e4', 0.705, 0.55, 'shot', 'highpass=f=70,lowpass=f=4800,afade=t=in:d=0.001', (-1, 0.14)),
  'shield_impact':('178c4ee7', 0.0, 0.52, 'shot', 'highpass=f=140,lowpass=f=5200,afade=t=in:d=0.001', (-1, 0.2)),
  'fire_burst':   ('6e4c3844', 0.0, 0.75, 'shot', '', (-1, 0.15)),
  'flame_ignite': ('a3609751', 0.0, 0.8, 'shot', '', (-1, 0.2)),
  'flame_jet':    ('4a41884a', 0.0, 2.2, 'shot', '', (-1, 0.3)),
  'flame_roar':   ('78cc3916', 0.0, 1.2, 'shot', '', (-1, 0.2)),
  'zap_a':        ('e6f2593e', 0.0, 0.6, 'shot', '', (-1, 0.1)),
  'zap_b':        ('e6f2593e', 1.0, 0.6, 'shot', 'afade=t=in:d=0.005', (-1, 0.1)),
  'zap_c':        ('4ba5212a', 0.7, 0.4, 'shot', 'afade=t=in:d=0.005', (-1, 0.1)),
  'zap_spark':    ('0949f756', 0.0, 0.22, 'shot', '', (-1, 0.04)),
  'ice_a':        ('929c561c', 0.0, 1.0, 'shot', '', (-1, 0.1)),
  'ice_b':        ('1d22b11b', 0.0, 0.35, 'shot', '', (-1, 0.05)),
  'ice_c':        ('481eb3fd', 0.0, 0.3, 'shot', '', (-1, 0.05)),
  'snow_crunch':  ('15848b7b', 0.0, 0.55, 'shot', '', (-1, 0.08)),
  'blade_swish':  ('a6022ca7', 0.2, 0.85, 'shot', 'afade=t=in:d=0.01', (-1, 0.1)),
  'clang_a':      ('1cf36e8e', 0.0, 0.55, 'shot', '', (-1, 0.1)),
  'clang_ring':   ('9754bbd4', 0.1, 1.4, 'shot', '', (-1, 0.3)),
  'clank':        ('6924665d', 0.0, 0.23, 'shot', '', (-1, 0.04)),
  'debris_a':     ('0271bcdd', 0.0, 0.8, 'shot', '', (-1, 0.15)),
  'debris_b':     ('1ceff886', 0.0, 0.7, 'shot', '', (-1, 0.15)),
  'debris_c':     ('58da3cb3', 0.0, 0.8, 'shot', '', (-1, 0.15)),
  'debris_d':     ('c4d81c8d', 0.0, 0.9, 'shot', '', (-1, 0.15)),
  'rock_fall':    ('c066b9ea', 0.0, 0.73, 'shot', '', (-1, 0.1)),
  'stone_drag':   ('6f269c4d', 0.05, 0.75, 'shot', '', (-1, 0.15)),
  'stone_door':   ('35725a9a', 0.0, 2.0, 'shot', '', (-1, 0.4)),
  'pebbles':      ('75fad8c7', 0.0, 1.0, 'shot', '', (-1, 0.15)),
  'tele_out':     ('31353cf2', 0.0, 0.5, 'shot', '', (-1, 0.1)),
  'tele_in':      ('eb7cb9d7', 0.05, 0.6, 'shot', '', (-1, 0.1)),
  'tele_high':    ('d7b3a2dd', 0.1, 0.85, 'shot', '', (-1, 0.15)),
  'magic_cast':   ('87a836ae', 0.0, 1.0, 'shot', '', (-1, 0.2)),
  'cloth_flutter':('cfdd9885', 0.0, 0.45, 'shot', '', (-1, 0.08)),
  'cloth_flap':   ('696f0ea0', 0.1, 0.45, 'shot', '', (-1, 0.08)),
  'swish':        ('4a2eec99', 0.0, 0.44, 'shot', '', (-1, 0.06)),
  'hit_a':        ('72d7e606', 0.0, 0.65, 'shot', '', (-1, 0.1)),
  'hit_b':        ('f9a080d7', 0.0, 0.48, 'shot', '', (-1, 0.08)),
  'thud_a':       ('65a5a67e', 0.0, 0.55, 'shot', '', (-1, 0.1)),
  'thud_b':       ('d19dc776', 0.0, 0.42, 'shot', '', (-1, 0.08)),
  # warlock death voices (trims from the 2026-10-19 death voice audition, D01/D02)
  'death_cry_a':  ('4d506ee0', 0.025, 1.35, 'shot', 'highpass=f=70,lowpass=f=6500,afade=t=in:d=0.003', (-1, 0.12)),
  'death_cry_b':  ('e46f2779', 0.005, 1.4, 'shot', 'highpass=f=70,lowpass=f=6500,afade=t=in:d=0.003', (-1, 0.12)),
  'death_cry_c':  ('d94d4a88', 0.005, 0.95, 'shot', 'highpass=f=70,lowpass=f=6500,afade=t=in:d=0.003', (-1, 0.12)),
  'death_cry_d':  ('e0639382', 0.96, 1.5, 'shot', 'highpass=f=70,lowpass=f=6500,afade=t=in:d=0.003', (-1, 0.35)),
  'death_grunt_a':('62fda412', 0.325, 0.45, 'shot', 'highpass=f=70,lowpass=f=6500,afade=t=in:d=0.003', (-1, 0.08)),
  'death_grunt_b':('1be3ef8d', 0.315, 0.4, 'shot', 'highpass=f=70,lowpass=f=6500,afade=t=in:d=0.003', (-1, 0.08)),
  'death_grunt_c':('758b5863', 0.345, 0.4, 'shot', 'highpass=f=70,lowpass=f=6500,afade=t=in:d=0.003', (-1, 0.08)),
  # rare homage: the Wilhelm scream, from its original recording session (CC0, qubodup cut)
  'death_wilhelm':('70a3c202', 0.0, 1.75, 'shot', 'highpass=f=70,lowpass=f=6500', (-1, 0.25)),
}
# ONLY=name,name encodes just those (new assets without re-encoding the rest)
if os.environ.get('ONLY'):
  PLAN = {k: v for k, v in PLAN.items() if k in os.environ['ONLY'].split(',')}
def run(args):
  r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-y', *args], capture_output=True, text=True)
  if r.returncode: raise RuntimeError(r.stderr[-800:])
  return r.stderr
tmp = os.path.join(out_dir, '_tmp.wav')
manifest = {}
for name, (sid, start, length, mode, extra, target) in PLAN.items():
  src = files[sid]
  meta = json.load(open(src[:-4] + '.json'))
  pre = 'aformat=channel_layouts=mono,aresample=48000' + (',' + extra if extra else '')
  if mode == 'loop':
    lufs, x = target
    fc = (f"[0:a]atrim=start={start}:end={start + length + x},asetpts=PTS-STARTPTS,{pre},asplit=3[p1][p2][p3];"
          f"[p1]atrim=start={x}:end={length},asetpts=PTS-STARTPTS[body];"
          f"[p2]atrim=start={length}:end={length + x},asetpts=PTS-STARTPTS[tail];"
          f"[p3]atrim=start=0:end={x},asetpts=PTS-STARTPTS[head];"
          f"[tail][head]acrossfade=d={x}:c1=tri:c2=tri[xf];[body][xf]concat=n=2:v=0:a=1[out]")
    run(['-i', src, '-filter_complex', fc, '-map', '[out]', '-c:a', 'pcm_s16le', tmp])
    m = re.findall(r'I:\s+(-?[\d.]+) LUFS', run(['-i', tmp, '-af', 'ebur128', '-f', 'null', '-']))
    mx = re.findall(r'max_volume: (-?[\d.]+) dB', run(['-i', tmp, '-af', 'volumedetect', '-f', 'null', '-']))
    # static gain only: a limiter's lookahead would shift the start and break the loop point
    gain = min(lufs - float(m[-1]), -1 - float(mx[-1]))
  else:
    peak, fade = target
    run(['-i', src, '-af', f"atrim=start={start}:duration={length},asetpts=PTS-STARTPTS,{pre},afade=t=out:st={max(0, length - fade)}:d={fade}", '-c:a', 'pcm_s16le', tmp])
    mx = re.findall(r'max_volume: (-?[\d.]+) dB', run(['-i', tmp, '-af', 'volumedetect', '-f', 'null', '-']))
    gain = peak - float(mx[-1])
  post = f'volume={gain:.2f}dB' + ('' if mode == 'loop' else ',alimiter=limit=0.95:level=false')
  run(['-i', tmp, '-af', post, '-c:a', 'libopus', '-b:a', '96k', '-vbr', 'on', '-application', 'audio', os.path.join(out_dir, name + '.ogg')])
  run(['-i', tmp, '-af', post, '-c:a', 'aac_at', '-b:a', '96k', os.path.join(out_dir, name + '.m4a')])
  dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', os.path.join(out_dir, name + '.ogg')], capture_output=True, text=True).stdout)
  manifest[name] = {'loop': mode == 'loop', 'duration': round(dur, 3), 'source': {
    'title': meta['title'], 'creator': meta['creator'], 'license': meta['license'], 'license_url': meta.get('license_url'),
    'url': meta['foreign_landing_url'], 'openverse_id': meta['id']}}
os.remove(tmp)
json.dump(manifest, open(manifest_out, 'w'), indent=1)
ogg = sum(os.path.getsize(f) for f in glob.glob(f'{out_dir}/*.ogg')); m4a = sum(os.path.getsize(f) for f in glob.glob(f'{out_dir}/*.m4a'))
print(len(manifest), 'assets; ogg', round(ogg / 1e6, 2), 'MB; m4a', round(m4a / 1e6, 2), 'MB')
