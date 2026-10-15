/**
 * Lava ambience under the music (procedural; recordings may layer on later):
 * - match: a low magma rumble, a breathing hiss, sparse crackle and bubbles plopping at
 *   random, plus an edge sizzle that swells and pans toward the lava as the local pawn
 *   nears the edge (setEdge);
 * - menu: the same caldera from further away: darker, fewer bubbles, no edge layer.
 * Cheap: four continuous noise sources and a handful of short bubble voices per second.
 */
import { layers, Voice, type Synth } from './synth'

const { burst } = layers

export type AmbienceKind = 'menu' | 'match'

/** edge sizzle at the lava's edge, relative to the bed: a warning you hear */
const EDGE_BOOST = 1.8

interface AmbDef {
  level: number
  rumbleHz: number
  hiss: number
  crackle: number
  /** bubbles per second */
  bubbles: number
  edge: boolean
}

const DEFS: Record<AmbienceKind, AmbDef> = {
  match: { level: 1, rumbleHz: 140, hiss: 0.25, crackle: 0.5, bubbles: 6, edge: true },
  menu: { level: 0.78, rumbleHz: 100, hiss: 0.12, crackle: 0.25, bubbles: 2.5, edge: false },
}

export class AmbienceLayer {
  readonly kind: AmbienceKind
  readonly out: GainNode
  private readonly synth: Synth
  private readonly def: AmbDef
  private readonly sources: AudioScheduledSourceNode[] = []
  private readonly edgeGain: GainNode | null = null
  private readonly edgePan: StereoPannerNode | null = null
  private nextBubble: number
  private stopAt = Infinity

  constructor(synth: Synth, dest: AudioNode, kind: AmbienceKind) {
    const ctx = synth.ctx
    this.synth = synth
    this.kind = kind
    this.def = DEFS[kind]
    this.out = ctx.createGain()
    this.out.gain.value = 0
    this.out.connect(dest)
    const t = ctx.currentTime + 0.05
    const loop = (buf: AudioBuffer, type: BiquadFilterType, hz: number, q: number, gain: number, into: AudioNode = this.out) => {
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.loop = true
      src.playbackRate.value = 0.9 + Math.random() * 0.2
      const f = ctx.createBiquadFilter()
      f.type = type
      f.frequency.value = hz
      f.Q.value = q
      const g = ctx.createGain()
      g.gain.value = gain
      src.connect(f)
      f.connect(g)
      g.connect(into)
      src.start(t, Math.random() * buf.duration * 0.9)
      this.sources.push(src)
      return { f, g }
    }
    // magma rumble with a slow swell
    const rumble = loop(synth.banks.brown, 'lowpass', this.def.rumbleHz, 0.7, 0.9)
    this.lfo(0.06, 0.35, rumble.g.gain, t)
    // breathing hiss of hot air
    const hiss = loop(synth.banks.pink, 'bandpass', 2600, 0.6, this.def.hiss)
    this.lfo(0.11, this.def.hiss * 0.6, hiss.g.gain, t)
    // sparse crackle, kept dark so it reads as distant
    loop(synth.banks.crackle, 'lowpass', 2200, 0.7, this.def.crackle)
    if (this.def.edge && typeof ctx.createStereoPanner === 'function') {
      // edge sizzle: silent until the local pawn nears lava
      this.edgePan = ctx.createStereoPanner()
      this.edgeGain = ctx.createGain()
      this.edgeGain.gain.value = 0
      this.edgeGain.connect(this.edgePan)
      this.edgePan.connect(this.out)
      const sizzle = loop(synth.banks.white, 'highpass', 3500, 0.7, 0.35, this.edgeGain)
      this.lfo(7, 0.15, sizzle.g.gain, t)
      loop(synth.banks.crackle, 'bandpass', 3000, 0.9, 0.9, this.edgeGain)
    }
    this.nextBubble = t + 0.2
  }

  private lfo(hz: number, depth: number, param: AudioParam, t: number): void {
    const ctx = this.synth.ctx
    const o = ctx.createOscillator()
    o.frequency.value = hz * (0.85 + Math.random() * 0.3)
    const g = ctx.createGain()
    g.gain.value = depth
    o.connect(g)
    g.connect(param)
    o.start(t)
    this.sources.push(o)
  }

  get stopped(): boolean {
    return this.synth.ctx.currentTime > this.stopAt
  }

  fadeTo(level: number, seconds: number): void {
    const now = this.synth.ctx.currentTime
    this.out.gain.cancelScheduledValues(now)
    this.out.gain.setValueAtTime(this.out.gain.value, now)
    this.out.gain.setTargetAtTime(level * this.def.level, now, seconds / 3)
  }

  release(seconds: number): void {
    this.fadeTo(0, seconds)
    const end = this.synth.ctx.currentTime + seconds + 0.2
    this.stopAt = end
    for (const s of this.sources) s.stop(end)
    setTimeout(() => this.out.disconnect(), (seconds + 0.5) * 1000)
  }

  /** Edge proximity 0 (safe) .. 1 (at the lava), and which side the lava is on (-1..1). */
  setEdge(proximity: number, pan: number): void {
    if (!this.edgeGain || !this.edgePan) return
    const now = this.synth.ctx.currentTime
    const k = Math.max(0, Math.min(1, proximity))
    this.edgeGain.gain.setTargetAtTime(k * k * EDGE_BOOST, now, 0.12)
    this.edgePan.pan.setTargetAtTime(Math.max(-0.8, Math.min(0.8, pan)), now, 0.12)
  }

  /** Schedule bubbles up to `until` (context time). */
  schedule(until: number): void {
    if (this.stopAt !== Infinity) return
    const now = this.synth.ctx.currentTime
    if (this.nextBubble < now - 0.2) this.nextBubble = now + 0.05
    while (this.nextBubble < until) {
      this.bubble(this.nextBubble)
      // Poisson-ish spacing so bubbles never tick like a clock
      this.nextBubble += (-Math.log(1 - Math.random() * 0.98) / this.def.bubbles) + 0.02
    }
  }

  private bubble(t: number): void {
    const v = new Voice(this.synth, this.out, t)
    const big = Math.random() < 0.2
    const f = (big ? 140 : 240) + Math.random() * (big ? 120 : 380)
    const g = v.gain(0, v.out)
    const o = v.osc('sine', f, 0, 0.12, g)
    v.glide(o.frequency, 0, f, f * (1.8 + Math.random()), big ? 0.09 : 0.05)
    v.ad(g.gain, 0, 0.004, (big ? 0.12 : 0.06) * (0.5 + Math.random()), big ? 0.1 : 0.05)
    if (big) burst(v, { noise: 'pink', type: 'lowpass', freq: 600, attack: 0.005, decay: 0.12, gain: 0.25 })
  }
}

/**
 * Edge proximity for the local pawn: 1 standing at the lava's edge, 0 from `reach` units
 * inward; `pan` points toward the nearest lava. `safe(x, y)` is the arena's lava test.
 */
export function edgeProximity(x: number, y: number, safe: (x: number, y: number) => boolean, reach = 160): { proximity: number; pan: number } {
  if (!safe(x, y)) return { proximity: 1, pan: 0 }
  let best = Infinity
  let pan = 0
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    const c = Math.cos(a)
    const s = Math.sin(a)
    for (let r = 24; r <= reach; r += 24) {
      if (!safe(x + c * r, y + s * r)) {
        if (r < best) {
          best = r
          pan = c
        }
        break
      }
    }
  }
  if (best === Infinity) return { proximity: 0, pan: 0 }
  return { proximity: 1 - best / reach, pan }
}
