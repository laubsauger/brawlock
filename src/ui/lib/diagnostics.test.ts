import { afterEach, describe, expect, it, vi } from 'vitest'
import { FrameWindow, watchServerPerf, type ServerProbe } from './diagnostics'

describe('local diagnostic frame windows', () => {
  it('measures steady frames and retains a main-thread stall in the same window', () => {
    const frames = new FrameWindow()
    frames.push(0)
    for (let t = 20; t < 800; t += 20) expect(frames.push(t)).toBeNull()
    expect(frames.push(1000)).toEqual({ windowMs: 1000, fps: 40, frameAvgMs: 25, frameMaxMs: 220, framesOver50Ms: 1 })
    for (let t = 1020; t < 2000; t += 20) frames.push(t)
    expect(frames.push(2000)).toMatchObject({ fps: 50, frameMaxMs: 20, framesOver50Ms: 0 })
  })
  it('resets when the page is hidden so time in another tab is not a frame stall', () => {
    const frames = new FrameWindow()
    frames.push(0)
    frames.push(20)
    frames.reset()
    expect(frames.push(60_000)).toBeNull()
    for (let t = 60_020; t < 61_000; t += 20) frames.push(t)
    expect(frames.push(61_000)).toMatchObject({ fps: 50, frameMaxMs: 20, framesOver50Ms: 0 })
  })
})

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

const serverSample = { sampleAt: 1, windowMs: 1000, processCpuPct: 4, eventLoopP95Ms: 20, eventLoopMaxMs: 21, simStepAvgMs: 0.2, simStepMaxMs: 1, simStepsPerSec: 60, rssMb: 80 }

describe('on-demand server diagnostics', () => {
  function setup() {
    vi.useFakeTimers()
    const doc = { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() }
    vi.stubGlobal('document', doc)
    return doc
  }
  it('polls at most once every three seconds and stops cleanly', async () => {
    setup()
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, perf: serverSample }) })
    vi.stubGlobal('fetch', request)
    const samples: ServerProbe[] = []
    const stop = watchServerPerf('https://eu.example', (value) => samples.push(value))
    await vi.advanceTimersByTimeAsync(0)
    expect(samples[0]).toMatchObject({ state: 'ready', sample: serverSample })
    expect(request).toHaveBeenCalledWith('https://eu.example/health', expect.objectContaining({ cache: 'no-store' }))
    await vi.advanceTimersByTimeAsync(2999)
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledTimes(2)
    stop()
    await vi.advanceTimersByTimeAsync(9000)
    expect(request).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps missing telemetry distinct from the first pending server sample', async () => {
    setup()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, perf: null }) }))
    const samples: ServerProbe[] = []
    const stop = watchServerPerf('https://eu.example', (value) => samples.push(value))
    await vi.advanceTimersByTimeAsync(0)
    expect(samples[0]).toMatchObject({ state: 'unavailable', sample: null })
    await vi.advanceTimersByTimeAsync(3000)
    expect(samples[1]).toMatchObject({ state: 'waiting', sample: null })
    stop()
  })
  it('avoids hidden-tab requests, does not overlap slow requests, and aborts on close', async () => {
    const doc = setup()
    doc.visibilityState = 'hidden'
    let signal: AbortSignal | undefined
    const request = vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => {
      signal = options.signal as AbortSignal
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    vi.stubGlobal('fetch', request)
    const samples: ServerProbe[] = []
    const stop = watchServerPerf('https://eu.example', (value) => samples.push(value))
    await vi.advanceTimersByTimeAsync(3000)
    expect(request).not.toHaveBeenCalled()
    doc.visibilityState = 'visible'
    const visible = doc.addEventListener.mock.calls[0][1] as () => void
    visible()
    visible()
    expect(request).toHaveBeenCalledTimes(1)
    stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(signal!.aborted).toBe(true)
    expect(samples).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(doc.removeEventListener).toHaveBeenCalledWith('visibilitychange', visible)
  })
})
