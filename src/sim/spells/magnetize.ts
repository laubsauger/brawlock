/**
 * Magnetize (spells.md §8.26). Bolt 800 u/s, r36, lifetime 1.2 s x rm, init -1,
 * std + ALLY{PLAYER} + SELF{PLAYER}. Ignores its own caster until it bounced off a pillar.
 * Pawn hit: enemy -> attract (sign +1, debuff timing), ally / self -> repel (sign -1, buff
 * timing); duration 3.5..6.5 s. Pillar: reflect and arm the self-hit. Projectile: dies.
 * Effect (magnetized pawn pre-tick, per ORIGINAL 0.035 s tick, converted): every Projectile that
 * is ENEMY to the magnetized pawn (not Meteor) within 300:
 *   f = 0.2 (1 - d^2/300^2);  v = (1 - f) v + f |v| sign unit(pawn - proj)
 * So magnetizing an enemy bends YOUR projectiles into them; magnetizing yourself / an ally bends
 * enemy projectiles away.
 */
import { MAGNETIZE_CC } from '../collision'
import { destroyProjectile } from '../combat'
import { ORIGINAL_TICK_SCALE, ticks } from '../config'
import { pow } from '../math'
import { type ModifierBehavior, addModifier } from '../modifiers'
import { behaviorOf, bounceOff, isAlive, isProjectileInstance, spawnProjectile } from '../projectiles'
import { buffDuration, debuffDuration } from '../stats'
import { isEnemy } from '../teams'
import { attr } from './data'
import type { ProjectileBehavior, SpellBehavior } from './types'
import { aim } from './util'

export const MOD_MAGNETIZE = 'magnetize'

export const magnetizeSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    const a = aim(ctx)
    const speed = attr(def, 'speed', level)
    spawnProjectile(state, caster.owner, 'magnetize', caster.x, caster.y, a.dx * speed, a.dy * speed, attr(def, 'radius', level), {
      level,
      lifetime: attr(def, 'lifetime', level),
      data: {
        duration: attr(def, 'duration', level),
        fieldRadius: attr(def, 'field_radius', level),
        fieldStrength: attr(def, 'field_strength', level),
        bounced: 0,
      },
    })
  },
}

export const magnetizeProjectile: ProjectileBehavior = {
  collider: MAGNETIZE_CC,
  onCollide(state, p, hit) {
    const o = hit.other
    if (o.kind === 'obstacle') {
      bounceOff(state, p, hit)
      p.data.bounced = 1
      return
    }
    if (o.kind === 'pawn') {
      const t = o.pawn
      if (t.owner === p.owner && !p.data.bounced) return
      const d = p.data
      const enemy = isEnemy(state, p.owner, t.owner)
      const seconds = enemy ? debuffDuration(state, t, p.owner, d.duration) : buffDuration(state, t, p.owner, d.duration)
      addModifier(state, t, MOD_MAGNETIZE, ticks(seconds), p.owner, { sign: enemy ? 1 : -1, radius: d.fieldRadius, strength: d.fieldStrength })
    }
    destroyProjectile(state, p, hit.otherId, hit.x, hit.y)
  },
}

export const magnetizeModifier: ModifierBehavior = {
  temporary: true,
  onPreTick(state, pawn, mod) {
    const r = mod.data.radius
    const r2 = r * r
    for (const q of state.projectiles) {
      if (!isAlive(q) || !isProjectileInstance(q) || behaviorOf(q)?.noSteer) continue
      if (!isEnemy(state, q.owner, pawn.owner)) continue
      const dx = pawn.x - q.x
      const dy = pawn.y - q.y
      const d2 = dx * dx + dy * dy
      if (d2 > r2 || d2 === 0) continue
      const f0 = mod.data.strength * (1 - d2 / r2)
      const f = 1 - pow(1 - f0, ORIGINAL_TICK_SCALE)
      const dist = Math.sqrt(d2)
      const speed = Math.sqrt(q.vx * q.vx + q.vy * q.vy)
      q.vx = (1 - f) * q.vx + f * speed * mod.data.sign * (dx / dist)
      q.vy = (1 - f) * q.vy + f * speed * mod.data.sign * (dy / dist)
    }
  },
}
