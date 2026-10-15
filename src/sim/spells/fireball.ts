/**
 * Fireball (spells.md §8.1): straight SimpleProjectile from the caster's centre, speed 1000,
 * radius 25, lifetime range/speed x range mastery, damage 70 + 7/level, knockback factor 1.
 * Damages whatever it touches (enemy pawns, enemy projectiles, obstacles) and dies.
 */
import { STD_PROJECTILE } from '../collision'
import { destroyProjectile } from '../combat'
import { cos, sin } from '../math'
import { damageHitBody, spawnProjectile } from '../projectiles'
import { attr } from './data'
import type { ProjectileBehavior, SpellBehavior } from './types'

export const fireballSpell: SpellBehavior = {
  onCast({ state, caster, def, level, x, y }) {
    const speed = attr(def, 'speed', level)
    const range = attr(def, 'range', level)
    let dx = x - caster.x
    let dy = y - caster.y
    const d = Math.sqrt(dx * dx + dy * dy)
    if (d > 0) {
      dx /= d
      dy /= d
    } else {
      dx = cos(caster.facing)
      dy = sin(caster.facing)
    }
    // knockback_factor: KV lookup returns 0, replaced by 1 (spells.md §5.3)
    const kb = attr(def, 'knockback_factor', level) || 1
    spawnProjectile(state, caster.owner, 'fireball', caster.x, caster.y, dx * speed, dy * speed, attr(def, 'radius', level), {
      lifetime: range / speed,
      data: { damage: attr(def, 'damage', level), kb, level },
    })
  },
}

export const fireballProjectile: ProjectileBehavior = {
  collider: STD_PROJECTILE,
  onCollide(state, proj, hit) {
    damageHitBody(state, proj, hit, {
      amount: proj.data.damage,
      source: proj.owner,
      normal: { x: hit.nx, y: hit.ny },
      knockbackFactor: proj.data.kb,
    })
    destroyProjectile(state, proj, hit.otherId, hit.x, hit.y)
  },
}
