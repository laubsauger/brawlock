/**
 * Snowball (spells.md §8.19). 400 u/s, r 75..87, lifetime 575 / 400 x rm, std collision,
 * IGNORES ALL DAMAGE (projectiles cannot destroy it).
 * Touching an enemy (re-triggers every tick while overlapping): drag along the roll direction so
 * the warlock moves at >= 425 u/s with it; if not already chilled, a 0.5 s modifier (-100 move
 * speed, not debuff-scaled) that deals damage x 0.5 without knockback when it expires.
 * Pillar: destroyed, deals damage_max to it. Enemy projectile: nothing happens to the Snowball.
 * Destroyed for any reason (expiry included): explosion r200, 0 .. damage_max, knockback 0.8.
 */
import { STD_PROJECTILE } from '../collision'
import { damageArea, damageObstacle, destroyProjectile, receiveDamage } from '../combat'
import { ticks } from '../config'
import { type ModifierBehavior, addModifier, hasModifier } from '../modifiers'
import { spawnProjectile } from '../projectiles'
import { isEnemy } from '../teams'
import { attr } from './data'
import type { ProjectileBehavior, SpellBehavior } from './types'
import { aim, castAttr } from './util'

export const MOD_SNOWBALL = 'snowball'

export const snowballSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    const a = aim(ctx)
    const speed = attr(def, 'speed', level)
    spawnProjectile(state, caster.owner, 'snowball', caster.x, caster.y, a.dx * speed, a.dy * speed, attr(def, 'coll_radius', level), {
      level,
      lifetime: attr(def, 'range', level) / speed,
      data: {
        damage: castAttr(ctx, 'damage'),
        damageMin: castAttr(ctx, 'damage_min'),
        damageMax: castAttr(ctx, 'damage_max'),
        explosion: attr(def, 'radius', level),
        kb: attr(def, 'knockback_factor', level),
        drag: attr(def, 'drag_speed', level),
        slow: attr(def, 'slow', level),
        dotPeriod: attr(def, 'dot_period', level),
      },
    })
  },
}

export const snowballProjectile: ProjectileBehavior = {
  collider: STD_PROJECTILE,
  ignoresDamage: true,
  onCollide(state, p, hit) {
    const o = hit.other
    const d = p.data
    if (o.kind === 'obstacle') {
      damageObstacle(state, o.obstacle, d.damageMax, p.owner)
      destroyProjectile(state, p, hit.otherId, hit.x, hit.y)
      return
    }
    if (o.kind !== 'pawn' || !isEnemy(state, p.owner, o.pawn.owner)) return
    const pawn = o.pawn
    const v = Math.sqrt(p.vx * p.vx + p.vy * p.vy)
    if (v > 0) {
      const dx = p.vx / v
      const dy = p.vy / v
      const c = d.drag - (dx * pawn.vx + dy * pawn.vy)
      if (c > 0) {
        pawn.vx += c * dx
        pawn.vy += c * dy
      }
    }
    if (!hasModifier(pawn, MOD_SNOWBALL)) {
      addModifier(state, pawn, MOD_SNOWBALL, ticks(d.dotPeriod), p.owner, { speed: -d.slow, damage: d.damage * d.dotPeriod })
    }
  },
  onDestroy(state, p) {
    const d = p.data
    state.events.push({ type: 'explosion', x: p.x, y: p.y, radius: d.explosion, spell: 'snowball', level: p.level })
    damageArea(state, p.owner, p.x, p.y, d.explosion, { amountMin: d.damageMin, amountMax: d.damageMax, knockbackFactor: d.kb, cause: 'snowball' })
  },
}

/** Chill: on expiry deals damage x 0.5 (no knockback, but DP). Removed without effect on death. */
export const snowballModifier: ModifierBehavior = {
  temporary: true,
  onRemove(state, pawn, mod, expired) {
    if (expired && pawn.alive) receiveDamage(state, pawn, { amount: mod.data.damage, source: mod.source, cause: 'snowball' })
  },
}
