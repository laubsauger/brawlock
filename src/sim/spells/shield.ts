/**
 * Shield (spells.md §8.20). IMMEDIATE, 1.2 s x dm. While active the body refuses ENEMY
 * PROJECTILE (std projectiles pass through it) and a temporary CC (radius 200..260, PLAYER,
 * init -3, ENEMY{PROJECTILE}, notifies only itself, blocks Lightning) touches enemy projectiles:
 * - reflect unless Swap / Gravity / Warpzone; steal ownership unless also Boomerang / Link
 * - a stolen projectile belongs to the shielder: it can hit its old caster, credits damage to the
 *   shielder, Homing retargets
 * - reflect only when moving toward the shielder: v -= 2 (v.n) n, n from shielder to projectile
 * - Boomerang is forced into return mode
 */
import { SHIELD_CC, BIT_PROJECTILE } from '../collision'
import { ticks } from '../config'
import { type ModifierBehavior, addModifier, removeModifiers } from '../modifiers'
import { behaviorOf, kindOf } from '../projectiles'
import { buffDuration } from '../stats'
import { attr } from './data'
import type { SpellBehavior } from './types'

export const MOD_SHIELD = 'shield'

export const shieldSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    removeModifiers(state, caster, MOD_SHIELD)
    addModifier(state, caster, MOD_SHIELD, ticks(buffDuration(state, caster, caster.owner, attr(def, 'duration', level))), caster.owner, {
      radius: attr(def, 'radius', level),
    })
  },
}

export const shieldModifier: ModifierBehavior = {
  temporary: true,
  bodyMask(_m, ally, enemy) {
    return [ally, enemy & ~BIT_PROJECTILE]
  },
  collider(_s, _p, mod) {
    return { radius: mod.data.radius, profile: SHIELD_CC }
  },
  onColliderHit(state, pawn, _mod, hit) {
    const o = hit.other
    if (o.kind !== 'projectile') return
    const p = o.proj
    const kind = kindOf(p)
    const reflect = kind !== 'swap' && kind !== 'gravity' && kind !== 'warpzone'
    const steal = reflect && kind !== 'boomerang' && kind !== 'link'
    if (kind === 'boomerang') p.data.returning = 1 // stopAcceleration(): return mode
    let stolen = false
    if (steal && p.owner !== pawn.owner) {
      if (p.data.origOwner === undefined) p.data.origOwner = p.owner
      p.owner = pawn.owner
      stolen = true
    }
    let reflected = false
    if (reflect) {
      // n points from the shielder to the projectile; moving toward the shielder = v.n < 0
      const nx = hit.nx
      const ny = hit.ny
      const vn = p.vx * nx + p.vy * ny
      if (vn < 0) {
        p.vx -= 2 * vn * nx
        p.vy -= 2 * vn * ny
        reflected = true
        behaviorOf(p)?.onReflect?.(state, p, nx, ny)
      }
    }
    if (reflected || stolen) state.events.push({ type: 'shieldReflect', pawn: pawn.id, projectile: p.id, x: hit.x, y: hit.y, reflected, stolen })
  },
}
