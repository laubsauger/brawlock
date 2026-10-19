import { describe, expect, it, vi } from 'vitest'
import { createServerPerf } from '../../server/perf.mjs'

function fixture() {
  let now = 0
  let cpu = { user: 100_000, system: 50_000 }
  let sample!: () => void
  const loop = {
    count: 0, max: 40_000_000,
    percentile: vi.fn(() => 25_000_000),
    enable: vi.fn(),
    reset: vi.fn(() => { loop.count = 0 }),
    disable: vi.fn(),
  }
  const timer = { unref: vi.fn() }
  const schedule = vi.fn((callback: () => void) => { sample = callback; return timer })
  const cancel = vi.fn()
  const cpuUsage = vi.fn(() => ({ ...cpu }))
  const rss = vi.fn(() => 64 * 1024 * 1024)
  const perf = createServerPerf({ now: () => now, wallNow: () => 1_700_000_000_000 + now, cpuUsage, rss, eventLoop: loop, schedule, cancel })
  return { perf, loop, timer, schedule, cancel, cpuUsage, rss,
    advance: (ms: number) => { now += ms },
    cpu: (user: number, system: number) => { cpu = { user, system } },
    sample: () => sample(),
  }
}

describe('cached Node server performance sampler', () => {
  it('starts explicitly unsampled and waits for actual event-loop observations', () => {
    const f = fixture()
    try {
      expect(f.perf.snapshot()).toBeNull()
      expect(f.schedule).toHaveBeenCalledWith(expect.any(Function), 1000)
      expect(f.timer.unref).toHaveBeenCalledOnce()
      expect(f.loop.enable).toHaveBeenCalledOnce()
      f.advance(1000)
      f.sample()
      expect(f.perf.snapshot()).toBeNull()
      expect(f.loop.reset).not.toHaveBeenCalled()
      f.loop.count = 1
      f.sample()
      expect(f.perf.snapshot()).toMatchObject({ windowMs: 1000, simStepsPerSec: 0, simStepAvgMs: 0, simStepMaxMs: 0 })
    } finally { f.perf.close() }
  })

  it('uses CPU deltas over the actual monotonic window, preserves multi-core usage and converts units', () => {
    const f = fixture()
    try {
      f.advance(1000)
      f.cpu(850_000, 300_000)
      f.loop.count = 50
      f.sample()
      expect(f.perf.snapshot()).toEqual({ sampleAt: 1_700_000_001_000, windowMs: 1000, processCpuPct: 100,
        eventLoopP95Ms: 25, eventLoopMaxMs: 40, simStepAvgMs: 0, simStepMaxMs: 0, simStepsPerSec: 0, rssMb: 64 })
      expect(f.loop.percentile).toHaveBeenCalledWith(95)
      f.advance(2500)
      f.cpu(3_850_000, 550_000)
      f.loop.count = 100
      f.sample()
      expect(f.perf.snapshot()).toMatchObject({ windowMs: 2500, processCpuPct: 130 })
      expect(f.loop.reset).toHaveBeenCalledTimes(2)
    } finally { f.perf.close() }
  })

  it('aggregates real synchronous wrapper durations across calls, then resets the whole window', () => {
    const f = fixture()
    try {
      const step = f.perf.wrapStep(function (this: { factor: number }, duration: number, value: number) {
        f.advance(duration)
        return value * this.factor
      })
      expect(step.call({ factor: 3 }, 2, 7)).toBe(21)
      expect(step.call({ factor: 4 }, 5, 8)).toBe(32)
      f.advance(993)
      f.loop.count = 10
      f.sample()
      expect(f.perf.snapshot()).toMatchObject({ windowMs: 1000, simStepAvgMs: 3.5, simStepMaxMs: 5, simStepsPerSec: 2 })
      step.call({ factor: 1 }, 1, 0)
      f.advance(1999)
      f.loop.count = 10
      f.sample()
      expect(f.perf.snapshot()).toMatchObject({ windowMs: 2000, simStepAvgMs: 1, simStepMaxMs: 1, simStepsPerSec: 0.5 })
    } finally { f.perf.close() }
  })

  it('does not mask simulation errors and still accounts for the attempted step cost', () => {
    const f = fixture()
    try {
      const error = new Error('simulation failure')
      const step = f.perf.wrapStep(() => { f.advance(4); throw error })
      expect(() => step()).toThrow(error)
      f.advance(996)
      f.loop.count = 10
      f.sample()
      expect(f.perf.snapshot()).toMatchObject({ simStepAvgMs: 4, simStepMaxMs: 4, simStepsPerSec: 1 })
    } finally { f.perf.close() }
  })

  it('serves cached immutable snapshots, cancels once, disables the native monitor and cannot resume after close', () => {
    const f = fixture()
    f.advance(1000)
    f.loop.count = 1
    f.sample()
    const snapshot = f.perf.snapshot()
    const calls = f.cpuUsage.mock.calls.length
    for (let i = 0; i < 100; i++) expect(f.perf.snapshot()).toBe(snapshot)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(f.cpuUsage).toHaveBeenCalledTimes(calls)
    expect(f.rss).toHaveBeenCalledOnce()
    f.perf.close()
    f.perf.close()
    f.advance(1000)
    f.loop.count = 1
    f.sample()
    expect(f.perf.snapshot()).toBeNull()
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(f.timer)
    expect(f.loop.disable).toHaveBeenCalledOnce()
    expect(f.cpuUsage).toHaveBeenCalledTimes(calls)
    const step = vi.fn(() => 42)
    expect(f.perf.wrapStep(step)()).toBe(42)
    expect(step).toHaveBeenCalledOnce()
  })
})
