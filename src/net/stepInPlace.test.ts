import { describe, expect, it } from 'vitest'
import { BotController } from '../bots'
import { DEFAULT_SETTINGS, createMatch, step, ticks as toTicks } from '../sim'
import { cloneState, hashState } from '../sim/snapshot'
import type { BotDifficulty, PlayerInput, PlayerSlot, SimEvent } from '../sim/types'
import { EVENT_REDUNDANCY_TICKS } from './protocol'

/**
 * The dedicated server steps its match state in place instead of a copy each tick (session
 * hostTick). That is only sound if stepping in place is exactly stepping a copy, and if what the
 * host keeps of a tick (its events, resent for EVENT_REDUNDANCY_TICKS) is not changed by later
 * steps. A bot match's first round and the start of its second cover the spells the builds buy,
 * deaths, arena shrinks and both round transitions (fight to shop, shop to fight).
 */
describe('stepping the match state in place', () => {
  it('matches stepping copies tick for tick and leaves earlier events untouched', () => {
    const diffs: BotDifficulty[] = ['hard', 'brutal', 'medium', 'uber', 'hard', 'easy', 'brutal', 'hard', 'uber', 'medium']
    const seed = 3
    const slots: PlayerSlot[] = diffs.map((d, id) => ({ id, name: `b${id}`, color: id, team: id, kind: 'bot', difficulty: d }))
    const settings = { ...DEFAULT_SETTINGS, winScore: 2, startGold: 50, roundGold: 15 }
    const inPlace = createMatch(settings, slots, seed)
    let copied = createMatch(settings, slots, seed)
    const bots = diffs.map((d, id) => new BotController(id, d, seed))
    const kept: { events: SimEvent[]; json: string; tick: number }[] = []
    let ticks = 0
    // until five seconds into round two's fight (eight minutes at most)
    const maxTicks = toTicks(8 * 60)
    let stopAt = Infinity
    while (inPlace.phase !== 'gameOver' && ticks < maxTicks && ticks < stopAt) {
      const inputs: PlayerInput[] = []
      for (const b of bots) {
        const cmds = b.think(inPlace)
        if (cmds.length) inputs.push({ player: b.player, tick: inPlace.tick, cmds })
      }
      step(inPlace, inputs)
      const next = cloneState(copied)
      step(next, inputs)
      copied = next
      // a divergence never heals: comparing every few ticks catches it
      if (ticks % 15 === 0) expect(hashState(inPlace)).toBe(hashState(copied))
      if (inPlace.events.length) kept.push({ events: inPlace.events, json: JSON.stringify(inPlace.events), tick: inPlace.tick })
      // the host resends a tick's events for a while: they must still read as emitted
      while (kept.length && kept[0].tick <= inPlace.tick - EVENT_REDUNDANCY_TICKS) {
        const k = kept.shift()!
        expect(JSON.stringify(k.events)).toBe(k.json)
      }
      ticks++
      if (stopAt === Infinity && inPlace.round === 2 && inPlace.phase === 'fight') stopAt = ticks + toTicks(5)
    }
    expect(hashState(inPlace)).toBe(hashState(copied))
    expect(ticks).toBe(stopAt)
    for (const k of kept) expect(JSON.stringify(k.events)).toBe(k.json)
  })
})
