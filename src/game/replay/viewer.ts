/**
 * Replay viewer runtime: re-simulates a replay (ReplayPlayer) and feeds the same frame
 * buffer and event log a live match does, so the match scene, the score plate and the
 * kill feed show it unchanged. Playback runs on animation frames at 0.25x..4x; seeking
 * resets the frame buffer (render and HUD rewind on a backward tick) and lands on the
 * exact re-simulated state.
 *
 * Camera: follow any player (frame.localPlayer = that player) or a free camera
 * (frame.localPlayer = -1 with a focus point the screen pans; `cameraFocus` sink).
 * No input is attached and nothing is sent anywhere: a replay is read-only.
 */
import { cloneState } from '../../sim'
import { DT, setTickRate, type PlayerId, type SimEvent, type SimState } from '../../sim/types'
import { frame, pushEvents, pushState, resetFrame } from '../frame'
import type { ReplayData, ReplayMeta } from './format'
import { ReplayPlayer, type Desync } from './player'
import { replays, type ReplayLibrary } from './store'

declare const __NET_ID__: string
/** this build's sim / netcode id (replays from another one do not play) */
export const BUILD_NET_ID: string = typeof __NET_ID__ === 'string' ? __NET_ID__ : 'dev'

export const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4] as const
/** above this speed replays play silently (sound would be a blur) */
const AUDIO_MAX_SPEED = 2
/** most ticks one animation frame may advance (4x at 30 fps = 8) */
const MAX_TICKS_PER_FRAME = 12
/** audio listener half-width, game units (same as the live session) */
const LISTENER_HALF_WIDTH = 1200

export type ViewerStatus = 'idle' | 'loading' | 'ready' | 'mismatch' | 'missing'

/**
 * Structural viewer state for React (useSyncExternalStore). It changes on load, play /
 * pause, speed, follow, seek and desync only, never per frame: the live tick is
 * `replayViewer.tick()`, read from the animation loop.
 */
export interface ViewerView {
  status: ViewerStatus
  id: string | null
  playing: boolean
  speed: number
  /** tick at the last structural change (seek / pause / end); live: tick() */
  tick: number
  startTick: number
  endTick: number
  desync: Desync | null
  /** followed player, -1 = free camera */
  follow: PlayerId
  /** the replay's slots / markers (empty until loaded) */
  slots: ReplayData['slots']
  rounds: ReplayData['rounds']
  kills: ReplayData['kills']
  /** netcode id the replay was recorded with (shown when it does not match) */
  netId: string | null
}

export interface ViewerSinks {
  /** play a tick's events as sound */
  audio?: (events: SimEvent[], listener: { x: number; y: number; halfWidth: number; localPlayer: PlayerId; state: SimState }) => void
  /** free camera focus (null = follow mode) */
  cameraFocus?: (p: { x: number; y: number } | null) => void
}

const IDLE: ViewerView = {
  status: 'idle',
  id: null,
  playing: false,
  speed: 1,
  tick: 0,
  startTick: 0,
  endTick: 0,
  desync: null,
  follow: -1,
  slots: [],
  rounds: [],
  kills: [],
  netId: null,
}

export class ReplayViewer {
  private view: ViewerView = IDLE
  private player: ReplayPlayer | null = null
  private readonly listeners = new Set<() => void>()
  private raf = 0
  private last = 0
  private acc = 0
  private focus = { x: 0, y: 0 }
  sinks: ViewerSinks = {}
  private readonly lib: ReplayLibrary
  private readonly netId: string

  constructor(lib: ReplayLibrary = replays, netId = BUILD_NET_ID) {
    this.lib = lib
    this.netId = netId
  }

  get(): ViewerView {
    return this.view
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private set(p: Partial<ViewerView>): void {
    this.view = { ...this.view, ...p }
    for (const cb of this.listeners) cb()
  }

  /** Load a stored replay by id. */
  async open(id: string): Promise<ViewerStatus> {
    this.close()
    this.set({ ...IDLE, status: 'loading', id })
    const d = await this.lib.load(id)
    if (this.view.id !== id) return this.view.status // closed or replaced meanwhile
    if (!d) {
      this.set({ status: 'missing' })
      return 'missing'
    }
    return this.openData(d)
  }

  /** Load a replay (from the library or an imported file). */
  openData(d: ReplayData): ViewerStatus {
    this.stop()
    const p = new ReplayPlayer(d, this.netId)
    const base = { id: d.id, slots: d.slots, rounds: d.rounds, kills: d.kills, netId: d.netId, startTick: p.startTick, endTick: p.endTick, tick: p.tick }
    if (!p.playable) {
      this.player = null
      this.set({ ...IDLE, ...base, status: 'mismatch' })
      return 'mismatch'
    }
    // the recorded rate: playback steps and its tick timeline mean the recorded seconds
    setTickRate(d.hz)
    this.player = p
    const follow = d.slots.some((s) => s.id === d.localPlayer) ? d.localPlayer : (d.slots[0]?.id ?? -1)
    this.set({ ...IDLE, ...base, status: 'ready', follow, playing: false, speed: 1 })
    this.applyCamera()
    this.restart()
    return 'ready'
  }

  close(): void {
    this.stop()
    this.player = null
    this.sinks.cameraFocus?.(null)
    if (this.view.status !== 'idle') resetFrame()
    this.set(IDLE)
  }

  play(): void {
    if (!this.player) return
    if (this.player.done) this.seek(this.player.startTick)
    this.set({ playing: true })
    this.start()
  }

  pause(): void {
    this.set({ playing: false, tick: this.tick() })
    this.stop()
  }

  toggle(): void {
    if (this.view.playing) this.pause()
    else this.play()
  }

  setSpeed(speed: number): void {
    const s = REPLAY_SPEEDS.reduce((a, b) => (Math.abs(b - speed) < Math.abs(a - speed) ? b : a), 1 as number)
    this.set({ speed: s })
  }

  /** Jump to a tick (re-simulated from the nearest keyframe). */
  seek(tick: number): void {
    const p = this.player
    if (!p) return
    p.seek(tick)
    this.acc = 0
    this.restart()
  }

  /** Follow a player (camera, HUD perspective), or -1 for the free camera. */
  follow(player: PlayerId): void {
    if (player >= 0 && !this.view.slots.some((s) => s.id === player)) return
    if (player < 0) {
      const pawn = this.player?.state.pawns.find((q) => q.owner === this.view.follow)
      this.focus = { x: pawn?.x ?? 0, y: pawn?.y ?? 0 }
    }
    this.set({ follow: player })
    this.applyCamera()
  }

  /** Free camera: move the focus by (dx, dy) game units. */
  pan(dx: number, dy: number): void {
    if (this.view.follow >= 0) return
    this.focus = { x: this.focus.x + dx, y: this.focus.y + dy }
    this.sinks.cameraFocus?.({ ...this.focus })
  }

  /**
   * Advance playback by `seconds` of wall time (the animation loop calls this; tests too).
   * Returns the ticks stepped.
   */
  advance(seconds: number): number {
    const p = this.player
    if (!p || !this.view.playing) return 0
    this.acc += Math.max(0, seconds) * this.view.speed
    let n = 0
    const sound = this.view.speed <= AUDIO_MAX_SPEED
    while (this.acc >= DT && n < MAX_TICKS_PER_FRAME && !p.done) {
      this.acc -= DT
      const events = p.stepOnce()
      n++
      if (events.length) {
        pushEvents(p.tick, events.slice())
        if (sound) this.sinks.audio?.(events, this.listener(p.state))
      }
    }
    if (this.acc > DT * MAX_TICKS_PER_FRAME) this.acc = 0 // fell behind: drop the backlog
    if (n > 0) {
      pushState(cloneState(p.state))
      // notify React only on structural changes (a desync, the end); the tick is live data
      if (p.done) {
        this.set({ tick: p.tick, desync: p.desync, playing: false })
        this.stop()
      } else if (p.desync !== this.view.desync) this.set({ desync: p.desync })
    }
    return n
  }

  /** Live replay tick (per frame; read it from the animation loop, not React state). */
  tick(): number {
    return this.player?.tick ?? this.view.tick
  }

  /** Current re-simulated state (null before a replay is loaded). */
  state(): SimState | null {
    return this.player?.state ?? null
  }

  private listener(s: SimState) {
    const follow = this.view.follow
    const pawn = follow >= 0 ? s.pawns.find((q) => q.owner === follow) : undefined
    const at = pawn ?? this.focus
    return { x: at.x, y: at.y, halfWidth: LISTENER_HALF_WIDTH, localPlayer: follow, state: s }
  }

  private applyCamera(): void {
    frame.localPlayer = this.view.follow
    this.sinks.cameraFocus?.(this.view.follow < 0 ? { ...this.focus } : null)
  }

  /** Show the player's current state from a clean frame buffer (after load / seek). */
  private restart(): void {
    const p = this.player
    if (!p) return
    resetFrame()
    // twice: render interpolates between prev and curr, both must be this state
    pushState(cloneState(p.state))
    pushState(cloneState(p.state))
    this.set({ tick: p.tick, desync: p.desync })
  }

  private start(): void {
    if (this.raf || typeof requestAnimationFrame !== 'function') return
    this.last = performance.now()
    const loop = () => {
      this.raf = requestAnimationFrame(loop)
      const now = performance.now()
      this.advance(Math.min(0.25, (now - this.last) / 1000))
      this.last = now
    }
    this.raf = requestAnimationFrame(loop)
  }

  private stop(): void {
    if (this.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf)
    this.raf = 0
    this.acc = 0
  }
}

/** The app's replay viewer. */
export const replayViewer = new ReplayViewer()

export type { ReplayMeta }
