import { describe, expect, test } from 'vitest'
import { FIREBALL_SLOT } from './config'
import { step } from './index'
import { IMPLEMENTED_SPELLS } from './spells'
import { RELEASED_SPELLS, SPELLS } from './spells/data'
import { castNow, cmd, fight, grant, newMatch, of, pawn, place, run, runUntil } from './testkit'
import type { SimEvent } from './types'

// Render scales effects with the spell level, so every projectile (children included) and every
// caster-spell event must carry the level of the slot that cast it.
describe('spell levels are reported for level-scaled visuals', () => {
  test('cast and castStart carry the slot level', () => {
    const s = fight()
    place(pawn(s, 0), 0, 0, 0)
    place(pawn(s, 1), 0, 1500)
    pawn(s, 0).levels[FIREBALL_SLOT] = 3
    const events = castNow(s, 0, FIREBALL_SLOT, 500, 0)
    expect(of(events, 'castStart')[0].level).toBe(3)
    expect(of(events, 'cast')[0].level).toBe(3)
    expect(s.projectiles[0].level).toBe(3)
  })

  const castable = Object.values(SPELLS).map((d) => d.id)
  const NO_PROJECTILE = new Set(['scourge', 'teleport', 'thrust', 'lightning', 'windwalk', 'shield', 'rush', 'alteration', 'rockpillar', 'pact', 'redirector'])
  for (const id of castable) {
    test(`${id}: every projectile and level-carrying event reports its level`, () => {
      const level = Math.min(4, SPELLS[id].maxLevel)
      const s = fight()
      const caster = pawn(s, 0)
      const victim = pawn(s, 1)
      place(caster, 0, 0, 0)
      place(victim, 260, 0)
      s.obstacles.push({ id: s.nextEntityId++, x: 0, y: -700, radius: 60, hp: 400, variant: 0 })
      const slot = grant(s, 0, id, level)
      const events: SimEvent[] = [...castNow(s, 0, slot, 260, 0)]
      // walk into the victim (Windwalk charge) and let everything play out (orbs return, splits)
      step(s, [cmd(0, { kind: 'move', x: 260, y: 0 })])
      events.push(...s.events)
      const seen = new Set<number>()
      for (let i = 0; i < 180; i++) {
        for (const p of s.projectiles) {
          seen.add(p.id)
          expect(p.level, `${p.kind ?? p.spell} #${p.id}`).toBe(level)
        }
        step(s, [])
        events.push(...s.events)
      }
      // non-vacuous: the spell fired, and projectile spells really produced projectiles
      expect(of(events, 'cast').some((e) => e.pawn === caster.id && e.spell === id)).toBe(true)
      if (!NO_PROJECTILE.has(id)) expect(seen.size).toBeGreaterThan(0)
      for (const e of of(events, 'cast')) if (e.pawn === caster.id) expect(e.level).toBe(level)
      for (const e of of(events, 'castStart')) if (e.pawn === caster.id) expect(e.level).toBe(level)
      for (const e of of(events, 'beam')) expect(e.level).toBe(level)
      for (const e of of(events, 'spellHit')) expect(e.level).toBe(level)
      for (const e of of(events, 'explosion')) if (e.spell !== 'obstacle') expect(e.level).toBe(level)
    })
  }

  test('children inherit: Drain heal orb, Recharge refresh orb, Splitter spawner and children', () => {
    const kinds = new Map<string, number>()
    for (const id of ['drain', 'recharge', 'splitter']) {
      const s = fight()
      place(pawn(s, 0), 0, 0, 0)
      place(pawn(s, 1), 260, 0)
      castNow(s, 0, grant(s, 0, id, 6), id === 'splitter' ? 3000 : 260, 0)
      for (let i = 0; i < 120; i++) {
        for (const p of s.projectiles) if (p.kind) kinds.set(p.kind, p.level ?? -1)
        step(s, [])
      }
    }
    expect(Object.fromEntries(kinds)).toEqual({ drainHeal: 6, rechargeRefresh: 6, splitterSpawner: 6, splitterChild: 6 })
  })
})

describe("'purchase' events fire only on a successful buy or upgrade", () => {
  const buy = (s: ReturnType<typeof newMatch>, ...c: Parameters<typeof cmd>[1][]) => {
    step(s, [cmd(0, ...c)])
    return of(s.events, 'purchase')
  }

  test('spell buy and upgrade, item upgrade, mastery: kind, id and the new level', () => {
    const s = newMatch({ startGold: 200 })
    const p = pawn(s, 0)
    expect(buy(s, { kind: 'buySpell', spell: 'teleport' })).toEqual([{ type: 'purchase', player: 0, pawn: p.id, kind: 'spell', id: 'teleport', level: 1 }])
    expect(buy(s, { kind: 'buySpell', spell: 'teleport' })[0]).toMatchObject({ kind: 'spell', id: 'teleport', level: 2 })
    expect(buy(s, { kind: 'buyItem', item: 'fireball' })[0]).toMatchObject({ kind: 'item', id: 'fireball', level: 2 })
    expect(buy(s, { kind: 'buyMastery', mastery: 'range' })[0]).toMatchObject({ kind: 'mastery', id: 'range', level: 1 })
    // the bundle raises three masteries: one event each with its new level
    expect(buy(s, { kind: 'buyMastery', mastery: 'all' }).map((e) => [e.id, e.level])).toEqual([['duration', 1], ['range', 2], ['lifesteal', 1]])
  })

  test('rejected purchases emit nothing', () => {
    const s = newMatch({ startGold: 11 })
    expect(buy(s, { kind: 'buySpell', spell: 'teleport' })).toEqual([]) // 12 gold needed
    s.scores[0].gold = 1000
    // not released (derived from the live gate; skipped once everything is released) or unknown:
    // rejected even with plenty of gold
    const unreleased = [...IMPLEMENTED_SPELLS].filter((id) => !RELEASED_SPELLS.has(id) && SPELLS[id]?.kind === 'spell')
    for (const spell of unreleased) expect(buy(s, { kind: 'buySpell', spell })).toEqual([])
    expect(buy(s, { kind: 'buySpell', spell: 'nonsense' })).toEqual([])
    expect(s.scores[0].gold).toBe(1000)
    pawn(s, 0).levels[7] = 3
    expect(buy(s, { kind: 'buyItem', item: 'scourge' })).toEqual([]) // max level
    for (let i = 0; i < 6; i++) buy(s, { kind: 'buyMastery', mastery: 'range' })
    expect(buy(s, { kind: 'buyMastery', mastery: 'range' })).toEqual([]) // maxed
    expect(buy(s, { kind: 'buyMastery', mastery: 'all' })).toEqual([]) // a mastery is maxed
    runUntil(s, (st) => st.phase === 'fight')
    expect(buy(s, { kind: 'buyItem', item: 'fireball' })).toEqual([]) // alive mid-fight
    run(s, 1)
  })
})
