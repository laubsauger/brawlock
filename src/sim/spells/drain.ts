/**
 * Drain (spells.md §8.13). Flies at 700 toward the cursor; at change_time = min(dist, 850 x rm)
 * / 700 (actor timer) it re-aims ONCE at the closest pawn that is not the caster (allies count)
 * at 600. Lifetime change_time + 1.2 x rm (range mastery applied once). Collision radius: the
 * defined 24.5 (the original read a missing key and was a point, §12.3).
 * Collides std + ALLY{PLAYER}:
 * - ally: heal = damage (their DP -0.5 x heal), +50 move speed for buff_duration (buff timing)
 * - enemy: damage (kb 0.2), -50 move speed (debuff timing), and a DrainHeal orb flies back to
 *   the caster at 650 u/s (no collision) and heals them by damage within 64 u
 * - obstacle: reflect;  enemy projectile: nothing happens to the Drain
 */
import { DRAIN_CC } from '../collision'
import { destroyProjectile, heal, receiveDamage } from '../combat'
import { ticks } from '../config'
import { type ModifierBehavior, addModifier } from '../modifiers'
import { bounceOff, killProjectile, ownerPawn, spawnProjectile } from '../projectiles'
import { buffDuration, debuffDuration, rangeFactor } from '../stats'
import { isEnemy } from '../teams'
import type { PawnState } from '../types'
import { attr } from './data'
import type { ProjectileBehavior, SpellBehavior } from './types'
import { aim, castAttr } from './util'

export const MOD_DRAIN_SLOW = 'drainSlow'
export const MOD_DRAIN_HASTE = 'drainHaste'

export const drainSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    const a = aim(ctx)
    const rm = rangeFactor(state, caster.owner)
    const speed = attr(def, 'projectile_speed', level)
    const turnDist = Math.min(a.dist, attr(def, 'range', level) * rm)
    const changeTime = turnDist / speed
    const lifetime = changeTime + attr(def, 'extra_time', level) * rm
    spawnProjectile(state, caster.owner, 'drain', caster.x, caster.y, a.dx * speed, a.dy * speed, attr(def, 'radius', level), {
      level,
      lifetime,
      rangeMastery: false,
      data: {
        damage: castAttr(ctx, 'damage'),
        kb: attr(def, 'knockback_factor', level),
        buff: attr(def, 'buff_duration', level),
        speedChange: attr(def, 'speed_change', level),
        changed: attr(def, 'changed_speed', level),
        healSpeed: attr(def, 'heal_speed', level),
        healDist: attr(def, 'heal_dist', level),
        turnAt: changeTime,
        t: 0,
        turned: 0,
      },
    })
  },
}

export const drainProjectile: ProjectileBehavior = {
  collider: DRAIN_CC,
  onTick(state, p, dt) {
    const d = p.data
    if (d.turned) return
    d.t += dt
    if (d.t < d.turnAt) return
    d.turned = 1
    let best: PawnState | null = null
    let bd = Infinity
    for (const q of state.pawns) {
      if (!q.alive || q.owner === p.owner) continue
      const dd = (q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y)
      if (dd < bd) {
        bd = dd
        best = q
      }
    }
    let dx = p.vx
    let dy = p.vy
    if (best) {
      dx = best.x - p.x
      dy = best.y - p.y
    }
    const l = Math.sqrt(dx * dx + dy * dy)
    if (l > 0) {
      p.vx = (dx / l) * d.changed
      p.vy = (dy / l) * d.changed
    }
  },
  onCollide(state, p, hit) {
    const o = hit.other
    if (o.kind === 'obstacle') {
      bounceOff(state, p, hit)
      return
    }
    if (o.kind !== 'pawn') return // enemy projectiles: nothing happens to Drain
    const target = o.pawn
    const d = p.data
    if (isEnemy(state, p.owner, target.owner)) {
      receiveDamage(state, target, { amount: d.damage, source: p.owner, normal: { x: hit.nx, y: hit.ny }, knockbackFactor: d.kb, cause: 'drain' })
      addModifier(state, target, MOD_DRAIN_SLOW, ticks(debuffDuration(state, target, p.owner, d.buff)), p.owner, { speed: -d.speedChange })
      spawnProjectile(state, p.owner, 'drain', hit.x, hit.y, 0, 0, 0, {
        lifetime: null,
        kind: 'drainHeal',
        level: p.level,
        data: { amount: d.damage, speed: d.healSpeed, dist: d.healDist },
      })
    } else {
      heal(state, target, d.damage)
      addModifier(state, target, MOD_DRAIN_HASTE, ticks(buffDuration(state, target, p.owner, d.buff)), p.owner, { speed: d.speedChange })
    }
    destroyProjectile(state, p, hit.otherId, hit.x, hit.y)
  },
}

/** DrainHealProjectile: no CC, no lifetime, homes to the caster at 650 and heals within 64. */
export const drainHealProjectile: ProjectileBehavior = {
  collider: null,
  onTick(state, p) {
    const caster = ownerPawn(state, p)
    if (!caster) {
      killProjectile(state, p)
      return
    }
    const dx = caster.x - p.x
    const dy = caster.y - p.y
    const d2 = dx * dx + dy * dy
    if (d2 < p.data.dist * p.data.dist) {
      heal(state, caster, p.data.amount)
      killProjectile(state, p)
      return
    }
    const l = Math.sqrt(d2)
    p.vx = (dx / l) * p.data.speed
    p.vy = (dy / l) * p.data.speed
  },
}

export const drainSlowModifier: ModifierBehavior = { temporary: true }
export const drainHasteModifier: ModifierBehavior = { temporary: true }
