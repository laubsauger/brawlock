/**
 * Procedural SFX recipes. No asset files: every sound is built from oscillators,
 * pre-rendered noise buffers, filters and envelopes on a BaseAudioContext, so the
 * same code runs on a live AudioContext or an OfflineAudioContext (for checks).
 *
 * A recipe schedules nodes starting at `t` into `out` and returns its duration (s).
 * `p` is a per-sound parameter (knockback intensity, windup length, size).
 * Random pitch and variation use Math.random (fine outside the sim).
 */

export interface Synth {
  ctx: BaseAudioContext
  white: AudioBuffer
  pink: AudioBuffer
  brown: AudioBuffer
  soft: Float32Array<ArrayBuffer>
  hard: Float32Array<ArrayBuffer>
}

export type Recipe = (s: Synth, out: AudioNode, t: number, p: number) => number

const EPS = 0.0001

// ---------------------------------------------------------------------------
// Buffers and curves, rendered once per context
// ---------------------------------------------------------------------------

export function createSynth(ctx: BaseAudioContext): Synth {
  const len = Math.floor(ctx.sampleRate * 2)
  const white = ctx.createBuffer(1, len, ctx.sampleRate)
  const pink = ctx.createBuffer(1, len, ctx.sampleRate)
  const brown = ctx.createBuffer(1, len, ctx.sampleRate)
  const w = white.getChannelData(0)
  const pk = pink.getChannelData(0)
  const br = brown.getChannelData(0)
  let b0 = 0
  let b1 = 0
  let b2 = 0
  let last = 0
  for (let i = 0; i < len; i++) {
    const r = Math.random() * 2 - 1
    w[i] = r
    // Paul Kellet's economy pink filter
    b0 = 0.99765 * b0 + r * 0.099046
    b1 = 0.963 * b1 + r * 0.2965164
    b2 = 0.57 * b2 + r * 1.0526913
    pk[i] = (b0 + b1 + b2 + r * 0.1848) * 0.2
    last = (last + 0.02 * r) / 1.02
    br[i] = last * 3.5
  }
  return { ctx, white, pink, brown, soft: makeCurve(1.6), hard: makeCurve(4) }
}

function makeCurve(k: number): Float32Array<ArrayBuffer> {
  const n = 1024
  const c = new Float32Array(new ArrayBuffer(n * 4))
  const norm = Math.tanh(k)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    c[i] = Math.tanh(k * x) / norm
  }
  return c
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const rnd = (a: number, b: number) => a + Math.random() * (b - a)

/** Attack-(hold)-exponential-decay gain envelope into `dest`. */
export function env(s: Synth, dest: AudioNode, t: number, attack: number, peak: number, decay: number, hold = 0): GainNode {
  const g = s.ctx.createGain()
  g.gain.setValueAtTime(EPS, t)
  g.gain.linearRampToValueAtTime(peak, t + attack)
  if (hold > 0) g.gain.setValueAtTime(peak, t + attack + hold)
  g.gain.exponentialRampToValueAtTime(EPS, t + attack + hold + decay)
  g.connect(dest)
  return g
}

export function osc(s: Synth, type: OscillatorType, f0: number, f1: number, t: number, glide: number, stop: number): OscillatorNode {
  const o = s.ctx.createOscillator()
  o.type = type
  o.frequency.setValueAtTime(f0, t)
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + glide)
  o.start(t)
  o.stop(stop)
  return o
}

export function noise(s: Synth, buf: AudioBuffer, t: number, stop: number, rate = 1): AudioBufferSourceNode {
  const n = s.ctx.createBufferSource()
  n.buffer = buf
  n.loop = true
  n.playbackRate.value = rate
  n.start(t, Math.random() * Math.max(0, buf.duration - 0.25))
  n.stop(stop)
  return n
}

export function filt(s: Synth, type: BiquadFilterType, freq: number, q = 0.707): BiquadFilterNode {
  const f = s.ctx.createBiquadFilter()
  f.type = type
  f.frequency.value = freq
  f.Q.value = q
  return f
}

function sweep(param: AudioParam, t: number, from: number, to: number, dur: number, then?: [number, number]): void {
  param.setValueAtTime(from, t)
  param.exponentialRampToValueAtTime(to, t + dur)
  if (then) param.exponentialRampToValueAtTime(then[0], t + dur + then[1])
}

function shape(s: Synth, curve: Float32Array<ArrayBuffer>, dest: AudioNode): WaveShaperNode {
  const w = s.ctx.createWaveShaper()
  w.curve = curve
  w.oversample = '2x'
  w.connect(dest)
  return w
}

/** Chain nodes left to right, return the first. */
export function chain(...nodes: AudioNode[]): AudioNode {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1])
  return nodes[0]
}

/** Sparse random clicks of filtered noise (fire crackle, debris, sparks). */
function crackle(
  s: Synth,
  dest: AudioNode,
  t: number,
  dur: number,
  count: number,
  peak: number,
  freq = 2500,
  type: BiquadFilterType = 'highpass',
  fade = true,
): void {
  const src = noise(s, s.white, t, t + dur + 0.05)
  const f = filt(s, type, freq, type === 'bandpass' ? 1.2 : 0.7)
  const g = s.ctx.createGain()
  g.gain.setValueAtTime(0, t)
  const times: number[] = []
  for (let i = 0; i < count; i++) times.push(rnd(0, dur))
  times.sort((a, b) => a - b)
  let prevEnd = -1
  for (const off of times) {
    const at = t + Math.max(off, prevEnd + 0.004)
    const len = rnd(0.003, 0.014)
    const a = peak * rnd(0.3, 1) * (fade ? 1 - (0.7 * off) / dur : 1)
    g.gain.setValueAtTime(a, at)
    g.gain.exponentialRampToValueAtTime(EPS, at + len)
    g.gain.setValueAtTime(0, at + len + 0.0005)
    prevEnd = at + len + 0.001 - t
  }
  chain(src, f, g, dest)
}

/** Decaying sine thump with a pitch drop (kicks, impacts, booms). */
export function thump(s: Synth, dest: AudioNode, t: number, f0: number, f1: number, glide: number, peak: number, decay: number): void {
  const o = osc(s, 'sine', f0, f1, t, glide, t + decay + 0.05)
  o.connect(env(s, dest, t, 0.002, peak, decay))
}

/** Bell / chime: a few inharmonic sine partials. */
export function bell(s: Synth, dest: AudioNode, t: number, f: number, peak: number, decay: number): void {
  const partials: [number, number][] = [
    [1, 1],
    [2.01, 0.45],
    [2.76, 0.25],
    [5.4, 0.08],
  ]
  for (const [m, a] of partials) {
    const o = osc(s, 'sine', f * m, f * m, t, 0, t + decay + 0.05)
    o.connect(env(s, dest, t, 0.002, peak * a, decay / Math.sqrt(m)))
  }
}

// ---------------------------------------------------------------------------
// SFX
// ---------------------------------------------------------------------------

const fireballCast: Recipe = (s, out, t) => {
  const r = rnd(0.9, 1.1)
  const n = noise(s, s.pink, t, t + 0.5)
  const bp = filt(s, 'bandpass', 400, 1.4)
  sweep(bp.frequency, t, 350 * r, 2600 * r, 0.11, [800 * r, 0.3])
  chain(n, bp, env(s, out, t, 0.012, 0.55, 0.38))
  const body = osc(s, 'sawtooth', 100 * r, 52 * r, t, 0.28, t + 0.4)
  chain(body, filt(s, 'lowpass', 650, 1), env(s, out, t, 0.008, 0.22, 0.3))
  crackle(s, out, t + 0.04, 0.38, 8, 0.32, 2300)
  return 0.5
}

/** p = size (1 = fireball, larger = obstacle blast) */
const explosion: Recipe = (s, out, t, p) => {
  const k = p > 0 ? p : 1
  const r = rnd(0.9, 1.08) / Math.sqrt(k)
  // crack transient
  chain(noise(s, s.white, t, t + 0.1), filt(s, 'highpass', 1500), env(s, out, t, 0.001, 0.55, 0.06))
  // body: noise through a closing lowpass, slightly driven
  const lp = filt(s, 'lowpass', 6000, 0.9)
  sweep(lp.frequency, t, 6500, 280, 0.45 * k)
  const drive = shape(s, s.soft, out)
  chain(noise(s, s.white, t, t + 0.9 * k), lp, env(s, drive, t, 0.003, 0.8, 0.55 * k))
  // low thump
  thump(s, out, t, 150 * r, 40 * r, 0.2, 1.0, 0.38 * k)
  // embers
  crackle(s, out, t + 0.08, 0.65 * k, Math.round(10 * k), 0.24, 3000)
  return 0.95 * k
}

const fizzle: Recipe = (s, out, t) => {
  const lp = filt(s, 'lowpass', 2500, 0.8)
  sweep(lp.frequency, t, 2600, 380, 0.2)
  chain(noise(s, s.pink, t, t + 0.3), lp, env(s, out, t, 0.004, 0.35, 0.2))
  thump(s, out, t, 230, 90, 0.1, 0.28, 0.12)
  crackle(s, out, t + 0.02, 0.2, 4, 0.18, 3200)
  return 0.35
}

/** p = knockback intensity, ~0.2 (graze) .. 1 (strong) .. 1.6 (huge) */
const hit: Recipe = (s, out, t, p) => {
  const k = Math.min(1.6, Math.max(0.2, p || 0.6))
  const r = rnd(0.92, 1.08)
  chain(noise(s, s.white, t, t + 0.12), filt(s, 'bandpass', 1600 * r, 0.9), env(s, out, t, 0.001, 0.45 + 0.2 * Math.min(k, 1), 0.07))
  thump(s, out, t, (125 - 25 * Math.min(k, 1.5)) * r, 38, 0.16, 0.9 * Math.min(1, 0.45 + 0.55 * k), 0.2 + 0.15 * k)
  osc(s, 'triangle', 260 * r, 110 * r, t, 0.09, t + 0.2).connect(env(s, out, t, 0.002, 0.22, 0.12))
  if (k > 0.85) {
    const big = k - 0.6
    thump(s, shape(s, s.soft, out), t, 62, 30, 0.35, 0.55 * big, 0.45)
    chain(noise(s, s.brown, t, t + 0.4), filt(s, 'lowpass', 420), env(s, out, t, 0.004, 0.35 * big, 0.3))
  }
  return 0.25 + 0.3 * k
}

/** p = windup seconds */
const scourgeWindup: Recipe = (s, out, t, p) => {
  const d = Math.max(0.2, p || 0.9)
  const r = rnd(0.95, 1.05)
  const main = s.ctx.createGain()
  main.gain.setValueAtTime(0.02, t)
  main.gain.linearRampToValueAtTime(0.26, t + d)
  main.gain.exponentialRampToValueAtTime(EPS, t + d + 0.07)
  main.connect(out)
  const lp = filt(s, 'lowpass', 180, 7)
  sweep(lp.frequency, t, 180, 3800, d)
  lp.connect(main)
  for (const det of [1, 1.0047]) osc(s, 'sawtooth', 65 * r * det, 260 * r * det, t, d, t + d + 0.1).connect(lp)
  // pulsing tremolo that speeds up as the charge builds
  const lfo = osc(s, 'sine', 7, 26, t, d, t + d + 0.1)
  const depth = s.ctx.createGain()
  depth.gain.value = 0.11
  lfo.connect(depth)
  depth.connect(main.gain)
  // rising shimmer
  const bp = filt(s, 'bandpass', 600, 3)
  sweep(bp.frequency, t, 600, 7000, d)
  const sg = s.ctx.createGain()
  sg.gain.setValueAtTime(EPS, t)
  sg.gain.linearRampToValueAtTime(0.16, t + d)
  sg.gain.exponentialRampToValueAtTime(EPS, t + d + 0.05)
  chain(noise(s, s.white, t, t + d + 0.1), bp, sg, out)
  return d + 0.1
}

const scourgeBlast: Recipe = (s, out, t) => {
  chain(noise(s, s.white, t, t + 0.12), filt(s, 'highpass', 1200), env(s, out, t, 0.001, 0.6, 0.08))
  const lp = filt(s, 'lowpass', 7000, 1)
  sweep(lp.frequency, t, 7000, 320, 0.5)
  chain(noise(s, s.white, t, t + 0.8), lp, env(s, shape(s, s.hard, out), t, 0.002, 0.55, 0.6))
  thump(s, out, t, 110, 32, 0.4, 1.0, 0.6)
  for (const f of [330, 498, 741]) osc(s, 'sine', f, f * 0.97, t, 0.9, t + 1).connect(env(s, out, t, 0.005, 0.07, 0.9))
  const bp = filt(s, 'bandpass', 2000, 1.5)
  sweep(bp.frequency, t, 2200, 300, 0.5)
  chain(noise(s, s.pink, t, t + 0.6), bp, env(s, out, t, 0.01, 0.28, 0.45))
  return 1.0
}

const teleportOut: Recipe = (s, out, t) => {
  const r = rnd(0.94, 1.06)
  const carrier = osc(s, 'sine', 2400 * r, 180 * r, t, 0.16, t + 0.3)
  const mod = osc(s, 'sine', 75, 75, t, 0, t + 0.3)
  const depth = s.ctx.createGain()
  depth.gain.value = 900
  mod.connect(depth)
  depth.connect(carrier.frequency)
  carrier.connect(env(s, out, t, 0.002, 0.28, 0.2))
  const bp = filt(s, 'bandpass', 8000, 2)
  sweep(bp.frequency, t, 8000, 900, 0.18)
  chain(noise(s, s.white, t, t + 0.3), bp, env(s, out, t, 0.01, 0.3, 0.2))
  return 0.3
}

const teleportIn: Recipe = (s, out, t) => {
  const r = rnd(0.94, 1.06)
  osc(s, 'sine', 280 * r, 2200 * r, t, 0.1, t + 0.35).connect(env(s, out, t, 0.003, 0.24, 0.22))
  osc(s, 'triangle', 140 * r, 1100 * r, t, 0.1, t + 0.35).connect(env(s, out, t, 0.003, 0.12, 0.2))
  chain(noise(s, s.white, t, t + 0.2), filt(s, 'highpass', 6000), env(s, out, t, 0.001, 0.18, 0.12))
  crackle(s, out, t, 0.18, 4, 0.2, 5000)
  thump(s, out, t, 180, 70, 0.08, 0.35, 0.1)
  return 0.35
}

const lavaSizzle: Recipe = (s, out, t) => {
  chain(
    noise(s, s.white, t, t + 0.3),
    filt(s, 'highpass', 2800),
    filt(s, 'bandpass', rnd(5500, 7500), 0.8),
    env(s, out, t, 0.01, 0.22, 0.24),
  )
  crackle(s, out, t, 0.22, 5, 0.28, 3500)
  const b = t + rnd(0, 0.12)
  thump(s, out, b, rnd(120, 160), 70, 0.07, 0.12, 0.08)
  return 0.3
}

const death: Recipe = (s, out, t) => {
  thump(s, shape(s, s.soft, out), t, 75, 24, 1.0, 1.0, 1.3)
  const lp = filt(s, 'lowpass', 1500, 0.8)
  sweep(lp.frequency, t, 1500, 140, 1.4)
  chain(noise(s, s.brown, t, t + 1.7), lp, env(s, out, t, 0.01, 0.75, 1.5))
  chain(noise(s, s.white, t, t + 0.2), filt(s, 'highpass', 900), env(s, out, t, 0.001, 0.55, 0.12))
  chain(noise(s, s.white, t, t + 1.6), filt(s, 'highpass', 3000), env(s, out, t, 0.15, 0.1, 1.2))
  crackle(s, out, t + 0.1, 1.3, 14, 0.2, 3000)
  return 1.7
}

const obstacleBreak: Recipe = (s, out, t) => {
  chain(noise(s, s.brown, t, t + 0.5), filt(s, 'bandpass', 700, 1), env(s, out, t, 0.002, 0.8, 0.35))
  crackle(s, out, t, 0.5, 12, 0.35, 1200)
  thump(s, out, t, 110, 45, 0.2, 0.7, 0.3)
  return 0.8
}

const shrinkRumble: Recipe = (s, out, t) => {
  chain(noise(s, s.brown, t, t + 2.6), filt(s, 'lowpass', 180, 0.5), env(s, out, t, 0.35, 0.75, 1.6, 0.6))
  const sub = osc(s, 'sine', 36, 36, t, 0, t + 2.6)
  const vib = osc(s, 'sine', 4, 4, t, 0, t + 2.6)
  const vd = s.ctx.createGain()
  vd.gain.value = 3
  vib.connect(vd)
  vd.connect(sub.frequency)
  sub.connect(env(s, out, t, 0.3, 0.5, 1.5, 0.5))
  crackle(s, out, t + 0.2, 1.8, 16, 0.3, 500, 'bandpass', false)
  const groan = osc(s, 'sawtooth', 55, 41, t, 2, t + 2.5)
  chain(groan, filt(s, 'lowpass', 220), env(s, out, t, 0.4, 0.12, 1.8))
  return 2.6
}

/** Round start: a low horn chord plus an impact. */
const roundStart: Recipe = (s, out, t) => {
  const lp = filt(s, 'lowpass', 250, 2)
  lp.frequency.setValueAtTime(250, t)
  lp.frequency.exponentialRampToValueAtTime(2200, t + 0.25)
  lp.frequency.exponentialRampToValueAtTime(900, t + 1.6)
  const g = env(s, out, t, 0.06, 0.16, 1.0, 0.45)
  lp.connect(g)
  for (const f of [110, 164.81, 220]) {
    for (const det of [0.9965, 1.0035]) osc(s, 'sawtooth', f * det, f * det, t, 0, t + 1.7).connect(lp)
  }
  chain(noise(s, s.white, t, t + 0.1), filt(s, 'highpass', 1500), env(s, out, t, 0.001, 0.5, 0.07))
  thump(s, out, t, 140, 38, 0.25, 0.85, 0.45)
  thump(s, out, t, 55, 40, 1.2, 0.45, 1.2)
  return 1.8
}

/** p = 1 win, 0 draw */
const roundWin: Recipe = (s, out, t, p) => {
  const notes = p > 0 ? [220, 277.18, 329.63, 440] : [220, 261.63, 311.13, 415.3]
  notes.forEach((f, i) => {
    const at = t + i * 0.07
    osc(s, 'triangle', f, f, at, 0, at + 1.4).connect(env(s, out, at, 0.01, 0.13, 1.2))
    bell(s, out, at, f * 2, 0.05, 1.0)
  })
  chain(osc(s, 'sawtooth', 110, 110, t, 0, t + 1.8), filt(s, 'lowpass', 400), env(s, out, t, 0.05, 0.08, 1.5))
  return 1.8
}

const gameOver: Recipe = (s, out, t) => {
  const lp = filt(s, 'lowpass', 300, 1.5)
  lp.frequency.setValueAtTime(300, t)
  lp.frequency.exponentialRampToValueAtTime(2600, t + 0.6)
  lp.frequency.exponentialRampToValueAtTime(700, t + 2.8)
  lp.connect(env(s, out, t, 0.1, 0.13, 1.8, 0.8))
  for (const f of [110, 164.81, 220, 277.18, 329.63]) {
    for (const det of [0.997, 1.003]) osc(s, 'sawtooth', f * det, f * det, t, 0, t + 2.9).connect(lp)
  }
  ;[440, 554.37, 659.25, 880].forEach((f, i) => bell(s, out, t + 0.3 + i * 0.12, f, 0.06, 1.6))
  thump(s, out, t, 120, 36, 0.3, 0.8, 0.6)
  return 3
}

const castGeneric: Recipe = (s, out, t) => {
  const bp = filt(s, 'bandpass', 900, 1.2)
  sweep(bp.frequency, t, 500, 2200, 0.12, [900, 0.2])
  chain(noise(s, s.pink, t, t + 0.35), bp, env(s, out, t, 0.01, 0.35, 0.25))
  return 0.35
}

const impact: Recipe = (s, out, t) => {
  chain(noise(s, s.white, t, t + 0.2), filt(s, 'bandpass', 1200, 1), env(s, out, t, 0.001, 0.45, 0.12))
  thump(s, out, t, 160, 60, 0.12, 0.5, 0.18)
  return 0.3
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const uiHover: Recipe = (s, out, t) => {
  osc(s, 'sine', 2200, 2600, t, 0.02, t + 0.06).connect(env(s, out, t, 0.002, 0.05, 0.04))
  return 0.06
}

const uiClick: Recipe = (s, out, t) => {
  osc(s, 'sine', 900, 420, t, 0.04, t + 0.1).connect(env(s, out, t, 0.001, 0.25, 0.06))
  chain(noise(s, s.white, t, t + 0.05), filt(s, 'bandpass', 3500, 1), env(s, out, t, 0.001, 0.12, 0.02))
  return 0.1
}

const uiBack: Recipe = (s, out, t) => {
  osc(s, 'triangle', 660, 440, t, 0.08, t + 0.2).connect(env(s, out, t, 0.002, 0.2, 0.12))
  osc(s, 'triangle', 330, 330, t + 0.06, 0, t + 0.25).connect(env(s, out, t + 0.06, 0.002, 0.12, 0.12))
  return 0.25
}

const uiBuy: Recipe = (s, out, t) => {
  bell(s, out, t, 1318.5, 0.16, 0.5)
  bell(s, out, t + 0.075, 1975.5, 0.16, 0.6)
  chain(noise(s, s.white, t, t + 0.12), filt(s, 'highpass', 7000), env(s, out, t, 0.002, 0.05, 0.08))
  return 0.7
}

const uiError: Recipe = (s, out, t) => {
  const lp = filt(s, 'lowpass', 1100)
  lp.connect(out)
  for (const at of [t, t + 0.12]) osc(s, 'square', 155, 150, at, 0.09, at + 0.12).connect(env(s, lp, at, 0.003, 0.14, 0.09))
  return 0.3
}

const uiReady: Recipe = (s, out, t) => {
  ;[523.25, 659.25, 783.99].forEach((f, i) => {
    const at = t + i * 0.06
    osc(s, 'triangle', f, f, at, 0, at + 0.4).connect(env(s, out, at, 0.003, 0.16, 0.35))
  })
  return 0.55
}

const uiCountdown: Recipe = (s, out, t) => {
  osc(s, 'sine', 880, 880, t, 0, t + 0.2).connect(env(s, out, t, 0.002, 0.3, 0.16))
  osc(s, 'triangle', 1760, 1760, t, 0, t + 0.12).connect(env(s, out, t, 0.002, 0.08, 0.08))
  return 0.2
}

export const RECIPES = {
  fireballCast,
  explosion,
  fizzle,
  hit,
  scourgeWindup,
  scourgeBlast,
  teleportOut,
  teleportIn,
  lavaSizzle,
  death,
  obstacleBreak,
  shrinkRumble,
  roundStart,
  roundWin,
  gameOver,
  castGeneric,
  impact,
  uiHover,
  uiClick,
  uiBack,
  uiBuy,
  uiError,
  uiReady,
  uiCountdown,
} satisfies Record<string, Recipe>

export type SfxId = keyof typeof RECIPES
