/**
 * What the shop offers for each entry, as plain data: can it be bought right
 * now, at what price, and is it already owned. Purchasability (`state`) and
 * ownership (`owned`) are separate on purpose: an owned spell is still for
 * sale as an upgrade, so styling must never decide whether a click buys.
 */
import { MASTERY_ALL_COST, MASTERY_COST, MASTERY_MAX_LEVEL, SPELL_MAX_LEVEL, type ShopItem, type ShopSpell } from '../data/catalog'

export type OfferState = 'ok' | 'poor' | 'max' | 'soon' | 'locked' | 'full' | 'closed'

export interface Offer {
  state: OfferState
  /** already bought (any level > 0) */
  owned: boolean
  level: number
  /** buy or next-upgrade price; null when nothing is for sale (max level, soon, taken column) */
  price: number | null
  tag?: 'Soon' | 'Max' | 'Owned'
}

export function canPurchase(o: Offer): boolean {
  return o.state === 'ok'
}

/** The spell column: one spell per column, upgrades by buying the owned spell again. */
export function spellOffer(def: ShopSpell, column: { id: string | null; level: number }, gold: number, open: boolean): Offer {
  const mine = column.id === def.id
  const level = mine ? column.level : 0
  if (!def.implemented) return { state: 'soon', owned: false, level: 0, price: null, tag: 'Soon' }
  if (column.id && !mine) return { state: 'locked', owned: false, level: 0, price: null }
  if (mine && level >= SPELL_MAX_LEVEL) return { state: 'max', owned: true, level, price: null, tag: 'Max' }
  const price = mine ? def.upgrades[level - 1] : def.buy
  const state: OfferState = !open ? 'closed' : gold >= price ? 'ok' : 'poor'
  return { state, owned: mine, level, price }
}

/** Items: buying an owned item upgrades it; a new item needs a free slot. */
export function itemOffer(def: ShopItem, level: number, gold: number, open: boolean, freeSlots: number): Offer {
  if (!def.implemented) return { state: 'soon', owned: level > 0, level, price: null, tag: 'Soon' }
  if (level >= def.maxLevel) return { state: 'max', owned: true, level, price: null, tag: def.maxLevel === 1 ? 'Owned' : 'Max' }
  if (level === 0 && freeSlots === 0) return { state: 'full', owned: false, level, price: def.cost }
  const state: OfferState = !open ? 'closed' : gold >= def.cost ? 'ok' : 'poor'
  return { state, owned: level > 0, level, price: def.cost }
}

export function masteryOffer(level: number, gold: number, open: boolean): Offer {
  if (level >= MASTERY_MAX_LEVEL) return { state: 'max', owned: true, level, price: null, tag: 'Max' }
  const state: OfferState = !open ? 'closed' : gold >= MASTERY_COST ? 'ok' : 'poor'
  return { state, owned: level > 0, level, price: MASTERY_COST }
}

/** "All three" raises every mastery by one; unavailable once any one is maxed. */
export function masteryAllOffer(levels: number[], gold: number, open: boolean): Offer {
  if (levels.some((l) => l >= MASTERY_MAX_LEVEL)) return { state: 'max', owned: false, level: 0, price: null, tag: 'Max' }
  const state: OfferState = !open ? 'closed' : gold >= MASTERY_ALL_COST ? 'ok' : 'poor'
  return { state, owned: false, level: 0, price: MASTERY_ALL_COST }
}
