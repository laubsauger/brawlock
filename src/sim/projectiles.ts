/**
 * Projectile base (spells.md §5): spawning with range-mastery lifetime and the generic
 * "damage whatever was hit" reaction of SimpleProjectile.
 */
import { TICK_HZ } from './types'
import type { PlayerId, ProjectileState, SimState, SpellId } from './types'
import { type DamageInfo, damageObstacle, destroyProjectile, receiveDamage } from './combat'
import type { CollisionHit } from './collision'
import { rangeFactor } from './stats'

export interface SpawnProjectileOptions {
  /** lifetime in seconds before range mastery */
  lifetime: number
  /** default true: lifetime x owner's range mastery (Projectile:setLifetime) */
  rangeMastery?: boolean
  /** spell payload; `noDamage: 1` = ignores incoming damage (Snowball) */
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
  const rm = opts.rangeMastery === false ? 1 : rangeFactor(state, owner)
  const proj: ProjectileState = {
    id: state.nextEntityId++,
    owner,
    spell,
    x,
    y,
    vx,
    vy,
    radius,
    ticksLeft: opts.lifetime * rm * TICK_HZ,
    data: { ...(opts.data ?? {}) },
  }
  state.projectiles.push(proj)
  state.events.push({ type: 'projectileSpawn', id: proj.id, spell })
  return proj
}

/**
 * `other:receiveDamage(...)` on whatever a projectile touched: pawns take damage and knockback,
 * projectiles are destroyed (unless they ignore damage), obstacles lose HP.
 */
export function damageHitBody(state: SimState, proj: ProjectileState, hit: CollisionHit, info: DamageInfo): void {
  const o = hit.other
  if (o.kind === 'pawn') receiveDamage(state, o.pawn, info)
  else if (o.kind === 'projectile') {
    if (!o.proj.data.noDamage) destroyProjectile(state, o.proj, proj.id)
  } else damageObstacle(state, o.obstacle, info.amount)
}
