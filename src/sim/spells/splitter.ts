/**
 * Splitter (spells.md §8.18). IGNORE_TURN, no cast point.
 * Stage 1 main bolt: 700 u/s, r50, std collision, no damage; lifetime min(1.0 x rm, dist / 700)
 * (range mastery applied once; the original applied it twice, §12.6). ANY collision destroys
 * it; off a pillar it first reverses and shifts the split point back out of the pillar.
 * Destroyed for any reason -> Stage 2 spawner at its position (+ offset): 250 u/s along the
 * main direction, empty collision matrix (only Shield / Alteration / Warpzone act on it), a wave
 * of 2 children every 0.12 s (actor timer) and gone after the 4th wave (8 children; the
 * original could lose the 4th wave to a timer race, §12.7).
 * Stage 3 children: wave k: a = 0.48 (1 - k/4); dir = (d + sign a perp) / (1 + a), NOT
 * normalised, speed 600 x |dir|; r21, kb 1.0, lifetime 1.2 x rm (once); SimpleProjectile.
 */
import { SPAWNER_CC, STD_PROJECTILE } from '../collision'
import { destroyProjectile } from '../combat'
import { killProjectile, spawnProjectile } from '../projectiles'
import { rangeFactor } from '../stats'
import type { ProjectileState, SimState } from '../types'
import { attr } from './data'
import type { ProjectileBehavior, SpellBehavior } from './types'
import { aim, castAttr } from './util'

export const splitterSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    const a = aim(ctx)
    const speed = attr(def, 'speed', level)
    const lifetime = Math.min(attr(def, 'max_time', level) * rangeFactor(state, caster.owner), a.dist / speed)
    spawnProjectile(state, caster.owner, 'splitter', caster.x, caster.y, a.dx * speed, a.dy * speed, attr(def, 'radius', level), {
      lifetime: lifetime > 0 ? lifetime : 1e-9,
      rangeMastery: false,
      data: {
        damage: castAttr(ctx, 'damage'),
        ox: 0,
        oy: 0,
        spawnerSpeed: attr(def, 'spawner_speed', level),
        spawnerTime: attr(def, 'spawner_time', level),
        waves: attr(def, 'waves', level),
        childSpeed: attr(def, 'child_speed', level),
        childRadius: attr(def, 'child_radius', level),
        childTime: attr(def, 'child_time', level),
        kb: attr(def, 'knockback_factor', level),
      },
    })
  },
}

export const splitterProjectile: ProjectileBehavior = {
  collider: STD_PROJECTILE,
  onCollide(state, p, hit) {
    if (hit.other.kind === 'obstacle') {
      p.vx = -p.vx
      p.vy = -p.vy
      const push = hit.otherRadius + hit.radius + 10 - hit.distance
      p.data.ox = -hit.nx * push
      p.data.oy = -hit.ny * push
    }
    destroyProjectile(state, p, hit.otherId, hit.x, hit.y)
  },
  onDestroy(state, p) {
    const d = p.data
    const v = Math.sqrt(p.vx * p.vx + p.vy * p.vy)
    const dx = v > 0 ? p.vx / v : 1
    const dy = v > 0 ? p.vy / v : 0
    spawnProjectile(state, p.owner, 'splitter', p.x + d.ox, p.y + d.oy, dx * d.spawnerSpeed, dy * d.spawnerSpeed, 1, {
      lifetime: d.spawnerTime,
      kind: 'splitterSpawner',
      data: { ...d, t: 0, wave: 0 },
    })
  },
}

function spawnWave(state: SimState, s: ProjectileState, k: number): void {
  const d = s.data
  const v = Math.sqrt(s.vx * s.vx + s.vy * s.vy)
  const dx = v > 0 ? s.vx / v : 1
  const dy = v > 0 ? s.vy / v : 0
  const alpha = 0.48 * (1 - k / d.waves)
  for (const sign of [1, -1]) {
    const cx = (dx + sign * alpha * -dy) / (1 + alpha)
    const cy = (dy + sign * alpha * dx) / (1 + alpha)
    spawnProjectile(state, s.owner, 'splitter', s.x, s.y, cx * d.childSpeed, cy * d.childSpeed, d.childRadius, {
      lifetime: d.childTime,
      kind: 'splitterChild',
      data: { damage: d.damage, kb: d.kb },
    })
  }
}

export const splitterSpawnerProjectile: ProjectileBehavior = {
  collider: SPAWNER_CC,
  onTick(state, p, dt) {
    const d = p.data
    d.t += dt
    const period = d.spawnerTime / d.waves
    while (d.wave < d.waves && d.t >= (d.wave + 1) * period - 1e-9) {
      spawnWave(state, p, d.wave)
      d.wave += 1
    }
    if (d.wave >= d.waves) killProjectile(state, p)
  },
}
