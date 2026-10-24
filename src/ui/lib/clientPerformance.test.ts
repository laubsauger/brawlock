import { describe, expect, it } from 'vitest'
import { ClientPerformance } from './clientPerformance'

describe('device performance attribution', () => {
  it('does not mistake a slow render cadence for a blocked main thread', () => {
    const perf = new ClientPerformance()
    for (let t = 0; t <= 1000; t += 100) {
      perf.timer(t)
      if (t % 200 === 0) perf.frame(t)
    }
    expect(perf.snapshot(1000)).toMatchObject({ frames: { fps: 5, frameMaxMs: 200 }, frameGapMs: 200, mainThreadStallMs: 0 })
  })

  it('retains a blocked timer separately from frame gaps and expires both', () => {
    const perf = new ClientPerformance()
    perf.timer(0)
    perf.frame(0)
    perf.timer(100)
    perf.frame(100)
    perf.timer(420)
    perf.frame(420)
    expect(perf.snapshot(420)).toMatchObject({ mainThreadStallMs: 220, frameGapMs: 320 })
    expect(perf.snapshot(5419).mainThreadStallMs).toBe(220)
    expect(perf.snapshot(5420)).toMatchObject({ mainThreadStallMs: 0, frameGapMs: 0 })
  })

  it('resets baselines on visibility changes instead of counting background time as overload', () => {
    const perf = new ClientPerformance()
    perf.timer(0)
    perf.frame(0)
    perf.reset()
    perf.timer(60_000)
    perf.frame(60_000)
    perf.timer(60_100)
    perf.frame(60_020)
    expect(perf.snapshot(60_100)).toEqual({ frames: null, mainThreadStallMs: 0, frameGapMs: 0 })
  })
})
