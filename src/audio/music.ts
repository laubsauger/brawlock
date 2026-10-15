/**
 * Generative ambient music: a dark drone bed (few continuous oscillators) plus a
 * step sequencer that schedules short notes slightly ahead of time. One layer per
 * track; the engine crossfades layers. Kept cheap: 3-5 running oscillators per
 * layer and a handful of short-lived nodes per step.
 *
 * menu:  slow drone, a breathing minor pad, heartbeat, distant bells
 * shop:  brighter drone and pad, soft kick, pentatonic plucks
 * fight: tense drone (minor second), pad swinging to the flat second, kick, bass pulse,
 *        hats; `intensity` (0..1, raised as the arena shrinks) opens the filter and adds
 *        hats and snares
 *
 * The drone alone sits at 55-220 Hz, which laptop speakers barely reproduce; the pad and
 * the melodic layers carry the music in the mids.
 */
import { layers, Voice, type Synth } from './synth'

const { burst, thump, fmBell, click, brass } = layers

export type MusicTrack = 'menu' | 'shop' | 'fight'

const A1 = 55
const PHRYGIAN = [440, 466.16, 523.25, 587.33, 659.25, 698.46]
const PENTA = [220, 261.63, 293.66, 329.63, 392, 440, 523.25]

interface PadDef {
  type: OscillatorType
  /** chord voicings (Hz), cycled every `chordSteps` steps */
  chords: number[][]
  chordSteps: number
  cutoff: number
  gain: number
}

interface TrackDef {
  /** layer level: the fight bed sits under combat SFX, menu / shop beds play alone */
  level: number
  stepDur: number
  steps: number
  pad: PadDef
  droneCutoff: number
  /** drone notes (Hz) and gains */
  drone: [OscillatorType, number, number][]
  droneGain: number
  droneQ: number
  play(l: MusicLayer, t: number, step: number): void
}

const TRACKS: Record<MusicTrack, TrackDef> = {
  menu: {
    level: 1,
    stepDur: 0.6,
    steps: 16,
    pad: {
      type: 'sawtooth',
      chords: [
        [220, 261.63, 329.63],
        [174.61, 220, 261.63],
        [146.83, 220, 293.66],
        [164.81, 207.65, 246.94],
      ],
      chordSteps: 16,
      cutoff: 900,
      gain: 0.07,
    },
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
      const v = l.voice(t)
      if (step % 8 === 0) {
        // heartbeat: a low thump plus a knock in the mids so small speakers hear it too
        for (const [at, a] of [
          [0, 1],
          [0.28, 0.65],
        ] as const) {
          thump(v, at, 62, 40, 0.3, 0.3 * a)
          burst(v, { at, noise: 'pink', freq: 300, q: 1.2, attack: 0.003, decay: 0.12, gain: 0.9 * a })
        }
      }
      if (step % 8 === 4 && Math.random() < 0.6) fmBell(v, 0, pick(PHRYGIAN), 3.5, 1.2, 3, 0.07)
    },
  },
  shop: {
    level: 1,
    stepDur: 0.3,
    steps: 32,
    pad: {
      type: 'triangle',
      chords: [
        [220, 261.63, 329.63],
        [196, 261.63, 329.63],
        [196, 246.94, 293.66],
        [164.81, 246.94, 329.63],
      ],
      chordSteps: 16,
      cutoff: 1400,
      gain: 0.09,
    },
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
      const v = l.voice(t)
      if (step % 8 === 0) {
        thump(v, 0, 70, 42, 0.25, 0.2)
        burst(v, { noise: 'pink', freq: 320, q: 1.2, attack: 0.003, decay: 0.1, gain: 0.6 })
      }
      if (step % 2 === 0 && Math.random() < 0.7) {
        l.walk = Math.max(0, Math.min(PENTA.length - 1, l.walk + Math.floor(Math.random() * 5) - 2))
        const f = PENTA[l.walk]
        const g = v.gain(0, v.out)
        const lp = v.filter('lowpass', 2200, 2, g)
        v.glide(lp.frequency, 0, 2200, 400, 0.45)
        v.osc('triangle', f, 0, 0.6, lp)
        v.osc('sawtooth', f, 0, 0.6, lp, 5)
        v.ad(g.gain, 0, 0.004, 0.09, 0.5)
      }
    },
  },
  fight: {
    level: 0.25,
    stepDur: 0.125,
    steps: 64,
    pad: {
      type: 'sawtooth',
      chords: [
        [220, 261.63, 329.63],
        [233.08, 293.66, 349.23],
      ],
      chordSteps: 32,
      cutoff: 1100,
      gain: 0.045,
    },
    droneCutoff: 500,
    droneQ: 3,
    droneGain: 0.1,
    drone: [
      ['sawtooth', A1, 1],
      ['sawtooth', 58.27, 0.7],
      ['sine', A1 / 2, 0.8],
    ],
    play(l, t, step) {
      const v = l.voice(t)
      const k = l.intensity
      const st = step % 16
      if (st === 0 || st === 8 || (k > 0.5 && st === 10)) {
        thump(v, 0, 120, 42, 0.22, 0.5, v.drive(v.out, 1.8, 0.7))
        click(v, 0, 0.2, 2500)
        burst(v, { noise: 'pink', freq: 900, q: 1, attack: 0.001, decay: 0.04, gain: 0.5 })
      }
      if ([0, 3, 6, 8, 11, 14].includes(st)) {
        const g = v.gain(0, v.out)
        const lp = v.filter('lowpass', 900, 4, g)
        v.glide(lp.frequency, 0, 900 + 900 * k, 180, 0.16)
        v.osc('sawtooth', A1, 0, 0.25, lp)
        if (k > 0.6) v.osc('square', A1 * 2, 0, 0.2, lp)
        v.ad(g.gain, 0, 0.003, 0.16, 0.18)
      }
      if (st % 4 === 2 || (k > 0.5 && st % 2 === 1)) {
        burst(v, { type: 'highpass', freq: 7000, attack: 0.001, decay: 0.03, gain: 0.07 + 0.06 * k })
      }
      if (k > 0.25 && (st === 4 || st === 12)) {
        burst(v, { freq: 1800, q: 0.8, attack: 0.001, decay: 0.14, gain: 0.45 })
        thump(v, 0, 210, 150, 0.08, 0.07)
      }
      if (step === 0) brass(v, 0, [220, 261.63, 311.13], 1.2, 0.12, [[0, 400], [0.1, 1400], [1.2, 500]])
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
  private readonly padOscs: { osc: OscillatorNode; voice: number }[] = []
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

    this.droneFilter = ctx.createBiquadFilter()
    this.droneFilter.type = 'lowpass'
    this.droneFilter.frequency.value = this.def.droneCutoff
    this.droneFilter.Q.value = this.def.droneQ
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

    // pad: two detuned oscillators per chord note through a breathing lowpass
    const pad = this.def.pad
    const padFilter = ctx.createBiquadFilter()
    padFilter.type = 'lowpass'
    padFilter.frequency.value = pad.cutoff
    padFilter.Q.value = 0.8
    const padGain = ctx.createGain()
    padGain.gain.value = pad.gain
    padFilter.connect(padGain)
    padGain.connect(this.out)
    const padLfo = ctx.createOscillator()
    padLfo.frequency.value = 0.07 + Math.random() * 0.03
    const padDepth = ctx.createGain()
    padDepth.gain.value = pad.cutoff * 0.4
    padLfo.connect(padDepth)
    padDepth.connect(padFilter.frequency)
    padLfo.start(t)
    this.sources.push(padLfo)
    const n = pad.chords[0].length
    for (let i = 0; i < n; i++) {
      for (const cents of [-7, 7]) {
        const o = ctx.createOscillator()
        o.type = pad.type
        o.frequency.value = pad.chords[0][i]
        o.detune.value = cents
        const g = ctx.createGain()
        g.gain.value = 1 / (n * 2)
        o.connect(g)
        g.connect(padFilter)
        o.start(t)
        this.sources.push(o)
        this.padOscs.push({ osc: o, voice: i })
      }
    }

    this.nextStepTime = t + 0.1
  }

  /** Glide the pad to the chord for this step (a slow portamento, no clicks). */
  private padChord(t: number): void {
    const pad = this.def.pad
    if (this.step % pad.chordSteps !== 0) return
    const chord = pad.chords[(this.step / pad.chordSteps) % pad.chords.length]
    for (const p of this.padOscs) p.osc.frequency.setTargetAtTime(chord[p.voice], t, 0.25)
  }

  get stopped(): boolean {
    return this.synth.ctx.currentTime > this.stopAt
  }

  /** The track's own level (fadeTo(1) reaches it). */
  get level(): number {
    return this.def.level
  }

  fadeTo(level: number, seconds: number): void {
    const now = this.synth.ctx.currentTime
    this.out.gain.cancelScheduledValues(now)
    this.out.gain.setValueAtTime(this.out.gain.value, now)
    this.out.gain.setTargetAtTime(level * this.def.level, now, seconds / 3)
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

  /** A one-shot voice into this layer at context time `t`. */
  voice(t: number): Voice {
    return new Voice(this.synth, this.out, t)
  }

  /** Schedule steps up to `until` (context time). */
  schedule(until: number): void {
    if (this.stopAt !== Infinity) return
    const now = this.synth.ctx.currentTime
    // after a stall (tab in background) skip ahead instead of bursting notes
    if (this.nextStepTime < now - 0.2) this.nextStepTime = now + 0.05
    while (this.nextStepTime < until) {
      this.padChord(this.nextStepTime)
      this.def.play(this, this.nextStepTime, this.step)
      this.step = (this.step + 1) % this.def.steps
      this.nextStepTime += this.def.stepDur
    }
  }
}
