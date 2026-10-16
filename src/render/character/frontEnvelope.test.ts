import { describe, expect, it } from 'vitest'
import { ENV_LAG, ENV_LEAD, stepEnvelope, type EnvelopeState } from './frontEnvelope'

/**
 * The cloth shader pushes the robe's front panels out to this envelope. If it
 * leaves the leg's neighbourhood the panels stretch across the arena (the
 * "exploding warlocks" P0: an explicit stiff spring stepped with the summed
 * half-rate dt of reduced detail diverged below ~30 fps). Whatever the frame
 * time or detail level, the envelope must stay attached to the leg.
 */

/** a striding leg: the knee / hem target swings forward and back at walk cadence */
const stride = (t: number) => 0.1 + 0.15 * Math.max(0, Math.sin(t * 2 * Math.PI * 1.6))

function attached(s: EnvelopeState, target: number): boolean {
  return Number.isFinite(s.x) && s.x >= target - ENV_LAG - 1e-9 && s.x <= target + ENV_LEAD + 1e-9
}

describe('front envelope spring', () => {
  it('stays attached to a striding leg at any step size (detail 1 doubles the step)', () => {
    for (const fps of [144, 60, 30, 15, 10, 5]) {
      const h = 1 / fps
      const s: EnvelopeState = { x: 0.1, v: 0 }
      for (let t = 0; t < 10; t += h) {
        const target = stride(t)
        stepEnvelope(s, target, h)
        expect(attached(s, target), `fps ${fps} t ${t.toFixed(2)} x ${s.x}`).toBe(true)
      }
    }
  })

  it('stays attached across detail switches: full rate, half rate with summed dt, offscreen gap', () => {
    const s: EnvelopeState = { x: 0.1, v: 0 }
    let t = 0
    const run = (secs: number, frameDt: number, every: number) => {
      let acc = 0
      for (let i = 0; i * frameDt < secs; i++) {
        t += frameDt
        acc += frameDt
        if (i % every !== 0) continue
        const target = stride(t)
        stepEnvelope(s, target, acc)
        acc = 0
        expect(attached(s, target), `t ${t.toFixed(2)} x ${s.x}`).toBe(true)
      }
    }
    run(3, 1 / 60, 1) // detail 0
    run(3, 1 / 30, 2) // detail 1 at 30 fps: 1/15 s steps
    // detail 2 offscreen: no envelope updates for a while, the leg is elsewhere
    t += 2
    run(0.5, 1 / 25, 1) // back on screen at a low frame rate
    run(3, 1 / 20, 2) // detail 1 at 20 fps: 1/10 s steps
  })

  it('still follows the leg like cloth (quick out, settles on the target)', () => {
    const s: EnvelopeState = { x: 0.1, v: 0 }
    for (let i = 0; i < 18; i++) stepEnvelope(s, 0.25, 1 / 60)
    // pushed out by the leg: within 2 cm after 0.3 s
    expect(Math.abs(s.x - 0.25)).toBeLessThan(0.02)
    for (let i = 0; i < 60; i++) stepEnvelope(s, 0.1, 1 / 60)
    // leg swings back: settled within 2 cm after 1 s
    expect(Math.abs(s.x - 0.1)).toBeLessThan(0.02)
  })

  it('recovers from a corrupted (non-finite) state', () => {
    const s: EnvelopeState = { x: Number.NaN, v: Number.POSITIVE_INFINITY }
    stepEnvelope(s, 0.2, 1 / 60)
    expect(attached(s, 0.2)).toBe(true)
  })
})
