/**
 * Shop (systems.md §2). Purchases fail silently (original: no reply) when gold, slot or level
 * limits forbid them. Gold lives in PlayerScore.gold.
 *
 * - buySpell(spell): column spell. Empty column -> buy at level 1 for `cost`.
 *   Same spell already in its column -> upgrade one level for upgradeCosts[level - 1]
 *   (the original addressed upgrades by column; sending buySpell again is our upgrade order).
 *   Column taken by another spell -> rejected (one spell per column, no selling).
 * - buyItem(item): owned item -> upgrade for `cost` per level, and the item's cooldown resets
 *   (the original swaps in a fresh item entity). New item -> first free item slot.
 * - buyMastery(kind): 5 gold per level (max 6); 'all' raises all three for 13, only while none
 *   is maxed.
 * Spells/items without a behavior module (not `implemented`) are rejected for now.
 */
import { ITEM_SLOT_START, MASTERY_ALL_COST, MASTERY_COST, MASTERY_MAX_LEVEL, SHOP_ANY_PHASE, SLOT_COUNT, SPELL_MAX_LEVEL } from './config'
import { SPELLS } from './spells/data'
import { pawnOf, scoreOf } from './teams'
import type { PlayerId, PlayerScore, SimState, SpellId } from './types'

/** Whether purchases are accepted right now. */
export function shopOpen(state: SimState): boolean {
  if (state.phase === 'gameOver') return false
  return SHOP_ANY_PHASE || state.phase === 'shop'
}

function pay(sc: PlayerScore, cost: number): boolean {
  if (sc.gold < cost) return false
  sc.gold -= cost
  return true
}

export function buySpell(state: SimState, player: PlayerId, spell: SpellId): boolean {
  if (!shopOpen(state)) return false
  const def = SPELLS[spell]
  const pawn = pawnOf(state, player)
  const sc = scoreOf(state, player)
  if (!def || def.kind !== 'spell' || !def.implemented || !pawn || !sc) return false
  const slot = def.column - 1
  const current = pawn.slots[slot]
  if (current === null) {
    if (!pay(sc, def.cost)) return false
    pawn.slots[slot] = spell
    pawn.levels[slot] = 1
    pawn.cooldowns[slot] = 0
    return true
  }
  if (current !== spell) return false
  const level = pawn.levels[slot]
  if (level >= Math.min(def.maxLevel, SPELL_MAX_LEVEL)) return false
  if (!pay(sc, def.upgradeCosts[level - 1])) return false
  pawn.levels[slot] = level + 1
  return true
}

export function buyItem(state: SimState, player: PlayerId, item: SpellId): boolean {
  if (!shopOpen(state)) return false
  const def = SPELLS[item]
  const pawn = pawnOf(state, player)
  const sc = scoreOf(state, player)
  // passive items (PASSIVE_ITEMS) and unimplemented actives are rejected in M0
  if (!def || def.kind !== 'item' || !def.implemented || !pawn || !sc) return false
  let free = -1
  for (let i = ITEM_SLOT_START; i < SLOT_COUNT; i++) {
    if (pawn.slots[i] === item) {
      if (pawn.levels[i] >= def.maxLevel) return false
      if (!pay(sc, def.cost)) return false
      pawn.levels[i] += 1
      pawn.cooldowns[i] = 0
      return true
    }
    if (free < 0 && pawn.slots[i] === null) free = i
  }
  if (free < 0) return false
  if (!pay(sc, def.cost)) return false
  pawn.slots[free] = item
  pawn.levels[free] = 1
  pawn.cooldowns[free] = 0
  return true
}

export function buyMastery(state: SimState, player: PlayerId, kind: 'duration' | 'range' | 'lifesteal' | 'all'): boolean {
  if (!shopOpen(state)) return false
  const sc = scoreOf(state, player)
  if (!sc || !pawnOf(state, player)) return false
  const m = sc.masteries
  if (kind === 'all') {
    if (m.duration >= MASTERY_MAX_LEVEL || m.range >= MASTERY_MAX_LEVEL || m.lifesteal >= MASTERY_MAX_LEVEL) return false
    if (!pay(sc, MASTERY_ALL_COST)) return false
    m.duration += 1
    m.range += 1
    m.lifesteal += 1
    return true
  }
  if (kind !== 'duration' && kind !== 'range' && kind !== 'lifesteal') return false
  if (m[kind] >= MASTERY_MAX_LEVEL) return false
  if (!pay(sc, MASTERY_COST)) return false
  m[kind] += 1
  return true
}
