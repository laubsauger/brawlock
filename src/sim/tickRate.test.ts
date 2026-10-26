import { afterEach, describe, expect, it } from 'vitest'
import { CAST_TURN_LIMIT_TICKS, ORIGINAL_TICK_SCALE, TURN_PER_TICK, ticks } from './config'
import { cmd, newMatch, pawn, run } from './testkit'
import { DT, TICK_HZ, TICK_RATES, setTickRate } from './types'

const startRate = TICK_HZ
afterEach(() => setTickRate(startRate))

describe('simulation rate per process (30 or 60 Hz)', () => {
  /** Why: a game server runs either rate from its config and a client switches to the rate of
   * the room it joins, so constants derived from the rate must follow every switch. */
  it('recomputes rate-derived constants when the rate changes', () => {
    for (const hz of TICK_RATES) {
      setTickRate(hz)
      expect(TICK_HZ).toBe(hz)
      expect(DT).toBe(1 / hz)
      expect(ticks(1)).toBe(hz)
      // 1.2 rad per 0.03 s: 40 rad/s at any rate
      expect(TURN_PER_TICK * hz).toBeCloseTo(40, 9)
      expect(CAST_TURN_LIMIT_TICKS).toBe(Math.ceil(Math.PI / TURN_PER_TICK) + 1)
      expect(ORIGINAL_TICK_SCALE).toBeCloseTo(1 / hz / 0.035, 12)
    }
    expect(() => setTickRate(45)).toThrow(/Unsupported tick rate/)
  })

  /** Why: the rate is a server cost and latency choice, not a game rule. The same orders must
   * play out in the same seconds and the same distances at either rate. */
  it('plays the same match in the same seconds and distances at either rate', () => {
    const seen = TICK_RATES.map((hz) => {
      setTickRate(hz)
      const s = newMatch({ shopSeconds: 4 })
      const shopTicks = s.phaseTicksLeft
      const x0 = pawn(s, 0).x
      run(s, ticks(2), () => [cmd(0, { kind: 'move', x: x0 - 2000, y: 0 })])
      return { hz, shopSeconds: shopTicks / hz, walked: x0 - pawn(s, 0).x }
    })
    expect(seen[0].shopSeconds).toBe(4)
    expect(seen[1].shopSeconds).toBe(4)
    // whole ticks of turning before walking differ by at most one tick of walk speed
    expect(Math.abs(seen[0].walked - seen[1].walked)).toBeLessThan(210 / 30 + 1)
    expect(seen[0].walked).toBeGreaterThan(300)
  })
})
