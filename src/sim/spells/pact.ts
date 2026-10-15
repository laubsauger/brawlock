/**
 * Pact (spells.md §8.4). Buff for 5 s x dm: the caster's NEXT spell whose damage, damage_min or
 * damage_max attribute is non-zero gets those x1.5 for that cast; then Pact is consumed and the
 * caster is slowed by 66 for 6 s x own debuff factor. Spells without damage (Teleport, Swap,
 * Shield, Grip, ...) do not consume it.
 */
import { ticks } from '../config'
import { type ModifierBehavior, addModifier, removeModifier } from '../modifiers'
import { buffDuration, debuffFactor } from '../stats'
import { attr } from './data'
import type { SpellBehavior } from './types'
import { castAttr } from './util'

export const MOD_PACT = 'pact'
export const MOD_PACT_SLOW = 'pactSlow'

export const pactSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    addModifier(state, caster, MOD_PACT, ticks(buffDuration(state, caster, caster.owner, attr(def, 'duration', level))), caster.owner, {
      mult: attr(def, 'damage_multiplier', level),
      slow: attr(def, 'speed_reduction', level),
      slowTime: attr(def, 'slow_duration', level),
    })
  },
}

export const pactModifier: ModifierBehavior = {
  temporary: true,
  onSpellCast(state, pawn, mod, ctx) {
    let changed = false
    for (const name of ['damage', 'damage_min', 'damage_max']) {
      const v = castAttr(ctx, name)
      if (v !== 0) {
        ctx.overrides[name] = v * mod.data.mult
        changed = true
      }
    }
    if (!changed) return
    removeModifier(state, pawn, mod)
    addModifier(state, pawn, MOD_PACT_SLOW, ticks(mod.data.slowTime * debuffFactor(pawn)), pawn.owner, { speed: -mod.data.slow })
  },
}

export const pactSlowModifier: ModifierBehavior = { temporary: true }
