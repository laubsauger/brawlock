/**
 * Alteration (spells.md §8.22). IMMEDIATE, 2 s x dm. Temporary CC r120 (PLAYER, init -3,
 * ENEMY{PROJECTILE}, notifies only itself, blocks Lightning); the body still accepts projectiles.
 * The first enemy projectile (not Gravity / Warpzone) that enters the bubble while moving toward
 * the caster swaps places with the caster; velocities are kept, so it flies on from where the
 * caster stood. One-shot.
 */
import { ALTERATION_CC } from '../collision'
import { ticks } from '../config'
import { type ModifierBehavior, addModifier, removeModifier, removeModifiers } from '../modifiers'
import { kindOf } from '../projectiles'
import { buffDuration } from '../stats'
import { attr } from './data'
import type { SpellBehavior } from './types'

export const MOD_ALTERATION = 'alteration'

export const alterationSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    removeModifiers(state, caster, MOD_ALTERATION)
    addModifier(state, caster, MOD_ALTERATION, ticks(buffDuration(state, caster, caster.owner, attr(def, 'duration', level))), caster.owner, {
      radius: attr(def, 'radius', level),
    })
  },
}

export const alterationModifier: ModifierBehavior = {
  temporary: true,
  collider(_s, _p, mod) {
    return { radius: mod.data.radius, profile: ALTERATION_CC }
  },
  onColliderHit(state, pawn, mod, hit) {
    const o = hit.other
    if (o.kind !== 'projectile') return
    const p = o.proj
    const kind = kindOf(p)
    if (kind === 'gravity' || kind === 'warpzone') return
    // moving toward the caster: v . (caster - projectile) > 0, and n points caster -> projectile
    if (!(p.vx * -hit.nx + p.vy * -hit.ny > 0)) return
    const fromX = pawn.x
    const fromY = pawn.y
    pawn.x = p.x
    pawn.y = p.y
    p.x = fromX
    p.y = fromY
    state.events.push({ type: 'swap', spell: 'alteration', pawn: pawn.id, other: p.id, fromX, fromY, toX: pawn.x, toY: pawn.y })
    removeModifier(state, pawn, mod)
  },
}
