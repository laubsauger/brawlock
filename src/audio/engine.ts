/**
 * WebAudio engine: context, bus graph, voice limiting, music crossfade.
 *
 *   voices ─▶ sfx ─┬──────────────▶ master ─▶ compressor ─▶ soft limiter ─▶ destination
 *                  └▶ send ─▶ reverb ─┘ ▲
 *   ui ───────────────────────────────┘ │
 *   music layers ─▶ music ─┬────────────┘
 *                          └▶ send ─▶ reverb
 *
 * Nothing exists before unlock(); every call is a no-op without an AudioContext
 * (node tests, old browsers) or while the context is not running.
 */
import { MusicLayer, type MusicTrack } from './music'
import { planEvents, type ListenerLike, type SoundCue } from './events'
import { createSynth, RECIPES, type SfxId, type Synth } from './synth'
import type { SimEvent } from '../sim/types'

interface VoiceSpec {
  /** concurrent voices of this sound */
  max: number
  /**
   * loudness trim, set from offline renders (Chrome OfflineAudioContext): casts ~0.05 rms,
   * hits and blasts ~0.1-0.15 rms with peaks <= ~1.3 before the master compressor
   */
  level: number
  bus: 'sfx' | 'ui'
  /** minimum seconds between starts (rate limit / dedupe) */
  minGap?: number
}

export const VOICES: Record<SfxId, VoiceSpec> = {
  fireballCast: { max: 4, level: 1.8, bus: 'sfx' },
  explosion: { max: 5, level: 0.75, bus: 'sfx' },
  fizzle: { max: 3, level: 0.9, bus: 'sfx' },
  hit: { max: 5, level: 0.9, bus: 'sfx', minGap: 0.02 },
  scourgeWindup: { max: 4, level: 0.7, bus: 'sfx' },
  scourgeBlast: { max: 3, level: 0.7, bus: 'sfx' },
  teleportOut: { max: 3, level: 1.1, bus: 'sfx' },
  teleportIn: { max: 3, level: 1.0, bus: 'sfx' },
  lavaSizzle: { max: 1, level: 1.4, bus: 'sfx', minGap: 0.22 },
  death: { max: 2, level: 0.9, bus: 'sfx' },
  obstacleBreak: { max: 3, level: 0.8, bus: 'sfx' },
  shrinkRumble: { max: 1, level: 0.9, bus: 'sfx', minGap: 1 },
  // phase 'fight' event and ui('fight') both trigger it: the gap plays it once
  roundStart: { max: 1, level: 0.75, bus: 'sfx', minGap: 0.8 },
  roundWin: { max: 1, level: 2, bus: 'sfx', minGap: 1 },
  gameOver: { max: 1, level: 0.9, bus: 'sfx', minGap: 2 },
  castGeneric: { max: 3, level: 2.4, bus: 'sfx' },
  impact: { max: 4, level: 0.7, bus: 'sfx' },
  uiHover: { max: 2, level: 1, bus: 'ui', minGap: 0.03 },
  uiClick: { max: 2, level: 1, bus: 'ui', minGap: 0.02 },
  uiBack: { max: 2, level: 1, bus: 'ui', minGap: 0.05 },
  uiBuy: { max: 2, level: 1, bus: 'ui', minGap: 0.05 },
  uiError: { max: 1, level: 1, bus: 'ui', minGap: 0.1 },
  uiReady: { max: 1, level: 1, bus: 'ui', minGap: 0.1 },
  uiCountdown: { max: 1, level: 1, bus: 'ui', minGap: 0.2 },
}

const MAX_VOICES = 40
const MUSIC_LEVEL = 1
const SFX_REVERB_SEND = 0.16
const MUSIC_REVERB_SEND = 0.3
/** gain ramp time constant: short enough to feel instant, long enough to never click */
const RAMP = 0.03

export interface Volumes {
  master: number
  sfx: number
  music: number
  muted: boolean
}

type Ctor = new (opts?: AudioContextOptions) => AudioContext

function audioContextCtor(): Ctor | null {
  const g = globalThis as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor }
  return g.AudioContext ?? g.webkitAudioContext ?? null
}

/** Perceptual slider curve: 0.5 on the slider is about half as loud. */
const curve = (v: number) => {
  const c = Math.max(0, Math.min(1, v))
  return c * c
}

interface Graph {
  ctx: AudioContext
  synth: Synth
  master: GainNode
  sfx: GainNode
  ui: GainNode
  music: GainNode
}

export class AudioEngine {
  private g: Graph | null = null
  private vol: Volumes = { master: 0.8, sfx: 1, music: 0.6, muted: false }
  private readonly voiceEnds = new Map<SfxId, number[]>()
  private readonly lastStart = new Map<SfxId, number>()
  private desiredTrack: MusicTrack | 'none' = 'none'
  private current: MusicLayer | null = null
  private fading: MusicLayer[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private shrinks = 0

  get ready(): boolean {
    return this.g !== null && this.g.ctx.state === 'running'
  }

  unlock(): void {
    if (this.g) {
      if (this.g.ctx.state === 'suspended') this.g.ctx.resume().catch(() => {})
      return
    }
    const C = audioContextCtor()
    if (!C) return
    let ctx: AudioContext
    try {
      ctx = new C({ latencyHint: 'interactive' })
    } catch {
      try {
        ctx = new C() // older WebKit rejects the options argument
      } catch {
        return
      }
    }
    const synth = createSynth(ctx)
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -12
    comp.knee.value = 10
    comp.ratio.value = 4
    comp.attack.value = 0.003
    comp.release.value = 0.2
    // safety net after the compressor: linear to 0.8, soft knee up to full scale
    const preLimit = ctx.createGain()
    preLimit.gain.value = 0.5
    const limiter = ctx.createWaveShaper()
    limiter.curve = softLimitCurve()
    limiter.oversample = '2x'
    comp.connect(preLimit)
    preLimit.connect(limiter)
    limiter.connect(ctx.destination)
    const master = ctx.createGain()
    master.connect(comp)
    const reverb = ctx.createConvolver()
    reverb.buffer = impulseResponse(ctx, 1.8)
    reverb.connect(master)
    const sfx = ctx.createGain()
    sfx.connect(master)
    const sfxSend = ctx.createGain()
    sfxSend.gain.value = SFX_REVERB_SEND
    sfx.connect(sfxSend)
    sfxSend.connect(reverb)
    const ui = ctx.createGain()
    ui.connect(master)
    const music = ctx.createGain()
    music.connect(master)
    const musicSend = ctx.createGain()
    musicSend.gain.value = MUSIC_REVERB_SEND
    music.connect(musicSend)
    musicSend.connect(reverb)
    this.g = { ctx, synth, master, sfx, ui, music }
    this.applyVolumes(true)
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    this.applyMusic()
  }

  setVolumes(v: Volumes): void {
    this.vol = { ...v }
    this.applyVolumes(false)
  }

  private applyVolumes(immediate: boolean): void {
    const g = this.g
    if (!g) return
    const now = g.ctx.currentTime
    const set = (p: AudioParam, v: number) => {
      if (immediate) p.setValueAtTime(v, now)
      else {
        p.cancelScheduledValues(now)
        p.setValueAtTime(p.value, now)
        p.setTargetAtTime(v, now, RAMP)
      }
    }
    set(g.master.gain, this.vol.muted ? 0 : curve(this.vol.master))
    set(g.sfx.gain, curve(this.vol.sfx))
    set(g.ui.gain, curve(this.vol.sfx) * 0.8)
    set(g.music.gain, curve(this.vol.music) * MUSIC_LEVEL)
  }

  playEvents(events: readonly SimEvent[], listener: ListenerLike): void {
    for (const e of events) {
      if (e.type === 'phase' && (e.phase === 'fight' || e.phase === 'shop')) {
        this.shrinks = 0
        this.current?.setIntensity(0)
      } else if (e.type === 'arenaShrink') {
        this.shrinks++
        this.current?.setIntensity(this.shrinks / 8)
      }
    }
    if (!this.ready || events.length === 0) return
    for (const c of planEvents(events, listener)) this.play(c)
  }

  ui(id: SfxId): void {
    // UI sounds come from gestures: a good moment to resume a suspended context
    if (this.g && this.g.ctx.state === 'suspended') this.g.ctx.resume().catch(() => {})
    this.play({ id, gain: 1, pan: 0 })
  }

  play(c: SoundCue): void {
    const g = this.g
    if (!g || g.ctx.state !== 'running' || this.vol.muted) return
    const spec = VOICES[c.id]
    const now = g.ctx.currentTime
    const ends = (this.voiceEnds.get(c.id) ?? []).filter((e) => e > now)
    this.voiceEnds.set(c.id, ends)
    if (ends.length >= spec.max) return
    if (spec.minGap !== undefined && now - (this.lastStart.get(c.id) ?? -Infinity) < spec.minGap) return
    let total = 0
    for (const list of this.voiceEnds.values()) for (const e of list) if (e > now) total++
    if (total >= MAX_VOICES) return

    const t = now + 0.005 + (c.delay ?? 0)
    const out = g.ctx.createGain()
    out.gain.value = c.gain * spec.level
    let tail: AudioNode = out
    if (c.pan !== 0 && typeof g.ctx.createStereoPanner === 'function') {
      const p = g.ctx.createStereoPanner()
      p.pan.value = c.pan
      out.connect(p)
      tail = p
    }
    tail.connect(spec.bus === 'ui' ? g.ui : g.sfx)
    let dur = 0.5
    try {
      dur = RECIPES[c.id](g.synth, out, t, c.param ?? 0)
    } catch {
      // a broken recipe must never take the game down
    }
    ends.push(t + dur)
    this.lastStart.set(c.id, now)
    setTimeout(
      () => {
        out.disconnect()
        if (tail !== out) tail.disconnect()
      },
      (t - now + dur + 0.3) * 1000,
    )
  }

  music(track: MusicTrack | 'none'): void {
    this.desiredTrack = track
    this.applyMusic()
  }

  private applyMusic(): void {
    const g = this.g
    if (!g) return
    const track = this.desiredTrack
    if ((this.current?.track ?? 'none') === track) return
    if (this.current) {
      this.current.release(1.6)
      this.fading.push(this.current)
      this.current = null
    }
    if (track !== 'none') {
      const layer = new MusicLayer(g.synth, g.music, track)
      layer.setIntensity(track === 'fight' ? this.shrinks / 8 : 0)
      layer.fadeTo(1, 2)
      this.current = layer
    }
    if (!this.timer) this.timer = setInterval(() => this.pump(), 50)
  }

  /** Lookahead scheduler for music steps. Stops itself when nothing plays. */
  private pump(): void {
    const g = this.g
    if (!g) return
    if (g.ctx.state === 'running') this.current?.schedule(g.ctx.currentTime + 0.25)
    this.fading = this.fading.filter((l) => !l.stopped)
    if (!this.current && this.fading.length === 0 && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

/** Small dark room: decaying stereo noise, darker toward the tail. */
function impulseResponse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    let lp = 0
    for (let i = 0; i < len; i++) {
      const x = i / len
      const k = 0.15 + 0.8 * x // more smoothing later = darker tail
      lp += (Math.random() * 2 - 1 - lp) * (1 - k)
      d[i] = lp * Math.pow(1 - x, 3) * (i < ctx.sampleRate * 0.01 ? i / (ctx.sampleRate * 0.01) : 1)
    }
  }
  return buf
}

/**
 * WaveShaper curve over input [-2, 2] (fed through a 0.5 pre-gain): identity below 0.8,
 * then a tanh knee approaching 1.0, so overlapping blasts never hard-clip.
 */
function softLimitCurve(): Float32Array<ArrayBuffer> {
  const n = 2048
  const c = new Float32Array(new ArrayBuffer(n * 4))
  for (let i = 0; i < n; i++) {
    const v = ((i / (n - 1)) * 2 - 1) * 2
    const a = Math.abs(v)
    const y = a < 0.8 ? a : 0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2)
    c[i] = Math.sign(v) * y
  }
  return c
}
