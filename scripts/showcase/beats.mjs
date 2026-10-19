#!/usr/bin/env node
/**
 * Music analysis for the trailer edit: tempo, beat phase, loudness per bar, quiet pockets
 * and the biggest hits, from the decoded audio (ffmpeg, mono 11025 Hz). No dependencies.
 *   node scripts/showcase/beats.mjs <track> [--bpm 144] [--json out.json]
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const file = args[0]
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : d
}
const SR = 11025
const raw = execFileSync('/opt/homebrew/bin/ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 })
const x = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
const dur = x.length / SR
const HOP = Math.round(SR / 100) // 10 ms frames
const N = Math.floor(x.length / HOP)

// band energies per frame: low (< ~150 Hz, one-pole low-pass) and full
const low = new Float32Array(N)
const full = new Float32Array(N)
let lp = 0
const a = Math.exp((-2 * Math.PI * 150) / SR)
for (let f = 0; f < N; f++) {
  let el = 0
  let ef = 0
  for (let i = f * HOP; i < (f + 1) * HOP; i++) {
    lp = a * lp + (1 - a) * x[i]
    el += lp * lp
    ef += x[i] * x[i]
  }
  low[f] = el / HOP
  full[f] = ef / HOP
}
const db = (e) => 10 * Math.log10(e + 1e-10)
// onset strength: positive change of log energy (full + weighted low band)
const onset = new Float32Array(N)
for (let f = 1; f < N; f++) onset[f] = Math.max(0, db(full[f]) - db(full[f - 1])) + 0.7 * Math.max(0, db(low[f]) - db(low[f - 1]))

// tempo: autocorrelation of the onset curve over 100..180 BPM (or the given BPM)
const lagOf = (bpm) => (60 / bpm) * 100
let bestBpm = Number(opt('bpm', '0'))
if (!bestBpm) {
  let best = -1
  for (let bpm = 100; bpm <= 180; bpm += 0.25) {
    const L = lagOf(bpm)
    let s = 0
    for (let f = 0; f + 4 * L < N; f++) {
      const g = (k) => {
        const p = f + k * L
        const i = Math.floor(p)
        return (onset[i] ?? 0) * (1 - (p - i)) + (onset[i + 1] ?? 0) * (p - i)
      }
      s += onset[f] * (g(1) + 0.5 * g(2) + 0.25 * g(4))
    }
    if (s > best) {
      best = s
      bestBpm = bpm
    }
  }
}
if (!(bestBpm > 0)) throw new Error('no tempo found')
const spb = 60 / bestBpm
// beat phase: offset (10 ms steps) whose beat grid collects the most onset strength
let phase = 0
let pBest = -1
for (let off = 0; off < spb; off += 0.005) {
  let s = 0
  for (let t = off; t < dur; t += spb) {
    const f = Math.round(t * 100)
    for (let d = -2; d <= 2; d++) s += (onset[f + d] ?? 0) * (1 - Math.abs(d) / 3)
  }
  if (s > pBest) {
    pBest = s
    phase = off
  }
}
// downbeat: of the four beat phases, the one with the strongest low-band accents
let bar0 = 0
let barBest = -1
for (let k = 0; k < 4; k++) {
  let s = 0
  for (let t = phase + k * spb; t < dur; t += 4 * spb) {
    const f = Math.round(t * 100)
    for (let d = -2; d <= 2; d++) s += Math.max(0, db(low[f + d] ?? 0) - db(low[f + d - 3] ?? 0))
  }
  if (s > barBest) {
    barBest = s
    bar0 = k
  }
}
const firstDownbeat = phase + bar0 * spb
// loudness per beat (dB, 0 = loudest beat)
const beats = []
for (let t = phase; t < dur; t += spb) {
  const f0 = Math.round(t * 100)
  const f1 = Math.min(N, Math.round((t + spb) * 100))
  let e = 0
  for (let f = f0; f < f1; f++) e += full[f]
  beats.push({ t, db: db(e / Math.max(1, f1 - f0)) })
}
const top = Math.max(...beats.map((b) => b.db))
for (const b of beats) b.db -= top
// quiet pockets: beats more than 12 dB under the median of their 4 bars
const sorted = beats.map((b) => b.db).sort((p, q) => p - q)
const median = sorted[Math.floor(sorted.length / 2)]
const pockets = beats.filter((b, i) => b.db < median - 12 && i > 4 && b.t < dur - 4)
// biggest hits: onset peaks (local max over +-150 ms), strongest first
const hits = []
for (let f = 15; f < N - 15; f++) {
  let peak = true
  for (let d = -15; d <= 15; d++) if (onset[f + d] > onset[f]) peak = false
  if (peak && onset[f] > 0) hits.push({ t: f / 100, s: onset[f] })
}
hits.sort((p, q) => q.s - p.s)
const out = { file, dur, bpm: bestBpm, spb, phase, firstDownbeat, beats, pockets, hits: hits.slice(0, 24) }
console.log(`duration ${dur.toFixed(2)} s, ${bestBpm} BPM (beat ${spb.toFixed(4)} s), first beat ${phase.toFixed(3)} s, first downbeat ${firstDownbeat.toFixed(3)} s`)
console.log(`quiet beats (< median ${median.toFixed(1)} dB - 12): ${pockets.map((p) => `${p.t.toFixed(2)}s (${p.db.toFixed(1)} dB)`).join(', ') || 'none'}`)
console.log(`biggest hits: ${hits.slice(0, 16).map((h) => `${h.t.toFixed(2)}`).join(' ')}`)
const line = []
for (let i = 0; i < beats.length; i++) {
  const b = beats[i]
  line.push(`${((b.t - firstDownbeat) / spb).toFixed(0).padStart(4)}:${b.t.toFixed(2).padStart(6)} ${'#'.repeat(Math.max(0, Math.round((b.db + 30) / 1.5)))}`)
}
if (args.includes('--bars')) console.log(line.join('\n'))
const j = opt('json', '')
if (j) writeFileSync(j, JSON.stringify(out, null, 1))
