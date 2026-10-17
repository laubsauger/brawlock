#!/usr/bin/env python3
"""
Ability hover-card clips for the shop / HUD, from the recorded showcase takes (no re-recording):
the plan's time windows (hovercards_plan.ts) with a light, even crop (EDGE off every side,
centred, 16:9), 300 px wide, silent, 30 fps, seamless loop (last 0.3 s cross-fades into
the start). Writes, named by sim spell / item id:
  <out>/<id>.webm (VP9 300x169), <id>.mp4 (H.264 main 300x168, Safari), <id>.webp (poster)
  <out>/index.json (ids with clips + sizes), and a poster contact sheet next to the plan.

  python3 -I scripts/showcase/hovercards_public.py <plan.json> <shots dir> <out dir> <contact.png>
Needs Pillow (WebP) and ffmpeg (libvpx-vp9, libx264); ffmpeg runs under `nice -n 15`.
"""
import json, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

FF = '/opt/homebrew/bin/ffmpeg'
FPS = 30
XF = 0.3
EDGE = 0.08
BUDGET = 150 * 1024
POSTER_MAX = 12 * 1024

plan_path, shots, out, contact = sys.argv[1:5]
os.makedirs(out, exist_ok=True)
plan = json.load(open(plan_path))

# even crop: EDGE off each side, centred, 16:9, even pixel sizes
CW = int(round(1920 * (1 - 2 * EDGE) / 2)) * 2
CH = int(round(CW * 9 / 16 / 2)) * 2
CX = (1920 - CW) // 2 // 2 * 2
CY = (1080 - CH) // 2 // 2 * 2


def ff(args):
    subprocess.run(['nice', '-n', '15', FF, '-loglevel', 'error', '-y', *args], check=True)


def chain(p, w, h):
    L = p['t1'] - p['t0']
    return (
        f"[0:v]trim=start={p['t0']}:end={p['t1']},setpts=PTS-STARTPTS,"
        f"crop={CW}:{CH}:{CX}:{CY},scale={w}:{h}:flags=lanczos,setsar=1,fps={FPS},split[a][b];"
        f"[a]trim=start={XF},setpts=PTS-STARTPTS[body];[b]trim=end={XF},setpts=PTS-STARTPTS[head];"
        f"[body][head]xfade=transition=fade:duration={XF}:offset={L - 2 * XF:.3f},format=yuv420p[v]"
    )


def vp9(p, dst, crf):
    ff(['-i', f"{shots}/{p['id']}.mp4", '-filter_complex', chain(p, 300, 169), '-map', '[v]', '-an',
        '-c:v', 'libvpx-vp9', '-crf', str(crf), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-g', '120', dst])


def h264(p, dst, crf):
    # H.264 4:2:0 needs even dimensions: 300x168 (0.6 % aspect difference)
    ff(['-i', f"{shots}/{p['id']}.mp4", '-filter_complex', chain(p, 300, 168), '-map', '[v]', '-an',
        '-c:v', 'libx264', '-profile:v', 'main', '-preset', 'slow', '-crf', str(crf), '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', dst])


def fit(enc, p, dst, crfs):
    for crf in crfs:
        enc(p, dst, crf)
        if os.path.getsize(dst) <= BUDGET:
            return crf
    return crfs[-1]


index = {'source': 'media/showcase/shots (showcase takes)', 'crop': {'edge': EDGE, 'w': CW, 'h': CH, 'x': CX, 'y': CY}, 'clips': {}}
posters = []
for p in plan:
    sid = p['id'].split('_', 1)[1]  # kit_fireball -> fireball, it_pact -> pact, c1_lightning -> lightning
    webm, mp4, webp = f'{out}/{sid}.webm', f'{out}/{sid}.mp4', f'{out}/{sid}.webp'
    c_vp9 = fit(vp9, p, webm, [36, 39, 42, 45, 48])
    c_264 = fit(h264, p, mp4, [28, 30, 32, 34, 36])
    png = f'{out}/{sid}_poster.png'
    ff(['-ss', str(p['key'] + 0.1), '-i', f"{shots}/{p['id']}.mp4", '-frames:v', '1', '-vf', f'crop={CW}:{CH}:{CX}:{CY},scale=300:169:flags=lanczos', png])
    im = Image.open(png).convert('RGB')
    os.remove(png)
    q = 80
    while True:
        im.save(webp, 'WEBP', quality=q, method=6)
        if os.path.getsize(webp) <= POSTER_MAX or q <= 30:
            break
        q -= 5
    dur = (p['t1'] - p['t0']) - XF
    index['clips'][sid] = {
        'shot': p['id'],
        'duration': round(dur, 2),
        'webm': {'bytes': os.path.getsize(webm), 'width': 300, 'height': 169, 'crf': c_vp9},
        'mp4': {'bytes': os.path.getsize(mp4), 'width': 300, 'height': 168, 'crf': c_264},
        'webp': {'bytes': os.path.getsize(webp), 'width': 300, 'height': 169, 'quality': q},
    }
    posters.append((sid, im))
    print(f"{sid:12} webm {os.path.getsize(webm) / 1024:5.1f}K (crf {c_vp9})  mp4 {os.path.getsize(mp4) / 1024:5.1f}K (crf {c_264})  webp {os.path.getsize(webp) / 1024:4.1f}K", flush=True)

tot = {k: sum(v[k]['bytes'] for v in index['clips'].values()) for k in ['webm', 'mp4', 'webp']}
index['totals'] = tot
json.dump(index, open(f'{out}/index.json', 'w'), indent=1)
print(f"totals: webm {tot['webm'] / 1048576:.2f} MB, mp4 {tot['mp4'] / 1048576:.2f} MB, webp {tot['webp'] / 1024:.0f} KB, {len(index['clips'])} clips")

try:
    font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 16)
except Exception:
    font = ImageFont.load_default()
cols = 7
rows = (len(posters) + cols - 1) // cols
sheet = Image.new('RGB', (cols * 300, rows * 193), (12, 8, 6))
d = ImageDraw.Draw(sheet)
for n, (sid, im) in enumerate(posters):
    x, y = (n % cols) * 300, (n // cols) * 193
    sheet.paste(im, (x, y))
    d.text((x + 6, y + 172), sid, fill=(240, 220, 190), font=font)
sheet.save(contact)
