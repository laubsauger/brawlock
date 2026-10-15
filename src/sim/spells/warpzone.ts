/**
 * Warpzone (spells.md §8.25). A static zone at the cursor clamped to 700 (no range mastery),
 * radius 200..260, lasting 4.5 s x caster dm (removed at round start). CC: PROJECTILE, init -5,
 * ENEMY{PROJECTILE}, notifies only itself. Every tick an ENEMY projectile overlaps it and is not
 * yet slowed by this zone, its time scale is multiplied by 0.40..0.16 (movement, steering and
 * actor timers all slow down; range is preserved). Every 0.1 s (real time) projectiles that left
 * the radius are restored; all are restored when the zone ends. Lightning, Shield, Alteration,
 * Gravity and Magnetize ignore the zone itself; Meteor and other zones are never slowed.
 * Stored as a ProjectileState of spell 'warpzone' (data.static = 1) for plain-data state.
 */
import { WARPZONE_CC } from '../collision'
import { ticks } from '../config'
import { kindOf, spawnProjectile, timeScale } from '../projectiles'
import { durationFactor } from '../stats'
import type { ProjectileState, SimState } from '../types'
import { attr } from './data'
import type { ProjectileBehavior, SpellBehavior } from './types'
import { clampTarget } from './util'

const CHECK_PERIOD = 0.1

export const warpzoneSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    const t = clampTarget(ctx, attr(def, 'range', level))
    spawnProjectile(state, caster.owner, 'warpzone', t.x, t.y, 0, 0, attr(def, 'radius', level), {
      level,
      lifetime: attr(def, 'duration', level) * durationFactor(state, caster.owner),
      rangeMastery: false,
      data: { static: 1, scale: attr(def, 'time_scale', level), check: ticks(CHECK_PERIOD) },
    })
  },
}

function key(zone: ProjectileState): string {
  return `wz${zone.id}`
}

function unscale(q: ProjectileState, zone: ProjectileState): void {
  delete q.data[key(zone)]
  const ts = timeScale(q) / zone.data.scale
  if (Math.abs(ts - 1) < 1e-12) delete q.data.timeScale
  else q.data.timeScale = ts
}

function release(state: SimState, zone: ProjectileState, all: boolean): void {
  const k = key(zone)
  const r2 = zone.radius * zone.radius
  for (const q of state.projectiles) {
    if (!q.data[k]) continue
    const d2 = (q.x - zone.x) * (q.x - zone.x) + (q.y - zone.y) * (q.y - zone.y)
    if (all || d2 > r2) unscale(q, zone)
  }
}

export const warpzoneProjectile: ProjectileBehavior = {
  collider: WARPZONE_CC,
  notProjectile: true,
  noGravity: true,
  noSteer: true,
  onCollide(_s, zone, hit) {
    if (hit.other.kind !== 'projectile') return
    const q = hit.other.proj
    const kind = kindOf(q)
    if (kind === 'warpzone' || kind === 'meteor') return
    const k = key(zone)
    if (q.data[k]) return
    q.data[k] = 1
    q.data.timeScale = timeScale(q) * zone.data.scale
  },
  onTick(state, zone) {
    zone.data.check -= 1 // GAME task: real time
    if (zone.data.check <= 0) {
      zone.data.check += ticks(CHECK_PERIOD)
      release(state, zone, false)
    }
  },
  onDestroy(state, zone) {
    release(state, zone, true)
  },
}
