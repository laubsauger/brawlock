/**
 * Pawn stats and mastery factors (systems.md §3-§5, spells.md §6.1).
 *
 * Pawn stats = base + passive items + modifiers, additive (original applyStats). Item values
 * are absolute per level (an upgrade replaces the previous level's values). Modifiers carry their
 * stat deltas in ModifierState.data under these keys:
 *   speed (speed_bonus_abs), hp (hp_bonus), regen (hp_regen), kbReduction (kb_reduction),
 *   debuff (debuff_factor), dmgRel (dmg_reduction_rel), dmgAbs (dmg_reduction_abs), mass.
 * Stats are recomputed from scratch on every change, which is identical to the original
 * add-on-toggle / subtract-on-untoggle bookkeeping but cannot drift.
 */
import { ITEM_SLOT_START, MASTERY_GAIN, PAWN_HEALTH_REG, PAWN_MASS, PAWN_MAX_LIFE, PAWN_MOVE_SPEED, SLOT_COUNT } from './config'
import { PASSIVE_ITEMS } from './spells/data'
import { scoreOf } from './teams'
import type { PawnState, PlayerId, SimState } from './types'

export type MasteryKind = 'duration' | 'range' | 'lifesteal'

export function masteryFactor(kind: MasteryKind, level: number): number {
  let f = kind === 'lifesteal' ? 0 : 1
  const gains = MASTERY_GAIN[kind]
  for (let i = 0; i < level && i < gains.length; i++) f += gains[i]
  return f
}

export function playerMastery(state: SimState, player: PlayerId | null, kind: MasteryKind): number {
  if (player === null) return masteryFactor(kind, 0)
  const sc = scoreOf(state, player)
  return masteryFactor(kind, sc ? sc.masteries[kind] : 0)
}

/** "rm" in spells.md: projectile lifetime / explicit range multiplier. */
export function rangeFactor(state: SimState, player: PlayerId | null): number {
  return playerMastery(state, player, 'range')
}

/** "dm" in spells.md: buff/debuff duration multiplier. */
export function durationFactor(state: SimState, player: PlayerId | null): number {
  return playerMastery(state, player, 'duration')
}

export function lifestealFactor(state: SimState, player: PlayerId | null): number {
  return playerMastery(state, player, 'lifesteal')
}

type ItemStat = 'hp_bonus' | 'hp_regen' | 'kb_reduction' | 'speed_bonus_abs' | 'debuff_factor'
export interface PawnStatSource {
  readonly slots: Readonly<PawnState['slots']>
  readonly levels: Readonly<PawnState['levels']>
  readonly modifiers: Readonly<PawnState['modifiers']>
}

function itemSum(pawn: PawnStatSource, stat: ItemStat): number {
  let sum = 0
  for (let i = ITEM_SLOT_START; i < SLOT_COUNT; i++) {
    const id = pawn.slots[i]
    const def = id ? PASSIVE_ITEMS[id] : undefined
    if (!def) continue
    const lv = pawn.levels[i]
    if (lv > 0) sum += def.levels[stat][Math.min(lv, def.maxLevel) - 1]
  }
  return sum
}

function modSum(pawn: PawnStatSource, key: string): number {
  let sum = 0
  for (const m of pawn.modifiers) {
    const v = m.data[key]
    if (v !== undefined) sum += v
  }
  return sum
}

/** Re-derive maxHp, hpRegen, moveSpeed and kbFactor. HP is kept (clamped to the new max). */
export function recomputeStats(pawn: PawnState): void {
  pawn.maxHp = PAWN_MAX_LIFE + itemSum(pawn, 'hp_bonus') + modSum(pawn, 'hp')
  pawn.hpRegen = PAWN_HEALTH_REG + itemSum(pawn, 'hp_regen') + modSum(pawn, 'regen')
  pawn.moveSpeed = PAWN_MOVE_SPEED + itemSum(pawn, 'speed_bonus_abs') + modSum(pawn, 'speed')
  pawn.kbFactor = 1 - itemSum(pawn, 'kb_reduction') - modSum(pawn, 'kbReduction')
  if (pawn.hp > pawn.maxHp) pawn.hp = pawn.maxHp
}

/** Scales incoming debuff durations (Cursed Ring +, Pocket Watch -). Base 1. */
export function debuffFactor(pawn: PawnStatSource): number {
  return 1 + itemSum(pawn, 'debuff_factor') + modSum(pawn, 'debuff')
}

/** Damage taken multiplier (dmg_factor). Base 1. */
export function dmgFactor(pawn: PawnState): number {
  return 1 - modSum(pawn, 'dmgRel')
}

/** Flat damage reduction (dmg_reduction). Base 0. */
export function dmgReduction(pawn: PawnState): number {
  return modSum(pawn, 'dmgAbs')
}

export function pawnMass(pawn: PawnState): number {
  return PAWN_MASS + modSum(pawn, 'mass')
}

/** Pawn:getBuffDuration: dur x receiver dm x (giver dm if giver != receiver). Seconds. */
export function buffDuration(state: SimState, receiver: PawnState, giver: PlayerId | null, seconds: number): number {
  let d = seconds * durationFactor(state, receiver.owner)
  if (giver !== null && giver !== receiver.owner) d *= durationFactor(state, giver)
  return d
}

/** Pawn:getDebuffDuration: dur x receiver debuff_factor x (giver dm if giver != receiver). Seconds. */
export function debuffDuration(state: SimState, receiver: PawnState, giver: PlayerId | null, seconds: number): number {
  let d = seconds * debuffFactor(receiver)
  if (giver !== null && giver !== receiver.owner) d *= durationFactor(state, giver)
  return d
}
