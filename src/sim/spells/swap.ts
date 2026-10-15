/**
 * Swap (spells.md §8.11). IMMEDIATE fast bolt (1983 u/s, r40), lifetime
 * min(dist / 1983, 0.4706 x rm) with range mastery applied once (no_range_mastery).
 * Collides with ALLY/ENEMY PLAYER and, only if combat was on at cast time, ENEMY OBSTACLE; never
 * with projectiles. Equal initiative: a shielded body refuses it, so shielded warlocks cannot
 * be swapped. On hit: caster and target exchange positions (velocities kept), caster Stop().
 * If nothing was swapped when it ends, the caster blinks to where it stopped.
 */
import { SWAP_CC, SWAP_CC_COMBAT } from '../collision'
import { destroyProjectile } from '../combat'
import { isCombat } from '../mode'
import { stopPawn } from '../orders'
import { ownerPawn, spawnProjectile } from '../projectiles'
import { rangeFactor } from '../stats'
import { attr } from './data'
import type { ProjectileBehavior, SpellBehavior } from './types'
import { aim } from './util'

export const swapSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    const a = aim(ctx)
    const speed = attr(def, 'speed', level)
    const maxTime = attr(def, 'max_time', level) * rangeFactor(state, caster.owner)
    const lifetime = Math.min(a.dist / speed, maxTime)
    spawnProjectile(state, caster.owner, 'swap', caster.x, caster.y, a.dx * speed, a.dy * speed, attr(def, 'radius', level), {
      level,
      lifetime: lifetime > 0 ? lifetime : 1e-9,
      rangeMastery: false,
      data: { combat: isCombat(state) ? 1 : 0 },
    })
  },
}

export const swapProjectile: ProjectileBehavior = {
  collider: (p) => (p.data.combat ? SWAP_CC_COMBAT : SWAP_CC),
  onCollide(state, p, hit) {
    const caster = ownerPawn(state, p)
    const o = hit.other
    if (caster && caster.alive && (o.kind === 'pawn' || o.kind === 'obstacle')) {
      const other = o.kind === 'pawn' ? o.pawn : o.obstacle
      const fromX = caster.x
      const fromY = caster.y
      caster.x = other.x
      caster.y = other.y
      other.x = fromX
      other.y = fromY
      stopPawn(state, caster)
      p.data.swapped = 1
      state.events.push({ type: 'swap', spell: 'swap', pawn: caster.id, other: hit.otherId, fromX, fromY, toX: caster.x, toY: caster.y })
    }
    destroyProjectile(state, p, hit.otherId, hit.x, hit.y)
  },
  onDestroy(state, p) {
    if (p.data.swapped) return
    const caster = ownerPawn(state, p)
    if (!caster || !caster.alive) return
    const fromX = caster.x
    const fromY = caster.y
    caster.x = p.x
    caster.y = p.y
    stopPawn(state, caster)
    state.events.push({ type: 'swap', spell: 'swap', pawn: caster.id, other: null, fromX, fromY, toX: caster.x, toY: caster.y })
  },
}
