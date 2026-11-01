import { describe, expect, it } from 'vitest'
import { layerRadius } from './arena'
import { killPawn } from './combat'
import { ARENA_COMPACT_LAYER, ARENA_MAX_LAYER, RANKED_SHRINK_PERIOD, ROUND_END_SECONDS, SHRINK_PERIOD, SPAWN_EDGE_MARGIN, ticks } from './config'
import { freshStartRefund, scheduledRoundsOf, step } from './index'
import { startRound } from './mode'
import { applyRosterChanges } from './roster'
import { cmd, newMatch, run } from './testkit'
import type { MatchSettings, SimState } from './types'

/**
 * Brisk casual (docs/moonshot/specs/faster-casual.md): casual quick play plays five scheduled
 * rounds on a compact arena with a faster ring, because first to 3 among ten warlocks dragged on
 * for about 28 minutes. The same three options exist in custom lobbies with the classic values as
 * defaults, so the original rules stay the default everywhere else.
 */

const BRISK: Partial<MatchSettings> = { scheduledRounds: 5, arenaCap: ARENA_COMPACT_LAYER, shrinkSeconds: 7 }

/** a fight started with every pawn spawned */
function fight(settings: Partial<MatchSettings>, players: number, teams?: number[]): SimState {
  const s = newMatch({ shopSeconds: 0, ...settings }, players, 1, teams)
  startRound(s)
  return s
}

/** ticks between the fight's first two rings */
function ringGap(s: SimState): number {
  const at: number[] = []
  let layer = s.arena.layer
  for (let i = 0; i < ticks(90) && at.length < 2; i++) {
    step(s, [])
    if (s.arena.layer !== layer) {
      at.push(s.tick)
      layer = s.arena.layer
    }
  }
  expect(at).toHaveLength(2)
  return at[1] - at[0]
}

/** `winner` (or their team) takes the round; the round end runs out */
function winRound(s: SimState, winner: number): void {
  if (s.phase === 'shop') startRound(s)
  const team = s.slots.find((slot) => slot.id === winner)!.team
  for (const p of s.pawns) if (p.alive && (s.settings.teamMode === 'teams' ? s.slots.find((slot) => slot.id === p.owner)!.team !== team : p.owner !== winner)) killPawn(s, p, null, 'lava')
  run(s, ticks(ROUND_END_SECONDS))
}

describe('Brisk casual pace options', () => {
  it('defaults stay faithful: ten warlocks fight on 21 layers, a ring every 10 s, first to winScore', () => {
    const s = fight({}, 10)
    expect(s.arena.layer).toBe(ARENA_MAX_LAYER)
    expect(ringGap(s)).toBe(ticks(SHRINK_PERIOD))
    const firstTo = newMatch({ shopSeconds: 0, winScore: 2 }, 3)
    winRound(firstTo, 0)
    winRound(firstTo, 0)
    expect(firstTo.phase).toBe('gameOver')
  })

  it('five scheduled rounds ignore winScore: two early wins do not end the match', () => {
    const s = newMatch({ shopSeconds: 0, winScore: 2, scheduledRounds: 5 }, 3)
    winRound(s, 0)
    winRound(s, 0)
    expect(s.phase).toBe('shop')
    winRound(s, 0)
    // three wins with two rounds left cannot be caught: the early clinch, as in ranked
    expect(s.phase).toBe('gameOver')
    expect(s.round).toBe(3)
  })

  it('the compact arena is the same size for every table, with every spawn well inside it', () => {
    for (const players of [10, 3, 2]) {
      const s = fight(BRISK, players)
      expect(s.arena.layer, `${players} players`).toBe(ARENA_COMPACT_LAYER)
      const edge = layerRadius(s.arena.layer)
      for (const p of s.pawns) expect(Math.hypot(p.x, p.y), `${players} players`).toBeLessThanOrEqual(edge - SPAWN_EDGE_MARGIN + 1e-6)
    }
  })

  it('the ring period is in seconds, not ticks, at the process rate', () => {
    expect(ringGap(fight({ shrinkSeconds: 6 }, 4))).toBe(ticks(6))
    expect(ringGap(fight(BRISK, 10))).toBe(ticks(7))
  })

  it('keeps casual rules: Fresh start in the shop and new seats between rounds, unlike ranked', () => {
    const casual = newMatch({ ...BRISK, startGold: 100 }, 2)
    const ranked = newMatch({ rankedRounds: 5, startGold: 100 }, 2)
    for (const s of [casual, ranked]) step(s, [cmd(0, { kind: 'buySpell', spell: 'teleport' })])
    expect(freshStartRefund(casual, 0)).toBeGreaterThan(0)
    expect(freshStartRefund(ranked, 0)).toBe(0)
    const late = { id: 2, name: 'late', color: 0xffffff, team: 2, kind: 'human' as const }
    expect(() => applyRosterChanges(casual, [late])).not.toThrow()
    expect(casual.slots.map((slot) => slot.id)).toEqual([0, 1, 2])
    expect(() => applyRosterChanges(ranked, [late])).toThrow()
  })

  it('ranked does not move: its arena and its 8 s ring ignore the casual pace options', () => {
    const s = fight({ rankedRounds: 5, shrinkSeconds: 6, arenaCap: ARENA_COMPACT_LAYER }, 8)
    expect(s.arena.layer).toBe(13 + 8)
    expect(ringGap(s)).toBe(ticks(RANKED_SHRINK_PERIOD))
  })

  it('other modes ignore them: deathmatch and the hill keep their arenas, teams play first to winScore', () => {
    expect(fight({ ...BRISK, gameMode: 'deathmatch' }, 10).arena.layer).toBe(ARENA_MAX_LAYER)
    const hill = fight({ ...BRISK, gameMode: 'hill', winScore: 75 }, 10)
    expect(hill.arena.layer).toBe(ARENA_MAX_LAYER)
    expect(ringGap(hill)).toBe(ticks(SHRINK_PERIOD))
    for (const settings of [{ gameMode: 'deathmatch' }, { gameMode: 'hill' }, { teamMode: 'teams' }, { teamMode: 'shuffle' }] as const) {
      expect(scheduledRoundsOf({ gameMode: 'rounds', teamMode: 'ffa', scheduledRounds: 5, ...settings })).toBe(0)
    }
    const teams = newMatch({ ...BRISK, teamMode: 'teams', winScore: 2, shopSeconds: 0 }, 4, 1, [0, 0, 1, 1])
    winRound(teams, 0)
    winRound(teams, 0)
    expect(teams.phase).toBe('gameOver')
  })

  it('bad values fall back to the classic ones, so a lobby never fails to start', () => {
    const junk = [-1, Number.NaN, Number.POSITIVE_INFINITY]
    for (const scheduledRounds of [...junk, 2.5, 16]) expect(newMatch({ scheduledRounds }).settings.scheduledRounds, String(scheduledRounds)).toBe(0)
    for (const arenaCap of [...junk, 0, 8, 15.5, 22]) expect(newMatch({ arenaCap }).settings.arenaCap, String(arenaCap)).toBe(ARENA_MAX_LAYER)
    for (const shrinkSeconds of [...junk, 0, 2.9, 31]) expect(newMatch({ shrinkSeconds }).settings.shrinkSeconds, String(shrinkSeconds)).toBe(SHRINK_PERIOD)
    // and a bad match still plays
    const s = newMatch({ scheduledRounds: Number.NaN, arenaCap: -1, shrinkSeconds: 0, shopSeconds: 0 }, 4)
    startRound(s)
    expect(s.arena.layer).toBe(13 + 4)
    // a fractional ring period is a valid choice
    expect(newMatch({ shrinkSeconds: 6.5 }).settings.shrinkSeconds).toBe(6.5)
  })
})
