/**
 * Thrust (spells.md §8.10). IMMEDIATE dash: Stop(), face the target, velocity = 0.77 x 1300 x dir
 * (replaces knockback), modifier for 0.09 + min(dist, 900) / 1300 s (not duration-scaled).
 * While active: +1733.33 u/s^2 along dir, body ignores enemy warlocks, temporary CC r60
 * (PLAYER, init -4, ENEMY{PLAYER}) that reacts to ANY enemy PLAYER-channel CC (body, Windwalk,
 * Thrust, Alteration, Shield CCs; §7.3).
 * Contact: shielded target -> bounce off, no damage. Otherwise stop dead and hit for
 * damage x min(1, (|v|^2 / 1300^2) / 0.8), knockback factor 1.2. Two thrusters: each hits the
 * other at full factor. With Windwalk up the Windwalk handler performs the hit (combo).
 * Expiry without a hit: velocity x 0.2 (hard brake).
 */
import { BIT_PLAYER, THRUST_CC } from '../collision'
import { receiveDamage } from '../combat'
import { ticks } from '../config'
import { atan2 } from '../math'
import { type ModifierBehavior, addModifier, getModifier, hasModifier, removeModifier, removeModifiers } from '../modifiers'
import { stopPawn } from '../orders'
import { reflectToward } from '../projectiles'
import { DT } from '../types'
import type { ModifierState, PawnState, SimState } from '../types'
import { attr } from './data'
import type { SpellBehavior } from './types'
import { aim, castAttr } from './util'

export const MOD_THRUST = 'thrust'

export const thrustSpell: SpellBehavior = {
  onCast(ctx) {
    const { state, caster, def, level } = ctx
    const a = aim(ctx)
    stopPawn(state, caster)
    caster.facing = atan2(a.dy, a.dx)
    const speed = attr(def, 'velocity', level)
    const launch = attr(def, 'launch_factor', level) * speed
    caster.vx = a.dx * launch
    caster.vy = a.dy * launch
    caster.walkVx = 0
    caster.walkVy = 0
    const range = attr(def, 'range', level)
    const seconds = attr(def, 'extra_time', level) + (a.dist < range ? a.dist : range) / speed
    removeModifiers(state, caster, MOD_THRUST)
    addModifier(state, caster, MOD_THRUST, Math.max(1, ticks(seconds)), caster.owner, {
      dx: a.dx,
      dy: a.dy,
      accel: attr(def, 'acceleration', level),
      damage: castAttr(ctx, 'damage'),
      kb: attr(def, 'knockback_factor', level),
      fullSpeed: speed,
    })
  },
}

/** ThrustModifier:hitPawn: damage x factor with the thrust knockback, then the thrust ends. */
export function thrustHitPawn(state: SimState, pawn: PawnState, mod: ModifierState, target: PawnState, nx: number, ny: number, factor: number): void {
  state.events.push({ type: 'spellHit', spell: 'thrust', pawn: pawn.id, target: target.id, x: pawn.x, y: pawn.y })
  receiveDamage(state, target, { amount: mod.data.damage * factor, source: pawn.owner, normal: { x: nx, y: ny }, knockbackFactor: mod.data.kb })
  removeModifier(state, pawn, mod)
}

export const thrustModifier: ModifierBehavior = {
  temporary: true,
  bodyMask(mod, ally, enemy) {
    // original quirk (§12.12): Windwalk ending re-enables enemy-body collision mid-thrust
    return mod.data.bodyCollides ? [ally, enemy] : [ally, enemy & ~BIT_PLAYER]
  },
  collider(_s, _p, mod) {
    return { radius: mod.data.radius ?? 60, profile: THRUST_CC }
  },
  onPreTick(_s, pawn, mod) {
    pawn.vx += mod.data.dx * mod.data.accel * DT
    pawn.vy += mod.data.dy * mod.data.accel * DT
  },
  onColliderHit(state, pawn, mod, hit) {
    const o = hit.other
    if (o.kind !== 'pawn') return
    const target = o.pawn
    if (hasModifier(target, 'shield')) {
      // bounce off the bubble, no damage, the thrust continues
      reflectToward(pawn, hit.nx, hit.ny)
      return
    }
    const v2 = pawn.vx * pawn.vx + pawn.vy * pawn.vy
    pawn.vx = 0
    pawn.vy = 0
    pawn.walkVx = 0
    pawn.walkVy = 0
    const full = mod.data.fullSpeed
    let factor = Math.min(1, v2 / (full * full) / 0.8)
    const theirs = getModifier(target, MOD_THRUST)
    if (theirs) {
      thrustHitPawn(state, target, theirs, pawn, -hit.nx, -hit.ny, 1)
      factor = 1
    }
    if (hasModifier(pawn, 'windwalk')) return // the Windwalk charge performs the thrust hit
    thrustHitPawn(state, pawn, mod, target, hit.nx, hit.ny, factor)
  },
  onRemove(_s, pawn, _mod, expired) {
    if (expired) {
      pawn.vx *= 0.2
      pawn.vy *= 0.2
    }
  },
}
