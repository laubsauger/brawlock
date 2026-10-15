/**
 * Windwalk (spells.md §8.16). IMMEDIATE, 2.6 s x dm: invisible (render hides it from enemies),
 * +200 move speed, the body ignores ALL warlocks, and a temporary CC r60 (PLAYER, init 0,
 * ENEMY{PLAYER}) charges the first enemy it touches: damage with knockback 1.0, then Windwalk
 * ends. With a Thrust running: the Thrust hits too at factor 1 with knockback 0.84 (0.7 x 1.2) and
 * the charge uses 0.7 (the Thrust -> Windwalk double hit). Any spell cast ends Windwalk first.
 * Original quirk kept (§12.12): ending Windwalk re-enables enemy-body collision even mid-Thrust.
 */
import { BIT_PLAYER, WINDWALK_CC } from '../collision'
import { receiveDamage } from '../combat'
import { ticks } from '../config'
import { type ModifierBehavior, addModifier, getModifier, removeModifier, removeModifiers } from '../modifiers'
import { buffDuration } from '../stats'
import { attr } from './data'
import { MOD_THRUST, thrustHitPawn } from './thrust'
import type { SpellBehavior } from './types'
import { castAttr } from './util'

export const MOD_WINDWALK = 'windwalk'

export const windwalkSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    removeModifiers(state, caster, MOD_WINDWALK)
    addModifier(state, caster, MOD_WINDWALK, ticks(buffDuration(state, caster, caster.owner, attr(def, 'duration', level))), caster.owner, {
      speed: attr(def, 'move_bonus', level),
      damage: castAttr(ctx, 'damage'),
      kb: attr(def, 'knockback_factor', level),
      thrustKb: attr(def, 'thrust_knockback_factor', level),
      radius: attr(def, 'radius', level),
      level,
    })
  },
}

export const windwalkModifier: ModifierBehavior = {
  temporary: true,
  bodyMask(_m, ally, enemy) {
    return [ally & ~BIT_PLAYER, enemy & ~BIT_PLAYER]
  },
  collider(_s, _p, mod) {
    return { radius: mod.data.radius, profile: WINDWALK_CC }
  },
  onSpellCast(state, pawn, mod) {
    removeModifier(state, pawn, mod)
  },
  onColliderHit(state, pawn, mod, hit) {
    const o = hit.other
    if (o.kind !== 'pawn') return
    const enemy = o.pawn
    let kb = mod.data.kb
    const thrust = getModifier(pawn, MOD_THRUST)
    if (thrust) {
      kb = mod.data.thrustKb
      thrust.data.kb = thrust.data.kb * mod.data.thrustKb
      thrustHitPawn(state, pawn, thrust, enemy, hit.nx, hit.ny, 1)
    }
    state.events.push({ type: 'spellHit', spell: 'windwalk', pawn: pawn.id, target: enemy.id, x: hit.x, y: hit.y, level: mod.data.level })
    receiveDamage(state, enemy, { amount: mod.data.damage, source: pawn.owner, normal: { x: hit.nx, y: hit.ny }, knockbackFactor: kb, cause: 'windwalk' })
    removeModifier(state, pawn, mod)
  },
  onRemove(_s, pawn) {
    const thrust = getModifier(pawn, MOD_THRUST)
    if (thrust) thrust.data.bodyCollides = 1
  },
}
