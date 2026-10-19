/**
 * Showcase soundtrack: renders the game's own audio engine (SFX, music, lava bed) offline,
 * in sync with the captured video. Every shot's sim is replayed exactly as the director
 * drives it during capture (same speed curve, same camera), so each tick's events land on
 * the video frame that shows them. Runs in a page (audio.html) on an OfflineAudioContext.
 */
import { AudioEngine, buildGraph } from '../../audio/engine'
import { ASSET_BASE } from '../../lib/assets'
import type { SimEvent, SimState } from '../../sim/types'
import { camOverride } from './camRig'
import { Director, VIDEO_FPS } from './director'
import { shotById } from './shots'

export interface AudioCue {
  /** seconds on the edit timeline */
  t: number
  events: SimEvent[]
  listener: { x: number; y: number; halfWidth: number; localPlayer: number; state: Pick<SimState, 'pawns' | 'projectiles' | 'arena'> }
}

/** Replay a shot and collect, per video frame, the events the renderer consumed. */
export function shotCues(id: string, start: number): { cues: AudioCue[]; dur: number } {
  const spec = shotById(id)
  const d = new Director(spec, null)
  d.attach()
  const out: AudioCue[] = []
  const frames = d.frames
  for (let k = 1; k <= frames; k++) {
    const before = d.sim.log.length
    d.advance(0)
    const evs = d.sim.log.slice(before).map((l) => l.e)
    const pose = camOverride.pose!
    const dist = Math.hypot(pose.x - pose.tx, pose.y - pose.ty, pose.h - pose.th)
    const half = dist * Math.tan(((pose.fov * Math.PI) / 180) / 2) * (16 / 9)
    const s = d.sim.curr
    out.push({
      t: start + (k - 1) / VIDEO_FPS,
      events: evs,
      listener: { x: pose.tx, y: pose.ty, halfWidth: half, localPlayer: spec.localPlayer ?? 0, state: { pawns: s.pawns, projectiles: s.projectiles, arena: s.arena } },
    })
  }
  return { cues: out, dur: frames / VIDEO_FPS }
}

type EngineInternals = {
  g: { sfx: GainNode; ui: GainNode; music: GainNode } | unknown
  modeNow: 'synth' | 'hybrid'
  current: unknown
  applyVolumes(immediate: boolean): void
  applyAmbience(kind: 'match' | 'menu' | null): void
  pump(): void
  play(c: { id: string; gain: number; pan: number; param?: number; delay?: number }): void
}

/** An OfflineAudioContext the engine accepts as a running live context. */
function liveFacade(ctx: OfflineAudioContext): BaseAudioContext {
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop === 'state') return 'running'
      const v = Reflect.get(target, prop, target)
      return typeof v === 'function' ? v.bind(target) : v
    },
  }) as unknown as BaseAudioContext
}

/**
 * No music anywhere (user rule): the fight / menu tracks never start, and the round
 * stingers (roundWin brass, gameOver horn, the FIGHT power chord on 'phase') are dropped.
 * Every spell / impact / death SFX and the lava ambience stay at full level.
 */
const MUSICAL_EVENTS = new Set<SimEvent['type']>(['roundWin', 'gameOver', 'phase'])

/** Intro swell built from game SFX only (shot-relative seconds) for the branded intro. */
const BRAND_SFX: { t: number; id: string; gain: number; param?: number }[] = [
  { t: 0.15, id: 'shrinkRumble', gain: 0.55 },
  { t: 0.35, id: 'meteorFall', gain: 0.7, param: 1.15 },
  { t: 1.5, id: 'meteorImpact', gain: 0.75 },
  { t: 1.52, id: 'scourgeBlast', gain: 0.45, param: 3 },
  { t: 2.1, id: 'shrinkRumble', gain: 0.35 },
  { t: 4.68, id: 'teleportOut', gain: 0.55 },
]

export interface RenderOpts {
  edit: string[]
  sampleRate?: number
  mode?: 'synth' | 'hybrid'
  /** verification: silence the SFX and UI buses (only a music bus could then be heard) */
  muteSfx?: boolean
  /** the lava ambience bed (default on; a trailer under its own music leaves it out) */
  ambience?: boolean
}

/** Render the whole edit's soundtrack. Returns interleaved 16-bit PCM WAV bytes. */
export async function renderSoundtrack(o: RenderOpts): Promise<{ wav: Uint8Array; dur: number; cues: number; musicStarted: boolean }> {
  let start = 0
  const all: AudioCue[] = []
  const brandAt: number[] = []
  for (const id of o.edit) {
    if (id === 'brand') brandAt.push(start)
    const { cues, dur } = shotCues(id, start)
    for (const c of cues) c.events = c.events.filter((e) => !MUSICAL_EVENTS.has(e.type))
    all.push(...cues)
    start += dur
  }
  const total = start
  const sr = o.sampleRate ?? 48000
  const ctx = new OfflineAudioContext(2, Math.ceil((total + 0.5) * sr), sr)
  const facade = liveFacade(ctx)
  const engine = new AudioEngine()
  const eng = engine as unknown as EngineInternals
  eng.g = buildGraph(facade)
  eng.modeNow = o.mode ?? 'hybrid'
  eng.applyVolumes(true)
  if (o.muteSfx) {
    const g = eng.g as { sfx: GainNode; ui: GainNode }
    g.sfx.gain.value = 0
    g.ui.gain.value = 0
  }
  if (eng.modeNow === 'hybrid') await engine.samples.load(facade, ASSET_BASE)
  // real-time timers would fire against the wall clock, not the offline timeline: the engine
  // only uses them to disconnect finished nodes (GC does that) and to pump the beds (done below)
  const realTimeout = window.setTimeout
  const realInterval = window.setInterval
  ;(window as unknown as { setTimeout: unknown }).setTimeout = () => 0
  ;(window as unknown as { setInterval: unknown }).setInterval = () => 0
  try {
    // lava ambience only (no music track)
    if (o.ambience !== false) eng.applyAmbience('match')
    const ambOut = total - 2.2
    let released = false
    const extra = new Map<number, { id: string; gain: number; param?: number }[]>()
    for (const b of brandAt) {
      for (const x of BRAND_SFX) {
        const k = Math.round((b + x.t) * 60)
        extra.set(k, [...(extra.get(k) ?? []), x])
      }
    }
    // one suspend per video frame: events, travel-loop following, ambience lookahead
    for (const cue of all) {
      void ctx.suspend(Math.max(128 / sr, cue.t)).then(() => {
        if (!released && cue.t >= ambOut && o.ambience !== false) {
          eng.applyAmbience(null)
          released = true
        }
        for (const x of extra.get(Math.round(cue.t * 60)) ?? []) eng.play({ id: x.id, gain: x.gain, pan: 0, param: x.param })
        engine.playEvents(cue.events, cue.listener)
        eng.pump()
        void ctx.resume()
      })
    }
    const buf = await ctx.startRendering()
    return { wav: toWav(buf), dur: total, cues: all.length, musicStarted: eng.current != null }
  } finally {
    window.setTimeout = realTimeout
    window.setInterval = realInterval
  }
}

function toWav(buf: AudioBuffer): Uint8Array {
  const n = buf.length
  const ch = buf.numberOfChannels
  const data = new DataView(new ArrayBuffer(44 + n * ch * 2))
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i))
  }
  w(0, 'RIFF')
  data.setUint32(4, 36 + n * ch * 2, true)
  w(8, 'WAVE')
  w(12, 'fmt ')
  data.setUint32(16, 16, true)
  data.setUint16(20, 1, true)
  data.setUint16(22, ch, true)
  data.setUint32(24, buf.sampleRate, true)
  data.setUint32(28, buf.sampleRate * ch * 2, true)
  data.setUint16(32, ch * 2, true)
  data.setUint16(34, 16, true)
  w(36, 'data')
  data.setUint32(40, n * ch * 2, true)
  const chans = Array.from({ length: ch }, (_, i) => buf.getChannelData(i))
  let o = 44
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]))
      data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true)
      o += 2
    }
  }
  return new Uint8Array(data.buffer)
}
