import { eventsSince, frame, type FrameBuffer, type TickEvents } from '../game/frame'

/**
 * Where a world reads snapshots and events from. Matches use the global
 * frame buffer and event log from game/frame.ts; the menu backdrop runs a
 * private mock buffer so it never touches match state.
 */
export interface RenderSource {
  buf: FrameBuffer
  eventsSince(lastTick: number): TickEvents[]
  /** write the projected cursor into buf.cursor (match only) */
  writesCursor: boolean
}

export const globalSource: RenderSource = {
  buf: frame,
  eventsSince,
  writesCursor: true,
}

/**
 * Show `prev` and `curr` interpolated at `alpha` now: the world interpolates
 * alpha = (now - currAt) / (currAt - prevAt), so the times are set to land on it (a replay or a
 * scripted shot drives the clock instead of the session).
 */
export function writeSubTick(buf: FrameBuffer, prev: FrameBuffer['curr'], curr: FrameBuffer['curr'], alpha: number, now: number): void {
  buf.prev = prev
  buf.curr = curr
  buf.currAt = now - alpha * 1000
  buf.prevAt = buf.currAt - 1000
}

/** A private buffer + event log with the same semantics as game/frame.ts; the log keeps `logCap` batches. */
export function createPrivateSource(logCap = 120): RenderSource & {
  push(state: FrameBuffer['curr'], at: number): void
  pushEvents(tick: number, events: TickEvents['events']): void
} {
  const buf: FrameBuffer = {
    prev: null,
    curr: null,
    prevAt: 0,
    currAt: 0,
    localPlayer: -1,
    cursor: { x: 0, y: 0, valid: false },
    net: { rttMs: 0, lossPct: 0 },
  }
  const log: TickEvents[] = []
  return {
    buf,
    writesCursor: false,
    eventsSince: (last) => log.filter((e) => e.tick > last),
    push(state, at) {
      buf.prev = buf.curr
      buf.prevAt = buf.currAt
      buf.curr = state
      buf.currAt = at
    },
    pushEvents(tick, events) {
      if (events.length === 0) return
      log.push({ tick, events })
      if (log.length > logCap) log.splice(0, log.length - logCap)
    },
  }
}
