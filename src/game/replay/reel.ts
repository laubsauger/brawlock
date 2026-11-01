/**
 * The results reel (docs/moonshot/specs/results-reel.md): the match's best moments, played on the
 * results screen through the Final Blow's camera before the board. This module picks the reel,
 * plans each moment, and steps a private replay player for it; the render side plays it
 * (src/render/reelPlayback.ts) and the results screen frames it (src/ui/screens/ResultsReel.tsx).
 */
import { cloneState } from '../../sim/snapshot'
import { ticks } from '../../sim/config'
import type { PlayerId, SimEvent, SimState } from '../../sim/types'
import type { FinalBlowPlan, FinalBlowSegment, FinalBlowShot } from '../finalBlow'
import type { Moment, MomentCamera } from '../moments'
import { useGame, type ReelView } from '../store'
import type { ReplayData } from './format'
import { ReplayPlayer } from './player'

export const REEL_SIZE = 3
/** a moment needs this reel score to play */
export const REEL_MIN_SCORE = 1
/** the local player's own moments count this much more */
export const REEL_LOCAL_WEIGHT = 1.5
/** a third moment by one player only when nothing else qualifies */
export const REEL_MAX_PER_ACTOR = 2
/** one moment shows at most this much match time (s) */
export const REEL_MOMENT_MAX = 6
/** the letterbox closes this long between moments (s) */
export const REEL_GAP = 0.4
/** preparing a moment (re-simulating to it) takes at most this much of a frame (ms) */
export const PREPARE_BUDGET_MS = 6

/** The reel score: the moment's score, more for the local player's own. */
export function reelScore(m: Moment, local: PlayerId): number {
  const mine = local >= 0 && (m.actors.includes(local) || m.victims.includes(local))
  return m.score * (mine ? REEL_LOCAL_WEIGHT : 1)
}

/**
 * Up to REEL_SIZE moments by reel score: no two windows overlap, a third by the same first actor
 * only when nothing else qualifies, nothing under REEL_MIN_SCORE; the match decider is left out
 * when its Final Blow was watched to the end. In match order.
 */
export function selectReel(moments: readonly Moment[], local: PlayerId, opts: { excludeDecider: boolean }): Moment[] {
  const candidates = moments
    .filter((m) => m.final && !(opts.excludeDecider && m.traits.includes('matchDecider')) && reelScore(m, local) >= REEL_MIN_SCORE)
    .sort((a, b) => reelScore(b, local) - reelScore(a, local) || a.id - b.id)
  const picked: Moment[] = []
  const overlaps = (m: Moment) => picked.some((p) => m.from < p.to && p.from < m.to)
  const byActor = (actor: PlayerId) => picked.filter((p) => p.actors[0] === actor).length
  for (const capped of [true, false]) {
    for (const m of candidates) {
      if (picked.length >= REEL_SIZE) break
      if (picked.includes(m) || overlaps(m)) continue
      if (capped && byActor(m.actors[0]) >= REEL_MAX_PER_ACTOR) continue
      picked.push(m)
    }
  }
  return picked.sort((a, b) => a.tick - b.tick || a.id - b.id)
}

/** A planned reel moment: segments in the Final Blow's plan shape, and who the camera frames. */
export interface ReelShot {
  moment: Moment
  plan: FinalBlowPlan
  camera: MomentCamera
}

/**
 * Plan one moment (spec Rule 6). `deciderOf` finds a round's decider (a clutch plays its round's
 * decisive hit at the end).
 */
export function planReelMoment(m: Moment, deciderOf: (round: number) => Moment | null, reducedMotion: boolean): ReelShot {
  const t = (s: number) => ticks(s)
  const segments: FinalBlowSegment[] = []
  const seg = (from: number, to: number, speed: number, shot: FinalBlowShot = 'push') => {
    if (to > from) segments.push({ from, to, speed: reducedMotion ? 1 : speed, shot })
  }
  /** a knockout as the Final Blow's round plan, with `runUp` seconds before the hit */
  const knockout = (k: Moment, runUp: number) => {
    const H = k.tick
    const D = Math.max(k.end, H)
    seg(H - t(runUp), H + t(0.5), 0.5)
    if (D <= H + t(1)) seg(H + t(0.5), D + t(0.1), 1)
    else seg(D - t(0.4), D + t(0.2), 1, 'death')
  }
  let camera = m.camera
  let hit = m.tick
  let death = m.end
  switch (m.kind) {
    case 'knockout':
      knockout(m, 0.5)
      break
    case 'multiKnockout': {
      const end = m.end + t(0.3)
      if (end - m.from <= t(REEL_MOMENT_MAX)) {
        seg(m.from, m.tick - t(0.4), 1)
        seg(m.tick - t(0.4), m.tick + t(0.4), 0.5)
        seg(m.tick + t(0.4), end, 1)
      } else {
        // links cut together: the first at half speed, then the last
        seg(m.from, m.tick - t(0.4), 1)
        seg(m.tick - t(0.4), m.tick + t(0.4), 0.5)
        seg(Math.max(m.tick + t(0.4), m.end - t(2)), end, 1, 'death')
      }
      break
    }
    case 'denied': {
      const T = m.tick
      const start = Math.max(m.from + t(0.2), T - t(REEL_MOMENT_MAX - 1))
      seg(start, T - t(0.4), 1)
      seg(T - t(0.4), T + t(0.3), 0.5)
      seg(T + t(0.3), T + t(0.8), 1)
      break
    }
    case 'clutch': {
      const d = deciderOf(m.round)
      if (d) {
        seg(d.tick - t(4), d.tick - t(0.3), 1)
        knockout(d, 0.3)
        camera = d.camera
        hit = d.tick
        death = d.end
      } else seg(m.to - t(REEL_MOMENT_MAX - 1), m.to, 1)
      break
    }
    case 'closeCall':
      seg(m.tick - t(0.3), m.tick + t(0.5), 0.6)
      seg(m.tick + t(0.5), m.tick + t(1.5), 1)
      break
  }
  const seconds = segments.reduce((n, s) => n + (s.to - s.from) / s.speed, 0) / Math.max(1, ticks(1))
  return {
    moment: m,
    camera,
    plan: { kind: 'round', segments, freeze: null, hero: 0, seconds, partial: false, reduced: reducedMotion, hit, death },
  }
}

/**
 * Steps a private replay player for the reel: jumps to a moment's first tick in budgeted slices
 * (from the nearest keyframe, fight starts included), then forward as playback needs ticks,
 * keeping copies of the previous and current state (the player steps in place).
 */
export class ReelPlayer {
  readonly player: ReplayPlayer
  prev: SimState | null = null
  curr: SimState | null = null
  private target = -1

  constructor(data: ReplayData, netId: string, keyframes: readonly [number, SimState][]) {
    this.player = new ReplayPlayer(data, netId)
    for (const [tick, state] of keyframes) this.player.addKeyframe(tick, state)
  }

  /** playable and true to the recording so far (a desync stops the reel) */
  get ok(): boolean {
    return this.player.playable && this.player.desync === null
  }

  /** Move toward `tick` within `budgetMs`; true once the player stands there. */
  prepare(tick: number, budgetMs: number): boolean {
    if (tick !== this.target) {
      this.target = tick
      this.player.restoreNearest(tick)
    }
    const until = performance.now() + budgetMs
    while (this.player.tick < tick && !this.player.done && this.ok) {
      this.player.stepOnce()
      if (performance.now() >= until) break
    }
    if (this.player.tick < tick && !this.player.done) return false
    this.curr = cloneState(this.player.state)
    this.prev = this.curr
    return true
  }

  /** Step until the current state reaches `tick`; each step's events, in order. */
  advance(tick: number): { tick: number; events: SimEvent[] }[] {
    const out: { tick: number; events: SimEvent[] }[] = []
    while (this.player.tick < tick && !this.player.done && this.ok) {
      const events = this.player.stepOnce()
      this.prev = this.curr
      this.curr = cloneState(this.player.state)
      out.push({ tick: this.player.tick, events: events.slice() })
    }
    return out
  }
}

export const NO_REEL: ReelView = { state: 'none', index: 0, count: 0, closed: false, available: false }

interface Prepared {
  data: ReplayData
  keyframes: readonly [number, SimState][]
  moments: readonly Moment[]
  local: PlayerId
  netId: string
}

/** A play request for the render side: the shots and their player. */
export interface ReelRequest {
  shots: ReelShot[]
  player: ReelPlayer
}

let prepared: Prepared | null = null
let playing: ReelShot[] = []
let finalBlowWatched = false
let request: ReelRequest | null = null
let stopRequested = false

function setView(p: Partial<ReelView>): void {
  useGame.setState({ reel: { ...useGame.getState().reel, ...p } })
}

/** The match's reel: prepared at match end, played on the results screen. */
export const reelSession = {
  /** the finished match's replay, fight-start states and moments (game/session.ts) */
  prepare(p: Prepared): void {
    prepared = p
    finalBlowWatched = false
    request = null
    useGame.setState({ reel: { ...NO_REEL, available: this.pick().length > 0 } })
  },
  /** play the highlights of a stored replay (the viewer): its moments, nobody weighted unless it was recorded by a player */
  playReplay(data: ReplayData, netId: string, moments: readonly Moment[], reducedMotion: boolean): boolean {
    prepared = { data, keyframes: [], moments, local: data.localPlayer, netId }
    finalBlowWatched = false
    return this.play(reducedMotion)
  },
  /** forget it (leaving the results, a new match) */
  clear(): void {
    prepared = null
    request = null
    stopRequested = this.view().state === 'playing'
    useGame.setState({ reel: NO_REEL })
  },
  /** the match Final Blow ended: watched to its end or not (spec Rule 4) */
  noteFinalBlow(kind: 'round' | 'match', completed: boolean): void {
    if (kind !== 'match') return
    finalBlowWatched = completed
    if (prepared) setView({ available: this.pick().length > 0 })
  },
  pick(): Moment[] {
    return prepared ? selectReel(prepared.moments, prepared.local, { excludeDecider: finalBlowWatched }) : []
  },
  view(): ReelView {
    return useGame.getState().reel
  },
  /** play the highlights (autoplay on results, or Watch highlights) */
  play(reducedMotion: boolean): boolean {
    if (!prepared) return false
    const picks = this.pick()
    if (picks.length === 0) return false
    const deciders = new Map<number, Moment>()
    for (const m of prepared.moments) if (m.traits.includes('roundDecider')) deciders.set(m.round, m)
    const shots = picks.map((m) => planReelMoment(m, (r) => deciders.get(r) ?? null, reducedMotion))
    request = { shots, player: new ReelPlayer(prepared.data, prepared.netId, prepared.keyframes) }
    playing = shots
    stopRequested = false
    setView({ state: 'playing', index: 0, count: shots.length, closed: true })
    return true
  },
  /** the moment on screen (or about to be), for the caption */
  current(): Moment | null {
    return playing[this.view().index]?.moment ?? null
  },
  /** the render side takes the request once */
  takeRequest(): ReelRequest | null {
    const r = request
    request = null
    return r
  },
  /** the render side moved on to moment `index`: preparing behind closed bars, or playing */
  showing(index: number, closed: boolean): void {
    setView({ index, closed })
  },
  /** skip, or the render side finished or lost the replay */
  finish(): void {
    request = null
    stopRequested = true
    if (this.view().state === 'playing') setView({ state: 'done', closed: false })
  },
  /** the render side asks whether to stop now */
  takeStop(): boolean {
    const s = stopRequested
    stopRequested = false
    return s
  },
}
