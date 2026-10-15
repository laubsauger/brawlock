import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryPair } from './memory'
import { LINK_TIMEOUT_MS, RAW_TIMEOUT_MS } from './transport'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('transport', () => {
  it('switches gameplay to the raw unreliable channel once a probe round-trips over it', async () => {
    const [a, b] = createMemoryPair({ latencyMs: 30 })
    expect(a.unreliableMode).toBe('pending')
    await vi.advanceTimersByTimeAsync(200)
    expect(a.unreliableMode).toBe('raw')
    expect(b.unreliableMode).toBe('raw')
    // RTT is measured on the unreliable path: 2 × one-way latency
    expect(a.rtt).toBeGreaterThan(55)
    expect(a.rtt).toBeLessThan(75)
  })

  /** Why: some networks / browsers may never open the raw channel; the match must still run. */
  it('falls back to the reliable channel when the raw channel never opens, losing nothing', async () => {
    const [a, b] = createMemoryPair({ latencyMs: 20, rawWorks: false, loss: 0.5 })
    const got: string[] = []
    b.onMessage((d) => got.push(d))
    a.sendUnreliable('{"t":"leave"}') // sent while pending: rides the reliable channel
    await vi.advanceTimersByTimeAsync(RAW_TIMEOUT_MS + 200)
    expect(a.unreliableMode).toBe('reliable')
    for (let i = 0; i < 20; i++) a.sendUnreliable(`{"i":${i}}`)
    await vi.advanceTimersByTimeAsync(100)
    expect(got).toHaveLength(21)
    expect(a.rtt).toBeGreaterThan(0) // keepalive / RTT still flows on the reliable channel
  })

  it('delivers messages that arrive before anyone subscribed, and never leaks control frames', async () => {
    const [a, b] = createMemoryPair({ latencyMs: 10 })
    a.sendReliable('{"t":"leave"}')
    await vi.advanceTimersByTimeAsync(1000)
    const got: string[] = []
    b.onMessage((d) => got.push(d))
    await vi.advanceTimersByTimeAsync(1000)
    expect(got).toEqual(['{"t":"leave"}'])
  })

  it('reports a remote close once, and a local close never fires its own onClose', async () => {
    const [a, b] = createMemoryPair({ latencyMs: 10 })
    const closedA = vi.fn()
    const closedB = vi.fn()
    a.onClose(closedA)
    b.onClose(closedB)
    a.close()
    await vi.advanceTimersByTimeAsync(100)
    expect(closedA).not.toHaveBeenCalled()
    expect(closedB).toHaveBeenCalledTimes(1)
    expect(b.open).toBe(false)
  })

  it('declares a silent link dead after the timeout', async () => {
    const [a, b] = createMemoryPair({ latencyMs: 10 })
    const closed = vi.fn()
    a.onClose(closed)
    // remote vanished without a goodbye (tab killed, network gone): nothing flows either way
    a.peer = null
    b.peer = null
    await vi.advanceTimersByTimeAsync(LINK_TIMEOUT_MS + 500)
    expect(closed).toHaveBeenCalledWith('timeout')
  })
})
