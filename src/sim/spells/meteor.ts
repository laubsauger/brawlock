/**
 * Meteor (spells.md §8.17). Target = cursor clamped to 1000 (no range mastery). A collisionless
 * meteor appears at target - 400 dir, z 700, hovers 0.55 s (z = 700 + 50 sin(pi / 0.55 t)),
 * then dives straight at the target in 0.60 s and explodes there: AoE radius 225..304, damage
 * linear 40 (edge) .. damage_max (centre), knockback 0.66, enemies only. Timers are real time
 * (GAME tasks). Immune to everything: no CC, ignored by Gravity, Magnetize, Redirector, Warpzone.
 */
import { damageArea } from '../combat'
import { ticks } from '../config'
import { PI, sin } from '../math'
import { killProjectile, spawnProjectile } from '../projectiles'
import { TICK_HZ } from '../types'
import { attr } from './data'
import type { ProjectileBehavior, SpellBehavior } from './types'
import { aim, castAttr, clampTarget } from './util'

const GAME_Z = 120

export const meteorSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    const a = aim(ctx)
    const t = clampTarget(ctx, attr(def, 'range', level))
    const back = attr(def, 'spawn_back', level)
    spawnProjectile(state, caster.owner, 'meteor', t.x - a.dx * back, t.y - a.dy * back, 0, 0, 0, {
      level,
      lifetime: null,
      data: {
        tx: t.x,
        ty: t.y,
        z: attr(def, 'spawn_z', level),
        z0: attr(def, 'spawn_z', level),
        hoverTicks: ticks(attr(def, 'hover_time', level)),
        fallTicks: ticks(attr(def, 'fall_time', level)),
        fallTime: attr(def, 'fall_time', level),
        hoverTime: attr(def, 'hover_time', level),
        elapsed: 0,
        falling: 0,
        vz: 0,
        damageMin: castAttr(ctx, 'damage_min'),
        damageMax: castAttr(ctx, 'damage_max'),
        radius: attr(def, 'radius', level),
        kb: attr(def, 'knockback_factor', level),
      },
    })
  },
}

export const meteorProjectile: ProjectileBehavior = {
  collider: null,
  noGravity: true,
  noSteer: true,
  onTick(state, p) {
    const d = p.data
    d.elapsed += 1 // real time
    if (!d.falling) {
      d.z = d.z0 + 50 * sin((PI / d.hoverTime) * (d.elapsed / TICK_HZ))
      if (d.elapsed >= d.hoverTicks) {
        d.falling = 1
        d.elapsed = 0
        p.vx = (d.tx - p.x) / d.fallTime
        p.vy = (d.ty - p.y) / d.fallTime
        d.vz = (GAME_Z - d.z) / d.fallTime
      }
      return
    }
    d.z += d.vz / TICK_HZ
    if (d.elapsed >= d.fallTicks) {
      p.vx = 0
      p.vy = 0
      d.z = GAME_Z
      state.events.push({ type: 'explosion', x: d.tx, y: d.ty, radius: d.radius, spell: 'meteor', level: p.level })
      damageArea(state, p.owner, d.tx, d.ty, d.radius, { amountMin: d.damageMin, amountMax: d.damageMax, knockbackFactor: d.kb, cause: 'meteor' })
      killProjectile(state, p)
    }
  },
}
