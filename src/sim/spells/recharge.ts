/**
 * Recharge (spells.md §8.15). Bolt (900 u/s, r35, 1 s x rm), damage = damage + 10 x streak,
 * streak read at cast. Enemy pawn hit: damage (kb 1.0) and a RechargeRefresh orb (no CC, no
 * lifetime) homes to the instigator at 400 u/s and fully resets their Recharge cooldown within
 * 64 u. Obstacle: reflect. Projectile: destroyed without damaging it.
 * When the bolt is destroyed: if it hit a pawn and was not stolen by a Shield, the caster's
 * streak +1; otherwise (miss, expiry, projectile, stolen) the streak resets to 0. Respawn resets.
 */
import { STD_PROJECTILE } from '../collision'
import { destroyProjectile, receiveDamage } from '../combat'
import { type ModifierBehavior, addModifier, getModifier } from '../modifiers'
import { bounceOff, killProjectile, ownerPawn, spawnProjectile } from '../projectiles'
import { pawnOf } from '../teams'
import type { PawnState, SimState } from '../types'
import { attr } from './data'
import type { ProjectileBehavior, SpellBehavior } from './types'
import { aim, castAttr } from './util'

export const MOD_RECHARGE_STREAK = 'rechargeStreak'

function streakOf(pawn: PawnState): number {
  return getModifier(pawn, MOD_RECHARGE_STREAK)?.data.streak ?? 0
}

function setStreak(state: SimState, pawn: PawnState, value: number): void {
  let m = getModifier(pawn, MOD_RECHARGE_STREAK)
  if (!m) m = addModifier(state, pawn, MOD_RECHARGE_STREAK, -1, pawn.owner, { streak: 0 })
  if (m.data.streak === value) return
  m.data.streak = value
  state.events.push({ type: 'streak', pawn: pawn.id, spell: 'recharge', value })
}

export const rechargeSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    const a = aim(ctx)
    const speed = attr(def, 'speed', level)
    const damage = castAttr(ctx, 'damage') + attr(def, 'damage_per_consecutive', level) * streakOf(caster)
    spawnProjectile(state, caster.owner, 'recharge', caster.x, caster.y, a.dx * speed, a.dy * speed, attr(def, 'radius', level), {
      lifetime: attr(def, 'lifetime', level),
      data: {
        damage,
        kb: attr(def, 'knockback_factor', level),
        origOwner: caster.owner,
        hitPawn: 0,
        refreshSpeed: attr(def, 'refresh_speed', level),
        refreshDist: attr(def, 'refresh_dist', level),
      },
    })
  },
}

export const rechargeProjectile: ProjectileBehavior = {
  collider: STD_PROJECTILE,
  onCollide(state, p, hit) {
    const o = hit.other
    if (o.kind === 'obstacle') {
      bounceOff(state, p, hit)
      return
    }
    if (o.kind === 'pawn') {
      receiveDamage(state, o.pawn, { amount: p.data.damage, source: p.owner, normal: { x: hit.nx, y: hit.ny }, knockbackFactor: p.data.kb, cause: 'recharge' })
      p.data.hitPawn = 1
      spawnProjectile(state, p.owner, 'recharge', hit.x, hit.y, 0, 0, 0, {
        lifetime: null,
        kind: 'rechargeRefresh',
        data: { speed: p.data.refreshSpeed, dist: p.data.refreshDist },
      })
    }
    destroyProjectile(state, p, hit.otherId, hit.x, hit.y)
  },
  onDestroy(state, p) {
    const caster = pawnOf(state, p.data.origOwner)
    if (!caster) return
    const kept = p.owner === p.data.origOwner
    setStreak(state, caster, p.data.hitPawn && kept ? streakOf(caster) + 1 : 0)
  },
}

/** RechargeRefreshProjectile: homes to the instigator, resets their Recharge cooldown. */
export const rechargeRefreshProjectile: ProjectileBehavior = {
  collider: null,
  onTick(state, p) {
    const caster = ownerPawn(state, p)
    if (!caster) {
      killProjectile(state, p)
      return
    }
    const dx = caster.x - p.x
    const dy = caster.y - p.y
    const d = Math.sqrt(dx * dx + dy * dy)
    if (d < p.data.dist) {
      const slot = caster.slots.indexOf('recharge')
      if (slot >= 0 && caster.cooldowns[slot] > 0) {
        caster.cooldowns[slot] = 0
        state.events.push({ type: 'cooldownReset', pawn: caster.id, slot, spell: 'recharge' })
      }
      killProjectile(state, p)
      return
    }
    p.vx = (dx / d) * p.data.speed
    p.vy = (dy / d) * p.data.speed
  },
}

/** permanent until respawn (Pawn:respawn resets the combo counter) */
export const rechargeStreakModifier: ModifierBehavior = { temporary: false }
