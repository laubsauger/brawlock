import { describe, expect, test } from 'vitest'
import { FIREBALL_SLOT, PAWN_MAX_LIFE, SCOURGE_SLOT } from './config'
import { canBuy, step } from './index'
import { IMPLEMENTED_SPELLS } from './spells'
import { RELEASED_SPELLS, SPELLS } from './spells/data'
import { cmd, newMatch, pawn, runUntil, toCombat } from './testkit'
import type { InputCommand } from './types'

const buy = (s: ReturnType<typeof newMatch>, ...c: InputCommand[]) => step(s, [cmd(0, ...c)])

test('final spectators keep their gold and loadout while finalists can still prepare', () => {
  const s = newMatch({ startGold: 100 })
  s.settings.rankedRounds = 5
  s.round = 6
  s.rankedFinal = { contenders: [1] }
  pawn(s, 0).alive = false
  const gold = s.scores[0].gold
  const slots = [...pawn(s, 0).slots]
  expect(canBuy(s, 0)).toBe(false)
  expect(canBuy(s, 1)).toBe(true)
  buy(s, { kind: 'buySpell', spell: 'teleport' }, { kind: 'buyItem', item: 'health' }, { kind: 'buyMastery', mastery: 'range' })
  expect(s.scores[0].gold).toBe(gold)
  expect(pawn(s, 0).slots).toEqual(slots)
  expect(s.scores[0].masteries.range).toBe(0)
})

describe('starting kit (spells.md §2.1)', () => {
  test('12 slots, Fireball L1 in slot 6, Scourge L1 in slot 7, start gold 30', () => {
    const s = newMatch()
    const p = pawn(s, 0)
    expect(p.slots).toHaveLength(12)
    expect(p.slots[FIREBALL_SLOT]).toBe('fireball')
    expect(p.slots[SCOURGE_SLOT]).toBe('scourge')
    expect(p.levels[FIREBALL_SLOT]).toBe(1)
    expect(p.levels[SCOURGE_SLOT]).toBe(1)
    expect(p.slots.filter((x) => x !== null)).toHaveLength(2)
    expect(s.scores[0].gold).toBe(30)
  })
})

describe('spells: one per column, buy then upgrade with the original costs', () => {
  test('teleport 12, then upgrades 6, 7, ... until gold runs out', () => {
    const s = newMatch()
    const p = pawn(s, 0)
    buy(s, { kind: 'buySpell', spell: 'teleport' })
    expect(s.scores[0].gold).toBe(18)
    buy(s, { kind: 'buySpell', spell: 'teleport' }, { kind: 'buySpell', spell: 'teleport' })
    expect(p.levels[1]).toBe(3)
    expect(s.scores[0].gold).toBe(5)
    buy(s, { kind: 'buySpell', spell: 'teleport' }) // next upgrade costs 8
    expect(p.levels[1]).toBe(3)
    expect(s.scores[0].gold).toBe(5)
  })

  test('max level 7 and the total cost to max matches the table (63)', () => {
    const s = newMatch({ startGold: 1000 })
    const p = pawn(s, 0)
    for (let i = 0; i < 10; i++) buy(s, { kind: 'buySpell', spell: 'teleport' })
    expect(p.levels[1]).toBe(7)
    expect(1000 - s.scores[0].gold).toBe(63)
  })

  test('unreleased and unknown spells are rejected and cost nothing', () => {
    // derived from the live gate, so releasing spells never invalidates this test
    const unreleased = [...IMPLEMENTED_SPELLS].filter((id) => !RELEASED_SPELLS.has(id) && SPELLS[id]?.kind === 'spell')
    const s = newMatch({ startGold: 1000 })
    buy(s, ...unreleased.map((spell) => ({ kind: 'buySpell' as const, spell })), { kind: 'buySpell', spell: 'nonsense' })
    expect(pawn(s, 0).slots.slice(0, 6)).toEqual([null, null, null, null, null, null])
    expect(s.scores[0].gold).toBe(1000)
  })

  test('data table covers all 28 spells and items with 6 upgrade costs per column spell', () => {
    const all = Object.values(SPELLS)
    expect(all).toHaveLength(28)
    const spells = all.filter((d) => d.kind === 'spell')
    expect(spells).toHaveLength(24)
    for (const d of spells) {
      expect(d.upgradeCosts).toHaveLength(6)
      expect(d.cooldown).toHaveLength(7)
      expect(d.column).toBeGreaterThanOrEqual(1)
      expect(d.column).toBeLessThanOrEqual(6)
    }
    // column sizes 4 3 4 4 3 6
    const sizes = [1, 2, 3, 4, 5, 6].map((c) => spells.filter((d) => d.column === c).length)
    expect(sizes).toEqual([4, 3, 4, 4, 3, 6])
  })
})

describe('items: Fireball / Scourge upgrades', () => {
  test('7 gold per level, Fireball max 7, Scourge max 3, upgrade resets that cooldown', () => {
    const s = newMatch({ startGold: 200 })
    const p = pawn(s, 0)
    p.cooldowns[FIREBALL_SLOT] = 100
    buy(s, { kind: 'buyItem', item: 'fireball' })
    expect(p.levels[FIREBALL_SLOT]).toBe(2)
    expect(p.cooldowns[FIREBALL_SLOT]).toBe(0)
    expect(s.scores[0].gold).toBe(193)
    for (let i = 0; i < 8; i++) buy(s, { kind: 'buyItem', item: 'fireball' }, { kind: 'buyItem', item: 'scourge' })
    expect(p.levels[FIREBALL_SLOT]).toBe(7)
    expect(p.levels[SCOURGE_SLOT]).toBe(3)
    expect(s.scores[0].gold).toBe(200 - 6 * 7 - 2 * 7)
  })
})

describe('masteries (systems.md §4)', () => {
  test('5 gold per level, max 6; the bundle costs 13 and needs all three below max', () => {
    const s = newMatch({ startGold: 200 })
    const m = s.scores[0].masteries
    buy(s, { kind: 'buyMastery', mastery: 'range' })
    expect(m.range).toBe(1)
    expect(s.scores[0].gold).toBe(195)
    buy(s, { kind: 'buyMastery', mastery: 'all' })
    expect(m).toEqual({ duration: 1, range: 2, lifesteal: 1 })
    expect(s.scores[0].gold).toBe(182)
    for (let i = 0; i < 6; i++) buy(s, { kind: 'buyMastery', mastery: 'range' })
    expect(m.range).toBe(6)
    const gold = s.scores[0].gold
    buy(s, { kind: 'buyMastery', mastery: 'all' })
    expect(m.duration).toBe(1)
    expect(s.scores[0].gold).toBe(gold)
  })
})

describe('shop timing (SHOP_RULE = shopPhaseOrDead)', () => {
  test('allowed in the shop phase', () => {
    const s = newMatch()
    expect(canBuy(s, 0)).toBe(true)
    buy(s, { kind: 'buySpell', spell: 'teleport' })
    expect(pawn(s, 0).slots[1]).toBe('teleport')
  })

  test('rejected mid-fight while alive, nothing charged', () => {
    const s = newMatch({ shopSeconds: 1 })
    runUntil(s, (st) => st.phase === 'fight')
    expect(canBuy(s, 0)).toBe(false)
    buy(s, { kind: 'buySpell', spell: 'teleport' }, { kind: 'buyItem', item: 'fireball' }, { kind: 'buyMastery', mastery: 'range' })
    expect(pawn(s, 0).slots[1]).toBeNull()
    expect(pawn(s, 0).levels[FIREBALL_SLOT]).toBe(1)
    expect(s.scores[0].gold).toBe(30)
  })

  test('allowed while your pawn is dead (spectating), in any phase but gameOver', () => {
    const s = newMatch({ shopSeconds: 1, winScore: 1 }, 3)
    runUntil(s, (st) => st.phase === 'fight')
    const p0 = pawn(s, 0)
    p0.x = 3000 // lava
    runUntil(s, () => !p0.alive)
    expect(s.phase).toBe('fight') // two others still fighting
    expect(canBuy(s, 0)).toBe(true)
    expect(canBuy(s, 1)).toBe(false)
    buy(s, { kind: 'buySpell', spell: 'teleport' })
    expect(p0.slots[1]).toBe('teleport')
  })

  test('closed for everyone after game over', () => {
    const s = newMatch({ shopSeconds: 1, winScore: 1 })
    runUntil(s, (st) => st.phase === 'fight')
    pawn(s, 1).x = 3000
    runUntil(s, (st) => st.phase === 'gameOver')
    expect(canBuy(s, 0)).toBe(false)
    expect(canBuy(s, 1)).toBe(false)
    const gold = s.scores[1].gold
    step(s, [cmd(1, { kind: 'buyItem', item: 'fireball' })])
    expect(s.scores[1].gold).toBe(gold)
  })
})

describe('Fresh start: a human who took over a bot seat may sell its build (PLAN §2 deviation)', () => {
  const fresh: InputCommand = { kind: 'freshStart' }
  /** A seat the host just handed from a bot to a human, with the bot's build already bought on it. */
  const takenOver = () => {
    const s = newMatch({ startGold: 100 })
    buy(s,
      { kind: 'buySpell', spell: 'teleport' },
      { kind: 'buySpell', spell: 'teleport' },
      { kind: 'buyItem', item: 'ring_of_health' },
      { kind: 'buyMastery', mastery: 'all' },
    )
    s.slots[0] = { ...s.slots[0], takeover: s.round }
    return s
  }
  const kit = () => pawn(newMatch(), 0)

  test('the newcomer gets back every gold paid on the seat and the plain starting kit', () => {
    const s = takenOver()
    const p = pawn(s, 0)
    const paid = 100 - s.scores[0].gold
    // the inherited build is real: gold went out, max HP rose with the ring
    expect(paid).toBeGreaterThan(0)
    expect(s.scores[0].spent).toBe(paid)
    expect(p.maxHp).toBeGreaterThan(PAWN_MAX_LIFE)
    buy(s, fresh)
    expect(s.scores[0].gold).toBe(100)
    expect(s.scores[0].spent).toBe(0)
    expect(s.scores[0].masteries).toEqual({ duration: 0, range: 0, lifesteal: 0 })
    expect(p.slots).toEqual(kit().slots)
    expect(p.levels).toEqual(kit().levels)
    expect(p.maxHp).toBe(PAWN_MAX_LIFE)
    expect(p.hp).toBeLessThanOrEqual(p.maxHp)
    expect(s.events).toContainEqual({ type: 'freshStart', player: 0, pawn: p.id, refund: paid })
    // the other seat is untouched
    expect(s.scores[1].gold).toBe(100)
  })

  test('using it again only refunds what was bought since: no gold is minted', () => {
    const s = takenOver()
    buy(s, fresh)
    buy(s, { kind: 'buySpell', spell: 'teleport' })
    expect(s.scores[0].gold).toBe(88)
    buy(s, fresh)
    expect(s.scores[0].gold).toBe(100)
    buy(s, fresh)
    expect(s.scores[0].gold).toBe(100)
    expect(s.events.some((e) => e.type === 'freshStart')).toBe(false)
  })

  test('refused once the fight is on: the build is locked in for combat', () => {
    const s = takenOver()
    toCombat(s)
    s.slots[0] = { ...s.slots[0], takeover: s.round }
    pawn(s, 0).alive = false // dead players may shop mid-fight, but not sell
    const gold = s.scores[0].gold
    buy(s, fresh)
    expect(s.scores[0].gold).toBe(gold)
    expect(pawn(s, 0).slots[1]).toBe('teleport')
  })

  test('refused in ranked, where every seat plays the build it earned', () => {
    const s = takenOver()
    s.settings.rankedRounds = 5
    const gold = s.scores[0].gold
    buy(s, fresh)
    expect(s.scores[0].gold).toBe(gold)
    expect(pawn(s, 0).slots[1]).toBe('teleport')
  })

  test('refused for a seat that was never taken over, or taken over in an earlier round', () => {
    const own = takenOver()
    own.slots[0] = { ...own.slots[0], takeover: undefined }
    const gold = own.scores[0].gold
    buy(own, fresh)
    expect(own.scores[0].gold).toBe(gold)

    const old = takenOver()
    old.round = 3
    old.slots[0] = { ...old.slots[0], takeover: 2 }
    buy(old, fresh)
    expect(old.scores[0].gold).toBe(gold)
    expect(pawn(old, 0).slots[1]).toBe('teleport')
  })

  test('nothing bought, nothing to refund: no event', () => {
    const s = newMatch({ startGold: 100 })
    s.slots[0] = { ...s.slots[0], takeover: s.round }
    buy(s, fresh)
    expect(s.scores[0].gold).toBe(100)
    expect(s.events.some((e) => e.type === 'freshStart')).toBe(false)
  })
})
