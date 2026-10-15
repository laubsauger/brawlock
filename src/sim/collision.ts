/**
 * Collision components (spells.md §3.2-§3.3): channel, per-alliance accept matrix, initiative,
 * elasticity. Shared by physics and spell behaviors.
 */
import type { EntityId, ObstacleState, PawnState, ProjectileState } from './types'
import { ALLIANCE_ALLY, ALLIANCE_ENEMY, ALLIANCE_SELF } from './teams'

export const CH_PLAYER = 1
export const CH_PROJECTILE = 2
export const CH_OBSTACLE = 3

export const BIT_PLAYER = 1 << CH_PLAYER
export const BIT_PROJECTILE = 1 << CH_PROJECTILE
export const BIT_OBSTACLE = 1 << CH_OBSTACLE

/** Accept matrix indexed by alliance (SELF, ALLY, ENEMY) -> channel bitmask. */
export type CollMatrix = readonly [number, number, number]

export function collMatrix(self: number, ally: number, enemy: number): CollMatrix {
  const m: [number, number, number] = [0, 0, 0]
  m[ALLIANCE_SELF] = self
  m[ALLIANCE_ALLY] = ally
  m[ALLIANCE_ENEMY] = enemy
  return m
}

export interface ColliderProfile {
  channel: number
  /** lower initiative dominates (spells.md §3.2 notification rule) */
  init: number
  mat: CollMatrix
  elastic: boolean
  elasticity: number
  mass: number
  /** false for Shield / Alteration / Warpzone CCs: they never let the other side be notified */
  notifiesOther: boolean
}

/** Standard projectile: ENEMY -> {PLAYER, PROJECTILE, OBSTACLE}, init 0, not elastic. */
export const STD_PROJECTILE: ColliderProfile = {
  channel: CH_PROJECTILE,
  init: 0,
  mat: collMatrix(0, 0, BIT_PLAYER | BIT_PROJECTILE | BIT_OBSTACLE),
  elastic: false,
  elasticity: 0,
  mass: 1,
  notifiesOther: true,
}

export type BodyRef =
  | { kind: 'pawn'; pawn: PawnState }
  | { kind: 'projectile'; proj: ProjectileState }
  | { kind: 'obstacle'; obstacle: ObstacleState }

/** What a notified collider is told (original coll_info). */
export interface CollisionHit {
  other: BodyRef
  otherId: EntityId
  /** unit vector from this collider's centre to the other's centre, at time of impact */
  nx: number
  ny: number
  /** contact midpoint */
  x: number
  y: number
  /** the pair already overlapped at the start of the tick (TOI 0) */
  overlapping: boolean
}
