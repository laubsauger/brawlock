/**
 * Damage, knockback points (DP), knockback, heal, lifesteal, death (spells.md §4, systems.md §5.2).
 */
import {
  KB_DMG_TO_VELOCITY,
  OBSTACLE_EXPLODE_DMG_GAIN,
  OBSTACLE_EXPLODE_DMG_MIN,
  OBSTACLE_EXPLODE_RADIUS,
} from './config'
import { isCombat, onKill } from './mode'
import { removeTemporaryModifiers } from './modifiers'
import { lifestealFactor } from './stats'
import { isEnemy, pawnOf, scoreOf } from './teams'
import type { ObstacleState, PawnState, PlayerId, ProjectileState, SimState, Vec2 } from './types'

export interface DamageInfo {
  amount: number
  /** player credited for the hit (lifesteal, damage stat, last hitter). null = lava etc. */
  source: PlayerId | null
  /** unit hit normal (pointing away from the hitter). Absent = no knockback, DP still gained. */
  normal?: Vec2 | null
  /** spell knockback factor (`knockback_factor`), default 1 */
  knockbackFactor?: number
  /** DP gain factor (`knockback_vulnerability_factor`), default 1, lava 0.5 */
  kbVulnerability?: number
}

/** g(d) = d up to 100, sqrt(100 d) above: the softer slope for big hits. */
export function knockbackDamageScale(amount: number): number {
  return amount <= 100 ? amount : Math.sqrt(100 * amount)
}

/**
 * Knockback speed (u/s) for a hit:
 *   max(0, kbFactor) * g(amount) * 10 * (1 + kbPoints / 1000) * spellKb * kbMultiplier
 * `kbPoints` already includes this hit's DP gain.
 */
export function knockbackSpeed(
  amount: number,
  kbPoints: number,
  kbFactor: number,
  spellKb: number,
  kbMultiplier: number,
): number {
  const kf = kbFactor > 0 ? kbFactor : 0
  return kf * knockbackDamageScale(amount) * KB_DMG_TO_VELOCITY * (1 + kbPoints / 1000) * spellKb * kbMultiplier
}

/** Pawn:receiveDamage. Returns the damage dealt (0 when ignored). */
export function receiveDamage(state: SimState, pawn: PawnState, info: DamageInfo): number {
  if (!isCombat(state) || !pawn.alive || pawn.invulnerable) return 0
  // dmg_factor (1) and dmg_reduction (0) have no M0 modifier; hook point for future ones
  const amount = info.amount * state.settings.dmgMultiplier
  if (!(amount > 0)) return 0
  const dp = pawn.kbPoints + amount * (info.kbVulnerability ?? 1)
  pawn.kbPoints = dp > 0 ? dp : 0
  let kb = 0
  const n = info.normal
  if (n) {
    kb = knockbackSpeed(amount, pawn.kbPoints, pawn.kbFactor, info.knockbackFactor ?? 1, state.settings.kbMultiplier)
    pawn.vx += kb * n.x
    pawn.vy += kb * n.y
  }
  // modifyDamagePostKB (Rush) would adjust `amount` here
  if (info.source !== null) {
    const sc = scoreOf(state, info.source)
    if (sc) sc.damageThisRound += amount
    const ls = lifestealFactor(state, info.source)
    if (ls > 0) {
      const src = pawnOf(state, info.source)
      if (src) heal(state, src, amount * ls)
    }
    pawn.lastHitter = info.source
  }
  state.events.push({ type: 'damage', target: pawn.id, amount, source: info.source, x: pawn.x, y: pawn.y, kb })
  const life = pawn.hp - amount
  if (life > 1) pawn.hp = life
  else killPawn(state, pawn, info.source ?? pawn.lastHitter)
  return amount
}

/** Pawn:heal. Lowers DP by dpFactor * amount. Ignored while dead. */
export function heal(state: SimState, pawn: PawnState, amount: number, dpFactor = 0.5): void {
  if (!pawn.alive || !(amount > 0)) return
  pawn.hp = Math.min(pawn.maxHp, pawn.hp + amount)
  const dp = pawn.kbPoints - dpFactor * amount
  pawn.kbPoints = dp > 0 ? dp : 0
  state.events.push({ type: 'heal', target: pawn.id, amount, x: pawn.x, y: pawn.y })
}

/**
 * Pawn:die. `killer` = lethal source, else last hitter (lava kills credit whoever hit last).
 * Self kills and sourceless deaths get no credit.
 */
export function killPawn(state: SimState, pawn: PawnState, killer: PlayerId | null): void {
  if (!pawn.alive) return
  pawn.hp = 0
  pawn.alive = false
  pawn.vx = 0
  pawn.vy = 0
  pawn.walkVx = 0
  pawn.walkVy = 0
  pawn.moveTarget = null
  pawn.cast = null
  pawn.lavaTicks = 0
  removeTemporaryModifiers(state, pawn)
  const credit = killer !== null && killer !== pawn.owner ? killer : null
  const victim = scoreOf(state, pawn.owner)
  if (victim) victim.deaths += 1
  if (credit !== null) {
    const k = scoreOf(state, credit)
    if (k) {
      k.kills += 1
      // original pays 1 s after the kill; paid at once here (default killGold is 0)
      k.gold += state.settings.killGold
    }
  }
  state.events.push({ type: 'death', pawn: pawn.id, owner: pawn.owner, killer: credit })
  onKill(state, pawn, credit)
}

export interface AreaDamage {
  /** flat amount, or linear from amountMin at the edge to amountMax at the centre */
  amount?: number
  amountMin?: number
  amountMax?: number
  knockbackFactor?: number
  /** linear knockback factor, kbFactorMin at the edge to kbFactorMax at the centre (Scourge) */
  kbFactorMin?: number
  kbFactorMax?: number
}

/**
 * Pawn:damageArea: every living ENEMY pawn of `owner` with distance d < radius (strict),
 * pushed along normalize(pawn - centre). Returns the number of pawns in range.
 */
export function damageArea(
  state: SimState,
  owner: PlayerId,
  cx: number,
  cy: number,
  radius: number,
  dmg: AreaDamage,
): number {
  let hits = 0
  for (const pawn of state.pawns) {
    if (!pawn.alive || !isEnemy(state, owner, pawn.owner)) continue
    const dx = pawn.x - cx
    const dy = pawn.y - cy
    const d = Math.sqrt(dx * dx + dy * dy)
    if (!(d < radius)) continue
    const normal = d > 0 ? { x: dx / d, y: dy / d } : { x: 1, y: 0 }
    const amount =
      dmg.amountMin !== undefined && dmg.amountMax !== undefined
        ? dmg.amountMin + ((dmg.amountMax - dmg.amountMin) / radius) * (radius - d)
        : (dmg.amount ?? 0)
    let kf = dmg.knockbackFactor ?? 1
    if (dmg.kbFactorMin !== undefined && dmg.kbFactorMax !== undefined) {
      const t = 1 - d / radius
      kf = (1 - t) * dmg.kbFactorMin + t * dmg.kbFactorMax
    }
    receiveDamage(state, pawn, { amount, source: owner, normal, knockbackFactor: kf })
    hits++
  }
  return hits
}

/**
 * Destroy a projectile now (setLifetime(0)): it stops colliding this tick and is removed in the
 * projectile post-tick without a 'projectileExpire'. `target` = entity it hit, if any.
 */
export function destroyProjectile(
  state: SimState,
  proj: ProjectileState,
  target: number | null,
  x = proj.x,
  y = proj.y,
): void {
  if (proj.data.dead) return
  proj.data.dead = 1
  proj.ticksLeft = 0
  state.events.push({ type: 'projectileHit', id: proj.id, spell: proj.spell, x, y, target })
}

/** Obstacle:receiveDamage. At 0 HP it explodes for 5-10 damage to ALL pawns within 300. */
export function damageObstacle(state: SimState, ob: ObstacleState, amount: number): void {
  if (!isCombat(state) || ob.hp <= 0 || !(amount > 0)) return
  ob.hp -= amount
  if (ob.hp > 0) return
  ob.hp = 0
  state.events.push({ type: 'obstacleDestroyed', id: ob.id, x: ob.x, y: ob.y })
  state.events.push({ type: 'explosion', x: ob.x, y: ob.y, radius: OBSTACLE_EXPLODE_RADIUS, spell: 'obstacle' })
  for (const pawn of state.pawns) {
    if (!pawn.alive) continue
    const dx = pawn.x - ob.x
    const dy = pawn.y - ob.y
    const d = Math.sqrt(dx * dx + dy * dy)
    if (!(d < OBSTACLE_EXPLODE_RADIUS)) continue
    const normal = d > 0 ? { x: dx / d, y: dy / d } : { x: 1, y: 0 }
    const amount = OBSTACLE_EXPLODE_DMG_MIN + OBSTACLE_EXPLODE_DMG_GAIN * (1 - d / OBSTACLE_EXPLODE_RADIUS)
    receiveDamage(state, pawn, { amount, source: null, normal })
  }
}
