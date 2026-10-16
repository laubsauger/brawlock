#!/usr/bin/env node
/**
 * Showcase editor: concatenates the recorded shots (record.mjs) in edit order into the
 * master, a 720p preview, a labelled contact sheet and a QC report (luma per frame:
 * white-outs, black frames, frozen stretches).
 *
 *   node scripts/showcase/edit.mjs --in <shots dir> --out <dir> [--name brawlock_showcase_v1]
 *   [--python <python with Pillow>] (contact sheet labels)
 *   [--audio] render the in-game soundtrack offline (audio.mjs) and mux it into master + preview
 *   [--static <snapshot dir>] render that soundtrack from the same snapshot build as the shots
 *   [--share] also write a <25 MB share copy (720p30, two-pass ~0.95 Mbps)
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : d
}
const IN = resolve(opt('in', '.'))
const OUT = resolve(opt('out', IN))
const NAME = opt('name', 'brawlock_showcase_v1')
const FF = opt('ffmpeg', '/opt/homebrew/bin/ffmpeg')
const FFPROBE = FF.replace(/ffmpeg$/, 'ffprobe')
const PY = opt('python', '')
mkdirSync(OUT, { recursive: true })

/** edit order: [shot id, section] */
export const EDIT = [
  ['brand', 'Intro'],
  ['open', 'Cold open'],
  ['tip_move', 'How to play'],
  ['tip_cast', 'How to play'],
  ['tip_lava', 'How to play'],
  ['kit_fireball', 'Starting kit'],
  ['kit_scourge', 'Starting kit'],
  ['c1_boomerang', 'Column 1 · Knockout'],
  ['c1_lightning', 'Column 1 · Knockout'],
  ['c1_combo', 'Column 1 · Knockout'],
  ['c1_homing', 'Column 1 · Knockout'],
  ['c1_twin', 'Column 1 · Knockout'],
  ['c2_teleport', 'Column 2 · Transport'],
  ['c2_thrust', 'Column 2 · Transport'],
  ['c2_swap', 'Column 2 · Transport'],
  ['c3_cluster', 'Column 3 · Damage'],
  ['c3_drain', 'Column 3 · Damage'],
  ['c3_bouncer', 'Column 3 · Damage'],
  ['c3_recharge', 'Column 3 · Damage'],
  ['c4_windwalk', 'Column 4 · Devastator'],
  ['c4_meteor', 'Column 4 · Devastator'],
  ['c4_splitter', 'Column 4 · Devastator'],
  ['c4_snowball', 'Column 4 · Devastator'],
  ['c5_shield', 'Column 5 · Defense'],
  ['c5_rush', 'Column 5 · Defense'],
  ['c5_alteration', 'Column 5 · Defense'],
  ['c6_gravity', 'Column 6 · Control'],
  ['c6_grip', 'Column 6 · Control'],
  ['c6_warpzone', 'Column 6 · Control'],
  ['c6_magnetize', 'Column 6 · Control'],
  ['c6_rockpillar', 'Column 6 · Control'],
  ['c6_link', 'Column 6 · Control'],
  ['it_redirector', 'Active items'],
  ['it_pact', 'Active items'],
  ['m_shrink', 'Mechanics'],
  ['m_pillar', 'Mechanics'],
  ['m_shop', 'Mechanics'],
  ['m_tiers', 'Mechanics'],
  ['m_tiers_scourge', 'Mechanics'],
  ['brawl_kb', 'The brawl'],
  ['brawl_a', 'The brawl'],
  ['brawl_b', 'The brawl'],
  ['f_wide', 'Finale'],
  ['f_mid', 'Finale'],
  ['f_last', 'Finale'],
  ['end', 'End card'],
]

const probeDur = (f) => Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim())

const shots = []
let t = 0
for (const [id, section] of EDIT) {
  const f = join(IN, `${id}.mp4`)
  if (!existsSync(f)) {
    console.warn(`missing ${id} (skipped)`)
    continue
  }
  const dur = probeDur(f)
  shots.push({ id, section, file: f, start: t, dur })
  t += dur
}
const list = join(OUT, `${NAME}.txt`)
writeFileSync(list, shots.map((s) => `file '${s.file}'`).join('\n') + '\n')
const master = join(OUT, `${NAME}.mp4`)
console.log(`master: ${shots.length} shots, ${t.toFixed(2)} s`)
let wav = null
if (args.includes('--audio')) {
  wav = join(OUT, `${NAME}.wav`)
  const st = opt('static', '')
  execFileSync('node', [join(import.meta.dirname, 'audio.mjs'), '--shots', shots.map((s) => s.id).join(','), '--out', wav, ...(st ? ['--static', st] : [])], { stdio: 'inherit' })
}
const audioIn = wav ? ['-i', wav] : []
const audioOut = wav ? ['-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '256k', '-shortest'] : []
execFileSync(FF, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, ...audioIn, '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', '60', ...audioOut, '-movflags', '+faststart', master], { stdio: 'inherit' })
const preview = join(OUT, `${NAME}_720p.mp4`)
execFileSync(FF, ['-y', '-loglevel', 'error', '-i', master, '-vf', 'scale=1280:720:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-crf', '25', '-pix_fmt', 'yuv420p', ...(wav ? ['-c:a', 'aac', '-b:a', '160k'] : []), '-movflags', '+faststart', preview], { stdio: 'inherit' })

if (args.includes('--share')) {
  // share copy under 25 MB: 720p30, two-pass to a bitrate budget of ~23 MB total
  const share = join(OUT, `${NAME}_share.mp4`)
  const audioK = wav ? 64 : 0
  const videoK = Math.floor((23 * 8 * 1024) / t - audioK)
  const common = ['-vf', 'scale=1280:720:flags=lanczos,fps=30', '-c:v', 'libx264', '-preset', 'slow', '-b:v', `${videoK}k`, '-pix_fmt', 'yuv420p']
  const pass = join(OUT, `${NAME}_2pass`)
  execFileSync(FF, ['-y', '-loglevel', 'error', '-i', master, ...common, '-pass', '1', '-passlogfile', pass, '-an', '-f', 'mp4', '/dev/null'], { stdio: 'inherit' })
  execFileSync(FF, ['-y', '-loglevel', 'error', '-i', master, ...common, '-pass', '2', '-passlogfile', pass, ...(wav ? ['-c:a', 'aac', '-b:a', `${audioK}k`] : ['-an']), '-movflags', '+faststart', share], { stdio: 'inherit' })
  console.log(`share copy: ${share} (${videoK} kbps video)`)
}

// QC: per-frame luma of the master
const qc = spawnSync(FF, ['-hide_banner', '-i', master, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { maxBuffer: 1 << 28 })
const lines = qc.stdout.toString().split('\n')
const yavg = []
for (const l of lines) {
  const m = /YAVG=([\d.]+)/.exec(l)
  if (m) yavg.push(Number(m[1]))
}
const issues = []
const at = (i) => {
  const s = i / 60
  const sh = shots.find((x) => s >= x.start && s < x.start + x.dur)
  return `${s.toFixed(2)}s (${sh ? sh.id : '?'})`
}
for (let i = 0; i < yavg.length; i++) {
  const y = yavg[i]
  if (y > 170) issues.push(`white-out? YAVG ${y.toFixed(1)} at ${at(i)}`)
  if (i > 0 && Math.abs(y - yavg[i - 1]) > 45) issues.push(`luma jump ${yavg[i - 1].toFixed(1)} -> ${y.toFixed(1)} at ${at(i)}`)
}
const shotLines = shots.map((s) => `${fmt(s.start)}  ${s.dur.toFixed(2)}s  ${s.id.padEnd(16)} ${s.section}`)
function fmt(s) {
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`
}
writeFileSync(join(OUT, `${NAME}_shots.txt`), shotLines.join('\n') + '\n')
writeFileSync(join(OUT, `${NAME}_qc.txt`), [`frames ${yavg.length}, luma min ${Math.min(...yavg).toFixed(1)} max ${Math.max(...yavg).toFixed(1)}`, ...issues].join('\n') + '\n')
console.log(shotLines.join('\n'))
console.log(`QC: ${issues.length} flagged frames (see ${NAME}_qc.txt)`)

// contact sheet: one still per shot at ~60% of its length (after the impact)
const stillDir = join(OUT, 'sheet')
mkdirSync(stillDir, { recursive: true })
const stills = []
for (const s of shots) {
  const f = join(stillDir, `${s.id}.png`)
  // key frame: just after the first impact (death, explosion, hit) in the shot's event log
  let pick = s.dur * 0.55
  try {
    const log = JSON.parse(readFileSync(s.file.replace(/\.mp4$/, '.json'), 'utf8')).events ?? []
    const hit = log.find((e) => e[1] === 'death') ?? log.find((e) => e[1] === 'explosion' || e[1] === 'damage' || e[1] === 'purchase' || e[1] === 'arenaShrink')
    if (hit) pick = hit[0] + 0.3
  } catch {
    /* no log: mid-shot */
  }
  pick = Math.max(0.2, Math.min(s.dur - 0.1, pick))
  execFileSync(FF, ['-y', '-loglevel', 'error', '-ss', String(pick), '-i', s.file, '-frames:v', '1', '-vf', 'scale=480:270', f])
  stills.push({ f, label: `${fmt(s.start + pick)}  ${s.id}` })
}
writeFileSync(join(stillDir, 'index.json'), JSON.stringify(stills))
if (PY) {
  const py = `
import json, sys
from PIL import Image, ImageDraw, ImageFont
items = json.load(open(sys.argv[1]))
cols = 6
w, h = 480, 270
rows = (len(items) + cols - 1) // cols
sheet = Image.new('RGB', (cols * w, rows * (h + 26)), (12, 8, 6))
try:
    font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 18)
except Exception:
    font = ImageFont.load_default()
d = ImageDraw.Draw(sheet)
for i, it in enumerate(items):
    x, y = (i % cols) * w, (i // cols) * (h + 26)
    sheet.paste(Image.open(it['f']).convert('RGB'), (x, y))
    d.text((x + 6, y + h + 3), it['label'], fill=(240, 220, 190), font=font)
sheet.save(sys.argv[2])
`
  writeFileSync(join(stillDir, 'sheet.py'), py)
  execFileSync(PY, ['-I', join(stillDir, 'sheet.py'), join(stillDir, 'index.json'), join(OUT, `${NAME}_contact.png`)], { stdio: 'inherit' })
}
console.log(`wrote ${master}\n      ${preview}\n      ${join(OUT, `${NAME}_contact.png`)}`)
JSON.parse(readFileSync(join(stillDir, 'index.json'), 'utf8'))
