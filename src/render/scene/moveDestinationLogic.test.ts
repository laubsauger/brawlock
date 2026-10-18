import { describe, expect, it } from 'vitest'
import { CLICK_BRIDGE_S, resolveDestination, type DestClick, type DestPawn } from './moveDestinationLogic'

/**
 * The persistent move destination must show where the local warlock is
 * actually going: the sim's move target (prediction, rollback, knockback),
 * the fresh click only while its order is in flight, and nothing once the
 * sim dropped the order (arrived, stopped, cast, died, round reset).
 */

const pawn = (moveTarget: { x: number; y: number } | null, extra: Partial<DestPawn> = {}): DestPawn => ({ alive: true, moveTarget, cast: null, ...extra })
const click = (x: number, y: number, at: number, queued = false): DestClick => ({ x, y, at, queued })

describe('move destination', () => {
  it('a new click replaces the old target at once, before the order reaches the sim', () => {
    const r = resolveDestination(pawn({ x: 0, y: 0 }), click(500, 200, 10), 10.05)
    expect(r).toMatchObject({ show: true, x: 500, y: 200, queued: false })
  })

  it('hands over to the sim target once the order lands', () => {
    const r = resolveDestination(pawn({ x: 500.5, y: 200 }), click(500, 200, 10), 10.1)
    expect(r.click).toBeNull()
    expect(r).toMatchObject({ show: true, x: 500.5, y: 200 })
  })

  it('stays on the target through knockback (the pawn walks back)', () => {
    // the pawn is far off its path, the target is unchanged
    const r = resolveDestination(pawn({ x: 500, y: 200 }), null, 20)
    expect(r).toMatchObject({ show: true, x: 500, y: 200 })
  })

  it('clears when the sim drops the order (arrival, stop, cast, round reset)', () => {
    expect(resolveDestination(pawn(null), null, 20).show).toBe(false)
  })

  it('clears on death, even with a click in flight', () => {
    const r = resolveDestination(pawn({ x: 1, y: 1 }, { alive: false }), click(500, 200, 10), 10.05)
    expect(r.show).toBe(false)
    expect(r.click).toBeNull()
  })

  it('drops a click the sim never took (e.g. stop right after) once the bridge expires', () => {
    const r = resolveDestination(pawn(null), click(500, 200, 10), 10 + CLICK_BRIDGE_S + 0.01)
    expect(r.show).toBe(false)
    expect(r.click).toBeNull()
  })

  it('shows a held move as queued for the whole windup, then follows the sim', () => {
    const c = click(300, 100, 10, true)
    // windup runs well past the bridge time: still shown, marked queued
    const during = resolveDestination(pawn(null, { cast: { spell: 'fireball' } }), c, 12)
    expect(during).toMatchObject({ show: true, x: 300, y: 100, queued: true })
    // windup over, the held move went out and the sim has it
    const after = resolveDestination(pawn({ x: 300, y: 100 }), during.click, 12.2)
    expect(after).toMatchObject({ show: true, x: 300, y: 100, queued: false })
  })
})
