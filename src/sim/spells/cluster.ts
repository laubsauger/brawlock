/**
 * Cluster (spells.md §8.12): four SimpleProjectiles at theta -0.18, -0.06, +0.06, +0.18 rad,
 * speed 844, r22, lifetime 672 / 844 x rm, knockback factor 0.65. Not FireballProjectiles, so
 * Lightning does not detonate them. Each bolt is independent (up to 4 x damage on one target).
 */
import { spawnProjectile } from '../projectiles'
import { attr } from './data'
import type { SpellBehavior } from './types'
import { aim, castAttr, rotate } from './util'

export const clusterSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    const a = aim(ctx)
    const speed = attr(def, 'speed', level)
    const inner = attr(def, 'spread_inner', level)
    const outer = attr(def, 'spread_outer', level)
    const damage = castAttr(ctx, 'damage')
    for (const angle of [-outer, -inner, inner, outer]) {
      const [dx, dy] = rotate(a.dx, a.dy, angle)
      spawnProjectile(state, caster.owner, 'cluster', caster.x, caster.y, dx * speed, dy * speed, attr(def, 'radius', level), {
        lifetime: attr(def, 'range', level) / speed,
        data: { damage, kb: attr(def, 'knockback_factor', level) },
      })
    }
  },
}
