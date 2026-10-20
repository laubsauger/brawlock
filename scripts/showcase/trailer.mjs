#!/usr/bin/env node
/**
 * Trailer editor: cuts the recorded trailer takes to the music's beat grid (trailer.edl.mjs),
 * adds the in-game SFX of each take, the title layer (titles.mjs) and the music track.
 *
 *   node scripts/showcase/trailer.mjs --music <track> [--beats <beats.json from beats.mjs>]
 *     [--shots media/trailer/shots] [--cues media/trailer/cues.json] [--out media/trailer]
 *     [--name brawlock_trailer_v1] [--static <snapshot dir for the SFX render>] [--sfx 0.5]
 *     [--voice <timeline-aligned WAV>] [--no-youtube]
 *     [--plan] (print the cut list and stop) [--titles-only] [--sfx-only] [--titles] (force a title re-render)
 *
 * Writes <name>.mp4 (1080p60 master), <name>_youtube.mp4 (1440p60 upload), <name>_share.mp4 (1080p30, < 25 MB), <name>_small.mp4
 * (720p30, < 10 MB), <name>_cuts.txt and <name>_contact.jpg (one frame per cut).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const args = process.argv.slice(2)
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d
}
const FF = '/opt/homebrew/bin/ffmpeg'
const FPS = 60
const SHOTS = resolve(opt('shots', join(root, 'media/trailer/shots')))
const OUT = resolve(opt('out', join(root, 'media/trailer')))
const NAME = opt('name', 'brawlock_trailer_v1')
const MUSIC = opt('music', '') && resolve(opt('music', ''))
const VOICE = opt('voice', '') && resolve(opt('voice', ''))
if (VOICE && !MUSIC) throw new Error('--voice requires --music for the narrated mix')
const SFX_GAIN = Number(opt('sfx', '0.3'))
const edl = await import(pathToFileURL(resolve(opt('edl', join(here, 'trailer.edl.mjs')))).href)
const cues = JSON.parse(readFileSync(resolve(opt('cues', join(root, 'media/trailer/cues.json'))), 'utf8'))
mkdirSync(OUT, { recursive: true })

// --- beat grid: the analysed track wins over the EDL's nominal tempo
let bpm = edl.BPM
let beat0 = 0
const beatsFile = opt('beats', '')
if (beatsFile) {
  const b = JSON.parse(readFileSync(resolve(beatsFile), 'utf8'))
  bpm = b.bpm
  beat0 = b.firstDownbeat
}
const spb = 60 / bpm
const beatT = (b) => beat0 + b * spb
const frameOf = (t) => Math.round(t * FPS)
const probe = (f) => Number(execFileSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim())
const musicDur = MUSIC ? probe(MUSIC) : beatT(edl.CLIPS.reduce((a, c) => a + (c.beats === 'end' ? 8 : c.beats), 0))
const totalF = frameOf(musicDur)

// --- cut list
const cuts = []
let b = 0
for (const c of edl.CLIPS) {
  const startF = cuts.length === 0 ? 0 : frameOf(beatT(b))
  const endB = c.beats === 'end' ? Infinity : b + c.beats
  const endF = c.beats === 'end' ? totalF : Math.min(totalF, frameOf(beatT(endB)))
  const n = endF - startF
  if (n <= 0) break
  const cut = { ...c, beat: b, startF, n, inF: 0, hitF: null }
  if (c.shot) {
    const cue = cues[c.shot]
    if (!cue) throw new Error(`no cue for ${c.shot}`)
    const metaFile = join(SHOTS, `${c.shot}.json`)
    if (!existsSync(metaFile)) console.warn(`  ! ${c.shot}: not recorded yet`)
    const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : { frames: Math.round(cue.dur * FPS) }
    let inF = c.from !== undefined ? frameOf(c.from) : frameOf(cue.sync) - (frameOf(beatT(b + c.hitAt)) - startF)
    const maxIn = meta.frames - n
    if (maxIn < 0) console.warn(`  ! ${c.shot}: take is ${meta.frames} frames, the cut needs ${n} (holds the last frame)`)
    const want = inF
    inF = Math.max(0, Math.min(Math.max(0, maxIn), inF))
    if (inF !== want) console.warn(`  ! ${c.shot}: in-point clamped ${want} -> ${inF} frames (hit lands ${((want - inF) / FPS).toFixed(2)} s off the beat)`)
    cut.inF = inF
    cut.frames = meta.frames
    cut.hitF = startF + frameOf(cue.sync) - inF
  }
  cuts.push(cut)
  b = endB
  if (endF >= totalF) break
}
const lines = cuts.map((c) => `${(c.startF / FPS).toFixed(2).padStart(6)}s  beat ${String(c.beat).padStart(5)}  ${(c.n / FPS).toFixed(2)}s  ${(c.shot ?? '(black)').padEnd(13)} in ${(c.inF / FPS).toFixed(2)}${c.hitF !== null ? `  hit @${(c.hitF / FPS).toFixed(2)}` : ''}${c.tag ? `  [${c.tag}]` : ''}`)
console.log(`${bpm} BPM, beat 0 at ${beat0.toFixed(3)} s, ${cuts.length} cuts, ${(totalF / FPS).toFixed(2)} s`)
console.log(lines.join('\n'))
writeFileSync(join(OUT, `${NAME}_cuts.txt`), lines.join('\n') + '\n')
if (args.includes('--plan')) process.exit(0)

// --- title layer spec (edit seconds)
const events = []
for (const [beat, kind, f] of edl.TITLES) {
  const at = beatT(beat)
  if (kind === 'brand') events.push({ kind, at: 0, mark: beatT(f.mark), out: beatT(f.out), until: beatT(f.out) + 0.04 })
  else if (kind === 'slam') events.push({ kind, at, until: beatT(beat + f.beats), text: f.text, sub: f.sub, size: f.size, hue: f.hue, y: f.y })
  else if (kind === 'caption') events.push({ kind, at, until: beatT(beat + f.beats), text: f.text, sub: f.sub, size: f.size })
  else if (kind === 'end') events.push({ kind, at, until: totalF / FPS + 1, line1: f.line1, line2: f.line2, line3: f.line3, emblem: f.emblem })
}
// Narrated titles use exact speech times rather than rounding to music beats.
if (edl.NARRATION) {
  for (const line of edl.NARRATION) {
    if (line.title) events.push({ kind: 'slam', at: line.at, ...line.title })
  }
}
for (const c of cuts) {
  if (c.tag) events.push({ kind: 'tag', at: c.startF / FPS + 0.02, until: (c.startF + c.n) / FPS, spell: c.tag })
  if (c.flash && c.hitF !== null) events.push({ kind: 'flash', at: c.hitF / FPS, dur: 0.32, color: c.flash, peak: c.flash === 'white' ? 0.7 : 0.8 })
}
// brand flash-out into the first take, and a fade to black on the music's tail
const brand = events.find((e) => e.kind === 'brand')
if (brand) events.push({ kind: 'flash', at: brand.out, dur: 0.4, color: 'ember', peak: 0.9 })
events.push({ kind: 'fade', at: totalF / FPS - 0.9, until: totalF / FPS, from: 0, to: 1 })
const titleSpec = { dur: totalF / FPS, events }
const titlesJson = join(OUT, `${NAME}_titles.json`)
const titlesMov = join(OUT, `${NAME}_titles.mov`)
const prevSpec = existsSync(titlesJson) ? readFileSync(titlesJson, 'utf8') : ''
const nextSpec = JSON.stringify(titleSpec, null, 1)
if (args.includes('--sfx-only')) console.log('titles: skipped (--sfx-only)')
else if (prevSpec !== nextSpec || !existsSync(titlesMov) || args.includes('--titles')) {
  writeFileSync(titlesJson, nextSpec)
  execFileSync('node', [join(here, 'titles.mjs'), '--spec', titlesJson, '--out', titlesMov], { stdio: 'inherit' })
} else console.log('titles: unchanged, reusing', titlesMov)
if (args.includes('--titles-only')) process.exit(0)

// --- SFX: every take's in-game audio rendered once (audio.mjs), sliced per cut
const order = [...new Set(cuts.filter((c) => c.shot).map((c) => c.shot))].sort()
const sfxWav = join(OUT, 'sfx.wav')
const sfxIndex = join(OUT, 'sfx.json')
let index = existsSync(sfxIndex) ? JSON.parse(readFileSync(sfxIndex, 'utf8')) : null
if (!index || index.order.join(',') !== order.join(',') || index.ambience !== false || !existsSync(sfxWav) || args.includes('--sfx-render')) {
  const st = opt('static', '')
  // no lava bed under the music: only the spells and impacts
  execFileSync('node', [join(here, 'audio.mjs'), '--shots', order.join(','), '--out', sfxWav, '--no-ambience', ...(st ? ['--static', st] : [])], { stdio: 'inherit' })
  const offsets = {}
  let t = 0
  for (const id of order) {
    offsets[id] = t
    // same frame count audio.ts renders per shot (Director.frames = round(dur * 60))
    t += Math.round(cues[id].dur * FPS) / FPS
  }
  index = { order, offsets, ambience: false }
  writeFileSync(sfxIndex, JSON.stringify(index, null, 1))
} else console.log('sfx: unchanged, reusing', sfxWav)
if (args.includes('--sfx-only')) process.exit(0)

// --- compose
const inputs = []
const filt = []
const pairs = []
cuts.forEach((c, i) => {
  const dur = (c.n / FPS).toFixed(6)
  if (c.shot) {
    inputs.push('-i', join(SHOTS, `${c.shot}.mp4`))
    const k = inputs.filter((x) => x === '-i').length - 1
    // a take shorter than its cut holds its last frame
    const pad = Math.max(0, c.inF + c.n - c.frames)
    filt.push(`[${k}:v]trim=start_frame=${c.inF}:end_frame=${c.inF + c.n - pad},setpts=PTS-STARTPTS,tpad=stop=${pad}:stop_mode=clone,fps=${FPS},format=yuv420p,setsar=1[v${i}]`)
  } else filt.push(`color=c=black:s=1920x1080:r=${FPS}:d=${dur},format=yuv420p,setsar=1[v${i}]`)
})
const nIn = inputs.filter((x) => x === '-i').length
inputs.push('-i', sfxWav, '-i', titlesMov)
const SFX = nIn
const TIT = nIn + 1
if (MUSIC) inputs.push('-i', MUSIC)
const MUS = nIn + 2
if (VOICE) inputs.push('-i', VOICE)
const VO = nIn + 3
const withShot = cuts.map((c, i) => [c, i]).filter(([c]) => c.shot)
filt.push(`[${SFX}:a]aresample=48000,aformat=channel_layouts=stereo,asplit=${withShot.length}${withShot.map(([, i]) => `[s${i}]`).join('')}`)
cuts.forEach((c, i) => {
  const dur = c.n / FPS
  if (c.shot) {
    const a = index.offsets[c.shot] + c.inF / FPS
    filt.push(`[s${i}]atrim=start=${a.toFixed(6)}:duration=${dur.toFixed(6)},asetpts=PTS-STARTPTS,apad=whole_dur=${dur.toFixed(6)},afade=t=in:d=0.006,afade=t=out:st=${(dur - 0.012).toFixed(6)}:d=0.012[a${i}]`)
  } else filt.push(`aevalsrc=exprs=0|0:s=48000:d=${dur.toFixed(6)}[a${i}]`)
  pairs.push(`[v${i}][a${i}]`)
})
filt.push(`${pairs.join('')}concat=n=${cuts.length}:v=1:a=1[vc][ac]`)
filt.push(`[vc]vignette=angle=0.42[vv]`)
filt.push(`[${TIT}:v]format=rgba[tt]`)
filt.push(`[vv][tt]overlay=0:0:format=auto:eof_action=pass,format=yuv420p[vo]`)
const total = (totalF / FPS).toFixed(6)
if (MUSIC) {
  // game SFX as accents under the music: no rumble or fizz, peaks tamed, well below the track
  filt.push(`[ac]highpass=f=110,lowpass=f=7000,acompressor=threshold=0.12:ratio=4:attack=5:release=120,volume=${SFX_GAIN}[sa]`)
  filt.push(`[${MUS}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${total},asetpts=PTS-STARTPTS[ma]`)
  if (VOICE) {
    filt.push(`[${VO}:a]aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${total},atrim=0:${total},asplit=2[va][side]`)
    filt.push('[ma][side]sidechaincompress=threshold=0.055:ratio=2.5:attack=80:release=650:knee=4[ducked]')
    filt.push('[sa][ducked][va]amix=inputs=3:normalize=0:duration=longest,alimiter=limit=0.97:level=false[ao]')
  } else filt.push(`[sa][ma]amix=inputs=2:normalize=0:duration=longest,alimiter=limit=0.97:level=false[ao]`)
} else filt.push(`[ac]volume=${SFX_GAIN},alimiter=limit=0.97:level=false[ao]`)
const master = join(OUT, `${NAME}.mp4`)
writeFileSync(join(OUT, `${NAME}_filter.txt`), filt.join(';\n'))
console.log(`compose: ${cuts.length} cuts -> ${master}`)
execFileSync(FF, ['-nostdin', '-y', '-loglevel', 'error', ...inputs, '-/filter_complex', join(OUT, `${NAME}_filter.txt`), '-map', '[vo]', '-map', '[ao]', '-t', total, '-r', String(FPS), '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '320k', '-movflags', '+faststart', master], { stdio: 'inherit' })

// YouTube upload: 1440p60 (YouTube serves 1440p+ uploads with a better codec and more bitrate than 1080p)
const yt = join(OUT, `${NAME}_youtube.mp4`)
if (!args.includes('--no-youtube')) {
  execFileSync(FF, ['-nostdin', '-y', '-loglevel', 'error', '-i', master, '-vf', 'scale=2560:1440:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-c:a', 'copy', '-movflags', '+faststart', yt], { stdio: 'inherit' })
  console.log(`youtube: ${yt}`)
}

// share copies: 1080p30 under 25 MB and 720p30 under 10 MB (two-pass to a bitrate budget)
for (const [suffix, scale, mb, ak] of [
  ['share', '1920:1080', 24, 192],
  ['small', '1280:720', 9.5, 128],
]) {
  const f = join(OUT, `${NAME}_${suffix}.mp4`)
  const vk = Math.floor((mb * 8 * 1024) / (totalF / FPS) - ak)
  const pass = join(OUT, `${NAME}_${suffix}_2pass`)
  const common = ['-vf', `scale=${scale}:flags=lanczos,fps=30`, '-c:v', 'libx264', '-preset', 'slow', '-b:v', `${vk}k`, '-pix_fmt', 'yuv420p']
  execFileSync(FF, ['-nostdin', '-y', '-loglevel', 'error', '-i', master, ...common, '-pass', '1', '-passlogfile', pass, '-an', '-f', 'mp4', '/dev/null'], { stdio: 'inherit' })
  execFileSync(FF, ['-nostdin', '-y', '-loglevel', 'error', '-i', master, ...common, '-pass', '2', '-passlogfile', pass, '-c:a', 'aac', '-b:a', `${ak}k`, '-movflags', '+faststart', f], { stdio: 'inherit' })
  console.log(`${suffix}: ${f} (${vk} kbps video)`)
}

// contact sheet: one frame per cut (at its hit, else mid-cut), 6 across
const sheetDir = join(OUT, 'sheet')
mkdirSync(sheetDir, { recursive: true })
const stills = cuts.map((c, i) => {
  const f = join(sheetDir, `${String(i).padStart(2, '0')}.png`)
  const t = ((c.hitF ?? c.startF + c.n / 2) + 3) / FPS
  execFileSync(FF, ['-nostdin', '-y', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', master, '-frames:v', '1', '-vf', 'scale=320:180', f])
  return f
})
const cols = 6
const lay = stills.map((_, i) => `${(i % cols) * 320}_${Math.floor(i / cols) * 180}`).join('|')
execFileSync(FF, ['-nostdin', '-y', '-loglevel', 'error', ...stills.flatMap((f) => ['-i', f]), '-filter_complex', `${stills.map((_, i) => `[${i}:v]`).join('')}xstack=inputs=${stills.length}:layout=${lay}:fill=black`, join(OUT, `${NAME}_contact.jpg`)])
console.log(`wrote ${master}`)
