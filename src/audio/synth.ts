/**
 * Procedural SFX. No asset files: every sound is layered from shared noise banks,
 * oscillators, filters, saturation and envelopes, built fresh per voice.
 *
 * Design rules (techniques borrowed from the user's pit-of-carnage engine):
 * - impacts = click (a few ms of bright noise that makes the blow land) + body (shaped
 *   noise in the mids, a small saturated pitch-dropping tone) + tail (a short dark rumble);
 * - metal (reflects, chains, tinks) = an FM strike whose index falls fast, modal partials
 *   for the ring, narrow resonant noise for the shimmer;
 * - fire, sizzle and debris use a pre-rendered crackle bank, whooshes swell band and level
 *   together;
 * - a band of noise carries far less energy than a sine at the same gain, so noise layers
 *   run hot and low sine bodies stay small and saturated: hits still read on laptop
 *   speakers that cannot play 60 Hz;
 * - every layer varies a little per trigger (band, level, decay, a few ms of timing), so the
 *   hundredth fireball is not the first one again.
 *
 * Runs on any BaseAudioContext (live, offline for level checks, or the test mock).
 */

export type NoiseKind = 'white' | 'pink' | 'brown' | 'crackle'

export interface Synth {
  ctx: BaseAudioContext
  banks: Record<NoiseKind, AudioBuffer>
  /** tanh saturation curve */
  drive: Float32Array<ArrayBuffer>
}

type Dest = AudioNode | AudioParam

// ---------------------------------------------------------------------------
// Banks, rendered once per context
// ---------------------------------------------------------------------------

function normalize(d: Float32Array, peak: number): void {
  let m = 0
  for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]))
  if (m > 0) for (let i = 0; i < d.length; i++) d[i] = (d[i] / m) * peak
}

/** Blend the end into the start so a looping source has no click at the wrap. Returns the new length. */
function crossfadeLoop(d: Float32Array, n: number): number {
  const len = d.length - n
  for (let i = 0; i < n; i++) {
    const a = i / n
    d[i] = d[i] * a + d[len + i] * (1 - a)
  }
  return len
}

function bank(ctx: BaseAudioContext, seconds: number, fill: (d: Float32Array) => void, loop: boolean): AudioBuffer {
  const sr = ctx.sampleRate
  const raw = new Float32Array(Math.floor(sr * seconds))
  fill(raw)
  const len = loop ? crossfadeLoop(raw, Math.floor(sr * 0.05)) : raw.length
  const data = raw.subarray(0, len)
  normalize(data, 0.9)
  const b = ctx.createBuffer(1, len, sr)
  b.getChannelData(0).set(data)
  return b
}

export function createSynth(ctx: BaseAudioContext): Synth {
  const sr = ctx.sampleRate
  const white = bank(ctx, 2, (d) => {
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  }, false)
  const pink = bank(ctx, 3, (d) => {
    // Paul Kellet's economy pink filter
    let b0 = 0
    let b1 = 0
    let b2 = 0
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1
      b0 = 0.99765 * b0 + w * 0.099046
      b1 = 0.963 * b1 + w * 0.2965164
      b2 = 0.57 * b2 + w * 1.0526913
      d[i] = b0 + b1 + b2 + w * 0.1848
    }
  }, true)
  const brown = bank(ctx, 3, (d) => {
    let last = 0
    for (let i = 0; i < d.length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02
      d[i] = last
    }
  }, true)
  // sparse random pops with their own short decay: fire, sizzle, sparks, debris
  const crackle = bank(ctx, 3, (d) => {
    const rate = 30 / sr
    for (let i = 0; i < d.length; i++) {
      if (Math.random() >= rate) continue
      const amp = 0.15 + 0.85 * Math.pow(Math.random(), 3)
      const len = Math.floor(sr * (0.0006 + Math.random() * 0.006))
      for (let k = 0; k < len && i + k < d.length; k++) d[i + k] += (Math.random() * 2 - 1) * amp * Math.exp((-5 * k) / len)
    }
  }, true)
  const n = 1024
  const drive = new Float32Array(new ArrayBuffer(n * 4))
  const norm = Math.tanh(2.2)
  for (let i = 0; i < n; i++) drive[i] = Math.tanh(2.2 * ((i / (n - 1)) * 2 - 1)) / norm
  return { ctx, banks: { white, pink, brown, crackle }, drive }
}

// ---------------------------------------------------------------------------
// Voice builder
// ---------------------------------------------------------------------------

function connect(node: AudioNode, dest: Dest): void {
  // duck-typed: AudioParam has no connect(); avoids needing the AudioNode global (tests)
  if (typeof (dest as AudioNode).connect === 'function') node.connect(dest as AudioNode)
  else node.connect(dest as AudioParam)
}

/**
 * One voice's node graph. Times are seconds after the voice start. Records the latest stop
 * (the voice length) and every buffer source (the engine bends their rate for Doppler).
 */
export class Voice {
  stopAt: number
  readonly buffers: { node: AudioBufferSourceNode; speed: number }[] = []

  constructor(
    readonly s: Synth,
    readonly out: AudioNode,
    readonly t0: number,
    /** scale of per-trigger variation (0 = identical every time) */
    readonly jitter = 1,
  ) {
    this.stopAt = t0
  }

  get ctx(): BaseAudioContext {
    return this.s.ctx
  }

  rand(): number {
    return Math.random()
  }

  /** 1 +- spread */
  vary(spread: number): number {
    return 1 + (Math.random() * 2 - 1) * spread * this.jitter
  }

  /** later layers drift late by up to `max` s: loose, physical timing */
  nudge(sec: number, max: number): number {
    return sec > 0 ? sec + Math.random() * max * this.jitter : sec
  }

  at(sec: number): number {
    return this.t0 + Math.max(0, sec)
  }

  private stop(src: AudioScheduledSourceNode, sec: number): void {
    const end = this.at(sec)
    src.stop(end)
    if (end > this.stopAt) this.stopAt = end
  }

  noise(kind: NoiseKind, sec: number, dur: number, dest: Dest, speed = 1): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource()
    const buf = this.s.banks[kind]
    src.buffer = buf
    src.loop = true
    src.playbackRate.value = speed
    connect(src, dest)
    src.start(this.at(sec), Math.random() * buf.duration * 0.9)
    this.stop(src, sec + dur)
    this.buffers.push({ node: src, speed })
    return src
  }

  osc(type: OscillatorType, hz: number, sec: number, dur: number, dest: Dest, detune = 0): OscillatorNode {
    const o = this.ctx.createOscillator()
    o.type = type
    o.frequency.value = hz
    o.detune.value = detune
    connect(o, dest)
    o.start(this.at(sec))
    this.stop(o, sec + dur)
    return o
  }

  filter(type: BiquadFilterType, hz: number, q: number, dest: Dest): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = Math.min(hz, this.ctx.sampleRate * 0.45)
    f.Q.value = q
    connect(f, dest)
    return f
  }

  gain(value: number, dest: Dest): GainNode {
    const g = this.ctx.createGain()
    g.gain.value = value
    connect(g, dest)
    return g
  }

  /** Saturation stage: `amount` drives into the curve, `level` sets the output. Returns its input. */
  drive(dest: Dest, amount = 1, level = 1): AudioNode {
    const pre = this.ctx.createGain()
    pre.gain.value = amount
    const ws = this.ctx.createWaveShaper()
    ws.curve = this.s.drive
    ws.oversample = '2x'
    pre.connect(ws)
    connect(ws, this.gain(level, dest))
    return pre
  }

  /** linear rise to peak, exponential fall to -60 dB over decay */
  ad(param: AudioParam, sec: number, attack: number, peak: number, decay: number): void {
    if (!(peak > 0)) return
    param.setValueAtTime(0, this.at(sec))
    param.linearRampToValueAtTime(peak, this.at(sec + attack))
    param.exponentialRampToValueAtTime(peak * 1e-3, this.at(sec + attack + decay))
  }

  /** rise, hold, exponential release */
  ahr(param: AudioParam, sec: number, attack: number, peak: number, hold: number, release: number): void {
    if (!(peak > 0)) return
    param.setValueAtTime(0, this.at(sec))
    param.linearRampToValueAtTime(peak, this.at(sec + attack))
    param.setValueAtTime(peak, this.at(sec + attack + hold))
    param.exponentialRampToValueAtTime(peak * 1e-3, this.at(sec + attack + hold + release))
  }

  /** exponential glide of a frequency param */
  glide(param: AudioParam, sec: number, from: number, to: number, dur: number): void {
    const nyq = this.ctx.sampleRate * 0.45
    param.setValueAtTime(Math.min(from, nyq), this.at(sec))
    param.exponentialRampToValueAtTime(Math.min(to, nyq), this.at(sec + dur))
  }

  /** exponential path through [sec, hz] points */
  path(param: AudioParam, points: readonly (readonly [number, number])[]): void {
    const nyq = this.ctx.sampleRate * 0.45
    param.setValueAtTime(Math.min(points[0][1], nyq), this.at(points[0][0]))
    for (let i = 1; i < points.length; i++) param.exponentialRampToValueAtTime(Math.min(points[i][1], nyq), this.at(points[i][0]))
  }
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

interface BurstOpts {
  at?: number
  noise?: NoiseKind
  type?: BiquadFilterType
  freq: number
  /** glide the filter here over the burst */
  to?: number
  q?: number
  attack?: number
  decay: number
  gain: number
  speed?: number
  dest?: Dest
}

/** Filtered noise burst: transients, smacks, hiss, crunch, fire. */
function burst(v: Voice, o: BurstOpts): void {
  const at = v.nudge(o.at ?? 0, 0.004)
  const attack = o.attack ?? 0.002
  const k = v.vary(0.06)
  const decay = o.decay * v.vary(0.1)
  const g = v.gain(0, o.dest ?? v.out)
  const f = v.filter(o.type ?? 'bandpass', o.freq * k, o.q ?? 1, g)
  if (o.to !== undefined) v.glide(f.frequency, at, o.freq * k, o.to * k, attack + decay)
  v.noise(o.noise ?? 'white', at, attack + decay + 0.02, f, (o.speed ?? 1) * v.vary(0.04))
  v.ad(g.gain, at, attack, o.gain * v.vary(0.12), decay)
}

/** Pitch-dropping tone: the body of a thud, a kick, a boom. */
function thump(v: Voice, at: number, from: number, to: number, dur: number, gain: number, dest: Dest = v.out, type: OscillatorType = 'sine'): void {
  const t = v.nudge(at, 0.003)
  const k = v.vary(0.05)
  const d = dur * v.vary(0.08)
  const g = v.gain(0, dest)
  const o = v.osc(type, from * k, t, d + 0.02, g)
  v.glide(o.frequency, t, from * k, to * k, d)
  v.ad(g.gain, t, 0.002, gain * v.vary(0.1), d)
}

/** Inharmonic partials with their own decays (modal synthesis): metal, bells, coins. */
function ring(v: Voice, at: number, base: number, ratios: readonly number[], decays: readonly number[], gain: number, dest: Dest = v.out): void {
  const b = base * v.vary(0.015)
  for (let i = 0; i < ratios.length; i++) {
    const d = (decays[i] ?? decays[decays.length - 1]) * v.vary(0.12)
    const g = v.gain(0, dest)
    v.osc('sine', b * ratios[i], at, d + 0.03, g)
    v.ad(g.gain, at, 0.001, (gain / (1 + i * 0.6)) * v.vary(0.1), d)
  }
}

/** Air rushing past: band and level swell together to the peak, then fall away. */
function whoosh(v: Voice, at: number, dur: number, from: number, peak: number, q: number, gain: number, noise: NoiseKind = 'white', dest: Dest = v.out): void {
  const len = dur * v.vary(0.06)
  const top = peak * v.vary(0.08)
  const g = v.gain(0, dest)
  const f = v.filter('bandpass', from, q, g)
  f.frequency.setValueAtTime(from, v.at(at))
  f.frequency.exponentialRampToValueAtTime(top, v.at(at + len * 0.55))
  f.frequency.exponentialRampToValueAtTime(from * 0.8, v.at(at + len))
  v.noise(noise, at, len + 0.02, f)
  g.gain.setValueAtTime(0, v.at(at))
  g.gain.linearRampToValueAtTime(gain, v.at(at + len * 0.55))
  g.gain.exponentialRampToValueAtTime(gain * 1e-3, v.at(at + len))
}

/** A gain stage wobbled by an LFO. Returns its input; `lfo` lets callers glide the rate. */
function tremolo(v: Voice, at: number, dur: number, hz: number, depth: number, dest: Dest, type: OscillatorType = 'sine'): GainNode & { lfo?: OscillatorNode } {
  const g = v.gain(1 - depth / 2, dest) as GainNode & { lfo?: OscillatorNode }
  const lfoG = v.gain(depth / 2, g.gain)
  g.lfo = v.osc(type, hz, at, dur, lfoG)
  return g
}

/** FM bell: a bright metallic attack settling into a pure tone. */
function fmBell(v: Voice, at: number, freq: number, ratio: number, index: number, dur: number, gain: number, dest: Dest = v.out): void {
  const idx = index * v.vary(0.15)
  const g = v.gain(0, dest)
  const car = v.osc('sine', freq, at, dur + 0.03, g)
  const modG = v.gain(0, car.frequency)
  v.osc('sine', freq * ratio, at, dur + 0.03, modG)
  modG.gain.setValueAtTime(freq * idx, v.at(at))
  modG.gain.exponentialRampToValueAtTime(freq * idx * 0.04, v.at(at + dur * 0.6))
  v.ad(g.gain, at, 0.002, gain * v.vary(0.08), dur)
}

/** The very front of a blow: a few ms of bright noise. */
function click(v: Voice, at: number, gain: number, hz = 3500, dest: Dest = v.out): void {
  burst(v, { at, type: 'highpass', freq: hz, attack: 0.0004, decay: 0.006, gain, dest })
}

/** What rings on after a blow: a short dark rumble. */
function tail(v: Voice, at: number, dur: number, hz: number, gain: number, dest: Dest = v.out): void {
  burst(v, { at, noise: 'brown', type: 'lowpass', freq: hz, q: 1.1, attack: 0.006, decay: dur, gain, dest })
}

interface ClangOpts {
  ratio?: number
  index?: number
  partials?: readonly number[]
  dest?: Dest
}

/** Struck metal: falling-index FM strike, modal ring, resonant noise shimmer. */
function clang(v: Voice, at: number, base: number, dur: number, gain: number, o: ClangOpts = {}): void {
  const dest = o.dest ?? v.out
  const b = base * v.vary(0.02)
  const index = (o.index ?? 3) * v.vary(0.15)
  const g = v.gain(0, dest)
  const car = v.osc('sine', b, at, dur + 0.03, g)
  const modG = v.gain(0, car.frequency)
  v.osc('sine', b * (o.ratio ?? 1.41), at, dur + 0.03, modG)
  modG.gain.setValueAtTime(b * index, v.at(at))
  modG.gain.exponentialRampToValueAtTime(b * index * 0.02, v.at(at + Math.min(0.15, dur * 0.4)))
  v.ad(g.gain, at, 0.0008, gain * 0.6, dur * 0.7)
  const partials = o.partials ?? [1, 2.76, 5.4, 8.93]
  ring(v, at, b, partials, partials.map((_, i) => dur * Math.pow(0.68, i)), gain * 0.7, dest)
  for (const r of [2.03, 3.9]) burst(v, { at, freq: b * r, q: 26, attack: 0.001, decay: dur * 0.5, gain: gain * 3, dest })
}

/** Bubbles: short sine plops with a rising pitch (a bubble's resonance as it opens). */
function plops(v: Voice, at: number, span: number, count: number, gain: number): void {
  for (let i = 0; i < count; i++) {
    const t = at + v.rand() * span
    const f = 260 + v.rand() * 520
    const g = v.gain(0, v.out)
    const o = v.osc('sine', f, t, 0.07, g)
    v.glide(o.frequency, t, f, f * 2.2, 0.05)
    v.ad(g.gain, t, 0.003, gain * (0.5 + v.rand()), 0.05)
  }
}

/** Detuned saw chord through an opening-then-closing resonant lowpass (horns, stings). */
function brass(v: Voice, at: number, notes: readonly number[], dur: number, gain: number, open: readonly (readonly [number, number])[]): void {
  const env = v.gain(0, v.out)
  const drv = v.drive(env, 1.6, 0.8)
  const lp = v.filter('lowpass', open[0][1], 1.8, drv)
  v.path(lp.frequency, open.map(([s, hz]) => [at + s, hz] as const))
  const each = v.gain(0.5 / Math.sqrt(notes.length * 2), lp)
  for (const n of notes) for (const cents of [-9, 9]) v.osc('sawtooth', n, at, dur + 0.05, each, cents)
  v.ahr(env.gain, at, 0.01, gain, dur * 0.35, dur * 0.6)
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

// ---------------------------------------------------------------------------
// Recipes. p = per-sound parameter (see each comment).
// ---------------------------------------------------------------------------

export type Recipe = (v: Voice, p: number) => void

/**
 * Fireball leaves the hand: an airy rush over a flame body, crackle, a saturated fwump.
 * p = size (1 Fireball, ~0.6 the Cluster fan: shorter and brighter)
 */
const fireballCast: Recipe = (v, p) => {
  const k = clamp(p || 1, 0.4, 1.5)
  const r = 1 / Math.sqrt(k)
  click(v, 0, 0.25, 2500)
  whoosh(v, 0, 0.42 * k, 500 * r, 2400 * r, 1.1, 0.55)
  whoosh(v, 0.01, 0.38 * k, 180 * r, 700 * r, 0.8, 0.5 * k, 'pink')
  burst(v, { noise: 'crackle', freq: 3000, q: 0.8, attack: 0.02, decay: 0.35 * k, gain: 0.7 })
  thump(v, 0, 150 * r, 60 * r, 0.18 * k, 0.35 * k, v.drive(v.out, 2, 0.55))
}

/**
 * Fireball in flight (loop): a wobbling flame roar with crackle and a low rumble.
 * p = flight seconds. The engine pans it along the flight and bends its rate (Doppler).
 */
const fireballTravel: Recipe = (v, p) => {
  const dur = clamp(p || 1, 0.15, 3)
  const env = v.gain(0, v.out)
  v.ahr(env.gain, 0, 0.05, 1, Math.max(0, dur - 0.13), 0.08)
  const am = tremolo(v, 0, dur, 7 + 5 * v.rand(), 0.4, env)
  v.noise('pink', 0, dur, v.filter('bandpass', 900 * v.vary(0.1), 0.9, v.gain(0.9, am)))
  v.noise('crackle', 0, dur, v.filter('highpass', 2200, 0.7, v.gain(0.45, env)))
  v.noise('brown', 0, dur, v.filter('lowpass', 420, 0.8, v.gain(0.4, env)))
}

/** p = size (1 fireball, 1.4 pillar blast) */
const explosion: Recipe = (v, p) => {
  const s = clamp(p || 1, 0.5, 1.8)
  const drv = v.drive(v.out, 2.5, 0.4)
  click(v, 0, 0.5, 2000)
  thump(v, 0, 110, 32, 0.45 + 0.3 * s, 0.45, drv)
  burst(v, { noise: 'brown', type: 'lowpass', freq: 3200, to: 160, q: 0.7, attack: 0.002, decay: 0.6 + 0.4 * s, gain: 0.3 })
  burst(v, { freq: 1500, q: 0.5, attack: 0.0005, decay: 0.04, gain: 1.2 })
  burst(v, { noise: 'pink', freq: 1400, to: 350, q: 0.8, attack: 0.003, decay: 0.35 + 0.15 * s, gain: 4 })
  burst(v, { at: 0.04, noise: 'crackle', freq: 2400, q: 0.8, attack: 0.04, decay: 0.55 + 0.3 * s, gain: 1.6 })
  tail(v, 0.02, 0.7 + 0.5 * s, 130, 0.2 + 0.1 * s)
}

/** A projectile burning out: a soft pop and embers. */
const fizzle: Recipe = (v) => {
  burst(v, { noise: 'pink', type: 'lowpass', freq: 2600, to: 380, q: 0.8, attack: 0.004, decay: 0.2, gain: 0.6 })
  burst(v, { noise: 'crackle', freq: 3200, q: 0.9, attack: 0.005, decay: 0.18, gain: 0.45 })
  thump(v, 0, 230, 90, 0.1, 0.18)
}

/** A spell landing on a warlock. p = knockback intensity, ~0.2 graze .. 1 strong .. 1.6 huge */
const hit: Recipe = (v, p) => {
  const k = clamp(p || 0.6, 0.2, 1.6)
  click(v, 0, 0.55 + 0.3 * Math.min(k, 1), 2600)
  const am = tremolo(v, 0, 0.2, 26 + 10 * v.rand(), 0.4, v.out)
  burst(v, { noise: 'pink', freq: 1600, to: 480, q: 1.3, decay: 0.07 + 0.06 * k, gain: 4.5, dest: am })
  burst(v, { at: 0.002, freq: 2300, q: 1.4, attack: 0.001, decay: 0.03, gain: 1.4 })
  thump(v, 0, 160, 55, 0.1 + 0.08 * k, 0.06 + 0.1 * k, v.drive(v.out, 1.8, 0.5))
  burst(v, { noise: 'crackle', freq: 1300, q: 0.9, attack: 0.003, decay: 0.1, gain: 1.6 * k })
  tail(v, 0.01, 0.12 + 0.2 * k, 380, 0.04 + 0.05 * k)
  if (k > 0.9) {
    // a launch: the body thrown across the arena
    thump(v, 0.005, 90, 34, 0.35, 0.15 * (k - 0.6), v.drive(v.out, 2.2, 0.5))
    whoosh(v, 0.03, 0.35, 300, 1300, 1, 0.5 * (k - 0.6), 'pink')
  }
}

/** Scourge charge: a resonant saw stack sweeping up, pulsing faster, sparks building. p = seconds */
const scourgeWindup: Recipe = (v, p) => {
  const d = clamp(p || 0.9, 0.2, 2)
  const env = v.gain(0, v.out)
  env.gain.setValueAtTime(0, v.at(0))
  env.gain.linearRampToValueAtTime(0.55, v.at(d))
  env.gain.exponentialRampToValueAtTime(0.0005, v.at(d + 0.06))
  const am = tremolo(v, 0, d + 0.08, 7, 0.5, env)
  if (am.lfo) v.glide(am.lfo.frequency, 0, 7, 28, d)
  const lp = v.filter('lowpass', 180, 8, v.drive(am, 2, 0.6))
  v.glide(lp.frequency, 0, 180, 4200, d)
  for (const cents of [-12, 0, 12]) {
    const o = v.osc('sawtooth', 65, 0, d + 0.08, lp, cents)
    v.glide(o.frequency, 0, 65 * v.vary(0.03), 260, d)
  }
  const ng = v.gain(0, v.out)
  ng.gain.setValueAtTime(0, v.at(0))
  ng.gain.linearRampToValueAtTime(0.45, v.at(d))
  ng.gain.exponentialRampToValueAtTime(0.0005, v.at(d + 0.05))
  const bp = v.filter('bandpass', 600, 3, ng)
  v.glide(bp.frequency, 0, 600, 7000, d)
  v.noise('white', 0, d + 0.08, bp)
  burst(v, { noise: 'crackle', freq: 4000, q: 1, attack: d * 0.9, decay: 0.08, gain: 0.6 })
}

/** Scourge release: blast, a dark magical clang and a shockwave rushing outward. */
const scourgeBlast: Recipe = (v) => {
  const drv = v.drive(v.out, 2.6, 0.4)
  click(v, 0, 0.6, 2200)
  thump(v, 0, 120, 30, 0.6, 0.45, drv)
  burst(v, { noise: 'brown', type: 'lowpass', freq: 4000, to: 200, q: 0.7, attack: 0.002, decay: 0.7, gain: 0.3 })
  burst(v, { noise: 'pink', freq: 1800, to: 400, q: 0.9, attack: 0.002, decay: 0.3, gain: 3 })
  burst(v, { freq: 1400, q: 0.6, attack: 0.0005, decay: 0.05, gain: 1.1 })
  clang(v, 0, 196, 0.9, 0.22, { ratio: 1.41, index: 4, partials: [1, 2.76, 5.4] })
  whoosh(v, 0.02, 0.5, 2500, 3200, 0.9, 1.2, 'pink')
  burst(v, { at: 0.03, noise: 'crackle', freq: 3000, q: 0.8, attack: 0.02, decay: 0.45, gain: 1.3 })
  tail(v, 0.02, 0.8, 150, 0.2)
}

/** Teleport out: a buzzy FM zap that drops away, with a swoosh. */
const teleportOut: Recipe = (v) => {
  click(v, 0, 0.3, 4000)
  const g = v.gain(0, v.out)
  const lp = v.filter('lowpass', 5000, 3, v.drive(g, 1.6, 0.7))
  v.glide(lp.frequency, 0, 6000, 600, 0.2)
  const car = v.osc('sawtooth', 1400 * v.vary(0.05), 0, 0.24, lp)
  v.glide(car.frequency, 0, 1400, 160, 0.18)
  v.osc('square', 63, 0, 0.24, v.gain(500, car.frequency))
  v.ad(g.gain, 0, 0.002, 0.35, 0.2)
  whoosh(v, 0, 0.22, 6000, 8000, 1.5, 0.35)
}

/** Teleport in: a rising chirp, sparkle and a small landing. */
const teleportIn: Recipe = (v) => {
  const g = v.gain(0, v.out)
  const car = v.osc('sine', 260, 0, 0.3, g)
  v.glide(car.frequency, 0, 260 * v.vary(0.05), 2200, 0.11)
  v.osc('sine', 390, 0, 0.3, v.gain(300, car.frequency))
  v.ad(g.gain, 0, 0.004, 0.3, 0.22)
  burst(v, { type: 'highpass', freq: 6000, attack: 0.002, decay: 0.12, gain: 0.35 })
  burst(v, { noise: 'crackle', freq: 5000, q: 1, attack: 0.005, decay: 0.15, gain: 0.5 })
  thump(v, 0.02, 180, 70, 0.1, 0.25)
}

/** Standing in lava (local pawn, rate-limited): hiss, crackle, steam and a bubble or two. */
const lavaSizzle: Recipe = (v) => {
  burst(v, { type: 'highpass', freq: 4200, attack: 0.008, decay: 0.26, gain: 0.4 })
  burst(v, { noise: 'crackle', freq: 2600, q: 0.9, attack: 0.004, decay: 0.24, gain: 0.7 })
  burst(v, { noise: 'pink', freq: 1300, q: 2, attack: 0.02, decay: 0.14, gain: 0.6 })
  thump(v, 0, 240, 120, 0.05, 0.15)
  plops(v, 0.02, 0.2, 2, 0.08)
}

/** A warlock dies: heavy saturated boom, the lava swallowing the body, a dark sting. */
const death: Recipe = (v) => {
  const drv = v.drive(v.out, 2.6, 0.45)
  click(v, 0, 0.5, 1800)
  thump(v, 0, 100, 28, 1.0, 0.5, drv)
  burst(v, { noise: 'brown', type: 'lowpass', freq: 2600, to: 120, q: 0.7, attack: 0.002, decay: 1.3, gain: 0.35 })
  burst(v, { freq: 1300, q: 0.6, attack: 0.0005, decay: 0.05, gain: 1.2 })
  burst(v, { noise: 'pink', freq: 1100, to: 300, q: 0.8, attack: 0.003, decay: 0.5, gain: 3.5 })
  whoosh(v, 0.05, 0.9, 1500, 6000, 0.7, 0.5)
  burst(v, { at: 0.1, noise: 'crackle', freq: 2400, q: 0.8, attack: 0.08, decay: 1.3, gain: 1.4 })
  plops(v, 0.2, 1.0, 6, 0.12)
  brass(v, 0.02, [55, 58.27, 110], 0.7, 0.6, [[0, 300], [0.05, 1800], [0.7, 400]])
  tail(v, 0.03, 1.5, 140, 0.25)
}

/** A pillar breaking: stone cracking, chunks clacking down, a thud. */
const obstacleBreak: Recipe = (v) => {
  burst(v, { noise: 'crackle', freq: 1200, q: 0.9, attack: 0.001, decay: 0.2, gain: 2.8 })
  burst(v, { noise: 'pink', freq: 800, q: 1, decay: 0.15, gain: 2 })
  thump(v, 0, 110, 45, 0.25, 0.2, v.drive(v.out, 2, 0.5))
  for (let i = 0; i < 6; i++) {
    const t = 0.08 + v.rand() * 0.45
    thump(v, t, 320 + v.rand() * 300, 150, 0.05, 0.12)
    burst(v, { at: t, noise: 'pink', freq: 1500, q: 1.2, decay: 0.03, gain: 0.4 })
  }
  tail(v, 0.02, 0.4, 220, 0.25)
}

/** The arena loses a ring: a long rumble, grinding stone, a low groan. */
const shrinkRumble: Recipe = (v) => {
  const env = v.gain(0, v.out)
  v.ahr(env.gain, 0, 0.35, 0.9, 0.6, 1.5)
  v.noise('brown', 0, 2.6, v.filter('lowpass', 180, 0.5, v.gain(0.6, env)))
  const sub = v.osc('sine', 38, 0, 2.6, v.gain(0.25, env))
  v.osc('sine', 4, 0, 2.6, v.gain(3, sub.frequency))
  burst(v, { at: 0.2, noise: 'crackle', freq: 700, q: 1.2, attack: 0.4, decay: 1.4, gain: 3.5 })
  // stone grinding: a band of noise chopped by a fast wobble, audible on small speakers
  const grind = tremolo(v, 0.1, 2.2, 17, 0.7, env)
  v.noise('pink', 0.1, 2.2, v.filter('bandpass', 900, 2, v.gain(1.1, grind)))
  for (let i = 0; i < 4; i++) burst(v, { at: 0.3 + v.rand() * 1.4, noise: 'pink', freq: 500, q: 1.5, decay: 0.12, gain: 0.7 })
  const groan = v.osc('sawtooth', 55, 0, 2.5, v.filter('lowpass', 240, 2, v.gain(0.12, env)))
  v.glide(groan.frequency, 0, 55, 41, 2.2)
}

/** FIGHT: a sub drop, a blast and a crash under a power chord that opens and slams shut. */
const roundStart: Recipe = (v) => {
  click(v, 0, 0.5, 2500)
  thump(v, 0, 150, 30, 0.9, 0.9, v.drive(v.out, 2.6, 0.45))
  burst(v, { noise: 'brown', type: 'lowpass', freq: 2600, to: 160, q: 0.7, attack: 0.002, decay: 0.9, gain: 0.7 })
  burst(v, { type: 'highpass', freq: 4300, attack: 0.002, decay: 1.4, gain: 0.25 })
  clang(v, 0, 3150, 1.1, 0.06, { ratio: 1.73, index: 6, partials: [1, 1.34, 1.97, 2.71] })
  brass(v, 0, [55, 82.41, 110, 164.81, 220], 1.2, 1, [[0, 500], [0.04, 4200], [0.8, 900]])
}

/** Round won (p = 1) or drawn (p = 0): a brass swell and bells, major vs minor. */
const roundWin: Recipe = (v, p) => {
  const notes = p > 0 ? [110, 138.59, 164.81, 220] : [110, 130.81, 155.56, 207.65]
  brass(v, 0, notes, 1.4, 0.8, [[0, 300], [0.3, 2600], [1.4, 600]])
  notes.forEach((f, i) => ring(v, 0.05 + i * 0.08, f * 4, [1, 2.76, 5.4], [1.0, 0.6, 0.35], 0.06))
  thump(v, 0, 110, 50, 0.3, 0.4, v.drive(v.out, 2, 0.5))
}

/** Match over: a long horn, a gong and rising bells. */
const gameOver: Recipe = (v) => {
  brass(v, 0, [55, 82.41, 110, 138.59, 164.81], 2.8, 0.9, [[0, 260], [0.6, 2400], [2.8, 600]])
  ring(v, 0.005, 98, [1, 1.47, 2.09, 2.56, 3.18, 4.08], [3.5, 2.8, 2.2, 1.8, 1.3, 1], 0.3)
  ;[440, 554.37, 659.25, 880].forEach((f, i) => fmBell(v, 0.4 + i * 0.14, f, 3.5, 2, 1.5, 0.08))
  thump(v, 0, 120, 36, 0.6, 0.8, v.drive(v.out, 2.4, 0.6))
}

/** Any other spell leaving the hand. */
const castGeneric: Recipe = (v) => {
  click(v, 0, 0.2, 3000)
  whoosh(v, 0, 0.32, 600, 2400, 1.2, 0.5)
  burst(v, { noise: 'crackle', freq: 3500, q: 1, attack: 0.01, decay: 0.2, gain: 0.3 })
}

/** Generic projectile impact. */
const impact: Recipe = (v) => {
  click(v, 0, 0.45, 2600)
  burst(v, { noise: 'pink', freq: 1300, to: 500, q: 1.1, decay: 0.09, gain: 2.2 })
  thump(v, 0, 170, 65, 0.12, 0.2, v.drive(v.out, 1.8, 0.5))
  tail(v, 0.01, 0.2, 320, 0.08)
}

/** Cast point "inhale": a rising breath that a cancel snuffs out (fake casts read). p = seconds */
const castInhale: Recipe = (v, p) => {
  const d = clamp(p || 0.2, 0.08, 0.6)
  const g = v.gain(0, v.out)
  g.gain.setValueAtTime(0, v.at(0))
  g.gain.linearRampToValueAtTime(0.5, v.at(d))
  g.gain.exponentialRampToValueAtTime(0.0005, v.at(d + 0.05))
  const bp = v.filter('bandpass', 450, 1.6, g)
  v.glide(bp.frequency, 0, 450, 2000, d)
  v.noise('pink', 0, d + 0.06, bp)
  burst(v, { noise: 'crackle', freq: 3500, q: 1, attack: d, decay: 0.04, gain: 0.25 })
}

/** Cast cancelled: a snuffed flame, short and dry. */
const castSnuff: Recipe = (v) => {
  click(v, 0, 0.2, 3000)
  burst(v, { type: 'lowpass', freq: 3200, to: 180, q: 1.2, attack: 0.002, decay: 0.09, gain: 0.9 })
  const g = v.gain(0, v.out)
  const o = v.osc('triangle', 640, 0, 0.14, g)
  v.glide(o.frequency, 0, 640, 190, 0.08)
  v.ad(g.gain, 0, 0.002, 0.22, 0.09)
  burst(v, { noise: 'crackle', freq: 3500, q: 1, attack: 0.005, decay: 0.07, gain: 0.35 })
}

/** Lightning: crack, buzzy FM through a closing resonant filter, sparks, a thunder tail. */
const beamZap: Recipe = (v) => {
  click(v, 0, 0.8, 2200)
  const g = v.gain(0, v.out)
  const lp = v.filter('lowpass', 4000, 6, v.drive(g, 2, 0.5))
  v.glide(lp.frequency, 0, 4000, 700, 0.25)
  const car = v.osc('sawtooth', 112, 0, 0.3, lp)
  v.osc('square', 47, 0, 0.3, v.gain(75, car.frequency))
  v.ad(g.gain, 0, 0.002, 0.5, 0.27)
  burst(v, { noise: 'crackle', freq: 3000, q: 1, decay: 0.25, gain: 0.7 })
  burst(v, { type: 'highpass', freq: 7000, attack: 0.005, decay: 0.38, gain: 0.15 })
  tail(v, 0.02, 0.5, 300, 0.35)
}

/** A beam or bolt stopped by a shield: bright metallic tink. */
const tink: Recipe = (v) => {
  click(v, 0, 0.4, 5000)
  clang(v, 0, 1800, 0.35, 0.2, { ratio: 1.47, index: 2.5, partials: [1, 2.76, 5.4] })
}

/** Shield reflecting a projectile: metal ping and a reversing whoosh. p = 1 when stolen */
const reflect: Recipe = (v, p) => {
  click(v, 0, 0.35, 4000)
  clang(v, 0, 1200, 0.6, 0.22, { ratio: 1.41, index: 4 })
  whoosh(v, 0, 0.18, 600, 3200, 1.5, 0.4, 'pink')
  if (p > 0) clang(v, 0.05, 600, 0.5, 0.15, { ratio: 2.4, index: 2, partials: [1, 2.4, 4.1] })
}

/** Swap / Alteration exchange: a warbling warp. p = 1 for Alteration (glassier) */
const swapWarp: Recipe = (v, p) => {
  const g = v.gain(0, v.out)
  const o = v.osc('sine', 900, 0, 0.32, g)
  v.glide(o.frequency, 0, 900 * v.vary(0.05), 260, 0.22)
  const vib = v.osc('sine', 28, 0, 0.32, v.gain(220, o.frequency))
  v.glide(vib.frequency, 0, 28, 34, 0.22)
  v.ad(g.gain, 0, 0.004, 0.3, 0.25)
  whoosh(v, 0, 0.26, 5000, 6500, 2, 0.35)
  thump(v, 0, 160, 60, 0.12, 0.3)
  if (p > 0) fmBell(v, 0, 1568, 2.01, 1.5, 0.6, 0.1)
}

/** Melee spell contact (Thrust, Windwalk charge): rushing air into a body slam. */
const chargeSlam: Recipe = (v) => {
  whoosh(v, 0, 0.12, 400, 2600, 1.2, 0.5, 'pink')
  click(v, 0.03, 0.6, 2400)
  burst(v, { at: 0.03, noise: 'pink', freq: 1500, q: 0.8, attack: 0.001, decay: 0.06, gain: 4 })
  thump(v, 0.03, 110, 40, 0.25, 0.2, v.drive(v.out, 2.2, 0.5))
  tail(v, 0.04, 0.25, 280, 0.12)
}

/** Ricochet: a short whistle down and a metallic ping. */
const ricochet: Recipe = (v) => {
  click(v, 0, 0.3, 4000)
  const g = v.gain(0, v.out)
  const o = v.osc('sine', 2600, 0, 0.16, g)
  v.glide(o.frequency, 0, 2600 * v.vary(0.08), 1400, 0.12)
  v.ad(g.gain, 0, 0.002, 0.15, 0.13)
  clang(v, 0, 1900, 0.2, 0.12, { ratio: 1.47, index: 2, partials: [1, 2.76] })
}

/** Cooldown refreshed: a quick rising sparkle of bells. */
const refresh: Recipe = (v) => {
  ;[1046.5, 1318.5, 1568, 2093].forEach((f, i) => ring(v, i * 0.045, f, [1, 2.76, 5.4], [0.35, 0.2, 0.1], 0.1))
  burst(v, { type: 'highpass', freq: 6000, attack: 0.05, decay: 0.15, gain: 0.12 })
}

/** Combo counter tick; pitch climbs with the streak. p = streak value */
const streakTick: Recipe = (v, p) => {
  const f = 660 * Math.pow(2, clamp(p, 0, 12) / 12)
  fmBell(v, 0, f, 2, 1.2, 0.18, 0.18)
  click(v, 0, 0.15, 5000)
}

/** Deathmatch respawn: a rising shimmer that lands on a chord and a soft thump. */
const respawnSwell: Recipe = (v) => {
  whoosh(v, 0, 0.6, 800, 5000, 2, 0.4)
  for (const f of [220, 329.63, 440]) {
    const g = v.gain(0, v.out)
    v.osc('triangle', f, 0.45, 0.85, g)
    v.ad(g.gain, 0.45, 0.01, 0.08, 0.8)
  }
  thump(v, 0.48, 120, 50, 0.2, 0.35)
}

/** Shield bubble up: a swelling "wom" with a glassy edge. */
const shieldUp: Recipe = (v) => {
  const env = v.gain(0, v.out)
  v.ad(env.gain, 0, 0.04, 0.35, 0.45)
  const o = v.osc('sine', 180, 0, 0.6, tremolo(v, 0, 0.6, 14, 0.3, env))
  v.glide(o.frequency, 0, 180, 520, 0.18)
  fmBell(v, 0.02, 1046.5, 1.5, 1.2, 0.5, 0.06)
  burst(v, { freq: 6000, q: 3, attack: 0.06, decay: 0.35, gain: 0.3 })
}

/** Bubble / buff ends: a small soft pop. */
const popOff: Recipe = (v) => {
  const g = v.gain(0, v.out)
  const o = v.osc('sine', 700, 0, 0.12, g)
  v.glide(o.frequency, 0, 700, 260, 0.06)
  v.ad(g.gain, 0, 0.002, 0.2, 0.08)
  burst(v, { freq: 3000, q: 1, attack: 0.001, decay: 0.03, gain: 0.4 })
}

/** Vanish (p = 1) / reappear (p = 0): an airy swoosh, reversed for the reappearance. */
const fade: Recipe = (v, p) => {
  const g = v.gain(0, v.out)
  const bp = v.filter('bandpass', 1500, 1.2, g)
  if (p > 0) v.glide(bp.frequency, 0, 3500, 400, 0.35)
  else v.glide(bp.frequency, 0, 400, 3500, 0.25)
  v.noise('pink', 0, 0.45, bp)
  v.ad(g.gain, 0, p > 0 ? 0.02 : 0.15, 0.6, 0.3)
}

/** Grip root: rattling chains. */
const chains: Recipe = (v) => {
  for (let i = 0; i < 5; i++) {
    const at = i * (0.035 + v.rand() * 0.025)
    clang(v, at, 900 + v.rand() * 600, 0.15, 0.08, { ratio: 2.32, index: 2, partials: [1, 2.32, 4.1] })
    click(v, at, 0.2, 4500)
  }
  thump(v, 0, 140, 70, 0.12, 0.3)
}

/** Flame aura ignites (Rush): a roaring flare. */
const ignite: Recipe = (v) => {
  whoosh(v, 0, 0.6, 300, 2400, 0.8, 0.9, 'pink')
  burst(v, { noise: 'crackle', freq: 2500, q: 0.8, attack: 0.05, decay: 0.5, gain: 0.7 })
  thump(v, 0, 120, 60, 0.2, 0.25, v.drive(v.out, 2, 0.5))
}

/** A dark pact or curse: a low dissonant pulse. */
const darkPulse: Recipe = (v) => {
  brass(v, 0, [73.42, 77.78, 146.83], 0.8, 0.6, [[0, 200], [0.15, 900], [0.8, 250]])
  ring(v, 0.01, 311.13, [1, 2.76], [0.8, 0.4], 0.06)
}

// --- M1 spells -------------------------------------------------------------

/** A sustained loop with a short fade in and out over `p` seconds; returns its envelope. */
function loopEnv(v: Voice, p: number): { env: GainNode; dur: number } {
  const dur = clamp(p || 1, 0.15, 6)
  const env = v.gain(0, v.out)
  v.ahr(env.gain, 0, 0.05, 1, Math.max(0, dur - 0.13), 0.08)
  return { env, dur }
}

/** Cluster bolt in flight: a small, brighter flame. p = seconds */
const clusterTravel: Recipe = (v, p) => {
  const { env, dur } = loopEnv(v, p)
  v.noise('pink', 0, dur, v.filter('bandpass', 1500 * v.vary(0.1), 1, v.gain(0.8, tremolo(v, 0, dur, 11, 0.4, env))))
  v.noise('crackle', 0, dur, v.filter('highpass', 3000, 0.7, v.gain(0.4, env)))
}

/** Boomerang thrown: a whip of air and a metallic shing. */
const bladeThrow: Recipe = (v) => {
  whoosh(v, 0, 0.16, 1200, 3800, 1.8, 0.5)
  clang(v, 0.01, 2900, 0.25, 0.12, { ratio: 1.47, index: 1.5, partials: [1, 1.47, 2.1] })
  click(v, 0, 0.2, 5000)
}

/** Boomerang spinning in flight: a whirring band chopped by the rotation, a faint ring. p = seconds */
const bladeSpin: Recipe = (v, p) => {
  const { env, dur } = loopEnv(v, p)
  const am = tremolo(v, 0, dur, 17, 0.9, env)
  v.noise('white', 0, dur, v.filter('bandpass', 1500 * v.vary(0.08), 2.2, v.gain(1.2, am)))
  const g = v.gain(0.02, env)
  v.osc('sine', 2350, 0, dur, g)
  v.osc('sine', 2350 * 1.62, 0, dur, v.gain(0.5, g))
}

/** Blade slicing into a warlock: a bright shhk and a metal tick. */
const bladeHit: Recipe = (v) => {
  burst(v, { freq: 2800, to: 5200, q: 0.9, attack: 0.002, decay: 0.09, gain: 1.2 })
  clang(v, 0, 2900, 0.12, 0.08, { ratio: 1.47, index: 1.5, partials: [1, 1.47, 2.1] })
  click(v, 0, 0.4, 3000)
}

/** Homing / arcane bolt released: a buzzy FM charge snapping down. */
const arcaneCast: Recipe = (v) => {
  const g = v.gain(0, v.out)
  const lp = v.filter('lowpass', 3200, 1.5, v.drive(g, 1.8, 0.8))
  const car = v.osc('sawtooth', 900, 0, 0.22, lp)
  v.glide(car.frequency, 0, 900 * v.vary(0.05), 170, 0.17)
  v.osc('square', 63, 0, 0.22, v.gain(280, car.frequency))
  v.ad(g.gain, 0, 0.003, 0.3, 0.18)
  burst(v, { noise: 'crackle', freq: 3500, q: 1.5, decay: 0.09, gain: 0.4 })
  whoosh(v, 0.02, 0.22, 1000, 3000, 1, 0.2)
}

/** Homing bolt seeking: an eerie whistle with a slow vibrato over a breathy hiss. p = seconds */
const homingTravel: Recipe = (v, p) => {
  const { env, dur } = loopEnv(v, p)
  const g = v.gain(0.05, env)
  const o = v.osc('sine', 1180 * v.vary(0.04), 0, dur, g)
  v.osc('sine', 5.5, 0, dur, v.gain(30, o.frequency))
  v.osc('triangle', 590, 0, dur, v.gain(0.4, g))
  v.noise('pink', 0, dur, v.filter('bandpass', 2400, 3, v.gain(0.35, env)))
}

/** Homing detonation: an arcane burst, glassy and bright over a soft blast. */
const arcaneBurst: Recipe = (v) => {
  click(v, 0, 0.5, 3000)
  burst(v, { noise: 'pink', freq: 2200, to: 500, q: 0.9, attack: 0.002, decay: 0.35, gain: 3 })
  fmBell(v, 0, 880, 1.41, 4, 0.7, 0.18)
  fmBell(v, 0.01, 1320, 2.01, 3, 0.5, 0.1)
  thump(v, 0, 140, 50, 0.3, 0.25, v.drive(v.out, 2, 0.45))
  burst(v, { noise: 'crackle', freq: 4000, q: 1, attack: 0.01, decay: 0.4, gain: 0.8 })
}

/** Speed buff (Homing self-hit, Drain on an ally): a rising airy whoosh and a chime. */
const hasteUp: Recipe = (v) => {
  whoosh(v, 0, 0.35, 600, 4000, 1.2, 0.45)
  fmBell(v, 0.08, 1568, 2, 1, 0.4, 0.08)
}

/** Slowed (Drain, Pact): a heavy falling groan. */
const slowDown: Recipe = (v) => {
  const g = v.gain(0, v.out)
  const lp = v.filter('lowpass', 900, 2, v.drive(g, 1.6, 0.7))
  const o = v.osc('sawtooth', 220, 0, 0.5, lp)
  v.glide(o.frequency, 0, 220 * v.vary(0.04), 70, 0.45)
  v.ad(g.gain, 0, 0.01, 0.25, 0.45)
  burst(v, { noise: 'pink', freq: 600, to: 200, q: 1.2, attack: 0.01, decay: 0.3, gain: 0.8 })
}

/** Twin released: two bright tones a fifth apart. */
const twinCast: Recipe = (v) => {
  for (const [f, at] of [
    [1046.5, 0],
    [1568, 0.03],
  ] as const) fmBell(v, at, f, 1.5, 2, 0.25, 0.12)
  whoosh(v, 0, 0.25, 900, 3200, 1.4, 0.4)
}

/** One Twin bolt arcing: a soft whistle (the pair forms an interval). p = seconds */
const twinTravel: Recipe = (v, p) => {
  const { env, dur } = loopEnv(v, p)
  const f = v.rand() < 0.5 ? 1046.5 : 1568
  const g = v.gain(0.035, env)
  const o = v.osc('sine', f, 0, dur, g)
  v.osc('sine', 7, 0, dur, v.gain(12, o.frequency))
  v.noise('white', 0, dur, v.filter('bandpass', f * 2, 6, v.gain(0.25, env)))
}

/** Swap bolt released: a warbling buzz snapping out. */
const swapCast: Recipe = (v) => {
  const g = v.gain(0, v.out)
  const o = v.osc('sawtooth', 300, 0, 0.2, v.filter('bandpass', 1500, 2, g))
  v.osc('sine', 40, 0, 0.2, v.gain(120, o.frequency))
  v.ad(g.gain, 0, 0.003, 0.5, 0.15)
  whoosh(v, 0, 0.15, 1500, 5000, 1.5, 0.35)
}

/** Swap bolt in flight: a fast warble. p = seconds */
const swapTravel: Recipe = (v, p) => {
  const { env, dur } = loopEnv(v, p)
  const o = v.osc('sawtooth', 320, 0, dur, v.filter('bandpass', 1400, 3, v.gain(0.3, env)))
  v.osc('sine', 32, 0, dur, v.gain(140, o.frequency))
  v.noise('white', 0, dur, v.filter('bandpass', 5000, 2, v.gain(0.25, env)))
}

/** Drain released: a wet sucking pull. */
const drainCast: Recipe = (v) => {
  const am = tremolo(v, 0, 0.3, 24, 0.6, v.out)
  burst(v, { noise: 'pink', freq: 400, to: 1800, q: 2, attack: 0.08, decay: 0.15, gain: 2, dest: am })
  thump(v, 0, 90, 140, 0.15, 0.15)
}

/** Drain bolt in flight: a gurgling hiss. p = seconds */
const drainTravel: Recipe = (v, p) => {
  const { env, dur } = loopEnv(v, p)
  const am = tremolo(v, 0, dur, 13, 0.7, env, 'triangle')
  v.noise('pink', 0, dur, v.filter('bandpass', 700 * v.vary(0.1), 3, v.gain(0.9, am)))
  v.noise('crackle', 0, dur, v.filter('bandpass', 1800, 1.5, v.gain(0.35, env)))
}

/** Drain landing on an enemy: a wet smack and a draining slurp. */
const drainHit: Recipe = (v) => {
  click(v, 0, 0.4, 2400)
  const am = tremolo(v, 0, 0.3, 26, 0.5, v.out)
  burst(v, { noise: 'pink', freq: 2600, to: 300, q: 1.7, attack: 0.004, decay: 0.2, gain: 2.5, dest: am })
  const g = v.gain(0, v.out)
  const o = v.osc('sine', 500, 0.04, 0.3, g)
  v.glide(o.frequency, 0.04, 500, 160, 0.25)
  v.ad(g.gain, 0.04, 0.01, 0.15, 0.25)
}

/** Return orb in flight (Drain heal, Recharge refresh): a soft shimmering hum. p = seconds */
const orbTravel: Recipe = (v, p) => {
  const { env, dur } = loopEnv(v, p)
  const g = v.gain(0.03, tremolo(v, 0, dur, 9, 0.5, env))
  for (const f of [880, 1320]) v.osc('sine', f * v.vary(0.01), 0, dur, g)
  v.noise('white', 0, dur, v.filter('bandpass', 6000, 4, v.gain(0.15, env)))
}

/** Heal orb absorbed by its caster: a warm rising chime. */
const orbAbsorb: Recipe = (v) => {
  ;[659.25, 880, 1318.5].forEach((f, i) => fmBell(v, i * 0.05, f, 2, 0.8, 0.5, 0.1))
  whoosh(v, 0, 0.3, 1200, 5000, 1.5, 0.25)
}

/** Recharge bolt released: an electric spark launch. */
const rechargeCast: Recipe = (v) => {
  click(v, 0, 0.4, 3500)
  const g = v.gain(0, v.out)
  const lp = v.filter('lowpass', 5000, 5, v.drive(g, 2, 0.5))
  v.glide(lp.frequency, 0, 5000, 1200, 0.15)
  const car = v.osc('sawtooth', 220, 0, 0.18, lp)
  v.osc('square', 90, 0, 0.18, v.gain(150, car.frequency))
  v.ad(g.gain, 0, 0.002, 0.35, 0.15)
  burst(v, { noise: 'crackle', freq: 4000, q: 1, decay: 0.15, gain: 0.6 })
}

/** Recharge bolt in flight: a crackling electric hum. p = seconds */
const rechargeTravel: Recipe = (v, p) => {
  const { env, dur } = loopEnv(v, p)
  const car = v.osc('sawtooth', 110, 0, dur, v.filter('bandpass', 1800, 4, v.gain(0.25, env)))
  v.osc('square', 55, 0, dur, v.gain(40, car.frequency))
  v.noise('crackle', 0, dur, v.filter('highpass', 3500, 0.8, v.gain(0.5, env)))
}

/** Electric hit (Recharge, Bouncer): a sharp zap and sizzle. */
const zapHit: Recipe = (v) => {
  click(v, 0, 0.6, 2500)
  const g = v.gain(0, v.out)
  const lp = v.filter('lowpass', 4000, 6, v.drive(g, 2, 0.45))
  v.glide(lp.frequency, 0, 4000, 700, 0.2)
  const car = v.osc('sawtooth', 112, 0, 0.25, lp)
  v.osc('square', 47, 0, 0.25, v.gain(75, car.frequency))
  v.ad(g.gain, 0, 0.002, 0.4, 0.2)
  burst(v, { noise: 'crackle', freq: 3000, q: 1, decay: 0.2, gain: 0.7 })
}

/** Bouncer released: a springy pulse. */
const bouncerCast: Recipe = (v) => {
  const g = v.gain(0, v.out)
  const o = v.osc('triangle', 300, 0, 0.25, g)
  v.glide(o.frequency, 0, 300 * v.vary(0.05), 900, 0.12)
  v.ad(g.gain, 0, 0.003, 0.35, 0.2)
  whoosh(v, 0, 0.2, 800, 2800, 1.3, 0.35)
}

/** Bouncer orb in flight: a pulsing buzz. p = seconds */
const bouncerTravel: Recipe = (v, p) => {
  const { env, dur } = loopEnv(v, p)
  const am = tremolo(v, 0, dur, 8, 0.8, env, 'square')
  const o = v.osc('sawtooth', 180, 0, dur, v.filter('bandpass', 900, 3, v.gain(0.25, am)))
  v.osc('sine', 4, 0, dur, v.gain(20, o.frequency))
}

/** Bouncer leaping to the next warlock: a springy boing over a zap. */
const bounceZap: Recipe = (v) => {
  const g = v.gain(0, v.out)
  const o = v.osc('triangle', 260, 0, 0.25, g)
  v.glide(o.frequency, 0, 260, 1100, 0.1)
  v.ad(g.gain, 0, 0.002, 0.3, 0.2)
  burst(v, { noise: 'crackle', freq: 3500, q: 1, decay: 0.12, gain: 0.5 })
  click(v, 0, 0.3, 3500)
}

/** Thrust: a jet of air and a roar as the warlock launches. */
const dashBurst: Recipe = (v) => {
  click(v, 0, 0.3, 2500)
  whoosh(v, 0, 0.35, 300, 2200, 1, 0.9, 'pink')
  whoosh(v, 0.02, 0.3, 1200, 5000, 1.4, 0.4)
  thump(v, 0, 120, 60, 0.15, 0.2, v.drive(v.out, 2, 0.5))
  burst(v, { noise: 'brown', type: 'lowpass', freq: 800, attack: 0.02, decay: 0.3, gain: 0.3 })
}

/** Redirector grabbing a projectile: a reversing warp and a twang. */
const redirect: Recipe = (v) => {
  const g = v.gain(0, v.out)
  const o = v.osc('sine', 300, 0, 0.3, g)
  v.path(o.frequency, [
    [0, 300],
    [0.08, 1600],
    [0.25, 700],
  ])
  v.osc('sine', 60, 0, 0.3, v.gain(250, o.frequency))
  v.ad(g.gain, 0, 0.004, 0.3, 0.25)
  whoosh(v, 0, 0.25, 3000, 600, 1.5, 0.4, 'pink')
  clang(v, 0.02, 1200, 0.3, 0.08, { ratio: 2.4, index: 2, partials: [1, 2.4] })
}

/** Meteor called down: a deep rising rumble with a distant whistle. */
const meteorCast: Recipe = (v) => {
  whoosh(v, 0, 0.5, 120, 600, 0.8, 0.6, 'brown')
  const g = v.gain(0, v.out)
  const o = v.osc('sine', 2400, 0, 0.5, g)
  v.glide(o.frequency, 0, 2400, 1500, 0.45)
  v.ad(g.gain, 0, 0.1, 0.04, 0.35)
  click(v, 0, 0.2, 2500)
}

/** Meteor hovering then falling: a roar that swells and a whistle dropping in pitch. p = seconds */
const meteorFall: Recipe = (v, p) => {
  const dur = clamp(p || 1.15, 0.3, 3)
  const env = v.gain(0, v.out)
  env.gain.setValueAtTime(0, v.at(0))
  env.gain.linearRampToValueAtTime(0.35, v.at(dur * 0.45))
  env.gain.linearRampToValueAtTime(1, v.at(dur))
  env.gain.exponentialRampToValueAtTime(0.001, v.at(dur + 0.05))
  const lp = v.filter('lowpass', 300, 1, env)
  v.glide(lp.frequency, 0, 300, 2500, dur)
  v.noise('pink', 0, dur + 0.06, v.gain(1.2, lp))
  v.noise('crackle', 0, dur + 0.06, v.filter('highpass', 2500, 0.7, v.gain(0.4, env)))
  const wg = v.gain(0.05, env)
  const o = v.osc('sine', 1800, 0, dur + 0.06, wg)
  v.glide(o.frequency, 0, 1800, 500, dur)
}

/** Meteor lands: the biggest blast in the game, with rocks raining after. */
const meteorImpact: Recipe = (v) => {
  explosion(v, 1.6)
  for (let i = 0; i < 7; i++) {
    const t = 0.12 + v.rand() * 0.6
    thump(v, t, 300 + v.rand() * 300, 140, 0.06, 0.12)
    burst(v, { at: t, noise: 'crackle', freq: 1500, q: 1, decay: 0.05, gain: 0.6 })
  }
}

/** Splitter released: a pulse-charged launch. */
const splitterCast: Recipe = (v) => {
  const g = v.gain(0, v.out)
  const o = v.osc('square', 220, 0, 0.25, v.filter('lowpass', 2000, 4, g))
  v.glide(o.frequency, 0, 220 * v.vary(0.04), 110, 0.2)
  v.ad(g.gain, 0, 0.003, 0.25, 0.2)
  whoosh(v, 0, 0.25, 700, 2600, 1.2, 0.45)
  click(v, 0, 0.3, 3000)
}

/** Splitter main bolt / spawner in flight: a throbbing low hum. p = seconds */
const splitterTravel: Recipe = (v, p) => {
  const { env, dur } = loopEnv(v, p)
  const am = tremolo(v, 0, dur, 12, 0.8, env, 'square')
  const o = v.osc('sawtooth', 110, 0, dur, v.filter('bandpass', 700, 3, v.gain(0.3, am)))
  v.osc('sine', 3, 0, dur, v.gain(8, o.frequency))
  v.noise('pink', 0, dur, v.filter('bandpass', 1500, 2, v.gain(0.3, env)))
}

/** A Splitter child bolt: a quick zip as it leaves the spawner. p = seconds */
const childZip: Recipe = (v, p) => {
  const dur = clamp(p || 0.5, 0.1, 2)
  const g = v.gain(0, v.out)
  const o = v.osc('triangle', 1800 * v.vary(0.1), 0, dur, g)
  v.glide(o.frequency, 0, 1800, 900, Math.min(dur, 0.15))
  v.ahr(g.gain, 0, 0.003, 0.2, Math.max(0, dur - 0.1), 0.08)
}

/** Snowball thrown: a soft whump and a packed-snow crunch. */
const snowCast: Recipe = (v) => {
  whoosh(v, 0, 0.3, 300, 1200, 0.9, 0.5, 'pink')
  burst(v, { noise: 'crackle', type: 'lowpass', freq: 2500, attack: 0.01, decay: 0.15, gain: 1.2 })
  thump(v, 0, 140, 70, 0.12, 0.2)
}

/** Snowball rolling: a crunching rumble. p = seconds */
const snowRoll: Recipe = (v, p) => {
  const { env, dur } = loopEnv(v, p)
  const am = tremolo(v, 0, dur, 6, 0.5, env)
  v.noise('crackle', 0, dur, v.filter('bandpass', 1400, 1, v.gain(1.4, am)))
  v.noise('brown', 0, dur, v.filter('lowpass', 500, 0.8, v.gain(0.6, am)))
}

/** Snowball catching a warlock: a packed crunch. */
const snowGrab: Recipe = (v) => {
  burst(v, { noise: 'crackle', freq: 1800, q: 0.9, attack: 0.002, decay: 0.12, gain: 2 })
  burst(v, { noise: 'pink', freq: 900, q: 1, decay: 0.08, gain: 1.5 })
  thump(v, 0, 160, 70, 0.12, 0.2)
}

/** Snowball bursting: an icy shatter with a glassy ring. */
const snowBurst: Recipe = (v) => {
  click(v, 0, 0.5, 4000)
  burst(v, { noise: 'crackle', type: 'highpass', freq: 3000, attack: 0.002, decay: 0.35, gain: 1.8 })
  burst(v, { noise: 'pink', freq: 1800, to: 600, q: 0.9, attack: 0.002, decay: 0.25, gain: 2.5 })
  ring(v, 0, 2600, [1, 1.47, 2.31, 3.1], [0.5, 0.35, 0.25, 0.15], 0.06)
  thump(v, 0, 120, 50, 0.2, 0.25, v.drive(v.out, 2, 0.45))
}

/** Gravity orb released: a deep swell sucking inward. */
const gravityCast: Recipe = (v) => {
  const g = v.gain(0, v.out)
  const o = v.osc('sine', 60, 0, 0.5, v.drive(g, 2, 0.6))
  v.glide(o.frequency, 0, 60, 110, 0.4)
  v.ad(g.gain, 0, 0.1, 0.5, 0.35)
  whoosh(v, 0, 0.45, 3000, 400, 1, 0.45, 'pink')
}

/** Gravity orb in flight: a throbbing low drone with a filter sweeping inward. p = seconds */
const gravityHum: Recipe = (v, p) => {
  const { env, dur } = loopEnv(v, p)
  const am = tremolo(v, 0, dur, 3.5, 0.6, env)
  const lp = v.filter('lowpass', 900, 5, v.drive(v.gain(0.4, am), 1.5, 0.8))
  for (const cents of [-10, 10]) v.osc('sawtooth', 55, 0, dur, lp, cents)
  v.osc('sine', 0.7, 0, dur, v.gain(500, lp.frequency))
  v.noise('pink', 0, dur, v.filter('bandpass', 400, 2, v.gain(0.5, am)))
}

/** Gravity orb collapsing: a reverse rush into a thump. */
const gravityEnd: Recipe = (v) => {
  const g = v.gain(0, v.out)
  const bp = v.filter('bandpass', 400, 1.2, g)
  v.glide(bp.frequency, 0, 400, 3000, 0.2)
  v.noise('pink', 0, 0.25, bp)
  g.gain.setValueAtTime(0, v.at(0))
  g.gain.linearRampToValueAtTime(0.8, v.at(0.2))
  g.gain.exponentialRampToValueAtTime(0.001, v.at(0.23))
  thump(v, 0.2, 140, 45, 0.25, 0.4, v.drive(v.out, 2, 0.5))
  click(v, 0.2, 0.4, 2500)
}

/** Grip thrown: a chain whip and a clink. */
const gripCast: Recipe = (v) => {
  whoosh(v, 0, 0.2, 900, 3000, 1.5, 0.45)
  clang(v, 0.02, 1100, 0.15, 0.08, { ratio: 2.32, index: 2, partials: [1, 2.32] })
}

/** Grip in flight: a whirling chain rattle. p = seconds */
const gripTravel: Recipe = (v, p) => {
  const { env, dur } = loopEnv(v, p)
  const am = tremolo(v, 0, dur, 21, 0.9, env, 'square')
  v.noise('crackle', 0, dur, v.filter('bandpass', 2600, 2, v.gain(1.4, am)))
  v.noise('white', 0, dur, v.filter('bandpass', 1200, 3, v.gain(0.3, env)))
}

/** Warpzone opened: a descending warble, time bending. */
const warpCast: Recipe = (v) => {
  const g = v.gain(0, v.out)
  const o = v.osc('sine', 900, 0, 0.6, g)
  v.glide(o.frequency, 0, 900, 220, 0.5)
  v.osc('sine', 9, 0, 0.6, v.gain(60, o.frequency))
  v.ad(g.gain, 0, 0.02, 0.3, 0.5)
  whoosh(v, 0, 0.5, 2500, 500, 1, 0.35, 'pink')
}

/** Warpzone active (loop): detuned tones beating slowly, drifting down. p = seconds */
const warpHum: Recipe = (v, p) => {
  const { env, dur } = loopEnv(v, p)
  const g = v.gain(0.03, env)
  for (const [f, d] of [
    [330, 0],
    [333.5, 0],
    [495, 0.3],
  ] as const) {
    const o = v.osc('sine', f, d, dur - d, g)
    v.glide(o.frequency, d, f, f * 0.94, Math.max(0.1, dur - d))
  }
  v.noise('pink', 0, dur, v.filter('bandpass', 700, 4, v.gain(0.25, tremolo(v, 0, dur, 0.8, 0.6, env))))
}

/** Magnetize thrown: an FM hum snapping out. */
const magnetCast: Recipe = (v) => {
  const g = v.gain(0, v.out)
  const car = v.osc('sine', 220, 0, 0.3, g)
  v.osc('sine', 330, 0, 0.3, v.gain(400, car.frequency))
  v.ad(g.gain, 0, 0.005, 0.3, 0.25)
  whoosh(v, 0, 0.2, 1000, 3500, 1.4, 0.35)
}

/** Magnetize bolt in flight: an electric hum. p = seconds */
const magnetTravel: Recipe = (v, p) => {
  const { env, dur } = loopEnv(v, p)
  const car = v.osc('sine', 110, 0, dur, v.gain(0.12, env))
  v.osc('sine', 165, 0, dur, v.gain(150, car.frequency))
  v.noise('crackle', 0, dur, v.filter('highpass', 4000, 0.8, v.gain(0.3, env)))
}

/** Magnetized: a swelling hum and a clank. */
const magnetOn: Recipe = (v) => {
  const g = v.gain(0, v.out)
  const car = v.osc('sine', 110, 0, 0.6, g)
  v.osc('sine', 165, 0, 0.6, v.gain(220, car.frequency))
  v.ahr(g.gain, 0, 0.08, 0.3, 0.2, 0.3)
  clang(v, 0, 700, 0.3, 0.1, { ratio: 2.4, index: 2, partials: [1, 2.4, 4.1] })
}

/** Rockpillar: stone grinding up out of the ground and settling with a thud. */
const pillarRise: Recipe = (v) => {
  const am = tremolo(v, 0, 0.35, 19, 0.7, v.out)
  burst(v, { noise: 'crackle', freq: 900, q: 1, attack: 0.15, decay: 0.2, gain: 2.5, dest: am })
  burst(v, { noise: 'brown', type: 'lowpass', freq: 400, attack: 0.15, decay: 0.25, gain: 0.5 })
  thump(v, 0.32, 110, 45, 0.25, 0.3, v.drive(v.out, 2, 0.5))
  burst(v, { at: 0.32, noise: 'pink', freq: 900, q: 1, decay: 0.08, gain: 1.5 })
  tail(v, 0.33, 0.3, 220, 0.15)
}

/** Link thrown: an electric whip. */
const linkCast: Recipe = (v) => {
  whoosh(v, 0, 0.18, 1500, 5000, 1.6, 0.4)
  zapHit(v, 0)
}

/** Link bolt in flight: a crackling arc. p = seconds */
const linkTravel: Recipe = (v, p) => {
  const { env, dur } = loopEnv(v, p)
  v.noise('crackle', 0, dur, v.filter('bandpass', 3000, 1.2, v.gain(1, env)))
  const car = v.osc('sawtooth', 140, 0, dur, v.filter('bandpass', 2200, 5, v.gain(0.15, env)))
  v.osc('square', 70, 0, dur, v.gain(60, car.frequency))
}

/** Link tether holding (loop until the modifier ends): a buzzing electric strain. p = max seconds */
const linkLoop: Recipe = (v, p) => {
  const { env, dur } = loopEnv(v, p || 8)
  const am = tremolo(v, 0, dur, 13, 0.5, env)
  const car = v.osc('sawtooth', 98, 0, dur, v.filter('bandpass', 1500, 3, v.gain(0.12, am)))
  v.osc('square', 49, 0, dur, v.gain(40, car.frequency))
  v.noise('crackle', 0, dur, v.filter('highpass', 3500, 0.8, v.gain(0.3, env)))
}

/** Alteration armed: a glassy shimmer around the warlock. */
const altArm: Recipe = (v) => {
  fmBell(v, 0, 1318.5, 2.76, 2, 0.6, 0.12)
  fmBell(v, 0.04, 1975.5, 2.76, 1.5, 0.5, 0.08)
  burst(v, { freq: 7000, q: 3, attack: 0.05, decay: 0.4, gain: 0.3 })
}

/** Rush absorbing damage: a short flame flare. */
const flare: Recipe = (v) => {
  whoosh(v, 0, 0.2, 400, 2000, 0.9, 0.5, 'pink')
  burst(v, { noise: 'crackle', freq: 2500, q: 0.8, attack: 0.005, decay: 0.15, gain: 0.6 })
}

// --- UI --------------------------------------------------------------------

const uiHover: Recipe = (v) => {
  click(v, 0, 0.08, 6000)
  const g = v.gain(0, v.out)
  v.osc('sine', 2400 * v.vary(0.02), 0, 0.05, g)
  v.ad(g.gain, 0, 0.002, 0.04, 0.035)
}

const uiClick: Recipe = (v) => {
  click(v, 0, 0.35, 3000)
  thump(v, 0, 620, 300, 0.05, 0.2)
  burst(v, { noise: 'pink', freq: 2000, q: 1.2, attack: 0.001, decay: 0.025, gain: 0.8 })
}

const uiBack: Recipe = (v) => {
  click(v, 0, 0.2, 3000)
  for (const [at, f0, f1] of [
    [0, 660, 520],
    [0.06, 440, 330],
  ] as const) {
    const g = v.gain(0, v.out)
    const o = v.osc('triangle', f0, at, 0.15, g)
    v.glide(o.frequency, at, f0, f1, 0.08)
    v.ad(g.gain, at, 0.002, 0.18, 0.1)
  }
}

const uiBuy: Recipe = (v) => {
  click(v, 0, 0.3, 5000)
  ring(v, 0, 1318.5, [1, 2.76, 5.4, 8.93], [0.5, 0.3, 0.18, 0.1], 0.16)
  ring(v, 0.075, 1975.5, [1, 2.76, 5.4, 8.93], [0.6, 0.35, 0.2, 0.1], 0.16)
  burst(v, { type: 'highpass', freq: 7000, attack: 0.002, decay: 0.08, gain: 0.12 })
}

const uiError: Recipe = (v) => {
  const lp = v.filter('lowpass', 1100, 1, v.out)
  for (const at of [0, 0.12]) {
    const g = v.gain(0, lp)
    v.osc('square', 155, at, 0.12, g)
    v.ad(g.gain, at, 0.003, 0.15, 0.09)
  }
  thump(v, 0, 120, 70, 0.08, 0.08)
}

const uiReady: Recipe = (v) => {
  click(v, 0, 0.2, 4000)
  ;[523.25, 659.25, 783.99].forEach((f, i) => fmBell(v, i * 0.06, f, 2, 0.8, 0.35, 0.14))
}

/** One beat of "3, 2, 1": drum, click and a struck plate. p = beat index 0..2 (pitch climbs) */
const uiCountdown: Recipe = (v, p) => {
  const step = clamp(Math.round(p), 0, 4)
  click(v, 0, 0.3, 3000)
  thump(v, 0, 120, 46, 0.3, 0.3, v.drive(v.out, 2, 0.5))
  clang(v, 0, 660 * Math.pow(2, (step * 2) / 12), 0.4, 0.2, { ratio: 1.5, index: 2, partials: [1, 2.01, 3.03] })
  burst(v, { noise: 'pink', freq: 1200, q: 1, attack: 0.001, decay: 0.05, gain: 1.2 })
  tail(v, 0.02, 0.4, 180, 0.08)
}

export const RECIPES = {
  fireballCast,
  fireballTravel,
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
  castInhale,
  castSnuff,
  beamZap,
  tink,
  reflect,
  swapWarp,
  chargeSlam,
  ricochet,
  refresh,
  streakTick,
  respawnSwell,
  shieldUp,
  popOff,
  fade,
  chains,
  ignite,
  darkPulse,
  clusterTravel,
  bladeThrow,
  bladeSpin,
  bladeHit,
  arcaneCast,
  homingTravel,
  arcaneBurst,
  hasteUp,
  slowDown,
  twinCast,
  twinTravel,
  swapCast,
  swapTravel,
  drainCast,
  drainTravel,
  drainHit,
  orbTravel,
  orbAbsorb,
  rechargeCast,
  rechargeTravel,
  zapHit,
  bouncerCast,
  bouncerTravel,
  bounceZap,
  dashBurst,
  redirect,
  meteorCast,
  meteorFall,
  meteorImpact,
  splitterCast,
  splitterTravel,
  childZip,
  snowCast,
  snowRoll,
  snowGrab,
  snowBurst,
  gravityCast,
  gravityHum,
  gravityEnd,
  gripCast,
  gripTravel,
  warpCast,
  warpHum,
  magnetCast,
  magnetTravel,
  magnetOn,
  pillarRise,
  linkCast,
  linkTravel,
  linkLoop,
  altArm,
  flare,
  uiHover,
  uiClick,
  uiBack,
  uiBuy,
  uiError,
  uiReady,
  uiCountdown,
} satisfies Record<string, Recipe>

export type SfxId = keyof typeof RECIPES

// ---------------------------------------------------------------------------
// Shared helpers for music (one-shot notes scheduled by the sequencer)
// ---------------------------------------------------------------------------

export const layers = { burst, thump, ring, whoosh, fmBell, click, tail, clang, brass }
