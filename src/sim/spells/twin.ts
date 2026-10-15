/**
 * Twin (spells.md §8.8). Two bolts (r35) on mirrored half-ellipses from the caster to the target
 * point at a constant path speed of 1000. Area a x b = 450^2 / pi: short casts bulge wide,
 * long casts are flat. dist clamped to [max(10, 2A / (pi R)), R], R = 800 x rm.
 * Each pre-tick: dt_e = dt 1000 / |E'(t)| (>= 0.001), t = min(pi, t + dt_e); the velocity delta
 * (newE - oldE) / dt is applied ADDITIVELY, so outside pushes (Gravity, Redirector) persist as
 * drift. Destroyed when t reaches pi. Std collision: damages whatever it touches, kb 1.0.
 * A Shield reflection mirrors the arc direction.
 */
import { STD_PROJECTILE } from '../collision'
import { destroyProjectile } from '../combat'
import { PI, cos, sin } from '../math'
import { damageHitBody, spawnProjectile } from '../projectiles'
import { rangeFactor } from '../stats'
import { attr } from './data'
import type { ProjectileBehavior, SpellBehavior } from './types'
import { aim, castAttr } from './util'

export const twinSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    const a = aim(ctx)
    const area = attr(def, 'ellipse_area', level)
    const R = attr(def, 'range', level) * rangeFactor(state, caster.owner)
    const minD = Math.max(10, (2 * area) / (PI * R))
    const dist = Math.min(Math.max(a.dist, minD), R)
    const ea = dist / 2
    const eb = area / (PI * ea)
    for (const sign of [1, -1]) {
      spawnProjectile(state, caster.owner, 'twin', caster.x, caster.y, 0, 0, attr(def, 'radius', level), {
        lifetime: null,
        data: {
          damage: castAttr(ctx, 'damage'),
          kb: attr(def, 'knockback_factor', level),
          sign,
          t: 0,
          ea,
          eb,
          // ellipse_dir = unit(start - target)
          edx: -a.dx,
          edy: -a.dy,
          ax: 0,
          ay: 0,
          speed: attr(def, 'path_speed', level),
        },
      })
    }
  },
}

export const twinProjectile: ProjectileBehavior = {
  collider: STD_PROJECTILE,
  onTick(state, p, dt) {
    const d = p.data
    if (d.t >= PI) {
      destroyProjectile(state, p, null)
      return
    }
    const st = sin(d.t)
    const ct = cos(d.t)
    const deriv = Math.sqrt(d.ea * d.ea * st * st + d.eb * d.eb * ct * ct)
    let dtE = deriv > 0 ? (dt * d.speed) / deriv : 0.001
    if (dtE < 0.001) dtE = 0.001
    const nt = Math.min(PI, d.t + dtE)
    const ex = (d.ea * cos(nt) - d.ea * ct) / dt
    const ey = (d.sign * d.eb * sin(nt) - d.sign * d.eb * st) / dt
    // rotate ellipse coordinates (along ellipse_dir, along its left normal) into the world
    const wx = ex * d.edx - ey * d.edy
    const wy = ex * d.edy + ey * d.edx
    p.vx += wx - d.ax
    p.vy += wy - d.ay
    d.ax = wx
    d.ay = wy
    d.t = nt
  },
  onCollide(state, p, hit) {
    damageHitBody(state, p, hit, { amount: p.data.damage, source: p.owner, normal: { x: hit.nx, y: hit.ny }, knockbackFactor: p.data.kb })
    destroyProjectile(state, p, hit.otherId, hit.x, hit.y)
  },
  onReflect(_s, p, nx, ny) {
    const d = p.data
    const e = d.edx * nx + d.edy * ny
    d.edx -= 2 * e * nx
    d.edy -= 2 * e * ny
    const v = d.ax * nx + d.ay * ny
    d.ax -= 2 * v * nx
    d.ay -= 2 * v * ny
  },
}
