import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sharedClock, startClock } from './clock'

/** A page: visibility, listeners and an animation-frame source we control. */
function fakePage() {
  let visibility: 'visible' | 'hidden' = 'visible'
  const listeners = new Set<() => void>()
  let framesOn = true
  let nextId = 1
  const frames = new Map<number, FrameRequestCallback>()
  const doc = {
    get visibilityState() {
      return visibility
    },
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
  }
  // 60 Hz display
  const vsync = setInterval(() => {
    if (!framesOn || visibility === 'hidden') return
    const due = [...frames.entries()]
    frames.clear()
    for (const [, cb] of due) cb(performance.now())
  }, 1000 / 60)
  vi.stubGlobal('document', doc)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.set(nextId, cb)
    return nextId++
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  return {
    setHidden(h: boolean) {
      visibility = h ? 'hidden' : 'visible'
      for (const cb of listeners) cb()
    },
    stallFrames(stall: boolean) {
      framesOn = !stall
    },
    dispose() {
      clearInterval(vsync)
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('startClock', () => {
  /**
   * Why: a 4 ms timer costs ~250 main-thread tasks per second for 60 ticks. While the
   * tab is visible the loops step from animation frames instead; background tabs (no
   * rAF, throttled timers) keep the worker so a hosting player's sim never freezes.
   */
  it('visible: one pulse per frame; hidden: 4 ms timer pulses; back to frames when visible', () => {
    const page = fakePage()
    let pulses = 0
    const stop = startClock(() => pulses++)
    vi.advanceTimersByTime(1000)
    expect(pulses).toBeGreaterThanOrEqual(58)
    expect(pulses).toBeLessThanOrEqual(62)

    page.setHidden(true)
    pulses = 0
    vi.advanceTimersByTime(1000)
    expect(pulses).toBeGreaterThanOrEqual(240)

    page.setHidden(false)
    pulses = 0
    vi.advanceTimersByTime(1000)
    expect(pulses).toBeLessThanOrEqual(62)
    stop()
    pulses = 0
    vi.advanceTimersByTime(500)
    expect(pulses).toBe(0)
    page.dispose()
  })

  /** Why: a visible page whose frames stall (occluded window) must still tick, if slower. */
  it('visible but frames stalled: the watchdog keeps pulsing', () => {
    const page = fakePage()
    let pulses = 0
    const stop = startClock(() => pulses++)
    page.stallFrames(true)
    vi.advanceTimersByTime(1000)
    // 50 ms watchdog: ~20 pulses, each stepping the accumulated ticks
    expect(pulses).toBeGreaterThanOrEqual(15)
    expect(pulses).toBeLessThanOrEqual(25)
    stop()
    page.dispose()
  })
})

describe('server clock shared by every match', () => {
  afterEach(() => vi.useRealTimers())

  it('pulses every match from one timer and stops it with the last match', () => {
    // Why: a timer per match woke the server 250 times a second per room (capacity profile,
    // about a tenth of its CPU). Every match must still get every pulse.
    vi.useFakeTimers()
    const intervals = vi.spyOn(globalThis, 'setInterval')
    const clock = sharedClock()
    const counts = [0, 0, 0]
    const stops = counts.map((_, i) => clock(() => counts[i]++))
    expect(intervals).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(100)
    expect(counts.every((c) => c >= 20)).toBe(true)
    expect(new Set(counts).size).toBe(1)
    stops[0]()
    vi.advanceTimersByTime(100)
    expect(counts[0]).toBe(counts[0])
    expect(counts[1]).toBeGreaterThan(counts[0])
    stops[1]()
    stops[2]()
    expect(vi.getTimerCount()).toBe(0)
    // a new match after an idle server starts the one timer again
    let later = 0
    const stop = clock(() => later++)
    vi.advanceTimersByTime(20)
    expect(later).toBeGreaterThan(0)
    stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
