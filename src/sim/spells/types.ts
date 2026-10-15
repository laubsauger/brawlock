/**
 * Spell behavior hooks. A spell = data (spells/data.ts) + a behavior module registered in
 * spells/index.ts. Projectiles reference their behavior by `ProjectileState.spell`.
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
}

export interface SpellBehavior {
  /** Runs when the cast point ends (or on the order for IMMEDIATE spells). */
  onCast(ctx: CastContext): void
}

export interface ProjectileBehavior {
  collider: ColliderProfile
  /** pre-tick: steering, acceleration */
  onTick?(state: SimState, proj: ProjectileState): void
  /** this projectile was notified of a collision (spells.md §3.2) */
  onCollide?(state: SimState, proj: ProjectileState, hit: CollisionHit): void
  /** lifetime ran out (not called when destroyed by a hit) */
  onExpire?(state: SimState, proj: ProjectileState): void
}
