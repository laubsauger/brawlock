import { describe, expect, test } from 'vitest'
import { killPawn } from './combat'
import { HILL_ARENA_MARGIN, HILL_DEFAULT_LAYER, HILL_MIN_LAYER, HILL_RESPAWN_SECONDS, HILL_ROUND_WIN_TICKETS, ticks } from './config'
import { hillLayerNow, onHill } from './hill'
import { applyRosterChanges } from './roster'
import { fight, of, pawn, place, run, runUntil } from './testkit'
import type { MatchSettings, SimState } from './types'

const hill = (overrides: Partial<MatchSettings> = {}, n = 2, teams?: number[]) => fight(n, teams, { gameMode: 'hill', winScore: 100, ...overrides })
const scoreOf = (s: SimState, id: number) => s.scores.find((sc) => sc.id === id)!.score
// off the hill (layer 6 reaches 500 from the centre), safe on the 2-player arena (layer 15)
const OFF = 1000

describe('King of the Hill: holding', () => {
  test('alone on the hill earns a ticket and gold every second; off it earns nothing', () => {
    const s = hill()
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), OFF, 0)
    const gold = s.scores.map((sc) => sc.gold)
    const events = run(s, ticks(3))
    expect(scoreOf(s, 0)).toBe(3)
    expect(scoreOf(s, 1)).toBe(0)
    expect(s.scores[0].gold).toBe(gold[0] + 3)
    expect(of(events, 'hill')[0]).toMatchObject({ team: 0, contested: false, prev: null })
  })

  test('an enemy on the hill contests it: nobody earns while both stand there', () => {
    const s = hill()
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), 192, 0)
    const events = run(s, ticks(3))
    expect(scoreOf(s, 0) + scoreOf(s, 1)).toBe(0)
    expect(s.hill).toMatchObject({ team: null, contested: true })
    expect(of(events, 'hillTicket')).toHaveLength(0)
  })

  test('teammates hold it together and every member gets each ticket', () => {
    const s = hill({}, 3, [0, 0, 1])
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), 192, 0)
    place(pawn(s, 2), -OFF, 0)
    run(s, ticks(2))
    expect([scoreOf(s, 0), scoreOf(s, 1), scoreOf(s, 2)]).toEqual([2, 2, 0])
  })

  test('the hill is whole tiles of its layer: the tile edge, not a circle, decides', () => {
    const s = hill()
    expect(hillLayerNow(s)).toBe(HILL_DEFAULT_LAYER)
    // layer 6 keeps tile (2, 1) (centre 429 from the middle), not tile (2, 2) (543)
    expect(onHill(s, 2 * 192 + 90, 192 + 90)).toBe(true)
    expect(onHill(s, 2 * 192, 2 * 192)).toBe(false)
  })

  test('the first ticket to reach winScore ends the match on the spot, mid-fight', () => {
    const s = hill({ winScore: 3 })
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), OFF, 0)
    const events = run(s, ticks(3))
    expect(s.phase).toBe('gameOver')
    expect(of(events, 'gameOver')[0].winners).toEqual([0])
  })

  test('the hill shrinks a ring at a time to its smallest, and never reaches past the arena', () => {
    const s = hill()
    place(pawn(s, 0), OFF, 0)
    place(pawn(s, 1), -OFF, 0)
    s.hill!.nextShrinkTick = s.tick + 1
    const events = run(s, 2)
    expect(of(events, 'hillShrink')).toEqual([{ type: 'hillShrink', layer: HILL_DEFAULT_LAYER - 1 }])
    s.hill!.layer = HILL_MIN_LAYER
    s.hill!.nextShrinkTick = s.tick + 1
    expect(of(run(s, 2), 'hillShrink')).toHaveLength(0)
    s.hill!.layer = 6
    s.arena.layer = 4
    expect(hillLayerNow(s)).toBe(4)
  })
})

describe('King of the Hill: rounds style (default)', () => {
  test('the last one standing ends the round with bonus tickets, and tickets carry into the next round', () => {
    const s = hill()
    place(pawn(s, 0), OFF, 0)
    place(pawn(s, 1), -OFF, 0)
    killPawn(s, pawn(s, 1), 0, 'test')
    expect(s.phase).toBe('roundEnd')
    expect(scoreOf(s, 0)).toBe(HILL_ROUND_WIN_TICKETS)
    runUntil(s, (st) => st.phase === 'fight')
    expect(scoreOf(s, 0)).toBe(HILL_ROUND_WIN_TICKETS)
    expect(s.hill).toMatchObject({ layer: HILL_DEFAULT_LAYER, team: null, heldTicks: 0 })
  })

  test('nobody joins mid-fight: entrants wait for the shop', () => {
    const s = hill()
    expect(() => applyRosterChanges(s, [{ id: 5, name: 'late', color: 0, team: 5, kind: 'human' }])).toThrow()
  })
})

describe('King of the Hill: respawn style', () => {
  const respawn = (overrides: Partial<MatchSettings> = {}) => hill({ hillRespawn: true, ...overrides })

  test('a death is no round end: the warlock respawns after five seconds and the fight goes on', () => {
    const s = respawn()
    place(pawn(s, 0), OFF, 0)
    place(pawn(s, 1), -OFF, 0)
    killPawn(s, pawn(s, 1), 0, 'test')
    expect(s.phase).toBe('fight')
    const events = run(s, ticks(HILL_RESPAWN_SECONDS) + 1)
    expect(of(events, 'respawn').map((e) => e.owner)).toEqual([1])
    expect(pawn(s, 1).alive).toBe(true)
  })

  test('the arena stops sinking with ground left around the hill for respawns', () => {
    const s = respawn()
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), 0, 0)
    for (let i = 0; i < 40; i++) {
      s.arena.nextShrinkTick = s.tick + 1
      run(s, 2)
    }
    expect(s.arena.layer).toBe(HILL_DEFAULT_LAYER + HILL_ARENA_MARGIN)
  })

  test('at the time limit the ticket leader wins; a tie plays on', () => {
    const s = respawn()
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), 192, 0)
    s.phaseTicksLeft = 2
    run(s, 3)
    expect(s.phase).toBe('fight') // 0 - 0, contested
    place(pawn(s, 1), OFF, 0)
    const events = run(s, ticks(1) + 1)
    expect(s.phase).toBe('gameOver')
    expect(of(events, 'gameOver')[0].winners).toEqual([0])
  })

  test('players may join mid-fight and spawn in at once', () => {
    const s = respawn()
    applyRosterChanges(s, [{ id: 5, name: 'late', color: 0, team: 5, kind: 'human' }])
    run(s, 2)
    expect(pawn(s, 5).alive).toBe(true)
  })
})
