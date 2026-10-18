import { describe, expect, it } from 'vitest'
import { canInspect, cycle, goldVisible, inspectedLoadout, inspectStore, isSpectating, livingPlayers, PICK_RADIUS, pickPawnAt } from './inspect'
import { frame, pushState, resetFrame } from './frame'
import { newMatch } from '../sim/testkit'
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
  it('allows other-player inspection in shop and while dead, but blocks a living fighter', () => {
    const s = newMatch()
    expect(canInspect(s, 0, 1)).toBe(true)
    s.phase = 'fight'
    expect(canInspect(s, 0, 1)).toBe(false)
    expect(inspectedLoadout(s, 0, 1)).toBeNull()
    expect(canInspect(s, 0, 0)).toBe(true)
    s.pawns.find((p) => p.owner === 0)!.alive = false
    expect(canInspect(s, 0, 1)).toBe(true)
    expect(canInspect(s, -1, 1)).toBe(true)
    expect(canInspect(s, -1, 999)).toBe(false)
  })

  it('reveals only combat-committed builds in the next shop, even after zero-gold purchases', () => {
    resetFrame()
    const s = newMatch()
    const enemy = s.pawns.find((p) => p.owner === 1)!
    const score = s.scores.find((p) => p.id === 1)!
    enemy.slots[0] = 'fireball'
    enemy.levels[0] = 1
    score.gold = 0
    pushState(s, 0)
    expect(inspectedLoadout(s, 0, 1)).toEqual({ kind: 'unrevealed', kit: null })

    s.phase = 'fight'
    s.round = 1
    score.masteries.range = 2
    pushState(s, 1)
    s.pawns.find((p) => p.owner === 0)!.alive = false
    enemy.levels[0] = 2
    score.masteries.range = 3
    expect(inspectedLoadout(s, 0, 1)?.kit?.levels[0]).toBe(2) // dead: live view
    pushState(s, 2) // same round must not replace the commit

    s.phase = 'shop'
    enemy.slots[1] = 'teleport'
    enemy.levels[1] = 1
    score.masteries.range = 4
    pushState(s, 3)
    const revealed = inspectedLoadout(s, 0, 1)!
    expect(revealed.kind).toBe('lastRound')
    expect(revealed.kit?.slots[1]).toBeNull()
    expect(revealed.kit?.levels[0]).toBe(1)
    expect(revealed.kit?.masteries.range).toBe(2)
    expect(inspectedLoadout(s, 1, 1)?.kit?.levels[0]).toBe(2) // own purchases remain current

    s.phase = 'fight'
    s.round = 2
    pushState(s, 4)
    s.phase = 'shop'
    pushState(s, 5)
    expect(inspectedLoadout(s, 0, 1)?.kit?.slots[1]).toBe('teleport')
    expect(inspectedLoadout(s, 0, 1)?.kit?.masteries.range).toBe(4)
    resetFrame()
    expect(frame.curr).toBeNull()
    expect(inspectedLoadout(s, 0, 1)).toEqual({ kind: 'unrevealed', kit: null })
  })

  it('does not retain future builds through a replay seek back to the first shop', () => {
    resetFrame()
    const s = newMatch()
    s.phase = 'fight'
    s.round = 3
    pushState(s, 1)
    s.phase = 'shop'
    s.round = 0
    pushState(s, 2)
    expect(inspectedLoadout(s, 0, 1)).toEqual({ kind: 'unrevealed', kit: null })
    resetFrame()
  })

  it('keeps committed history through a profile-preserving rename but hides it from a new seat occupant', () => {
    resetFrame()
    const s = newMatch()
    s.slots[1].profileId = 'original-human'
    s.pawns[1].levels[6] = 2
    s.phase = 'fight'
    s.round = 1
    pushState(s, 0)
    s.phase = 'shop'
    s.slots[1].name = 'Renamed'
    s.slots[1].team = 7
    s.slots[1].color = 0xff0088
    pushState(s, 1)
    expect(inspectedLoadout(s, 0, 1)).toMatchObject({ kind: 'lastRound', kit: { levels: s.pawns[1].levels } })

    // Same seat and visible label, another browser: it has no previous combat build.
    s.slots[1].profileId = 'replacement-human'
    pushState(s, 2)
    expect(inspectedLoadout(s, 0, 1)).toEqual({ kind: 'unrevealed', kit: null })
    s.phase = 'fight'
    s.round = 2
    pushState(s, 3)
    s.phase = 'shop'
    pushState(s, 4)
    expect(inspectedLoadout(s, 0, 1)?.kind).toBe('lastRound')
    resetFrame()
  })

  it('does not attribute a replaced bot build to the human promoted into its seat', () => {
    resetFrame()
    const s = newMatch()
    Object.assign(s.slots[1], { kind: 'bot', profileId: 'bot:hard', name: 'Thorn' })
    s.phase = 'fight'
    s.round = 1
    pushState(s, 0)
    s.phase = 'shop'
    // Identical pawn/seat/name must not make a promotion inherit the bot's history.
    Object.assign(s.slots[1], { kind: 'human', profileId: 'human-thorn' })
    pushState(s, 1)
    expect(inspectedLoadout(s, 0, 1)).toEqual({ kind: 'unrevealed', kit: null })
    resetFrame()
  })

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
