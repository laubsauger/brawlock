import { describe, expect, it } from 'vitest'
import { SPELLS as SIM_SPELLS } from '../../sim'
import { ITEMS, MASTERY_ALL_COST, MASTERY_COST, MASTERY_MAX_LEVEL, SPELL_MAX_LEVEL, SPELLS } from '../data/catalog'
import { canPurchase, itemOffer, masteryAllOffer, masteryOffer, spellOffer } from './shopOffers'

const spell = (id: string) => SPELLS.find((s) => s.id === id)!
const item = (id: string) => ITEMS.find((s) => s.id === id)!

describe('spell offers', () => {
  const teleport = spell('teleport')

  it('sells an owned, affordable spell as its next upgrade (the level 2 bug)', () => {
    // an owned spell must stay purchasable; ownership is styling, not a lock
    const o = spellOffer(teleport, { id: 'teleport', level: 1 }, 18, true)
    expect(o.owned).toBe(true)
    expect(canPurchase(o)).toBe(true)
    expect(o.price).toBe(SIM_SPELLS.teleport.upgradeCosts[0])
  })

  it('prices every upgrade from the sim table, level by level', () => {
    for (let level = 1; level < SPELL_MAX_LEVEL; level++) {
      const o = spellOffer(teleport, { id: 'teleport', level }, 999, true)
      expect(o.price).toBe(SIM_SPELLS.teleport.upgradeCosts[level - 1])
      expect(canPurchase(o)).toBe(true)
    }
  })

  it('charges the buy price, not an upgrade price, for an unowned spell', () => {
    const o = spellOffer(teleport, { id: null, level: 0 }, 30, true)
    expect(o.price).toBe(SIM_SPELLS.teleport.cost)
    expect(canPurchase(o)).toBe(true)
  })

  it('keeps an owned spell owned but unbuyable when gold is short', () => {
    const o = spellOffer(teleport, { id: 'teleport', level: 2 }, 3, true)
    expect(o).toMatchObject({ state: 'poor', owned: true })
    expect(canPurchase(o)).toBe(false)
  })

  it('shows Max and no price at the top level', () => {
    const o = spellOffer(teleport, { id: 'teleport', level: SPELL_MAX_LEVEL }, 999, true)
    expect(o).toMatchObject({ state: 'max', price: null, tag: 'Max', owned: true })
  })

  it('locks the other spells of a taken column and marks unimplemented ones as soon', () => {
    const thrust = spell('thrust')
    expect(spellOffer(thrust, { id: 'teleport', level: 1 }, 999, true).state).toBe(thrust.implemented ? 'locked' : 'soon')
    const unimplemented = SPELLS.find((s) => !s.implemented)
    if (unimplemented) expect(spellOffer(unimplemented, { id: null, level: 0 }, 999, true)).toMatchObject({ state: 'soon', tag: 'Soon' })
  })

  it('never sells while the shop is closed', () => {
    expect(canPurchase(spellOffer(teleport, { id: 'teleport', level: 1 }, 999, false))).toBe(false)
  })
})

describe('item offers', () => {
  it('upgrades the starting Fireball and Scourge from level 1', () => {
    for (const id of ['fireball', 'scourge']) {
      const o = itemOffer(item(id), 1, item(id).cost, true, 4)
      expect(canPurchase(o)).toBe(true)
      expect(o.price).toBe(item(id).cost)
    }
  })

  it('stops at max level (Scourge 3, Fireball 7)', () => {
    expect(itemOffer(item('scourge'), 3, 999, true, 4)).toMatchObject({ state: 'max', price: null })
    expect(itemOffer(item('fireball'), item('fireball').maxLevel, 999, true, 4)).toMatchObject({ state: 'max', price: null })
  })

  it('needs a free slot only for a new item, not for an upgrade', () => {
    expect(itemOffer(item('fireball'), 1, 999, true, 0).state).toBe('ok')
  })
})

describe('mastery offers', () => {
  it('sells levels until max, and the bundle until any mastery is maxed', () => {
    expect(masteryOffer(0, MASTERY_COST, true).state).toBe('ok')
    expect(masteryOffer(MASTERY_MAX_LEVEL, 999, true).state).toBe('max')
    expect(masteryAllOffer([1, 2, 3], MASTERY_ALL_COST, true).state).toBe('ok')
    expect(masteryAllOffer([MASTERY_MAX_LEVEL, 0, 0], 999, true).state).toBe('max')
  })
})
