/** Place the approved dry Maverick stems on the exact trailer timeline. */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const dir = resolve('media/trailer/teaser30/voice')
const plan = JSON.parse(readFileSync(`${dir}/plan.json`, 'utf8'))
const inputs = [], filters = [], placed = []
for (const [i, line] of plan.lines.entries()) {
  const file = `${dir}/${line.id}.wav`
  const dur = Number(execFileSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim())
  if (line.at + dur > line.finishBy) throw new Error(`${line.id} exceeds its narration window; revise timing or performance`)
  inputs.push('-i', file)
  filters.push(`[${i}:a]adelay=${Math.round(line.at * 1000)}[v${i}]`)
  placed.push({ id: line.id, at: line.at, end: line.at + dur, text: line.text })
}
filters.push(`${plan.lines.map((_, i) => `[v${i}]`).join('')}amix=inputs=${plan.lines.length}:normalize=0:duration=longest,apad=whole_dur=29.5,atrim=0:29.5[vo]`)
execFileSync('/opt/homebrew/bin/ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[vo]', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s24le', `${dir}/narration.wav`], { stdio: 'inherit' })
writeFileSync(`${dir}/timeline.json`, JSON.stringify(placed, null, 2) + '\n')
console.log(placed)
