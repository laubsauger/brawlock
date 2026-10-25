import { describe, expect, it } from 'vitest'
import { roomProgress } from './roomProgress'
import { TICK_HZ } from '../sim/types'

describe('public match progress', () => {
  it('uses the upcoming round during shopping and simulation time rather than wall time', () => {
    expect(roomProgress({ round: 2, tick: 242 * TICK_HZ - 1, phase: 'shop' })).toEqual({ round: 3, elapsedSeconds: 241, phase: 'shop', final: false })
    expect(roomProgress({ round: 3, tick: 242 * TICK_HZ, phase: 'fight' }).round).toBe(3)
    expect(roomProgress({ round: 0, tick: 0, phase: 'warmup' }).round).toBe(1)
    expect(roomProgress({ round: 5, tick: 900 * TICK_HZ, phase: 'gameOver', rankedFinal: { contenders: [0, 1] } }).final).toBe(true)
  })
})
