import { describe, expect, it } from 'vitest'
import { cycle, goldVisible, inspectStore, isSpectating, livingPlayers, PICK_RADIUS, pickPawnAt } from './inspect'
import type { SimState } from '../sim/types'

const pawn = (id: number, owner: number, x: number, y: number, alive = true) => ({ id, owner, x, y, alive })
const state = (pawns: ReturnType<typeof pawn>[], teamMode = 'ffa', teams: number[] = []) =>
  ({ pawns, slots: pawns.map((p, i) => ({ id: p.owner, team: teams[i] ?? i })), settings: { teamMode } }) as unknown as SimState

describe('picking a warlock with a click', () => {
  const s = state([pawn(10, 0, 0, 0), pawn(11, 1, 300, 0), pawn(12, 2, 330, 0)])

  it('picks the warlock under the cursor, within about 60 game units', () => {
    expect(pickPawnAt(s, 20, 20)).toBe(0)
    expect(pickPawnAt(s, PICK_RADIUS - 1, 0)).toBe(0)
  })

  it('picks nothing on empty ground, so a click there closes the card', () => {
    expect(pickPawnAt(s, 150, 150)).toBe(-1)
    expect(pickPawnAt(s, PICK_RADIUS + 5, 0)).toBe(-1)
  })

  it('takes the nearest when two warlocks stand close', () => {
    expect(pickPawnAt(s, 322, 0)).toBe(2)
    expect(pickPawnAt(s, 308, 0)).toBe(1)
  })

  it('never picks a warlock that is down', () => {
    expect(pickPawnAt(state([pawn(10, 0, 0, 0, false)]), 0, 0)).toBe(-1)
  })
})

describe('spectating', () => {
  it('counts as watching when your warlock is down or you have none', () => {
    const s = state([pawn(10, 0, 0, 0, false), pawn(11, 1, 0, 0)])
    expect(isSpectating(s, 0)).toBe(true)
    expect(isSpectating(s, 1)).toBe(false)
    expect(isSpectating(s, -1)).toBe(true)
  })

  it('cycles through the warlocks still standing, wrapping around', () => {
    const s = state([pawn(10, 0, 0, 0, false), pawn(11, 1, 0, 0), pawn(12, 2, 0, 0), pawn(13, 3, 0, 0, false)])
    const live = livingPlayers(s, 0)
    expect(live).toEqual([1, 2])
    expect(cycle(live, 2, 1)).toBe(1)
    expect(cycle(live, 1, -1)).toBe(2)
    expect(cycle(live, -1, 1)).toBe(1)
  })
})

describe('what the inspect card may show', () => {
  it('shows gold for yourself and allies only, never for enemies', () => {
    const ffa = state([pawn(10, 0, 0, 0), pawn(11, 1, 0, 0)])
    expect(goldVisible(ffa, 0, 0)).toBe(true)
    expect(goldVisible(ffa, 0, 1)).toBe(false)
    const teams = state([pawn(10, 0, 0, 0), pawn(11, 1, 0, 0), pawn(12, 2, 0, 0)], 'teams', [0, 0, 1])
    expect(goldVisible(teams, 0, 1)).toBe(true)
    expect(goldVisible(teams, 0, 2)).toBe(false)
  })

  it('closes the card when the same warlock is clicked again', () => {
    inspectStore.reset()
    inspectStore.toggleInspect(2)
    expect(inspectStore.get().inspect).toBe(2)
    inspectStore.toggleInspect(2)
    expect(inspectStore.get().inspect).toBe(-1)
  })
})
