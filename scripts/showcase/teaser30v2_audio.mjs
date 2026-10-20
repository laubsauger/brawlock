/** Unbroken music excerpt, plus sparse narration placed on the final edit timeline. */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NARRATION } from './teaser30v2.edl.mjs'

const out = resolve('media/trailer/teaser30/v2')
const ff = '/opt/homebrew/bin/ffmpeg'
const phase = .07, bpm = 143.75, sourceStart = 72 * 60 / bpm
execFileSync(ff, ['-nostdin', '-y', '-loglevel', 'error', '-ss', String(sourceStart), '-i', 'media/trailer/music/no_safe_ground.wav', '-c:a', 'pcm_s16le', `${out}/no_safe_ground_continuous.wav`])
writeFileSync(`${out}/music.beats.json`, JSON.stringify({ bpm, firstDownbeat: phase, source: 'media/trailer/music/no_safe_ground.wav', sourceStart, continuous: true, internalEdits: 0 }, null, 2) + '\n')
const lines = NARRATION.map(({ file, at, text }) => ({ file, at, text }))
const inputs = [], filters = []
for (const [i, line] of lines.entries()) {
  const file = `${out}/voice/${line.file}`
  const duration = Number(execFileSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim())
  if (line.at + duration > (lines[i + 1]?.at ?? 29.5)) throw new Error(`Narration overlaps the following line: ${line.file}`)
  inputs.push('-i', file)
  filters.push(`[${i}:a]adelay=${Math.round(line.at * 1000)}[v${i}]`)
}
filters.push(`${lines.map((_, i) => `[v${i}]`).join('')}amix=inputs=${lines.length}:normalize=0:duration=longest,apad=whole_dur=29.5,atrim=0:29.5[voice]`)
execFileSync(ff, ['-nostdin', '-y', '-loglevel', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[voice]', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s24le', `${out}/voice/narration.wav`])
writeFileSync(`${out}/voice/timeline.json`, JSON.stringify(lines, null, 2) + '\n')
console.log('Continuous music excerpt and spaced narration prepared.')
