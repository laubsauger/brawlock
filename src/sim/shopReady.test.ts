import { describe, expect, it } from 'vitest'
import { RANKED_FINAL_SHOP_SECONDS, SHOP_READY_MIN_SECONDS, SHOP_READY_SECONDS, ticks } from './config'
import { killPawn } from './combat'
import { setPlayerConnected, shopReadyView, step } from './index'
import { applyRosterChanges } from './roster'
import { cmd, newMatch, of, pawn, run, toCombat } from './testkit'
import type { InputCommand, MatchSettings, SimEvent, SimState } from './types'

const READY: InputCommand = { kind: 'shopReady', ready: true }
const UNREADY: InputCommand = { kind: 'shopReady', ready: false }

/** `n` seats: the first `humans` human, the rest Medium bots. In the first shop phase. */
function table(humans: number, n = 10, overrides: Partial<MatchSettings> = {}): SimState {
  const s = newMatch(overrides, n)
  for (const slot of s.slots) if (slot.id >= humans) Object.assign(slot, { kind: 'bot', difficulty: 'medium' })
  return s
}

/** Step until `seconds` of the first shop have passed. */
function shopUntil(s: SimState, seconds: number): void {
  run(s, ticks(seconds) - (ticks(s.settings.shopSeconds) - s.phaseTicksLeft))
}

/** Step until the fight starts; returns the ticks it took and every event seen. */
function toFight(s: SimState, inputs: (s: SimState) => ReturnType<typeof cmd>[] = () => []): { ticks: number; events: SimEvent[] } {
  const events: SimEvent[] = []
  let n = 0
  while (s.phase !== 'fight') {
    step(s, inputs(s))
    events.push(...s.events)
    n += 1
    if (n > ticks(60)) throw new Error('the shop never ended')
  }
  return { ticks: n, events }
}

describe('Shop Ready', () => {
  it('waits for every human: one Ready changes nothing, the last one ends the shop 3 s later', () => {
    // the shop is everyone's time; nobody may cut it short for the others
    const s = table(2)
    shopUntil(s, 10)
    step(s, [cmd(0, READY)])
    expect(of(s.events, 'allReady')).toHaveLength(0)
    expect(s.phaseTicksLeft).toBe(ticks(15) - 1)
    step(s, [cmd(1, READY)])
    const cut = of(s.events, 'allReady')
    expect(cut).toHaveLength(1)
    const rest = toFight(s)
    const total = ticks(10) + 2 + rest.ticks
    expect(total).toBe(ticks(10) + 1 + ticks(SHOP_READY_SECONDS))
    expect(cut[0].saved).toBe(ticks(25) - total)
    expect(of(rest.events, 'allReady')).toHaveLength(0)
  })

  it('never ends the shop in its first 6 s, so the round result lands and slow buyers finish', () => {
    // Easy bots need up to about 5.4 s to finish buying
    const s = table(2)
    shopUntil(s, 1)
    step(s, [cmd(0, READY), cmd(1, READY)])
    expect(ticks(1) + 1 + toFight(s).ticks).toBe(ticks(SHOP_READY_MIN_SECONDS))
  })

  it('lets a player alone with bots skip the wait: bots are always ready', () => {
    const s = table(1)
    shopUntil(s, 4)
    step(s, [cmd(0, READY)])
    expect(ticks(4) + 1 + toFight(s).ticks).toBe(ticks(4) + ticks(SHOP_READY_SECONDS))
  })

  it('does not let a leaver hold the room: a disconnect cuts the shop on that tick', () => {
    const s = table(2)
    shopUntil(s, 8)
    step(s, [cmd(1, READY)])
    expect(of(s.events, 'allReady')).toHaveLength(0)
    setPlayerConnected(s, 0, false)
    step(s, [])
    expect(of(s.events, 'allReady')).toHaveLength(1)
  })

  it('gives a newcomer time, and a cut once made stays made', () => {
    const s = table(1)
    shopUntil(s, 5)
    applyRosterChanges(s, [{ ...s.slots[3], kind: 'human', difficulty: undefined, profileId: 'p-new' }])
    step(s, [cmd(0, READY)])
    expect(of(s.events, 'allReady')).toHaveLength(0)
    run(s, ticks(2))
    step(s, [cmd(3, READY)])
    expect(of(s.events, 'allReady')).toHaveLength(1)
    const left = s.phaseTicksLeft
    applyRosterChanges(s, [{ ...s.slots[4], kind: 'human', difficulty: undefined, profileId: 'p-later' }])
    step(s, [cmd(0, UNREADY)])
    expect(s.phaseTicksLeft).toBe(left - 1)
    expect(toFight(s).ticks).toBe(left - 1)
  })

  it('never inherits consent: a new occupant of a ready seat is not ready', () => {
    const s = table(2)
    step(s, [cmd(1, READY)])
    expect(s.shopReady).toEqual([1])
    applyRosterChanges(s, [{ ...s.slots[1], profileId: 'someone-else' }])
    expect(s.shopReady).toEqual([])
  })

  it('never lengthens a shop: a 5 s custom shop stays 5 s', () => {
    const s = table(2, 4, { shopSeconds: 5 })
    const { ticks: n, events } = toFight(s, (st) => (st.tick === 0 ? [cmd(0, READY), cmd(1, READY)] : []))
    expect(n).toBe(ticks(5))
    expect(of(events, 'allReady')).toHaveLength(0)
  })

  it('hears only seats that count: bots, fighters and benched finalists change nothing', () => {
    const s = table(1, 4)
    step(s, [cmd(2, READY)])
    expect(s.shopReady).toBeUndefined()
    toCombat(s)
    step(s, [cmd(0, READY)])
    expect(s.shopReady).toBeUndefined()

    // ranked final: only the finalists count
    const f = table(3, 4, { rankedRounds: 5 })
    f.rankedFinal = { contenders: [0, 1] }
    f.phaseTicksLeft = ticks(RANKED_FINAL_SHOP_SECONDS)
    step(f, [cmd(2, READY)])
    expect(f.shopReady).toBeUndefined()
    expect(shopReadyView(f, 2).shown).toBe(false)
    step(f, [cmd(0, READY), cmd(1, READY)])
    expect(of(f.events, 'allReady')).toHaveLength(1)
  })

  it('keeps every bot-only shop at full length, so harnesses and the ladder keep their timing', () => {
    const s = table(0, 4)
    const { ticks: n, events } = toFight(s)
    expect(n).toBe(ticks(25))
    expect(of(events, 'allReady')).toHaveLength(0)
  })

  it('drops malformed Ready commands', () => {
    const s = table(1, 2)
    const bad = [{ kind: 'shopReady', ready: 'yes' }, { kind: 'shopReady', ready: true, x: 1 }, { kind: 'shopReady' }] as unknown as InputCommand[]
    step(s, [cmd(0, ...bad)])
    expect(s.shopReady).toBeUndefined()
  })

  it('cuts the opening shop of a respawn mode, but means nothing in its fight', () => {
    const s = table(1, 4, { gameMode: 'deathmatch' })
    step(s, [cmd(0, READY)])
    expect(of(s.events, 'allReady')).toHaveLength(1)
    toCombat(s)
    killPawn(s, pawn(s, 0), null, 'lava')
    expect(shopReadyView(s, 0).shown).toBe(false)
    step(s, [cmd(0, READY)])
    expect(s.shopReady).toBeUndefined()
  })

  it('shows the button state the HUD needs', () => {
    const s = table(2, 4)
    expect(shopReadyView(s, 0)).toEqual({ shown: true, can: true, mine: false, ready: 0, total: 2, starting: false })
    expect(shopReadyView(s, 2).shown).toBe(false)
    step(s, [cmd(0, READY), cmd(1, READY)])
    expect(shopReadyView(s, 0)).toMatchObject({ shown: true, can: false, mine: true, ready: 2, total: 2, starting: true })
  })
})

describe('shopping while out', () => {
  it('pays the round gold at the knockout, the same total as before, and the win gold only at the win', () => {
    // the round gold is the same for everyone whatever the outcome, so paying it early decides nothing
    const s = table(3, 3, { roundGold: 15, winGold: 3 })
    toCombat(s)
    const before = s.scores.map((sc) => sc.gold)
    killPawn(s, pawn(s, 2), null, 'lava')
    expect(s.scores.map((sc) => sc.gold)).toEqual([before[0], before[1], before[2] + 15])
    killPawn(s, pawn(s, 1), null, 'lava')
    // the last knockout decides the round: its win gold comes with roundWin, the survivor's round gold at round end
    expect(s.scores.map((sc) => sc.gold)).toEqual([before[0] + 3, before[1] + 15, before[2] + 15])
    expect(s.phase).toBe('roundEnd')
    run(s, ticks(5))
    expect(s.phase).toBe('shop')
    expect(s.scores.map((sc) => sc.gold)).toEqual([before[0] + 15 + 3, before[1] + 15, before[2] + 15])
    expect(s.scores.some((sc) => 'roundPaid' in sc)).toBe(false)
  })

  it('pays again next round, once', () => {
    const s = table(3, 3, { roundGold: 15 })
    toCombat(s)
    killPawn(s, pawn(s, 2), null, 'lava')
    killPawn(s, pawn(s, 1), null, 'lava')
    toCombat(s)
    const gold = s.scores[2].gold
    killPawn(s, pawn(s, 2), null, 'lava')
    expect(s.scores[2].gold).toBe(gold + 15)
  })

  it('changes nothing in respawn modes, where a death is not out', () => {
    const s = table(2, 2, { gameMode: 'deathmatch', roundGold: 15 })
    toCombat(s)
    const gold = s.scores[1].gold
    killPawn(s, pawn(s, 1), null, 'lava')
    expect(s.scores[1].gold).toBe(gold)
    expect(s.scores[1].roundPaid).toBeUndefined()
  })

  it('lets the knocked out buy and ready, so the next shop runs only its 6 s floor', () => {
    const s = table(2, 4, { roundGold: 15 })
    toCombat(s)
    killPawn(s, pawn(s, 0), null, 'lava')
    killPawn(s, pawn(s, 1), null, 'lava')
    const gold = s.scores[0].gold
    step(s, [cmd(0, { kind: 'buyMastery', mastery: 'range' }, READY), cmd(1, READY)])
    expect(s.scores[0].gold).toBe(gold - 5)
    expect(s.shopReady).toEqual([0, 1])
    killPawn(s, pawn(s, 3), null, 'lava')
    let opening: SimEvent[] = []
    while (s.phase !== 'shop') {
      step(s, [])
      opening = s.events
    }
    // cut as it opens, so the shop's own banner already shows the real time
    expect(s.phaseTicksLeft).toBe(ticks(SHOP_READY_MIN_SECONDS))
    expect(of(opening, 'allReady')).toEqual([{ type: 'allReady', saved: ticks(25) - ticks(SHOP_READY_MIN_SECONDS) }])
    expect(toFight(s).ticks).toBe(ticks(SHOP_READY_MIN_SECONDS))
    expect(s.shopReady).toBeUndefined()
  })
})
