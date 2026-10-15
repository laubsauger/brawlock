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
import { flightPath, newCueMemory, planEvents, type ListenerLike, type SoundCue } from './events'
import { createSynth, RECIPES, Voice, type SfxId, type Synth } from './synth'
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
  fireballCast: { max: 4, level: 0.75, bus: 'sfx' },
  fireballTravel: { max: 6, level: 0.36, bus: 'sfx' },
  explosion: { max: 5, level: 1.0, bus: 'sfx' },
  fizzle: { max: 3, level: 0.9, bus: 'sfx' },
  hit: { max: 5, level: 0.9, bus: 'sfx', minGap: 0.02 },
  scourgeWindup: { max: 4, level: 0.7, bus: 'sfx' },
  scourgeBlast: { max: 3, level: 1.0, bus: 'sfx' },
  teleportOut: { max: 3, level: 1.1, bus: 'sfx' },
  teleportIn: { max: 3, level: 1.0, bus: 'sfx' },
  lavaSizzle: { max: 1, level: 1.2, bus: 'sfx', minGap: 0.22 },
  death: { max: 2, level: 1.0, bus: 'sfx' },
  obstacleBreak: { max: 3, level: 0.8, bus: 'sfx' },
  shrinkRumble: { max: 1, level: 0.9, bus: 'sfx', minGap: 1 },
  // phase 'fight' event and ui('fight') both trigger it: the gap plays it once
  roundStart: { max: 1, level: 0.75, bus: 'sfx', minGap: 0.8 },
  roundWin: { max: 1, level: 0.6, bus: 'sfx', minGap: 1 },
  gameOver: { max: 1, level: 0.7, bus: 'sfx', minGap: 2 },
  castGeneric: { max: 3, level: 1.6, bus: 'sfx' },
  impact: { max: 4, level: 1.2, bus: 'sfx' },
  uiHover: { max: 2, level: 1, bus: 'ui', minGap: 0.03 },
  uiClick: { max: 2, level: 1, bus: 'ui', minGap: 0.02 },
  uiBack: { max: 2, level: 1, bus: 'ui', minGap: 0.05 },
  uiBuy: { max: 2, level: 1, bus: 'ui', minGap: 0.05 },
  uiError: { max: 1, level: 1, bus: 'ui', minGap: 0.1 },
  uiReady: { max: 1, level: 1, bus: 'ui', minGap: 0.1 },
  uiCountdown: { max: 1, level: 1, bus: 'ui', minGap: 0.2 },
  castInhale: { max: 6, level: 1.8, bus: 'sfx' },
  castSnuff: { max: 4, level: 1.2, bus: 'sfx' },
  beamZap: { max: 3, level: 1.6, bus: 'sfx' },
  tink: { max: 3, level: 1.4, bus: 'sfx' },
  reflect: { max: 3, level: 1, bus: 'sfx' },
  swapWarp: { max: 4, level: 1, bus: 'sfx' },
  chargeSlam: { max: 3, level: 0.9, bus: 'sfx' },
  ricochet: { max: 4, level: 1.3, bus: 'sfx', minGap: 0.03 },
  refresh: { max: 2, level: 1, bus: 'sfx' },
  streakTick: { max: 1, level: 1, bus: 'ui', minGap: 0.05 },
  respawnSwell: { max: 2, level: 1, bus: 'sfx' },
  shieldUp: { max: 3, level: 1, bus: 'sfx' },
  popOff: { max: 3, level: 0.9, bus: 'sfx' },
  fade: { max: 3, level: 2.5, bus: 'sfx' },
  chains: { max: 2, level: 1, bus: 'sfx' },
  ignite: { max: 2, level: 1, bus: 'sfx' },
  darkPulse: { max: 2, level: 0.5, bus: 'sfx' },
  clusterTravel: { max: 8, level: 0.57, bus: 'sfx' },
  bladeThrow: { max: 3, level: 1.76, bus: 'sfx' },
  bladeSpin: { max: 4, level: 0.37, bus: 'sfx' },
  bladeHit: { max: 3, level: 1.16, bus: 'sfx' },
  arcaneCast: { max: 3, level: 1.45, bus: 'sfx' },
  homingTravel: { max: 4, level: 0.78, bus: 'sfx' },
  arcaneBurst: { max: 3, level: 1.3, bus: 'sfx' },
  hasteUp: { max: 2, level: 1.45, bus: 'sfx' },
  slowDown: { max: 2, level: 1.22, bus: 'sfx' },
  twinCast: { max: 3, level: 1.71, bus: 'sfx' },
  twinTravel: { max: 6, level: 0.92, bus: 'sfx' },
  swapCast: { max: 3, level: 2.11, bus: 'sfx' },
  swapTravel: { max: 4, level: 0.51, bus: 'sfx' },
  drainCast: { max: 3, level: 1.88, bus: 'sfx' },
  drainTravel: { max: 4, level: 1.1, bus: 'sfx' },
  drainHit: { max: 3, level: 1.7, bus: 'sfx' },
  orbTravel: { max: 6, level: 0.98, bus: 'sfx' },
  orbAbsorb: { max: 3, level: 1.53, bus: 'sfx' },
  rechargeCast: { max: 3, level: 1.92, bus: 'sfx' },
  rechargeTravel: { max: 4, level: 1.49, bus: 'sfx' },
  zapHit: { max: 4, level: 1.97, bus: 'sfx' },
  bouncerCast: { max: 3, level: 1.26, bus: 'sfx' },
  bouncerTravel: { max: 4, level: 1.5, bus: 'sfx' },
  bounceZap: { max: 4, level: 1.74, bus: 'sfx', minGap: 0.03 },
  dashBurst: { max: 3, level: 0.94, bus: 'sfx' },
  redirect: { max: 2, level: 1.39, bus: 'sfx' },
  meteorCast: { max: 2, level: 2.22, bus: 'sfx' },
  meteorFall: { max: 3, level: 0.4, bus: 'sfx' },
  meteorImpact: { max: 2, level: 0.98, bus: 'sfx' },
  splitterCast: { max: 3, level: 1.11, bus: 'sfx' },
  splitterTravel: { max: 4, level: 1.1, bus: 'sfx' },
  childZip: { max: 8, level: 0.27, bus: 'sfx' },
  snowCast: { max: 2, level: 2.33, bus: 'sfx' },
  snowRoll: { max: 3, level: 0.29, bus: 'sfx' },
  snowGrab: { max: 3, level: 1.14, bus: 'sfx' },
  snowBurst: { max: 2, level: 1.24, bus: 'sfx' },
  gravityCast: { max: 2, level: 0.72, bus: 'sfx' },
  gravityHum: { max: 3, level: 0.16, bus: 'sfx' },
  gravityEnd: { max: 3, level: 0.74, bus: 'sfx' },
  gripCast: { max: 2, level: 2.08, bus: 'sfx' },
  gripTravel: { max: 3, level: 1.19, bus: 'sfx' },
  warpCast: { max: 2, level: 1.2, bus: 'sfx' },
  warpHum: { max: 3, level: 0.88, bus: 'sfx' },
  magnetCast: { max: 2, level: 1.19, bus: 'sfx' },
  magnetTravel: { max: 3, level: 0.37, bus: 'sfx' },
  magnetOn: { max: 3, level: 0.36, bus: 'sfx' },
  pillarRise: { max: 3, level: 0.92, bus: 'sfx' },
  linkCast: { max: 2, level: 1.42, bus: 'sfx' },
  linkTravel: { max: 3, level: 2.54, bus: 'sfx' },
  linkLoop: { max: 4, level: 3.37, bus: 'sfx' },
  altArm: { max: 3, level: 1.68, bus: 'sfx' },
  flare: { max: 3, level: 3.2, bus: 'sfx' },
}

const MAX_VOICES = 40
/**
 * Bus calibration at default settings (master 0.8, sfx 1, music 0.6), measured from
 * offline renders of the production graph (see docs in busGains): a busy fight lands near
 * -16 LUFS with peaks held at about -3 dBFS by the limiter; menu / shop music near -19 LUFS.
 */
export const SFX_LEVEL = 0.6
export const UI_LEVEL = 0.8
export const MUSIC_LEVEL = 2.9
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

export interface Graph {
  ctx: BaseAudioContext
  synth: Synth
  master: GainNode
  sfx: GainNode
  ui: GainNode
  music: GainNode
}

/** Bus gains for the user's volume settings (pure; shared with offline level checks). */
export function busGains(v: Volumes): { master: number; sfx: number; ui: number; music: number } {
  return {
    master: v.muted ? 0 : curve(v.master),
    sfx: curve(v.sfx) * SFX_LEVEL,
    ui: curve(v.sfx) * UI_LEVEL,
    music: curve(v.music) * MUSIC_LEVEL,
  }
}

/**
 * The bus graph on any context (live, or offline for level checks):
 *
 *   voices ─▶ sfx ─┬───────────────▶ master ─▶ glue comp ─▶ limiter ─▶ soft clip ─▶ out
 *                  └▶ send ─▶ reverb ─┘ ▲
 *   ui ────────────────────────────────┘ │
 *   music layers ─▶ music ─┬─────────────┘
 *                          └▶ send ─▶ reverb
 *
 * WebAudio compressors add automatic makeup gain (0.6 x the gain they take off a full-scale
 * signal), so the limiter's threshold is set where threshold + makeup lands near -3 dBFS.
 */
export function buildGraph(ctx: BaseAudioContext): Graph {
  const synth = createSynth(ctx)
  const glue = ctx.createDynamicsCompressor()
  glue.threshold.value = -18
  glue.knee.value = 12
  glue.ratio.value = 2
  glue.attack.value = 0.01
  glue.release.value = 0.25
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -12
  limiter.knee.value = 0
  limiter.ratio.value = 20
  limiter.attack.value = 0.001
  limiter.release.value = 0.12
  // last resort for what the limiter's attack lets through: unity below 0.9, soft to 1.0
  const clip = ctx.createWaveShaper()
  clip.curve = softClipCurve()
  clip.oversample = '2x'
  glue.connect(limiter)
  limiter.connect(clip)
  clip.connect(ctx.destination)
  const master = ctx.createGain()
  master.connect(glue)
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
  return { ctx, synth, master, sfx, ui, music }
}

export class AudioEngine {
  private g: Graph | null = null
  private vol: Volumes = { master: 0.8, sfx: 1, music: 0.6, muted: false }
  private readonly voiceEnds = new Map<SfxId, number[]>()
  private readonly lastStart = new Map<SfxId, number>()
  private readonly keyed = new Map<
    string,
    { gain: GainNode; end: number; level: number; loop?: { proj: number; panner: StereoPannerNode | null; voice: Voice } }
  >()
  private readonly memory = newCueMemory()
  private resuming = false
  private readonly pending: SoundCue[] = []
  private countdown = 0
  private lastCountdown = -Infinity
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
      this.resume()
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
    this.g = buildGraph(ctx)
    this.applyVolumes(true)
    this.resume()
    this.applyMusic()
  }

  /**
   * Resume a suspended context. Cues requested while the resume is pending (the splash
   * "ready" chime right after unlock) are queued and played once it runs, not dropped.
   */
  private resume(): void {
    const g = this.g
    if (!g || g.ctx.state !== 'suspended' || this.resuming) return
    this.resuming = true
    // the engine only builds its live graph on an AudioContext (offline graphs never resume)
    ;(g.ctx as AudioContext)
      .resume()
      .then(() => {
        this.resuming = false
        const queued = this.pending.splice(0)
        for (const c of queued) this.play(c)
      })
      .catch(() => {
        this.resuming = false
      })
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
    const b = busGains(this.vol)
    set(g.master.gain, b.master)
    set(g.sfx.gain, b.sfx)
    set(g.ui.gain, b.ui)
    set(g.music.gain, b.music)
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
    if (!this.ready) return
    if (events.length > 0) for (const c of planEvents(events, listener, this.memory)) this.play(c)
    this.followLoops(listener)
  }

  /**
   * Re-aim travel loops at where their projectiles are now (curving Boomerang, Homing,
   * redirected bolts). Runs on every playEvents call; between calls a loop keeps
   * extrapolating its last straight flight.
   */
  private followLoops(listener: ListenerLike): void {
    const projectiles = listener.state?.projectiles
    const g = this.g
    if (!projectiles || !g) return
    const now = g.ctx.currentTime
    for (const [key, kv] of this.keyed) {
      if (!kv.loop) continue
      if (kv.end <= now) {
        this.keyed.delete(key)
        continue
      }
      const pr = projectiles.find((q) => q.id === kv.loop!.proj)
      if (!pr) {
        this.stopKeyed(key) // gone without an event we saw
        continue
      }
      const left = Math.min(kv.end - now, 1.5)
      if (left < 0.06) continue
      const path = flightPath(pr.x, pr.y, pr.vx, pr.vy, left, listener)
      const params = [kv.gain.gain, kv.loop.panner?.pan, ...kv.loop.voice.buffers.map((b) => b.node.playbackRate)]
      for (const p of params) {
        if (!p) continue
        p.cancelScheduledValues(now)
        p.setValueAtTime(p.value, now)
      }
      for (const pt of path) {
        const at = now + pt.t + 0.02
        kv.gain.gain.linearRampToValueAtTime(pt.gain * kv.level, at)
        kv.loop.panner?.pan.linearRampToValueAtTime(pt.pan, at)
        for (const b of kv.loop.voice.buffers) b.node.playbackRate.linearRampToValueAtTime(b.speed * pt.rate, at)
      }
    }
  }

  ui(id: SfxId): void {
    // UI sounds come from gestures: a good moment to resume a suspended context
    this.resume()
    this.play({ id, gain: 1, pan: 0 })
  }

  /** Settings "Test sound": unlock if needed, then a short reference through the SFX path. */
  test(): void {
    this.unlock()
    this.play({ id: 'uiReady', gain: 1, pan: 0 })
    this.play({ id: 'fireballCast', gain: 1, pan: -0.4, delay: 0.25 })
    this.play({ id: 'explosion', gain: 1, pan: 0.4, param: 1, delay: 0.75 })
  }

  play(c: SoundCue): void {
    const g = this.g
    if (!g) return
    if (g.ctx.state !== 'running') {
      // right after a gesture the context may still be resuming: keep a few cues for it
      if (this.resuming && this.pending.length < 8) this.pending.push(c)
      return
    }
    if (c.stopKey) this.stopKeyed(c.stopKey)
    if (c.id === null || this.vol.muted) return
    const id = c.id
    const spec = VOICES[id]
    const now = g.ctx.currentTime
    const ends = (this.voiceEnds.get(id) ?? []).filter((e) => e > now)
    this.voiceEnds.set(id, ends)
    if (ends.length >= spec.max) return
    if (spec.minGap !== undefined && now - (this.lastStart.get(id) ?? -Infinity) < spec.minGap) return
    let total = 0
    for (const list of this.voiceEnds.values()) for (const e of list) if (e > now) total++
    if (total >= MAX_VOICES) return

    const t = now + 0.005 + (c.delay ?? 0)
    const out = g.ctx.createGain()
    out.gain.value = c.gain * spec.level
    let tail: AudioNode = out
    let panner: StereoPannerNode | null = null
    if ((c.pan !== 0 || c.path) && typeof g.ctx.createStereoPanner === 'function') {
      panner = g.ctx.createStereoPanner()
      panner.pan.value = c.pan
      out.connect(panner)
      tail = panner
    }
    tail.connect(spec.bus === 'ui' ? g.ui : g.sfx)
    const param = id === 'uiCountdown' ? this.countdownStep(now) : (c.param ?? 0)
    const v = new Voice(g.synth, out, t)
    try {
      RECIPES[id](v, param)
    } catch {
      // a broken recipe must never take the game down
    }
    const dur = Math.max(0.05, v.stopAt - t)
    if (c.path && c.path.length > 1) {
      // a moving source: follow its flight (pan, distance) and bend its rate (Doppler)
      out.gain.setValueAtTime(out.gain.value, t)
      for (const pt of c.path) {
        const at = t + pt.t
        out.gain.linearRampToValueAtTime(pt.gain * spec.level, at)
        panner?.pan.linearRampToValueAtTime(pt.pan, at)
        for (const b of v.buffers) b.node.playbackRate.linearRampToValueAtTime(b.speed * pt.rate, at)
      }
    }
    ends.push(t + dur)
    this.lastStart.set(id, now)
    if (c.key) {
      this.stopKeyed(c.key)
      const proj = c.key.startsWith('proj:') ? Number(c.key.slice(5)) : Number.NaN
      this.keyed.set(c.key, {
        gain: out,
        end: t + dur,
        level: spec.level,
        loop: Number.isFinite(proj) ? { proj, panner, voice: v } : undefined,
      })
    }
    setTimeout(
      () => {
        out.disconnect()
        if (tail !== out) tail.disconnect()
      },
      (t - now + dur + 0.3) * 1000,
    )
  }

  /** "3, 2, 1": consecutive countdown blips climb in pitch. */
  private countdownStep(now: number): number {
    this.countdown = now - this.lastCountdown < 1.6 ? this.countdown + 1 : 0
    this.lastCountdown = now
    return this.countdown
  }

  /** Cut a keyed voice (cancelled windup, projectile that hit) with a fast fade, no click. */
  private stopKeyed(key: string): void {
    const v = this.keyed.get(key)
    if (!v || !this.g) return
    this.keyed.delete(key)
    const now = this.g.ctx.currentTime
    if (v.end <= now) return
    v.gain.gain.cancelScheduledValues(now)
    v.gain.gain.setValueAtTime(v.gain.gain.value, now)
    v.gain.gain.setTargetAtTime(0, now, 0.015)
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

/** Identity below 0.9, then a tanh knee that reaches 1.0 at full scale. */
function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 2048
  const c = new Float32Array(new ArrayBuffer(n * 4))
  for (let i = 0; i < n; i++) {
    const v = (i / (n - 1)) * 2 - 1
    const a = Math.abs(v)
    c[i] = Math.sign(v) * (a < 0.9 ? a : 0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1))
  }
  return c
}
