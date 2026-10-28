import { describe, expect, test } from 'vitest'
import { isLocationSafeAtLayer } from './arena'
import { killPawn } from './combat'
import { HILL_ARENA_MARGIN, HILL_CAPTURE_SECONDS, HILL_DEFAULT_LAYER, HILL_GOLD_FIRST, HILL_GOLD_MAX, HILL_GOLD_SECONDS, HILL_GOLD_STEP, HILL_MIN_LAYER, HILL_RESPAWN_SECONDS, HILL_ROUND_WIN_TICKETS, HILL_SEAL_SECONDS, HILL_TICKET_SECONDS, PAWN_RADIUS, ticks } from './config'
import { hillLayerNow, hillSealed, hillStartLayer, hillStayOf, onHill } from './hill'
import { prepareForRound } from './mode'
import { applyRosterChanges } from './roster'
import { shopOpen } from './shop'
import { cmd, fight, grant, newMatch, of, pawn, place, run, runUntil } from './testkit'
import type { MatchSettings, SimState } from './types'

const sealed = (overrides: Partial<MatchSettings> = {}, n = 2, teams?: number[]) => fight(n, teams, { gameMode: 'hill', winScore: 100, ...overrides })
/** a fight with the opening force field already down; the field has its own tests below */
const hill = (overrides: Partial<MatchSettings> = {}, n = 2, teams?: number[]) => {
  const s = sealed(overrides, n, teams)
  s.hill!.openTick = s.tick
  return s
}
const scoreOf = (s: SimState, id: number) => s.scores.find((sc) => sc.id === id)!.score
// off the hill (layer 6 reaches 500 from the centre), safe on the 2-player arena (layer 15)
const OFF = 1000

const goldOf = (s: SimState, id: number) => s.scores.find((sc) => sc.id === id)!.gold

describe('King of the Hill: gold for standing on it', () => {
  test('a stay pays every few seconds and ramps up to a cap: staying put is worth more, but the hill is no gold mine', () => {
    const s = hill()
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), OFF, 0)
    const start = goldOf(s, 0)
    // long enough to reach the cap and stay on it for a while
    const grants = (HILL_GOLD_MAX - HILL_GOLD_FIRST) * HILL_GOLD_STEP + 3
    const events = run(s, ticks(HILL_GOLD_SECONDS * grants))
    const paid = of(events, 'hillGold').map((e) => e.gold)
    expect(paid).toHaveLength(grants)
    expect(paid[0]).toBe(HILL_GOLD_FIRST)
    paid.slice(1).forEach((gold, i) => expect(gold).toBeGreaterThanOrEqual(paid[i]))
    expect(paid.at(-1)).toBeGreaterThan(paid[0])
    expect(paid.slice(-2)).toEqual([HILL_GOLD_MAX, HILL_GOLD_MAX])
    expect(goldOf(s, 0) - start).toBe(paid.reduce((a, b) => a + b, 0))
    expect(of(events, 'hillGold').every((e) => e.player === 0)).toBe(true)
  })

  test('gold keeps paying while contested, unlike tickets: both players on it earn', () => {
    const s = hill()
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), 192, 0)
    const events = run(s, ticks(HILL_GOLD_SECONDS))
    expect(s.hill?.contested).toBe(true)
    expect(of(events, 'hillGold').map((e) => [e.player, e.gold])).toEqual([[0, HILL_GOLD_FIRST], [1, HILL_GOLD_FIRST]])
  })

  test('stepping off for a moment starts the stay over: the timer and the ramp reset', () => {
    const s = hill()
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), OFF, 0)
    run(s, ticks(HILL_GOLD_SECONDS) + 1)
    expect(hillStayOf(s, 0)).toMatchObject({ paid: 1 })
    place(pawn(s, 0), OFF, OFF)
    run(s, 1)
    expect(hillStayOf(s, 0)).toBeUndefined()
    place(pawn(s, 0), 0, 0)
    const events = run(s, ticks(HILL_GOLD_SECONDS) - 1)
    expect(of(events, 'hillGold')).toHaveLength(0)
    expect(of(run(s, 1), 'hillGold').map((e) => e.gold)).toEqual([HILL_GOLD_FIRST])
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

describe('King of the Hill: the opening force field', () => {
  // Why: an instant Teleport onto the hill decided who held it first (user call after alpha.16).
  // The default hill's east tip tile ends here; a warlock's body stays a radius off it.
  const EDGE = 2 * 192 + 96

  test('for its first seconds nobody walks onto the hill, then it opens and pays as usual', () => {
    const s = sealed()
    expect(hillSealed(s)).toBe(true)
    const p = pawn(s, 0)
    place(p, OFF, 0, Math.PI)
    place(pawn(s, 1), -OFF, 0)
    const walk = () => [cmd(0, { kind: 'move', x: 0, y: 0 })]
    let touched = false
    for (let i = 0; i < ticks(HILL_SEAL_SECONDS) - 1; i++) {
      run(s, 1, walk)
      if (p.x < EDGE + PAWN_RADIUS - 1e-6 || onHill(s, p.x, p.y)) touched = true
    }
    expect(touched).toBe(false)
    expect(p.x).toBeCloseTo(EDGE + PAWN_RADIUS, 0) // pressed against the field, not turned away
    expect(s.hill).toMatchObject({ team: null, stays: [] })
    run(s, 1, walk)
    expect(hillSealed(s)).toBe(false)
    runUntil(s, (st) => onHill(st, p.x, p.y), ticks(2))
    run(s, ticks(HILL_CAPTURE_SECONDS))
    expect(scoreOf(s, 0)).toBe(1)
  })

  test('a Teleport onto the sealed hill lands at the field, on its own path, and says so', () => {
    const s = sealed()
    const p = pawn(s, 0)
    place(p, 900, 0, Math.PI)
    place(pawn(s, 1), -OFF, 0)
    const slot = grant(s, 0, 'teleport')
    const events = run(s, 1, () => [cmd(0, { kind: 'cast', slot, x: 0, y: 0 })])
    expect(p.x).toBeCloseTo(EDGE + PAWN_RADIUS, 0)
    expect(p.y).toBeCloseTo(0, 6)
    expect(of(events, 'teleport')[0]).toMatchObject({ fromX: 900, toX: p.x, toY: p.y })
  })

  test('a warlock knocked into the field bounces off it, as off a pillar', () => {
    const s = sealed()
    const p = pawn(s, 0)
    place(p, EDGE + 200, 0)
    place(pawn(s, 1), -OFF, 0)
    p.vx = -900
    let touched = false
    let bounced = false
    for (let i = 0; i < ticks(1); i++) {
      run(s, 1)
      if (p.x < EDGE + PAWN_RADIUS - 1e-6) touched = true
      if (p.vx > 0) bounced = true
    }
    expect(touched).toBe(false)
    expect(bounced).toBe(true)
  })

  test('every fight opens sealed, the next round included, and never the shop', () => {
    const s = sealed()
    run(s, ticks(HILL_SEAL_SECONDS))
    expect(hillSealed(s)).toBe(false)
    killPawn(s, pawn(s, 1), 0, 'test')
    runUntil(s, (st) => st.phase === 'shop')
    expect(hillSealed(s)).toBe(false)
    runUntil(s, (st) => st.phase === 'fight')
    expect(hillSealed(s)).toBe(true)
    run(s, ticks(HILL_SEAL_SECONDS))
    expect(hillSealed(s)).toBe(false)
  })
})

describe('King of the Hill: holding', () => {
  test('alone on the hill: the first ticket after the capture time, then one per ticket period; off it earns nothing', () => {
    const s = hill()
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), OFF, 0)
    // a capture must be held a while before it pays: stepping on is not a ticket
    const events = run(s, ticks(HILL_CAPTURE_SECONDS) - 1)
    expect(scoreOf(s, 0)).toBe(0)
    run(s, 1)
    expect(scoreOf(s, 0)).toBe(1)
    run(s, 2 * ticks(HILL_TICKET_SECONDS))
    expect(scoreOf(s, 0)).toBe(3)
    expect(scoreOf(s, 1)).toBe(0)
    expect(of(events, 'hill')[0]).toMatchObject({ team: 0, contested: false, prev: null })
  })

  test('a contest pauses the holder, who resumes after it; a newcomer captures from scratch', () => {
    // Why: one tick of an enemy brushing the hill used to restart the holder's capture, so a busy
    // 10-player hill paid almost no tickets (bot-only matches past 90 minutes)
    const s = hill()
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), OFF, 0)
    run(s, ticks(HILL_CAPTURE_SECONDS))
    expect(scoreOf(s, 0)).toBe(1)
    const held = Math.floor(ticks(HILL_TICKET_SECONDS) / 2)
    run(s, held)
    place(pawn(s, 1), 192, 0)
    run(s, ticks(3))
    expect(scoreOf(s, 0)).toBe(1)
    place(pawn(s, 1), OFF, 0)
    // the time held before the contest still counts: the next ticket comes only the rest later
    run(s, ticks(HILL_TICKET_SECONDS) - held - 1)
    expect(scoreOf(s, 0)).toBe(1)
    run(s, 1)
    expect(scoreOf(s, 0)).toBe(2)

    // the other warlock takes over alone: a fresh capture
    place(pawn(s, 0), OFF, 0)
    place(pawn(s, 1), 0, 0)
    run(s, ticks(HILL_CAPTURE_SECONDS) - 1)
    expect(scoreOf(s, 1)).toBe(0)
    run(s, 1)
    expect(scoreOf(s, 1)).toBe(1)
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
    run(s, ticks(HILL_CAPTURE_SECONDS) + ticks(HILL_TICKET_SECONDS))
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
    const events = run(s, ticks(HILL_CAPTURE_SECONDS) + 2 * ticks(HILL_TICKET_SECONDS))
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

describe('King of the Hill: pillars catch a warlock knocked off the hill', () => {
  /** the shop before fight `round + 1`, with its pillars */
  const shopAt = (round: number, seed = 1) => {
    const s = newMatch({ gameMode: 'hill' }, 2, seed, undefined, true)
    s.round = round
    prepareForRound(s)
    return s
  }
  const layer = hillStartLayer({ hillLayer: HILL_DEFAULT_LAYER })
  // a pillar circle overlaps the hill iff some point of it within the radius stands on a hill tile
  const touchesHill = (x: number, y: number, r: number) => {
    for (let a = 0; a < 64; a++) {
      const t = (a / 64) * Math.PI * 2
      for (const k of [0.5, 1]) if (isLocationSafeAtLayer(layer, x + Math.cos(t) * r * k, y + Math.sin(t) * r * k)) return true
    }
    return isLocationSafeAtLayer(layer, x, y)
  }

  test('four rim pillars alternate between the corners and the tips, round by round', () => {
    const corners = shopAt(0).obstacles.slice(0, 4)
    const tips = shopAt(1).obstacles.slice(0, 4)
    expect(corners.every((o) => Math.abs(Math.abs(o.x) - Math.abs(o.y)) < 1e-6)).toBe(true)
    expect(tips.every((o) => Math.abs(o.x) < 1e-6 || Math.abs(o.y) < 1e-6)).toBe(true)
    expect(shopAt(2).obstacles.slice(0, 4).map((o) => [Math.sign(o.x), Math.sign(o.y)])).toEqual(corners.map((o) => [Math.sign(o.x), Math.sign(o.y)]))
  })

  test('a warlock pressed against a rim pillar from the hill still stands on it; no pillar blocks the hill itself', () => {
    for (const round of [0, 1]) {
      for (const seed of [1, 2, 3]) {
        const s = shopAt(round, seed)
        const rim = s.obstacles.slice(0, 4)
        for (const o of rim) {
          const d = Math.hypot(o.x, o.y)
          const back = (o.radius + 30) / d
          expect(isLocationSafeAtLayer(layer, o.x - o.x * back, o.y - o.y * back)).toBe(true)
          expect(touchesHill(o.x, o.y, o.radius)).toBe(false)
        }
        // the random extras keep off the hill too
        expect(s.obstacles.length).toBeGreaterThan(4)
        for (const o of s.obstacles.slice(4)) expect(touchesHill(o.x, o.y, o.radius + 100)).toBe(false)
      }
    }
  })
})
