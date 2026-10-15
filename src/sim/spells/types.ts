/**
 * Spell behavior hooks. A spell = data (spells/data.ts) + a behavior module registered in
 * spells/index.ts. Projectiles reference their behavior by `ProjectileState.kind ?? spell`.
 */
import type { ColliderProfile, CollisionHit } from '../collision'
import type { PawnState, ProjectileState, SimState, SlotIndex } from '../types'
import type { SpellDef } from './data'

export interface CastContext {
  state: SimState
  caster: PawnState
  def: SpellDef
  slot: SlotIndex
  level: number
  /** target point (ignored by no-target spells) */
  x: number
  y: number
  /** per-cast attribute overrides (Pact writes damage / damage_min / damage_max x 1.5) */
  overrides: Record<string, number>
}

export interface SpellBehavior {
  /** Runs when the cast point ends (or on the order for IMMEDIATE spells). */
  onCast(ctx: CastContext): void
}

export interface ProjectileBehavior {
  /** collision component; a function for per-instance profiles; null = no CC (Meteor, orbs) */
  collider: ColliderProfile | null | ((p: ProjectileState) => ColliderProfile | null)
  /**
   * pre-tick: steering, acceleration, timers. `dt` = DT x the projectile's time scale
   * (Warpzone); real-time (GAME task) timers should count ticks instead.
   */
  onTick?(state: SimState, proj: ProjectileState, dt: number): void
  /** this projectile was notified of a collision (spells.md §3.2) */
  onCollide?(state: SimState, proj: ProjectileState, hit: CollisionHit): void
  /** destroyed for any reason except a round reset; `expired` = its lifetime ran out */
  onDestroy?(state: SimState, proj: ProjectileState, expired: boolean): void
  /** a Shield reflected it (Twin mirrors its arc, Boomerang returns) */
  onReflect?(state: SimState, proj: ProjectileState, nx: number, ny: number): void
  /** damage destroys a projectile unless this is true (Snowball) */
  ignoresDamage?: boolean
  /** not a `Projectile` instance (WarpZoneActor): Gravity, Magnetize, Redirector skip it */
  notProjectile?: boolean
  /** excluded from Gravity pulls (Meteor, Gravity, Link) */
  noGravity?: boolean
  /** excluded from Magnetize / Redirector (Meteor) */
  noSteer?: boolean
}
