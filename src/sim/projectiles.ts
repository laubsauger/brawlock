/**
 * Projectile base (spells.md §5): spawning with range-mastery lifetime, time scale, the
 * generic "damage whatever was hit" reaction of SimpleProjectile, reflection, ownership.
 *
 * ProjectileState.kind (absent = spell) and the data keys render can read:
 *   all            timeScale (Warpzone slow, absent = 1), noTimer, origOwner (pre-Shield owner)
 *   fireball       damage, kb, level
 *   cluster        damage, kb                       (4 small fireballs)
 *   boomerang      returning (0/1), damage
 *   homing         target (pawn entity id, -1 none), damage
 *   twin           sign (+1/-1), t (0..pi progress along the arc), damage
 *   swap           (none)                           (caster blinks / swaps on hit or expiry)
 *   drain          turned (0/1), damage
 *   drainHeal      amount                            (orb flying back to the caster)
 *   bouncer        damage, hits, prevHit (pawn entity id)
 *   recharge       damage, hitPawn (0/1)
 *   rechargeRefresh                                  (orb flying back to the caster)
 *   meteor         z (height), tx, ty (impact point), falling (0/1), radius (impact AoE)
 *   splitter       (main bolt) / splitterSpawner (waves) / splitterChild (damage)
 *   snowball       damage, damageMax                 (radius = ProjectileState.radius)
 *   gravity        (orb; pull radius 550 pawns / 600 projectiles, DPS radius 250)
 *   grip, magnetize  bounced (magnetize, 0/1)
 *   link           retracting (0/1)                  (render a beam from the owner's pawn)
 *   warpzone       scale (time scale applied), radius = ProjectileState.radius (static zone)
 */
import { TICK_HZ } from './types'
import type { PawnState, PlayerId, ProjectileState, SimState, SpellId } from './types'
import { type DamageInfo, damageObstacle, destroyProjectile, receiveDamage } from './combat'
import type { CollisionHit } from './collision'
import type { ProjectileBehavior } from './spells/types'
import { rangeFactor } from './stats'
import { pawnOf } from './teams'

export interface SpawnProjectileOptions {
  /** lifetime in seconds before range mastery; null = no timer (ends through its own logic) */
  lifetime: number | null
  /** default true: lifetime x owner's range mastery (Projectile:setLifetime) */
  rangeMastery?: boolean
  kind?: string
  /** level of the creating spell; child projectiles pass their parent's (visual scaling) */
  level?: number
  data?: Record<string, number>
}

export function spawnProjectile(
  state: SimState,
  owner: PlayerId,
  spell: SpellId,
  x: number,
  y: number,
  vx: number,
  vy: number,
  radius: number,
  opts: SpawnProjectileOptions,
): ProjectileState {
  const data: Record<string, number> = { ...(opts.data ?? {}) }
  let ticksLeft = 1
  if (opts.lifetime === null) data.noTimer = 1
  else {
    const rm = opts.rangeMastery === false ? 1 : rangeFactor(state, owner)
    ticksLeft = opts.lifetime * rm * TICK_HZ
  }
  const proj: ProjectileState = { id: state.nextEntityId++, owner, spell, x, y, vx, vy, radius, ticksLeft, data }
  if (opts.kind && opts.kind !== spell) proj.kind = opts.kind
  if (opts.level !== undefined) proj.level = opts.level
  state.projectiles.push(proj)
  state.events.push({ type: 'projectileSpawn', id: proj.id, spell })
  return proj
}

export function kindOf(p: ProjectileState): string {
  return p.kind ?? p.spell
}

export function timeScale(p: ProjectileState): number {
  const t = p.data.timeScale
  return t === undefined ? 1 : t
}

/**
 * This tick's share of a projectile step: timeScale, cut on its last tick to the lifetime left,
 * so a timed bolt flies exactly speed x lifetime at any tick rate. It used to fly whole ticks,
 * up to one too far (Swap ~933 flew 958 at 60 Hz, 991 at 30 Hz).
 */
export function stepScale(p: ProjectileState): number {
  const t = timeScale(p)
  return p.data.noTimer === 1 || p.ticksLeft >= t ? t : Math.max(0, p.ticksLeft)
}

export function isAlive(p: ProjectileState): boolean {
  return !p.data.dead && (p.data.noTimer === 1 || p.ticksLeft > 0)
}

/** Projectile:setLifetime(t): t x range mastery of the current owner (unless rm = false). */
export function setLifetime(state: SimState, p: ProjectileState, seconds: number, rm = true): void {
  if (seconds <= 0) {
    p.ticksLeft = 0
    return
  }
  delete p.data.noTimer
  p.ticksLeft = seconds * (rm ? rangeFactor(state, p.owner) : 1) * TICK_HZ
}

/** Remaining lifetime in seconds (null when it has no timer). */
export function lifetimeLeft(p: ProjectileState): number | null {
  return p.data.noTimer === 1 ? null : p.ticksLeft / TICK_HZ
}

/** The projectile's instigator pawn (current owner). */
export function ownerPawn(state: SimState, p: ProjectileState): PawnState | undefined {
  return pawnOf(state, p.owner)
}

/** Reflect the velocity about n if moving toward it (v.n > 0, n = from projectile to the other). */
export function reflectToward(p: { vx: number; vy: number }, nx: number, ny: number): boolean {
  const vn = p.vx * nx + p.vy * ny
  if (!(vn > 0)) return false
  p.vx -= 2 * vn * nx
  p.vy -= 2 * vn * ny
  return true
}

/** Reflect off an obstacle and emit a bounce event (Drain, Bouncer, Recharge, Gravity...). */
export function bounceOff(state: SimState, p: ProjectileState, hit: CollisionHit): void {
  if (reflectToward(p, hit.nx, hit.ny)) state.events.push({ type: 'projectileBounce', id: p.id, spell: p.spell, x: hit.x, y: hit.y })
}

/**
 * `other:receiveDamage(...)` on whatever a projectile touched: pawns take damage and knockback,
 * projectiles are destroyed (unless they ignore damage), obstacles lose HP.
 */
export function damageHitBody(state: SimState, proj: ProjectileState, hit: CollisionHit, info: Omit<DamageInfo, 'cause'>): void {
  const o = hit.other
  if (o.kind === 'pawn') receiveDamage(state, o.pawn, { ...info, cause: proj.spell })
  else if (o.kind === 'projectile') damageProjectile(state, o.proj, proj.id)
  else damageObstacle(state, o.obstacle, info.amount, proj.owner)
}

// Behavior registry lookup, installed by spells/index.ts (avoids an import cycle).
let lookup: (kind: string) => ProjectileBehavior | undefined = () => undefined
export function setProjectileBehaviorLookup(fn: (kind: string) => ProjectileBehavior | undefined): void {
  lookup = fn
}
export function behaviorOf(p: ProjectileState): ProjectileBehavior | undefined {
  return lookup(kindOf(p))
}

/** A `Projectile` instance (WarpZoneActor is not): Gravity, Magnetize, Redirector act on these. */
export function isProjectileInstance(p: ProjectileState): boolean {
  return !behaviorOf(p)?.notProjectile
}

/** Projectile:receiveDamage: any damage destroys it, except kinds that ignore damage. */
export function damageProjectile(state: SimState, target: ProjectileState, by: number | null): void {
  if (behaviorOf(target)?.ignoresDamage) return
  destroyProjectile(state, target, by)
}

/** Destroy without a hit target (setLifetime(0)). */
export function killProjectile(state: SimState, p: ProjectileState): void {
  destroyProjectile(state, p, null)
}
