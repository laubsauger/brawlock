import { describe, expect, it } from 'vitest'
import { ticks } from '../sim/config'
import { newMatch } from '../sim/testkit'
import { TICK_HZ, type SimEvent } from '../sim/types'
import { RING_RATE, RING_SECONDS, StateRing } from './stateRing'

/**
 * The ring holds what a Final Blow replays: the last 8 s of confirmed states. It must keep them
 * as they were when observed (the stream client steps its state in place), drop older ones, and
 * stay at 30 states a second whatever the sim rate.
 */
describe('state ring', () => {
  const feed = (seconds: number) => {
    const ring = new StateRing()
    const s = newMatch()
    const events: SimEvent[] = [{ type: 'arenaShrink', layer: 9 }]
    for (let i = 0; i < ticks(seconds); i++) {
      s.tick += 1
      ring.observe(s, i % 10 === 0 ? events : [])
    }
    return { ring, s }
  }

  it('keeps 30 states a second at most, and nothing older than 8 s', () => {
    const { ring, s } = feed(12)
    const kept = ring.statesIn(-Infinity, Infinity)
    const perSecond = kept.length / RING_SECONDS
    expect(perSecond).toBeLessThanOrEqual(RING_RATE + 1)
    expect(perSecond).toBeGreaterThanOrEqual(Math.min(TICK_HZ, RING_RATE) - 1)
    expect(ring.oldest).toBeGreaterThanOrEqual(s.tick - ticks(RING_SECONDS))
    expect(ring.eventsIn(-Infinity, Infinity).every((e) => e.tick >= s.tick - ticks(RING_SECONDS))).toBe(true)
  })

  it('a state stepped in place after observe leaves the kept copy as it was', () => {
    const ring = new StateRing()
    const s = newMatch()
    s.tick = 100
    ring.observe(s, [])
    s.pawns[0].x = 12345
    s.tick = 101
    expect(ring.statesIn(100, 100)[0].pawns[0].x).not.toBe(12345)
  })

  it('event batches come back in tick order, and a window starts at the last state at or before it', () => {
    const { ring, s } = feed(3)
    const batches = ring.eventsIn(s.tick - ticks(2), s.tick)
    expect(batches.length).toBeGreaterThan(0)
    expect(batches.map((b) => b.tick)).toEqual([...batches.map((b) => b.tick)].sort((a, b) => a - b))
    const from = s.tick - ticks(1) + 1
    const win = ring.statesIn(from, s.tick)
    expect(win[0].tick).toBeLessThanOrEqual(from)
    expect(win.at(-1)!.tick).toBeLessThanOrEqual(s.tick)
  })

  it('a new match (the tick going back) starts over', () => {
    const { ring, s } = feed(3)
    s.tick = 5
    ring.observe(s, [])
    expect(ring.oldest).toBe(5)
  })
})
