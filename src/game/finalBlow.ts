/**
 * The Final Blow (docs/moonshot/specs/final-blow.md): a beat after a round is won, the hit that
 * decided it (the moments engine's round decider) replays from the state ring, slowed down, from
 * a side-on camera, then play returns to the winner's hero shot. The round that wins the match gets
 * a longer version and holds the results screen until it ends. The sim never pauses: this is a
 * replay of recent confirmed states. A round replay may run into the next shop (ROUND_GRACE); the
 * HUD opens the shop when it ends.
 *
 * This module plans a replay (pure) and holds the results screen; the render side plays the plan.
 */
import { ticks } from '../sim/config'
import { TICK_HZ } from '../sim/types'
import type { Moment } from './moments'

/** after the displayed roundWin (s): a beat to see the round end before the replay */
export const FB_DELAY = 0.6
/** the results screen waits at most this long after the displayed roundWin (s) */
export const RESULTS_HOLD_MAX = 11.5
/** the live hero shot that closes a match Final Blow (s) */
export const MATCH_HERO_SECONDS = 3
/** the impact freeze of a match Final Blow (s) */
export const MATCH_FREEZE_SECONDS = 0.35
/**
 * How long a round replay may keep playing after the next shop opened (s). The sim's 3 s round end
 * is too short for a replay players can follow (playtest 2026-11-02: "way too rushed"), so the
 * replay runs about a second into the shop and the shop opens when it ends.
 */
export const ROUND_GRACE = 1.5

export type FinalBlowKind = 'round' | 'match'
/** which camera a segment uses: side-on on the push, or on the death after a cut */
export type FinalBlowShot = 'push' | 'death'

export interface FinalBlowSegment {
  /** ticks of the recorded stream, from < to */
  from: number
  to: number
  /** playback speed: 1 = real time */
  speed: number
  shot: FinalBlowShot
}

export interface FinalBlowPlan {
  kind: FinalBlowKind
  segments: FinalBlowSegment[]
  /** a world freeze at this tick (match only), seconds long */
  freeze: { tick: number; seconds: number } | null
  /** the live hero shot after the replay (match only), seconds */
  hero: number
  /** total length, seconds */
  seconds: number
  /** the ring did not reach back to the hit: the plan shows the death only */
  partial: boolean
  /** reduced motion: real time and static gameplay-angle cameras */
  reduced: boolean
  /** the decider: hit tick and death tick */
  hit: number
  death: number
}

const segSeconds = (s: FinalBlowSegment) => (s.to - s.from) / TICK_HZ / s.speed

/**
 * Plan a Final Blow for `decider` (hit tick H = decider.tick, death tick D = decider.end), given
 * the oldest tick the ring still holds. Round: a short run-up, the hit at 0.35x, then the flight
 * joined (or a cut to the death) at 0.7x, about 3.3 s at most. Match: a run-up, the hit at a quarter
 * speed with a freeze on impact, the flight or a cut to the death at 0.6x, then the live hero
 * shot, about 10 s at most. Reduced motion: real time, no freeze,
 * static cameras. A ring that starts after the plan's first tick gives the death alone.
 */
export function planFinalBlow(decider: Moment | null, ringOldest: number, kind: FinalBlowKind, reducedMotion: boolean): FinalBlowPlan | null {
  if (!decider) return null
  const H = decider.tick
  const D = Math.max(decider.end, H)
  const t = (s: number) => ticks(s)
  const segments: FinalBlowSegment[] = []
  const push = (from: number, to: number, speed: number, shot: FinalBlowShot) => {
    if (to > from) segments.push({ from, to, speed: reducedMotion ? 1 : speed, shot })
  }
  let freeze: FinalBlowPlan['freeze'] = null
  if (kind === 'round') {
    push(H - t(0.5), H - t(0.15), 1, 'push')
    push(H - t(0.15), H + t(0.45), 0.35, 'push')
    if (D <= H + t(1.0)) push(H + t(0.45), D + t(0.3), 0.7, 'push')
    else push(D - t(0.5), D + t(0.3), 0.7, 'death')
  } else {
    push(H - t(1.2), H - t(0.25), 1, 'push')
    push(H - t(0.25), H + t(0.6), 0.25, 'push')
    if (!reducedMotion) freeze = { tick: H, seconds: MATCH_FREEZE_SECONDS }
    if (D <= H + t(1.6)) push(H + t(0.6), D + t(0.5), 0.6, 'push')
    else push(D - t(0.6), D + t(0.5), 0.6, 'death')
  }
  let partial = false
  if (segments.length === 0 || segments[0].from < ringOldest) {
    // the ring does not reach the hit: show the death only (3% of measured round deciders)
    segments.length = 0
    freeze = null
    partial = true
    push(D - t(1.0), D + t(0.3), 0.5, 'death')
    if (segments[0].from < ringOldest) return null
  }
  const hero = kind === 'match' ? MATCH_HERO_SECONDS : 0
  const seconds = segments.reduce((n, s) => n + segSeconds(s), 0) + (freeze?.seconds ?? 0) + hero
  return { kind, segments, freeze, hero, seconds, partial, reduced: reducedMotion, hit: H, death: D }
}

/**
 * Where playback is `elapsed` seconds into a plan: the recorded tick (fractional) and the world
 * time scale (0 while frozen); null once the replay part is over (the hero shot, or the end).
 */
export function planClock(plan: FinalBlowPlan, elapsed: number): { tick: number; speed: number; segment: number } | null {
  let left = elapsed
  for (let i = 0; i < plan.segments.length; i++) {
    const s = plan.segments[i]
    if (plan.freeze && s.from <= plan.freeze.tick && plan.freeze.tick < s.to) {
      // the freeze sits inside this segment, at its tick
      const before = (plan.freeze.tick - s.from) / TICK_HZ / s.speed
      if (left < before) return { tick: s.from + left * s.speed * TICK_HZ, speed: s.speed, segment: i }
      left -= before
      if (left < plan.freeze.seconds) return { tick: plan.freeze.tick, speed: 0, segment: i }
      left -= plan.freeze.seconds
      const after = (s.to - plan.freeze.tick) / TICK_HZ / s.speed
      if (left < after) return { tick: plan.freeze.tick + left * s.speed * TICK_HZ, speed: s.speed, segment: i }
      left -= after
      continue
    }
    const len = segSeconds(s)
    if (left < len) return { tick: s.from + left * s.speed * TICK_HZ, speed: s.speed, segment: i }
    left -= len
  }
  return null
}

/**
 * The results hold (Rule 9): a match Final Blow defers the results screen per viewer, never the
 * session. `route` sends a screen change through: 'results' waits while holding, any other screen
 * cancels the hold and goes through at once. The hold ends on `release()` (the replay ended, was
 * skipped or aborted) or after `maxMs`, and then shows the results if they came meanwhile.
 */
export function createResultsHold(timers: { set(fn: () => void, ms: number): unknown; clear(id: unknown): void } = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) }) {
  let holding = false
  let timer: unknown = null
  let pending: (() => void) | null = null
  const end = () => {
    if (timer !== null) timers.clear(timer)
    timer = null
    holding = false
    const show = pending
    pending = null
    show?.()
  }
  return {
    get holding() {
      return holding
    },
    hold(maxMs: number): void {
      if (timer !== null) timers.clear(timer)
      holding = true
      timer = timers.set(end, maxMs)
    },
    release: end,
    route(screen: string, apply: () => void): void {
      if (screen === 'results' && holding) {
        pending = apply
        return
      }
      if (holding) {
        if (timer !== null) timers.clear(timer)
        timer = null
        holding = false
        pending = null
      }
      apply()
    },
  }
}

/** The app's results hold, used by game/session.ts's UI port. */
export const resultsHold = createResultsHold()
