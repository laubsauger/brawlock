import { describe, expect, test } from 'vitest'
import { killPawn } from './combat'
import { HILL_ARENA_MARGIN, HILL_CAPTURE_SECONDS, HILL_DEFAULT_LAYER, HILL_GOLD_MAX, HILL_GOLD_SECONDS, HILL_MIN_LAYER, HILL_RESPAWN_SECONDS, HILL_ROUND_WIN_TICKETS, ticks } from './config'
import { hillLayerNow, hillStayOf, onHill } from './hill'
import { applyRosterChanges } from './roster'
import { shopOpen } from './shop'
import { fight, of, pawn, place, run, runUntil } from './testkit'
import type { MatchSettings, SimState } from './types'

const hill = (overrides: Partial<MatchSettings> = {}, n = 2, teams?: number[]) => fight(n, teams, { gameMode: 'hill', winScore: 100, ...overrides })
const scoreOf = (s: SimState, id: number) => s.scores.find((sc) => sc.id === id)!.score
// off the hill (layer 6 reaches 500 from the centre), safe on the 2-player arena (layer 15)
const OFF = 1000

const goldOf = (s: SimState, id: number) => s.scores.find((sc) => sc.id === id)!.gold

describe('King of the Hill: gold for standing on it', () => {
  test('a stay pays every few seconds and ramps 1, 1, 2, 2, then 3 each: staying put is worth more', () => {
    const s = hill()
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), OFF, 0)
    const start = goldOf(s, 0)
    const events = run(s, ticks(HILL_GOLD_SECONDS * 7))
    const paid = of(events, 'hillGold').map((e) => e.gold)
    // tuned with the user after the first playtest: the hill is not a gold mine
    expect(paid).toEqual([1, 1, 2, 2, 3, 3, 3])
    expect(HILL_GOLD_MAX).toBe(3)
    expect(goldOf(s, 0) - start).toBe(paid.reduce((a, b) => a + b, 0))
    expect(of(events, 'hillGold').every((e) => e.player === 0)).toBe(true)
  })

  test('gold keeps paying while contested, unlike tickets: both players on it earn', () => {
    const s = hill()
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), 192, 0)
    const events = run(s, ticks(HILL_GOLD_SECONDS))
    expect(s.hill?.contested).toBe(true)
    expect(of(events, 'hillGold').map((e) => [e.player, e.gold])).toEqual([[0, 1], [1, 1]])
  })

  test('stepping off for a moment starts the stay over: the timer and the ramp reset', () => {
    const s = hill()
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), OFF, 0)
    run(s, ticks(HILL_GOLD_SECONDS) + 1)
    expect(hillStayOf(s, 0)).toMatchObject({ paid: 1, next: 1 })
    place(pawn(s, 0), OFF, OFF)
    run(s, 1)
    expect(hillStayOf(s, 0)).toBeUndefined()
    place(pawn(s, 0), 0, 0)
    const events = run(s, ticks(HILL_GOLD_SECONDS) - 1)
    expect(of(events, 'hillGold')).toHaveLength(0)
    expect(of(run(s, 1), 'hillGold').map((e) => e.gold)).toEqual([1])
  })

  test('dying on the hill ends the stay', () => {
    const s = hill({ hillRespawn: true })
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), OFF, 0)
    run(s, ticks(HILL_GOLD_SECONDS) - 2)
    killPawn(s, pawn(s, 0), 1, 'lightning')
    run(s, 1)
    expect(hillStayOf(s, 0)).toBeUndefined()
  })
})

describe('King of the Hill: holding', () => {
  test('alone on the hill: the first ticket after the capture time, then one a second; off it earns nothing', () => {
    const s = hill()
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), OFF, 0)
    // a capture must be held a while before it pays: stepping on is not a ticket
    const events = run(s, ticks(HILL_CAPTURE_SECONDS) - 1)
    expect(scoreOf(s, 0)).toBe(0)
    run(s, 1)
    expect(scoreOf(s, 0)).toBe(1)
    run(s, ticks(2))
    expect(scoreOf(s, 0)).toBe(3)
    expect(scoreOf(s, 1)).toBe(0)
    expect(of(events, 'hill')[0]).toMatchObject({ team: 0, contested: false, prev: null })
  })

  test('contesting resets the capture: the holder waits the capture time again', () => {
    const s = hill()
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), OFF, 0)
    run(s, ticks(HILL_CAPTURE_SECONDS))
    expect(scoreOf(s, 0)).toBe(1)
    place(pawn(s, 1), 192, 0)
    run(s, 1)
    place(pawn(s, 1), OFF, 0)
    run(s, ticks(HILL_CAPTURE_SECONDS) - 1)
    expect(scoreOf(s, 0)).toBe(1)
    run(s, 1)
    expect(scoreOf(s, 0)).toBe(2)
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
    run(s, ticks(HILL_CAPTURE_SECONDS) + ticks(1))
    expect([scoreOf(s, 0), scoreOf(s, 1), scoreOf(s, 2)]).toEqual([2, 2, 0])
  })

  test('the hill is whole tiles of its layer: the tile edge, not a circle, decides', () => {
    expect(hillLayerNow(hill())).toBe(HILL_DEFAULT_LAYER)
    const s = hill({ hillLayer: 6 })
    // layer 6 keeps tile (2, 1) (centre 429 from the middle), not tile (2, 2) (543)
    expect(onHill(s, 2 * 192 + 90, 192 + 90)).toBe(true)
    expect(onHill(s, 2 * 192, 2 * 192)).toBe(false)
  })

  test('the first ticket to reach winScore ends the match on the spot, mid-fight', () => {
    const s = hill({ winScore: 3 })
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), OFF, 0)
    const events = run(s, ticks(HILL_CAPTURE_SECONDS) + ticks(2))
    expect(s.phase).toBe('gameOver')
    expect(of(events, 'gameOver')[0].winners).toEqual([0])
  })

  test('the hill shrinks a ring at a time to its smallest, and stays two rings inside the arena', () => {
    const s = hill()
    place(pawn(s, 0), OFF, 0)
    place(pawn(s, 1), -OFF, 0)
    s.hill!.nextShrinkTick = s.tick + 1
    const events = run(s, 2)
    expect(of(events, 'hillShrink')).toEqual([{ type: 'hillShrink', layer: HILL_DEFAULT_LAYER - 1 }])
    s.hill!.layer = HILL_MIN_LAYER
    s.hill!.nextShrinkTick = s.tick + 1
    expect(of(run(s, 2), 'hillShrink')).toHaveLength(0)
    // a small late arena keeps ground off the hill: 13 tiles left (layer 5), the hill is the plus
    // of 5 (layer 3); then only the centre tile (layer 2), which never goes
    s.hill!.layer = 6
    s.arena.layer = 7
    expect(hillLayerNow(s)).toBe(5)
    s.arena.layer = 5
    expect(hillLayerNow(s)).toBe(3)
    s.arena.layer = 4
    expect(hillLayerNow(s)).toBe(2)
    s.arena.layer = 2
    expect(onHill(s, 0, 0)).toBe(true)
    expect(onHill(s, 192, 0)).toBe(false)
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

  /** Why: the match is won at the ticket target, straight away (playtest 2026-10-25). */
  test('round-win tickets that reach the target end the match at once, at exactly the target', () => {
    const s = hill()
    place(pawn(s, 0), OFF, 0)
    place(pawn(s, 1), -OFF, 0)
    s.scores.find((sc) => sc.id === 0)!.score = 98
    killPawn(s, pawn(s, 1), 0, 'test')
    expect(s.phase).toBe('gameOver')
    expect(scoreOf(s, 0)).toBe(100)
    expect(of(s.events, 'gameOver')[0].winners).toEqual([0])
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
    // done sinking: no shrink stays scheduled, so no "Arena shrinks in" warning lingers
    s.arena.nextShrinkTick = s.tick + 1
    run(s, 2)
    expect(s.arena.nextShrinkTick).toBe(-1)
  })

  test('at the time limit the ticket leader wins; a tie plays on', () => {
    const s = respawn()
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), 192, 0)
    s.phaseTicksLeft = 2
    run(s, 3)
    expect(s.phase).toBe('fight') // 0 - 0, contested
    place(pawn(s, 1), OFF, 0)
    const events = run(s, ticks(HILL_CAPTURE_SECONDS) + 1)
    expect(s.phase).toBe('gameOver')
    expect(of(events, 'gameOver')[0].winners).toEqual([0])
  })

  test('the shop stays open all fight: there is no later shop phase to spend the gold in', () => {
    const s = respawn()
    expect(s.phase).toBe('fight')
    expect(shopOpen(s)).toBe(true)
    expect(shopOpen(hill())).toBe(false)
  })

  test('players may join mid-fight and spawn in at once', () => {
    const s = respawn()
    applyRosterChanges(s, [{ id: 5, name: 'late', color: 0, team: 5, kind: 'human' }])
    run(s, 2)
    expect(pawn(s, 5).alive).toBe(true)
  })
})
