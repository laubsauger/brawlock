/**
 * Cosmetics are looks only: whatever a player wears (horns, wings, a staff whose crystal the
 * renderer casts from), the simulation must play out exactly as for a bare warlock. Same seed,
 * same bot inputs, one side fully dressed: every tick's state, apart from the worn list itself,
 * must hash the same. Fails the moment any sim code reads equipment (hitbox, cast origin, speed).
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, createMatch, hashState, step } from './index'
import type { MatchSettings, PlayerSlot, SimState } from './index'
import { createBot } from '../bots'
import { COSMETICS, COSMETIC_SLOTS, EMPTY_EQUIPMENT, type CosmeticEquipment } from '../game/progressionCatalog'

const SETTINGS: MatchSettings = { ...DEFAULT_SETTINGS, winScore: 2, shopSeconds: 2 }

/** the last catalog item of every slot (a staff included) */
const DRESSED = Object.fromEntries(COSMETIC_SLOTS.map((slot) => [slot, COSMETICS.filter((c) => c.slot === slot).at(-1)!.id])) as unknown as CosmeticEquipment

function run(dressed: boolean): number[] {
  const slots: PlayerSlot[] = [0, 1, 2].map((i) => ({ id: i, name: `Bot ${i}`, color: 0xff0000 + i, team: i, kind: 'bot', difficulty: 'hard', cosmetics: dressed ? DRESSED : { ...EMPTY_EQUIPMENT } }))
  const state: SimState = createMatch(SETTINGS, slots, 7)
  const bots = slots.map((s) => createBot(s.id, 'hard', 7 * 31 + s.id))
  const hashes: number[] = []
  for (let i = 0; i < 60 * 60 && state.phase !== 'gameOver'; i++) {
    step(state, bots.map((b) => ({ player: b.player, tick: state.tick, cmds: b.think(state) })))
    const worn = state.slots.map((s) => s.cosmetics)
    for (const s of state.slots) delete s.cosmetics
    hashes.push(hashState(state))
    state.slots.forEach((s, k) => { s.cosmetics = worn[k] })
  }
  return hashes
}

describe('cosmetics', () => {
  it('never change the simulation: a fully dressed match plays out tick for tick like a bare one', () => {
    expect(COSMETIC_SLOTS.every((slot) => DRESSED[slot])).toBe(true)
    const bare = run(false)
    const dressed = run(true)
    expect(bare.length).toBeGreaterThan(600)
    expect(dressed).toEqual(bare)
  })
})
