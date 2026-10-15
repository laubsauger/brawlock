/**
 * Gravity (spells.md §8.23). Orb 450 u/s, lifetime 2 s x rm, CC r25 that only meets pillars
 * (reflects off them). Each pre-tick (dt = the orb's time-scaled dt):
 * - ENEMY pawns within 550: v += strength (1 - d^2/550^2) unit(orb - pawn) dt
 * - EVERY Projectile of any owner (its caster's own included; not Meteor, Gravity, Link) within
 *   600: v += 1650 (1.5 - d^2/600^2) unit(orb - proj) dt / proj time scale
 * - every 0.2 s real time: damage x 0.2 to ENEMY pawns within 250 (no knockback, but DP)
 * Shield / Alteration / Lightning / projectiles ignore it; Warpzone slows it.
 */
import { GRAVITY_CC } from '../collision'
import { receiveDamage } from '../combat'
import { ticks } from '../config'
import { behaviorOf, bounceOff, isAlive, isProjectileInstance, spawnProjectile, timeScale } from '../projectiles'
import { isEnemy } from '../teams'
import { attr } from './data'
import type { ProjectileBehavior, SpellBehavior } from './types'
import { aim, castAttr } from './util'

export const gravitySpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    const a = aim(ctx)
    const speed = attr(def, 'speed', level)
    spawnProjectile(state, caster.owner, 'gravity', caster.x, caster.y, a.dx * speed, a.dy * speed, attr(def, 'radius', level), {
      lifetime: attr(def, 'range', level) / speed,
      data: {
        strength: attr(def, 'strength', level),
        dps: castAttr(ctx, 'damage'),
        pawnRadius: attr(def, 'pawn_pull_radius', level),
        projRadius: attr(def, 'projectile_pull_radius', level),
        projPull: attr(def, 'projectile_pull', level),
        dpsRadius: attr(def, 'dps_radius', level),
        dpsPeriod: ticks(attr(def, 'dps_period', level)),
        dpsTimer: ticks(attr(def, 'dps_period', level)),
      },
    })
  },
}

export const gravityProjectile: ProjectileBehavior = {
  collider: GRAVITY_CC,
  noGravity: true,
  onCollide(state, p, hit) {
    if (hit.other.kind === 'obstacle') bounceOff(state, p, hit)
  },
  onTick(state, p, dt) {
    const d = p.data
    const pr2 = d.pawnRadius * d.pawnRadius
    for (const pawn of state.pawns) {
      if (!pawn.alive || !isEnemy(state, p.owner, pawn.owner)) continue
      const dx = p.x - pawn.x
      const dy = p.y - pawn.y
      const d2 = dx * dx + dy * dy
      if (d2 > pr2 || d2 === 0) continue
      const dist = Math.sqrt(d2)
      const f = d.strength * (1 - d2 / pr2) * dt
      pawn.vx += (dx / dist) * f
      pawn.vy += (dy / dist) * f
    }
    const qr2 = d.projRadius * d.projRadius
    for (const q of state.projectiles) {
      if (q === p || !isAlive(q) || !isProjectileInstance(q) || behaviorOf(q)?.noGravity) continue
      const dx = p.x - q.x
      const dy = p.y - q.y
      const d2 = dx * dx + dy * dy
      if (d2 > qr2 || d2 === 0) continue
      const dist = Math.sqrt(d2)
      const f = (d.projPull * (1.5 - d2 / qr2) * dt) / timeScale(q)
      q.vx += (dx / dist) * f
      q.vy += (dy / dist) * f
    }
    // DPS: GAME task, real time
    d.dpsTimer -= 1
    if (d.dpsTimer <= 0) {
      d.dpsTimer += d.dpsPeriod
      const r2 = d.dpsRadius * d.dpsRadius
      for (const pawn of state.pawns) {
        if (!pawn.alive || !isEnemy(state, p.owner, pawn.owner)) continue
        const d2 = (pawn.x - p.x) * (pawn.x - p.x) + (pawn.y - p.y) * (pawn.y - p.y)
        if (d2 <= r2) receiveDamage(state, pawn, { amount: d.dps * (d.dpsPeriod / 60), source: p.owner, cause: 'gravity' })
      }
    }
  },
}
