/**
 * Boomerang (spells.md §8.5). Curved shuriken, r38, no lifetime, init -2,
 * ENEMY {PLAYER, OBSTACLE} only (never touches projectiles, ignored by Lightning).
 * D = min(max(dist, 300), 800 x rm); v0 = 1500 dir + 300 perp; par = -1500^2 / (2D),
 * perpAcc = 0.4 par. Phase A for T1 = 2D/1500: acc = par dir + perpAcc perp; phase B for
 * T1 - 0.15: acc = par dir - perpAcc perp; then return mode: steer at 1000 u/s^2 toward a
 * 1000 u/s homing velocity, destroyed within 75 of the caster.
 * Hits: enemy pawn takes damage (kb 0.95); off a pawn / pillar it reflects at 500 / 750 u/s,
 * is pushed out to r1 + r2 + 10 and enters return mode. No hit memory (can hit twice).
 */
import { BOOMERANG_CC } from '../collision'
import { receiveDamage } from '../combat'
import { killProjectile, ownerPawn, reflectToward, spawnProjectile } from '../projectiles'
import { rangeFactor } from '../stats'
import { attr } from './data'
import type { ProjectileBehavior, SpellBehavior } from './types'
import { aim, castAttr } from './util'

export const boomerangSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    const a = aim(ctx)
    const D = Math.min(Math.max(a.dist, attr(def, 'min_dist', level)), attr(def, 'range', level) * rangeFactor(state, caster.owner))
    const launch = attr(def, 'launch_speed', level)
    const lateral = attr(def, 'lateral_speed', level)
    const px = -a.dy
    const py = a.dx
    const par = -(launch * launch) / (2 * D)
    spawnProjectile(state, caster.owner, 'boomerang', caster.x, caster.y, a.dx * launch + px * lateral, a.dy * launch + py * lateral, attr(def, 'radius', level), {
      level,
      lifetime: null,
      data: {
        damage: castAttr(ctx, 'damage'),
        kb: attr(def, 'knockback_factor', level),
        dx: a.dx,
        dy: a.dy,
        par,
        perpAcc: ((2 * par * lateral) / launch),
        t: 0,
        t1: (2 * D) / launch,
        returning: 0,
      },
    })
  },
}

function startReturn(p: { data: Record<string, number> }): void {
  p.data.returning = 1
}

export const boomerangProjectile: ProjectileBehavior = {
  collider: BOOMERANG_CC,
  onTick(state, p, dt) {
    const d = p.data
    if (!d.returning) {
      d.t += dt
      const phaseB = d.t >= d.t1
      if (d.t >= d.t1 + (d.t1 - 0.15)) startReturn(p)
      else {
        const px = -d.dy
        const py = d.dx
        const sp = phaseB ? -d.perpAcc : d.perpAcc
        p.vx += (d.par * d.dx + sp * px) * dt
        p.vy += (d.par * d.dy + sp * py) * dt
      }
    }
    if (d.returning) {
      const caster = ownerPawn(state, p)
      if (!caster) return
      const tx = caster.x - p.x
      const ty = caster.y - p.y
      const dist = Math.sqrt(tx * tx + ty * ty)
      if (dist < 75) {
        killProjectile(state, p)
        return
      }
      const ddx = (1000 * tx) / dist - p.vx
      const ddy = (1000 * ty) / dist - p.vy
      const dl = Math.sqrt(ddx * ddx + ddy * ddy)
      if (dl > 0) {
        p.vx += ((1000 * dt) * ddx) / dl
        p.vy += ((1000 * dt) * ddy) / dl
      }
    }
  },
  onCollide(state, p, hit) {
    const o = hit.other
    if (o.kind === 'pawn') {
      receiveDamage(state, o.pawn, { amount: p.data.damage, source: p.owner, normal: { x: hit.nx, y: hit.ny }, knockbackFactor: p.data.kb, cause: 'boomerang' })
    }
    if (o.kind === 'pawn' || o.kind === 'obstacle') {
      const other = o.kind === 'pawn' ? o.pawn : o.obstacle
      if (reflectToward(p, hit.nx, hit.ny)) {
        const speed = o.kind === 'pawn' ? 500 : 750
        const v = Math.sqrt(p.vx * p.vx + p.vy * p.vy)
        if (v > 0) {
          p.vx = (p.vx / v) * speed
          p.vy = (p.vy / v) * speed
        }
      }
      const push = hit.radius + hit.otherRadius + 10
      p.x = other.x - hit.nx * push
      p.y = other.y - hit.ny * push
      startReturn(p)
      state.events.push({ type: 'projectileBounce', id: p.id, spell: p.spell, x: hit.x, y: hit.y })
    }
  },
  onReflect(_s, p) {
    startReturn(p) // Shield: stopAcceleration() forces return mode
  },
}
