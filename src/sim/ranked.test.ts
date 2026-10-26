import { describe, expect, test } from 'vitest'
import { ARENA_BASE_LAYER, ARENA_LAYER_PER_PLAYER, RANKED_FINAL_SHOP_SECONDS, RANKED_FINAL_SHRINK_PERIOD, RANKED_SHRINK_PERIOD, ROUND_END_SECONDS, ticks } from './config'
import { killPawn } from './combat'
import { BET_TWO_STARTER_SECONDS, canSpectateBet, placeSpectateBet } from './bets'
import { cloneState, gameWinners, hashState, isRoundParticipant, setPlayerConnected, step } from './index'
import { endRound, roundWon, startRound } from './mode'
import { MOD_SPAWN_INVULNERABLE, removeModifiers } from './modifiers'
import { attr, cooldownSeconds, SPELLS } from './spells/data'
import { masteryFactor } from './stats'
import { activePlayers } from './teams'
import { clampLayer } from './arena'
import { cmd, grant, newMatch, of, pawn, place, run, runUntil } from './testkit'
import type { SimState } from './types'

function ranked(n = 8, botsReplaceLeavers = true): SimState {
  return newMatch({ rankedRounds: 5, shopSeconds: 0, startGold: 40, roundGold: 12, winGold: 3, botsReplaceLeavers }, n)
}

/** Resolve actual knockouts, then let the normal three-second round-end timer run. */
function winRound(state: SimState, winner: number): void {
  if (state.phase === 'shop') startRound(state)
  expect(state.phase).toBe('fight')
  for (const p of state.pawns) if (p.owner !== winner && p.alive) killPawn(state, p, null, 'lava')
  expect(state.phase).toBe('roundEnd')
  run(state, ticks(ROUND_END_SECONDS))
}

/** The fight platform a regular round gives this many players: a final's is smaller (RANKED-FORMAT.md). */
const regularLayer = (players: number) => clampLayer(ARENA_BASE_LAYER + ARENA_LAYER_PER_PLAYER * players)

function tiedFinal(): SimState {
  const state = ranked()
  for (const winner of [0, 1, 0, 1, 2]) winRound(state, winner)
  expect(state.rankedFinal?.contenders).toEqual([0, 1])
  return state
}

describe('dedicated ranked scheduled rounds', () => {
  test('five distinct winners reach a single five-leader final, then stop after round six', () => {
    const state = ranked()
    for (let winner = 0; winner < 5; winner++) {
      winRound(state, winner)
      expect(state.phase).toBe('shop')
      expect(state.round).toBe(winner + 1)
    }
    expect(state.rankedFinal).toEqual({ contenders: [0, 1, 2, 3, 4] })
    expect(state.phaseTicksLeft).toBe(ticks(RANKED_FINAL_SHOP_SECONDS))
    // a smaller platform than a regular round of five, but larger than a two-warlock final's
    expect(state.arena.layer).toBeLessThan(regularLayer(5))
    expect(state.arena.layer).toBeGreaterThan(tiedFinal().arena.layer)
    expect(state.pawns.filter((p) => p.alive).map((p) => p.owner)).toEqual([0, 1, 2, 3, 4])
    winRound(state, 4)
    expect(state.round).toBe(6)
    expect(state.phase).toBe('gameOver')
    expect(gameWinners(state)).toEqual([4])
    expect(state.scores.map((s) => s.score)).toEqual([1, 1, 1, 1, 1, 0, 0, 0])
    expect(state.rankedFinal?.winners).toEqual([4])
    expect(of(state.events, 'gameOver')).toEqual([{ type: 'gameOver', winners: [4] }])
    run(state, ticks(30))
    expect(state.round).toBe(6)
    expect(gameWinners(state)).toEqual([4])
  })

  test('a three-win lead clinches round three; a catchable lead continues', () => {
    const state = ranked()
    winRound(state, 0)
    winRound(state, 0)
    expect(state.phase).toBe('shop')
    expect(gameWinners(state)).toBeNull()
    winRound(state, 0)
    expect(state.phase).toBe('gameOver')
    expect(state.round).toBe(3)
    expect(gameWinners(state)).toEqual([0])
    expect(state.rankedFinal).toBeUndefined()

    const catchable = ranked()
    for (const winner of [0, 0, 1, 2]) winRound(catchable, winner)
    expect(catchable.phase).toBe('shop')
    expect(catchable.round).toBe(4)
    winRound(catchable, 0)
    expect(catchable.phase).toBe('gameOver')
    expect(catchable.round).toBe(5)
  })

  test('a 2–2 tie admits only leaders and preserves purchases, masteries and earned gold', () => {
    const state = ranked()
    grant(state, 1, 'drain', 4)
    grant(state, 1, 'cape', 3)
    state.scores[1].masteries.duration = 3
    for (const winner of [0, 1, 0, 1, 2]) winRound(state, winner)
    expect(state.rankedFinal).toEqual({ contenders: [0, 1] })
    const finalLayer = state.arena.layer
    expect(finalLayer).toBeLessThan(regularLayer(2))
    expect(state.phaseTicksLeft).toBe(ticks(RANKED_FINAL_SHOP_SECONDS))
    expect(state.scores[1].gold).toBe(40 + 5 * 12 + 2 * 3)
    expect(state.scores[1].masteries.duration).toBe(3)
    expect(pawn(state, 1).levels[pawn(state, 1).slots.indexOf('drain')]).toBe(4)
    expect(pawn(state, 1).levels[pawn(state, 1).slots.indexOf('cape')]).toBe(3)
    expect(state.scores.every((s) => s.connected)).toBe(true)
    expect(activePlayers(state)).toEqual([0, 1])
    expect(isRoundParticipant(state, 2)).toBe(false)
    const outsiderDeaths = state.scores[2].deaths
    setPlayerConnected(state, 2, false)
    setPlayerConnected(state, 2, true)
    step(state, [cmd(2, { kind: 'move', x: 0, y: 0 }), cmd(2, { kind: 'cast', slot: 0, x: 0, y: 0 })])
    expect(pawn(state, 2).alive).toBe(false)
    expect(pawn(state, 2).cast).toBeNull()
    expect(state.scores[2].deaths).toBe(outsiderDeaths)
    expect(of(state.events, 'death')).toEqual([])
    startRound(state)
    // the final fights on the platform it shopped on
    expect(state.arena.layer).toBe(finalLayer)
    expect(state.arena.nextShrinkTick - state.tick).toBe(ticks(RANKED_FINAL_SHRINK_PERIOD))
    expect(pawn(state, 2).alive).toBe(false)
    killPawn(state, pawn(state, 0), 1, 'fireball')
    expect(state.scores[1].score).toBe(2)
    expect(state.scores[1].gold).toBe(40 + 5 * 12 + 3 * 3 + state.settings.killGold)
    expect(of(state.events, 'roundWin').at(-1)?.players).toEqual([1])
    run(state, ticks(ROUND_END_SECONDS))
    expect(gameWinners(state)).toEqual([1])
    expect(gameWinners(cloneState(state))).toEqual([1])
  })

  test('a sole remaining finalist wins at fight start, and all gone shares the final without a seventh round', () => {
    const sole = tiedFinal()
    sole.settings.botsReplaceLeavers = false
    setPlayerConnected(sole, 0, false)
    startRound(sole)
    expect(sole.phase).toBe('roundEnd')
    expect(sole.rankedFinal?.winners).toEqual([1])
    endRound(sole)
    expect(sole.phase).toBe('gameOver')
    expect(gameWinners(sole)).toEqual([1])

    const gone = tiedFinal()
    gone.settings.botsReplaceLeavers = false
    for (const id of [0, 1]) setPlayerConnected(gone, id, false)
    startRound(gone)
    expect(gone.phase).toBe('roundEnd')
    expect(of(gone.events, 'roundWin').at(-1)?.players).toEqual([])
    expect(gone.betting.lastSettlement?.round).toBe(6)
    endRound(gone)
    expect(gone.phase).toBe('gameOver')
    expect(gameWinners(gone)).toEqual([0, 1])
    expect(gone.round).toBe(6)
  })

  test('the two-warlock final takes bets for its first seconds only', () => {
    // Why: spectators may bet on the final, but not once the duel is decided (a safe late bet).
    const state = tiedFinal()
    startRound(state)
    expect(canSpectateBet(state, 2, 0)).toBe(true)
    run(state, ticks(BET_TWO_STARTER_SECONDS))
    expect(canSpectateBet(state, 2, 0)).toBe(false)
  })

  test('disconnecting all finalists during combat resolves once; regular draws consume scheduled rounds', () => {
    const state = tiedFinal()
    state.settings.botsReplaceLeavers = false
    startRound(state)
    const bettorGold = state.scores[2].gold
    expect(placeSpectateBet(state, 2, 6, 0)).toBe(true)
    for (const id of [0, 1]) setPlayerConnected(state, id, false)
    step(state, [])
    expect(state.rankedFinal?.winners).toEqual([0, 1])
    expect(of(state.events, 'roundWin')).toHaveLength(1)
    expect(state.scores[2].gold).toBe(bettorGold)
    run(state, ticks(ROUND_END_SECONDS))
    expect(state.phase).toBe('gameOver')

    const draws = ranked()
    for (let round = 1; round <= 5; round++) {
      startRound(draws)
      for (const p of draws.pawns) p.alive = false
      roundWon(draws, null)
      endRound(draws)
      expect(draws.round).toBe(round)
    }
    expect(draws.rankedFinal?.contenders).toHaveLength(8)
    expect(draws.arena.layer).toBeLessThan(regularLayer(8))
    startRound(draws)
    for (const p of draws.pawns) p.alive = false
    roundWon(draws, null)
    endRound(draws)
    expect(draws.phase).toBe('gameOver')
    expect(gameWinners(draws)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(draws.round).toBe(6)
  })

  test.each(['shield', 'rush'])('ranked collapse reaches zero safe floor while max passive health and %s still burn', (defense) => {
    const state = ranked(2)
    startRound(state)
    expect(state.arena.nextShrinkTick - state.tick).toBe(ticks(RANKED_SHRINK_PERIOD))
    for (const p of state.pawns) {
      grant(state, p.owner, 'ring_of_health', 5)
      grant(state, p.owner, 'cursed_ring', 2)
      grant(state, p.owner, 'cape', 3)
      grant(state, p.owner, defense, 7)
      state.scores[p.owner].masteries.duration = 6
      place(p, p.owner === 0 ? 0 : 80, 0)
      removeModifiers(state, p, MOD_SPAWN_INVULNERABLE)
    }
    // No artificial fight deadline: hold the centre until every tile is removed naturally.
    const events = runUntil(state, (s) => s.arena.layer === 1)
    expect(of(events, 'arenaShrink').at(-1)?.layer).toBe(1)
    expect(state.phase).toBe('fight')
    const collapsedAt = state.tick
    const burning = []
    while (state.phase === 'fight' && state.tick - collapsedAt < ticks(25)) {
      step(state, state.pawns.map((p) => cmd(p.owner, { kind: 'cast', slot: p.slots.indexOf(defense), x: p.x, y: p.y })))
      burning.push(...state.events)
    }
    expect(state.phase).toBe('roundEnd')
    expect(state.tick - collapsedAt).toBeLessThan(ticks(25))
    expect(of(burning, 'cast').some((e) => e.spell === defense)).toBe(true)
    expect(of(burning, 'damage').filter((e) => e.cause === 'lava').every((e) => e.amount === 25 && !e.absorbed)).toBe(true)
    expect(of(burning, 'death')[0]?.cause).toBe('lava')
  })

  test('max Drain/Pact/lifesteal cannot replenish the collapsed arena health pool indefinitely', () => {
    const state = ranked(2)
    startRound(state)
    state.arena.layer = 1
    for (const p of state.pawns) {
      for (const [id, level] of [['ring_of_health', 5], ['cursed_ring', 2], ['cape', 3], ['pact', 1], ['drain', 7]] as const) {
        grant(state, p.owner, id, level)
      }
      state.scores[p.owner].masteries = { duration: 6, range: 6, lifesteal: 6 }
      p.hp = p.maxHp
      place(p, p.owner === 0 ? -100 : 100, 0, p.owner === 0 ? 0 : Math.PI)
      removeModifiers(state, p, MOD_SPAWN_INVULNERABLE)
    }
    const p = pawn(state, 0)
    expect(p.maxHp).toBe(1600)
    expect(p.hpRegen).toBe(8.5)
    // Only Drain and passive regeneration create health. Other lifesteal returns <100% of
    // health removed from a living enemy, so cannot grow the aggregate health pool.
    // Generously assume every max-Pact Drain creates its entire heal AND lifesteal without
    // removing any enemy HP, and that Pact is available for every Drain (actual cooldown30s).
    const drain = SPELLS.drain
    const burst = attr(drain, 'damage', drain.maxLevel) * attr(SPELLS.pact, 'damage_multiplier', 1)
    const generousReplenishment = p.hpRegen + burst * (1 + masteryFactor('lifesteal', 6)) / cooldownSeconds(drain, drain.maxLevel)
    expect(generousReplenishment).toBeLessThan(state.settings.lavaDps)
    const burning = []
    for (let tick = 0; tick < ticks(30) && state.phase === 'fight'; tick++) {
      const inputs = state.pawns.filter((q) => q.alive && !q.cast).map((q) => {
        const pactSlot = q.slots.indexOf('pact')
        const drainSlot = q.slots.indexOf('drain')
        const target = pawn(state, q.owner === 0 ? 1 : 0)
        const slot = q.cooldowns[pactSlot] === 0 ? pactSlot : drainSlot
        return cmd(q.owner, { kind: 'cast', slot, x: target.x, y: target.y })
      })
      step(state, inputs)
      burning.push(...state.events)
    }
    expect(of(burning, 'cast').some((e) => e.spell === 'pact')).toBe(true)
    expect(of(burning, 'cast').some((e) => e.spell === 'drain')).toBe(true)
    expect(of(burning, 'heal').length).toBeGreaterThan(0)
    expect(state.phase).toBe('roundEnd')
    expect(state.tick).toBeLessThan(ticks(30))
  })

  test('absent/zero flag preserves first-to rules and deterministic snapshots; invalid formats fail clearly', () => {
    for (const rankedRounds of [undefined, 0] as const) {
      const state = newMatch({ rankedRounds, shopSeconds: 0, winScore: 5 }, 8)
      for (let round = 0; round < 4; round++) winRound(state, 0)
      expect(state.phase).toBe('shop')
      expect(state.rankedFinal).toBeUndefined()
      startRound(state)
      expect(state.arena.nextShrinkTick - state.tick).toBe(ticks(10))
      const copy = cloneState(state)
      run(state, 20)
      run(copy, 20)
      expect(hashState(copy)).toBe(hashState(state))
    }
    expect(() => newMatch({ rankedRounds: 5, gameMode: 'deathmatch' })).toThrow('free-for-all rounds')
    expect(() => newMatch({ rankedRounds: 5, teamMode: 'teams' })).toThrow('free-for-all rounds')
    expect(() => newMatch({ rankedRounds: 4 } as never)).toThrow('five scheduled rounds')
  })
})
