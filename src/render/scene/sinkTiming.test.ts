import { describe, expect, it } from 'vitest'
import { SINK_DROP, SINK_DUR, SINK_SWALLOW, SINK_SWEEP, sinkDelay } from './Arena'

describe('removed tile sink timing', () => {
  it('reads as lava within the first ~0.3 s: the sim already counts a pawn on it as in the lava', () => {
    // the slow sweep and swallow are presentation only; the drop that says
    // "no longer ground" must never be delayed or stretched
    expect(SINK_DROP).toBeLessThanOrEqual(0.3)
  })

  it('sweeps the swallow around the ring from the start angle, both ways, meeting opposite', () => {
    const R = 1000
    const at = (a: number) => sinkDelay(Math.cos(a) * R, Math.sin(a) * R, 0.7)
    expect(at(0.7)).toBeCloseTo(0, 5)
    expect(at(0.7 + Math.PI)).toBeCloseTo(SINK_SWEEP, 5)
    // symmetric: both halves of the ring run at the same pace
    expect(at(0.7 + 1)).toBeCloseTo(at(0.7 - 1), 5)
    // monotonic away from the start, so the wave never jumps back
    expect(at(0.7 + 1)).toBeLessThan(at(0.7 + 2))
  })

  it('every tile is fully under before its sinking slot is dropped', () => {
    // Arena keeps a removed tile in the instance buffer for SINK_DUR: the
    // latest one (delay = SINK_SWEEP) must have finished swallowing by then
    let worst = 0
    for (let a = -Math.PI; a <= Math.PI; a += 0.01) worst = Math.max(worst, sinkDelay(Math.cos(a) * 500, Math.sin(a) * 500, -2.1))
    expect(worst).toBeLessThanOrEqual(SINK_SWEEP + 1e-9)
    expect(SINK_DROP + worst + SINK_SWALLOW).toBeLessThanOrEqual(SINK_DUR + 1e-9)
  })
})
