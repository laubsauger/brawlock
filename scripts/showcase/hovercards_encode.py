#!/usr/bin/env python3
"""
Hover-card preview clips, cropped from the recorded showcase takes (no re-recording).
Reads the plan from hovercards_plan.ts (window + 16:9 crop per ability; flagged shots are
skipped), writes per ability:
  <id>_300.webm (VP9, 300x169) + <id>_300.mp4 (H.264 main, 300x168 for Safari) + 600x338 versions
  + <id>.webp poster (300x169)
plus a poster contact sheet, a labelled review montage and a size table.
Loops are seamless: the last 0.3 s cross-fades into the first frames of the clip.

  python3 -I scripts/showcase/hovercards_encode.py <plan.json> <shots dir> <out dir>
Needs Pillow (WebP) and ffmpeg (libvpx-vp9, libx264). Runs ffmpeg under `nice -n 15`.
"""
import json, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

FF = '/opt/homebrew/bin/ffmpeg'
FPS = 30
XF = 0.3  # loop cross-fade, seconds
BUDGET_300 = 150 * 1024
POSTER_MAX = 12 * 1024

plan_path, shots, out = sys.argv[1:4]
os.makedirs(out, exist_ok=True)
plan = json.load(open(plan_path))


def ff(args):
    subprocess.run(['nice', '-n', '15', FF, '-loglevel', 'error', '-y', *args], check=True)


def chain(p, w, h):
    c = p['crop']
    L = p['t1'] - p['t0']
    return (
        f"[0:v]trim=start={p['t0']}:end={p['t1']},setpts=PTS-STARTPTS,"
        f"crop={c['w']}:{c['h']}:{c['x']}:{c['y']},scale={w}:{h}:flags=lanczos,setsar=1,fps={FPS},split[a][b];"
        f"[a]trim=start={XF},setpts=PTS-STARTPTS[body];[b]trim=end={XF},setpts=PTS-STARTPTS[head];"
        f"[body][head]xfade=transition=fade:duration={XF}:offset={L - 2 * XF:.3f},format=yuv420p[v]"
    )


def vp9(p, w, h, dst, crf, cap=None):
    rate = ['-b:v', cap] if cap else ['-b:v', '0']
    ff(['-i', f"{shots}/{p['id']}.mp4", '-filter_complex', chain(p, w, h), '-map', '[v]', '-an',
        '-c:v', 'libvpx-vp9', '-crf', str(crf), *rate, '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2',
        '-g', '120', dst])


def h264(p, w, h, dst, crf):
    ff(['-i', f"{shots}/{p['id']}.mp4", '-filter_complex', chain(p, w, h), '-map', '[v]', '-an',
        '-c:v', 'libx264', '-profile:v', 'main', '-preset', 'slow', '-crf', str(crf), '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', dst])


def fit(enc, p, w, h, dst, crfs, limit):
    for crf in crfs:
        enc(p, w, h, dst, crf)
        if os.path.getsize(dst) <= limit:
            return crf
    return crfs[-1]


rows = []
posters = []
for p in plan:
    if p.get('flag'):
        rows.append({'id': p['id'], 'flag': p['flag']})
        continue
    i = p['id']
    r = {'id': i, 'window': f"{p['t0']:.2f}-{p['t1']:.2f}s", 'crop': p['crop'], 'note': p.get('note')}
    r['vp9_300_crf'] = fit(vp9, p, 300, 169, f'{out}/{i}_300.webm', [34, 38, 42, 46], BUDGET_300)
    # H.264 4:2:0 needs even dimensions: the Safari MP4 is 300x168 (0.6 % aspect difference)
    r['h264_300_crf'] = fit(h264, p, 300, 168, f'{out}/{i}_300.mp4', [26, 29, 32, 35], BUDGET_300)
    r['vp9_600_crf'] = fit(vp9, p, 600, 338, f'{out}/{i}_600.webm', [36, 40, 44], 2 * BUDGET_300)
    r['h264_600_crf'] = fit(h264, p, 600, 338, f'{out}/{i}_600.mp4', [28, 31, 34], 2 * BUDGET_300)
    for k in ['300.webm', '300.mp4', '600.webm', '600.mp4']:
        r[k] = os.path.getsize(f'{out}/{i}_{k}')
    # poster: the impact frame, cropped like the clip
    c = p['crop']
    png = f'{out}/{i}_poster.png'
    ff(['-ss', str(p['key'] + 0.1), '-i', f'{shots}/{i}.mp4', '-frames:v', '1', '-vf',
        f"crop={c['w']}:{c['h']}:{c['x']}:{c['y']},scale=300:169:flags=lanczos", png])
    im = Image.open(png).convert('RGB')
    q = 80
    while True:
        im.save(f'{out}/{i}.webp', 'WEBP', quality=q, method=6)
        if os.path.getsize(f'{out}/{i}.webp') <= POSTER_MAX or q <= 30:
            break
        q -= 5
    os.remove(png)
    r['poster.webp'] = os.path.getsize(f'{out}/{i}.webp')
    r['poster_q'] = q
    rows.append(r)
    posters.append((i, im))
    print(f"{i:15} webm300 {r['300.webm'] / 1024:5.1f}K mp4300 {r['300.mp4'] / 1024:5.1f}K webm600 {r['600.webm'] / 1024:5.1f}K mp4600 {r['600.mp4'] / 1024:5.1f}K poster {r['poster.webp'] / 1024:4.1f}K", flush=True)

json.dump(rows, open(f'{out}/sizes.json', 'w'), indent=1)

# size table
ok = [r for r in rows if 'flag' not in r]
tot = {k: sum(r[k] for r in ok) for k in ['300.webm', '300.mp4', '600.webm', '600.mp4', 'poster.webp']}
lines = ['| ability | window | crop (1080p px) | VP9 300 | H.264 300 | VP9 600 | H.264 600 | poster |', '|---|---|---|---|---|---|---|---|']
for r in rows:
    if 'flag' in r:
        lines.append(f"| {r['id']} | FLAGGED: {r['flag']} | | | | | | |")
        continue
    c = r['crop']
    lines.append(f"| {r['id']} | {r['window']} | {c['w']}x{c['h']}+{c['x']}+{c['y']} | {r['300.webm'] / 1024:.0f} KB | {r['300.mp4'] / 1024:.0f} KB | {r['600.webm'] / 1024:.0f} KB | {r['600.mp4'] / 1024:.0f} KB | {r['poster.webp'] / 1024:.1f} KB |")
lines.append(f"| **total ({len(ok)} clips)** | | | {tot['300.webm'] / 1048576:.2f} MB | {tot['300.mp4'] / 1048576:.2f} MB | {tot['600.webm'] / 1048576:.2f} MB | {tot['600.mp4'] / 1048576:.2f} MB | {tot['poster.webp'] / 1024:.0f} KB |")
open(f'{out}/sizes.md', 'w').write('\n'.join(lines) + '\n')
print('\n'.join(lines[-1:]))

# poster contact sheet (labelled)
try:
    font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 16)
except Exception:
    font = ImageFont.load_default()
cols = 6
rows_n = (len(posters) + cols - 1) // cols
sheet = Image.new('RGB', (cols * 300, rows_n * 193), (12, 8, 6))
d = ImageDraw.Draw(sheet)
for n, (i, im) in enumerate(posters):
    x, y = (n % cols) * 300, (n // cols) * 193
    sheet.paste(im, (x, y))
    d.text((x + 6, y + 172), i, fill=(240, 220, 190), font=font)
sheet.save(f'{out}/posters_contact.png')

# review montage: each 600 px clip twice, its name burned in, one file
lab_dir = f'{out}/_labels'
os.makedirs(lab_dir, exist_ok=True)
parts = []
try:
    big = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Bold.ttf', 22)
except Exception:
    big = font
for (i, _) in posters:
    lab = Image.new('RGBA', (600, 36), (0, 0, 0, 150))
    ImageDraw.Draw(lab).text((10, 6), i, fill=(255, 230, 190, 255), font=big)
    lp = f'{lab_dir}/{i}.png'
    lab.save(lp)
    seg = f'{lab_dir}/{i}_seg.mp4'
    ff(['-stream_loop', '1', '-i', f'{out}/{i}_600.mp4', '-i', lp, '-filter_complex', '[0:v][1:v]overlay=0:0,format=yuv420p[v]',
        '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-r', str(FPS), seg])
    parts.append(seg)
open(f'{lab_dir}/list.txt', 'w').write(''.join(f"file '{s}'\n" for s in parts))
ff(['-f', 'concat', '-safe', '0', '-i', f'{lab_dir}/list.txt', '-c', 'copy', '-movflags', '+faststart', f'{out}/review_montage.mp4'])
print('montage', os.path.getsize(f'{out}/review_montage.mp4') / 1048576, 'MB')
