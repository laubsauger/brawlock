import { describe, expect, it } from 'vitest'
import { TICK_HZ, type SimEvent, type SimState } from '../sim/types'
import { SnapshotBuffer } from './jitter'
import { mulberry32 } from './memory'
import type { TickEvents } from './protocol'

const DT_MS = 1000 / TICK_HZ

function state(tick: number): SimState {
  return { tick, events: [] } as unknown as SimState
}

/** one event per tick so we can check that none is lost or repeated */
function ev(tick: number): SimEvent[] {
  return [{ type: 'arenaShrink', layer: tick }]
}

describe('snapshot jitter buffer', () => {
  /**
   * Why: snapshots arrive late, out of order or not at all. Render must still get
   * a strictly advancing, evenly timed stream, and VFX / SFX must fire exactly
   * once per tick even for ticks whose own snapshot was lost.
   */
  it('plays a lossy, jittery, reordered stream smoothly with every event exactly once', () => {
    const rand = mulberry32(3)
    const buf = new SnapshotBuffer()
    const N = 1200
    const arrivals: { at: number; tick: number }[] = []
    for (let tick = 1; tick <= N; tick++) {
      if (rand() < 0.2) continue // 20 % loss
      arrivals.push({ at: tick * DT_MS + 50 + rand() * 30, tick })
    }
    arrivals.sort((a, b) => a.at - b.at)

    const played: { tick: number; at: number }[] = []
    const events: number[] = []
    let rejectedStale = 0
    let i = 0
    for (let now = 0; now < N * DT_MS + 500; now += 4) {
      while (i < arrivals.length && arrivals[i].at <= now) {
        const tick = arrivals[i++].tick
        const recent: TickEvents[] = []
        for (let t = Math.max(1, tick - 9); t <= tick; t++) recent.push({ tick: t, events: ev(t) })
        if (!buf.push({ n: tick, iv: 1, ev: recent, state: state(tick) }, now)) rejectedStale++
      }
      buf.pull(now, (s, at, evs) => {
        played.push({ tick: s.tick, at })
        for (const e of evs) {
          expect(e.events).toEqual(ev(e.tick))
          events.push(e.tick)
        }
        // the played state carries its own tick's events back
        expect(s.events).toEqual(ev(s.tick))
      })
    }

    // strictly advancing ticks, display times one tick apart per tick; the offset
    // steers at most 5 % of wall time and plays land on 4 ms pulls, so allow 7 %
    for (let k = 1; k < played.length; k++) {
      const dTick = played[k].tick - played[k - 1].tick
      expect(dTick).toBeGreaterThan(0)
      const perTick = (played[k].at - played[k - 1].at) / dTick
      expect(perTick).toBeGreaterThan(DT_MS * 0.93)
      expect(perTick).toBeLessThan(DT_MS * 1.07)
    }
    // a 30 ms jitter window must not make us skip ticks we received
    expect(played.length).toBeGreaterThan(arrivals.length * 0.97)
    // every tick's events exactly once, in order, including ticks whose snapshot was lost
    const last = played[played.length - 1].tick
    expect(events).toEqual(Array.from({ length: last }, (_, k) => k + 1))
    expect(buf.lossPct).toBeGreaterThan(10)
    expect(buf.lossPct).toBeLessThan(30)
    expect(buf.delayMs).toBeLessThan(150)
    expect(rejectedStale).toBeLessThan(arrivals.length * 0.03)
  })

  it('ignores stale and duplicate snapshots', () => {
    const buf = new SnapshotBuffer()
    expect(buf.push({ n: 1, iv: 1, ev: [], state: state(10) }, 0)).toBe(true)
    expect(buf.push({ n: 1, iv: 1, ev: [], state: state(10) }, 1)).toBe(false)
    let played = 0
    buf.pull(1000, () => played++)
    expect(played).toBe(1)
    expect(buf.push({ n: 2, iv: 1, ev: [], state: state(9) }, 1001)).toBe(false)
  })
})
