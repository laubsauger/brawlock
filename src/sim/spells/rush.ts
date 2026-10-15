/**
 * Rush (spells.md §8.21). IMMEDIATE, duration x dm, +35 move speed at once. Absorbs 50% of
 * damage from other players (not lava, not your own) up to absorb_max, AFTER knockback was
 * computed on the full amount (modifyDamagePostKB); DP gain is not reduced. Every absorbed HP
 * adds 1.5 move speed until Rush ends.
 */
import { ticks } from '../config'
import { type ModifierBehavior, addModifier } from '../modifiers'
import { buffDuration, recomputeStats } from '../stats'
import { attr } from './data'
import type { SpellBehavior } from './types'

export const MOD_RUSH = 'rush'

export const rushSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    addModifier(state, caster, MOD_RUSH, ticks(buffDuration(state, caster, caster.owner, attr(def, 'duration', level))), caster.owner, {
      speed: attr(def, 'initial_speed_bonus', level),
      absorbLeft: attr(def, 'absorb_max', level),
      ratio: attr(def, 'absorb_ratio', level),
      perHp: attr(def, 'speed_per_absorbed', level),
    })
  },
}

export const rushModifier: ModifierBehavior = {
  temporary: true,
  modifyDamagePostKB(_s, pawn, mod, dmg) {
    if (dmg.source === null || dmg.source === pawn.owner) return 0
    const d = mod.data
    const absorbed = Math.min(d.absorbLeft, d.ratio * dmg.amount)
    if (!(absorbed > 0)) return 0
    d.absorbLeft -= absorbed
    d.speed += d.perHp * absorbed
    recomputeStats(pawn)
    return -absorbed
  },
}
