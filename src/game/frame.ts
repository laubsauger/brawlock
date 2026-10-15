import type { SimState } from '../sim/types'

/**
 * Mutable render buffer. The session (host loop or network client) writes,
 * the scene reads every animation frame. No React state: zero re-renders.
 *
 * Render interpolates between `prev` and `curr` with
 * alpha = clamp((now - currAt) / (currAt - prevAt), 0, 1) where now = performance.now()
 * minus the session's interpolation delay.
 */
export interface FrameBuffer {
  prev: SimState | null
  curr: SimState | null
  /** performance.now() when prev / curr became available */
  prevAt: number
  currAt: number
  /** id of the locally controlled player, -1 = spectator */
  localPlayer: number
  /** cursor projected onto the ground plane, game units. Written by render, read by input. */
  cursor: { x: number; y: number; valid: boolean }
  /** network stats for HUD. Written by session. */
  net: { rttMs: number; lossPct: number }
}

export const frame: FrameBuffer = {
  prev: null,
  curr: null,
  prevAt: 0,
  currAt: 0,
  localPlayer: -1,
  cursor: { x: 0, y: 0, valid: false },
  net: { rttMs: 0, lossPct: 0 },
}

/** Push a new authoritative state. Caller must not mutate `state` afterwards. */
export function pushState(state: SimState, at = performance.now()): void {
  frame.prev = frame.curr
  frame.prevAt = frame.currAt
  frame.curr = state
  frame.currAt = at
}

/**
 * Tick-stamped event log for VFX / SFX / killfeed. Snapshots can arrive out of
 * order or be skipped, so producers push every authoritative tick's events here
 * (duplicates ignored) and consumers keep their own `lastTick` cursor.
 */
export interface TickEvents {
  tick: number
  events: SimState['events']
}

const EVENT_LOG_MAX = 240
export const eventLog: TickEvents[] = []

export function pushEvents(tick: number, events: SimState['events']): void {
  if (events.length === 0) return
  if (eventLog.some((e) => e.tick === tick)) return
  eventLog.push({ tick, events })
  eventLog.sort((a, b) => a.tick - b.tick)
  if (eventLog.length > EVENT_LOG_MAX) eventLog.splice(0, eventLog.length - EVENT_LOG_MAX)
}

/** Events with tick > lastTick, oldest first. */
export function eventsSince(lastTick: number): TickEvents[] {
  return eventLog.filter((e) => e.tick > lastTick)
}

export function resetFrame(): void {
  frame.prev = null
  frame.curr = null
  frame.prevAt = 0
  frame.currAt = 0
  eventLog.length = 0
}
