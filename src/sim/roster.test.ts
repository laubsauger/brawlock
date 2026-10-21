import { describe, expect, it } from 'vitest'
import { applyRosterChanges } from './roster'
import { newMatch, fight } from './testkit'
import { cloneState, hashState, step } from './index'
import type { PlayerSlot } from './types'

const entrant: PlayerSlot = { id: 2, name: 'Late', color: 3, kind: 'human', team: 0, profileId: 'profile-late' }

describe('between-round roster additions', () => {
  it('creates a real, unique pawn and catch-up budget without altering existing builds or damage', () => {
    const s = newMatch({ startGold: 50, roundGold: 15 })
    s.round = 2
    s.pawns[0].hp = 123
    s.pawns[0].kbPoints = 72
    s.pawns[0].levels[6] = 3
    const existing = structuredClone(s.pawns)
    applyRosterChanges(s, [entrant])
    expect(s.pawns.slice(0, 2)).toEqual(existing)
    expect(s.scores[2]).toMatchObject({ gold: 80, score: 0, kills: 0, deaths: 0, connected: true })
    expect(new Set(s.pawns.map((p) => p.id)).size).toBe(3)
    expect(s.slots[2].team).toBe(2)
    step(s, [])
    expect(s.pawns[2].alive).toBe(true)
    const nextEntity = s.nextEntityId
    applyRosterChanges(s, [{ ...entrant, name: 'Renamed', team: 2 }])
    expect(s.pawns).toHaveLength(3)
    expect(s.nextEntityId).toBe(nextEntity)
    expect(s.scores[2].gold).toBe(80)
  })

  it('keeps a round-end entrant dead until shop and does not pay the current round twice', () => {
    const s = newMatch({ startGold: 50, roundGold: 15 })
    s.phase = 'roundEnd'
    s.round = 2
    s.phaseTicksLeft = 1
    applyRosterChanges(s, [entrant])
    expect(s.pawns[2].alive).toBe(false)
    expect(s.scores[2].gold).toBe(65)
    step(s, [])
    expect(s.phase).toBe('shop')
    expect(s.pawns[2].alive).toBe(true)
    expect(s.scores[2].gold).toBe(80)
  })

  it('rejects additions during a rounds fight, ranked play or game over', () => {
    for (const s of [fight(), newMatch({ rankedRounds: 5 }), { ...newMatch(), phase: 'gameOver' as const }]) {
      expect(() => applyRosterChanges(s, [entrant])).toThrow(/between casual rounds/)
      expect(s.slots).toHaveLength(2)
      expect(s.pawns).toHaveLength(2)
    }
  })

  it('spawns a deathmatch entrant through the ordinary respawn path', () => {
    const s = fight(2, undefined, { gameMode: 'deathmatch' })
    applyRosterChanges(s, [entrant])
    const copy = cloneState(s)
    step(s, [])
    step(copy, [])
    expect(s.pawns[2].alive).toBe(true)
    expect(s.events.some((e) => e.type === 'respawn' && e.owner === entrant.id)).toBe(true)
    expect(hashState(s)).toBe(hashState(copy))
  })
})
