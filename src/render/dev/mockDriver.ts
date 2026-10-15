import { frame, pushEvents, pushState, resetFrame } from '../../game/frame'
import { TICK_HZ } from '../../sim/types'
import { devTime } from '../stats'
import { createMockMatch } from './mockState'

export interface MockSink {
  push(state: NonNullable<typeof frame.curr>, at: number): void
  pushEvents(tick: number, events: NonNullable<typeof frame.curr>['events']): void
}

/** Global frame buffer sink (MatchView mock mode). Local player = 0. */
export const globalSink: MockSink = {
  push: (s, at) => pushState(s, at),
  pushEvents: (tick, ev) => pushEvents(tick, ev),
}

/**
 * Run the mock sim at TICK_HZ into a sink. Returns a stop function.
 * Fixed-step with catch-up so timing stays steady under timer jitter.
 */
export function startMockDriver(sink: MockSink, opts: { calm?: boolean; global?: boolean } = {}): () => void {
  if (opts.global) {
    resetFrame()
    frame.localPlayer = 0
  }
  const mock = createMockMatch({ calm: opts.calm })
  let simTime = 0
  let last = performance.now()
  let done = 0
  const id = window.setInterval(() => {
    const now = performance.now()
    simTime += ((now - last) / 1000) * devTime.scale
    last = now
    const due = Math.floor(simTime * TICK_HZ)
    let n = 0
    while (done < due && n < 6) {
      const { state, events } = mock.step()
      sink.pushEvents(state.tick, events)
      sink.push(state, performance.now())
      done++
      n++
    }
    if (done < due) done = due
  }, 1000 / TICK_HZ / 2)
  return () => {
    window.clearInterval(id)
    if (opts.global) {
      resetFrame()
      frame.localPlayer = -1
    }
  }
}
