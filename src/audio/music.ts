/**
 * Generative ambient music: a dark drone bed (few continuous oscillators) plus a
 * step sequencer that schedules short notes slightly ahead of time. One layer per
 * track; the engine crossfades layers. Kept cheap: 3-5 running oscillators per
 * layer and a handful of short-lived nodes per step.
 *
 * menu:  slow drone, heartbeat, distant bells
 * shop:  brighter drone, soft kick, pentatonic plucks
 * fight: tense drone (minor second), kick, bass pulse, hats; `intensity` (0..1,
 *        raised as the arena shrinks) opens the filter and adds hats and snares
 */
import { bell, chain, env, filt, noise, osc, thump, type Synth } from './synth'

export type MusicTrack = 'menu' | 'shop' | 'fight'

const A1 = 55
const PHRYGIAN = [440, 466.16, 523.25, 587.33, 659.25, 698.46]
const PENTA = [220, 261.63, 293.66, 329.63, 392, 440, 523.25]

interface TrackDef {
  stepDur: number
  steps: number
  droneCutoff: number
  /** drone notes (Hz) and gains */
  drone: [OscillatorType, number, number][]
  droneGain: number
  droneQ: number
  play(l: MusicLayer, t: number, step: number): void
}

const TRACKS: Record<MusicTrack, TrackDef> = {
  menu: {
    stepDur: 0.6,
    steps: 16,
    droneCutoff: 320,
    droneQ: 1.5,
    droneGain: 0.14,
    drone: [
      ['sawtooth', A1, 1],
      ['sawtooth', A1 * 1.0055, 1],
      ['sine', A1 / 2, 0.7],
      ['triangle', 82.41, 0.3],
    ],
    play(l, t, step) {
      const s = l.synth
      if (step % 8 === 0) {
        thump(s, l.out, t, 62, 40, 0.2, 0.3, 0.3)
        thump(s, l.out, t + 0.28, 60, 40, 0.2, 0.18, 0.3)
      }
      if (step % 8 === 4 && Math.random() < 0.5) bell(s, l.out, t, pick(PHRYGIAN), 0.03, 3)
    },
  },
  shop: {
    stepDur: 0.3,
    steps: 32,
    droneCutoff: 420,
    droneQ: 1.5,
    droneGain: 0.12,
    drone: [
      ['sawtooth', A1, 1],
      ['sawtooth', A1 * 1.004, 1],
      ['sine', A1 / 2, 0.6],
      ['triangle', 110, 0.25],
    ],
    play(l, t, step) {
      const s = l.synth
      if (step % 8 === 0) thump(s, l.out, t, 70, 42, 0.18, 0.2, 0.25)
      if (step % 2 === 0 && Math.random() < 0.7) {
        l.walk = Math.max(0, Math.min(PENTA.length - 1, l.walk + Math.floor(Math.random() * 5) - 2))
        const f = PENTA[l.walk]
        const lp = filt(s, 'lowpass', 2000, 2)
        lp.frequency.setValueAtTime(2200, t)
        lp.frequency.exponentialRampToValueAtTime(400, t + 0.45)
        lp.connect(env(s, l.out, t, 0.004, 0.05, 0.5))
        osc(s, 'triangle', f, f, t, 0, t + 0.6).connect(lp)
        osc(s, 'sawtooth', f * 1.003, f * 1.003, t, 0, t + 0.6).connect(lp)
      }
    },
  },
  fight: {
    stepDur: 0.125,
    steps: 64,
    droneCutoff: 500,
    droneQ: 3,
    droneGain: 0.1,
    drone: [
      ['sawtooth', A1, 1],
      ['sawtooth', 58.27, 0.7],
      ['sine', A1 / 2, 0.8],
    ],
    play(l, t, step) {
      const s = l.synth
      const k = l.intensity
      const st = step % 16
      if (st === 0 || st === 8 || (k > 0.5 && st === 10)) thump(s, l.out, t, 120, 42, 0.2, 0.5, 0.22)
      if ([0, 3, 6, 8, 11, 14].includes(st)) {
        const lp = filt(s, 'lowpass', 900, 4)
        lp.frequency.setValueAtTime(900 + 900 * k, t)
        lp.frequency.exponentialRampToValueAtTime(180, t + 0.16)
        lp.connect(env(s, l.out, t, 0.003, 0.12, 0.18))
        osc(s, 'sawtooth', A1, A1, t, 0, t + 0.25).connect(lp)
        if (k > 0.6) osc(s, 'square', A1 * 2, A1 * 2, t, 0, t + 0.2).connect(lp)
      }
      if (st % 4 === 2 || (k > 0.5 && st % 2 === 1)) {
        chain(noise(s, s.white, t, t + 0.06), filt(s, 'highpass', 7000), env(s, l.out, t, 0.001, 0.025 + 0.04 * k, 0.03))
      }
      if (k > 0.25 && (st === 4 || st === 12)) {
        chain(noise(s, s.white, t, t + 0.2), filt(s, 'bandpass', 1800, 0.8), env(s, l.out, t, 0.001, 0.1, 0.14))
        thump(s, l.out, t, 210, 150, 0.05, 0.07, 0.08)
      }
      if (step === 0) {
        const lp = filt(s, 'lowpass', 1200, 1)
        lp.connect(env(s, l.out, t, 0.02, 0.035, 1.2))
        for (const f of [220, 261.63, 311.13]) osc(s, 'sawtooth', f, f, t, 0, t + 1.3).connect(lp)
      }
    },
  },
}

function pick<T>(a: readonly T[]): T {
  return a[Math.floor(Math.random() * a.length)]
}

export class MusicLayer {
  readonly track: MusicTrack
  readonly synth: Synth
  readonly out: GainNode
  intensity = 0
  walk = 3
  private readonly def: TrackDef
  private readonly sources: AudioScheduledSourceNode[] = []
  private readonly droneFilter: BiquadFilterNode
  private nextStepTime: number
  private step = 0
  private stopAt = Infinity

  constructor(synth: Synth, dest: AudioNode, track: MusicTrack) {
    const ctx = synth.ctx
    this.synth = synth
    this.track = track
    this.def = TRACKS[track]
    this.out = ctx.createGain()
    this.out.gain.value = 0
    this.out.connect(dest)
    const t = ctx.currentTime + 0.05

    this.droneFilter = filt(synth, 'lowpass', this.def.droneCutoff, this.def.droneQ)
    const dg = ctx.createGain()
    dg.gain.value = this.def.droneGain
    this.droneFilter.connect(dg)
    dg.connect(this.out)
    for (const [type, f, a] of this.def.drone) {
      const o = ctx.createOscillator()
      o.type = type
      o.frequency.value = f
      const g = ctx.createGain()
      g.gain.value = a / this.def.drone.length
      o.connect(g)
      g.connect(this.droneFilter)
      o.start(t)
      this.sources.push(o)
    }
    // slow breathing of the drone filter
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 0.05 + Math.random() * 0.03
    const depth = ctx.createGain()
    depth.gain.value = this.def.droneCutoff * 0.35
    lfo.connect(depth)
    depth.connect(this.droneFilter.frequency)
    lfo.start(t)
    this.sources.push(lfo)

    this.nextStepTime = t + 0.1
  }

  get stopped(): boolean {
    return this.synth.ctx.currentTime > this.stopAt
  }

  fadeTo(level: number, seconds: number): void {
    const now = this.synth.ctx.currentTime
    this.out.gain.cancelScheduledValues(now)
    this.out.gain.setValueAtTime(this.out.gain.value, now)
    this.out.gain.setTargetAtTime(level, now, seconds / 3)
  }

  /** Fade out and stop every source afterwards. */
  release(seconds: number): void {
    this.fadeTo(0, seconds)
    const end = this.synth.ctx.currentTime + seconds + 0.2
    this.stopAt = end
    for (const s of this.sources) s.stop(end)
    setTimeout(() => this.out.disconnect(), (seconds + 0.5) * 1000)
  }

  setIntensity(k: number): void {
    this.intensity = Math.max(0, Math.min(1, k))
    if (this.track !== 'fight') return
    const now = this.synth.ctx.currentTime
    this.droneFilter.frequency.setTargetAtTime(this.def.droneCutoff + 1400 * this.intensity, now, 1.5)
  }

  /** Schedule steps up to `until` (context time). */
  schedule(until: number): void {
    if (this.stopAt !== Infinity) return
    const now = this.synth.ctx.currentTime
    // after a stall (tab in background) skip ahead instead of bursting notes
    if (this.nextStepTime < now - 0.2) this.nextStepTime = now + 0.05
    while (this.nextStepTime < until) {
      this.def.play(this, this.nextStepTime, this.step)
      this.step = (this.step + 1) % this.def.steps
      this.nextStepTime += this.def.stepDur
    }
  }
}
