/**
 * Collision components (spells.md §3.2-§3.3, §7.1): channel, per-alliance accept matrix,
 * initiative, elasticity. Shared by physics, Lightning and spell behaviors.
 */
import type { EntityId, ModifierState, ObstacleState, PawnState, ProjectileState } from './types'
import { ALLIANCE_ALLY, ALLIANCE_ENEMY, ALLIANCE_SELF } from './teams'

export const CH_PLAYER = 1
export const CH_PROJECTILE = 2
export const CH_OBSTACLE = 3

export const BIT_PLAYER = 1 << CH_PLAYER
export const BIT_PROJECTILE = 1 << CH_PROJECTILE
export const BIT_OBSTACLE = 1 << CH_OBSTACLE
const ALL = BIT_PLAYER | BIT_PROJECTILE | BIT_OBSTACLE

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
  /** Lightning damages what it stops on only if true (Shield / Alteration / Thrust CCs: false) */
  acceptDamage: boolean
}

function profile(channel: number, init: number, mat: CollMatrix, o: Partial<ColliderProfile> = {}): ColliderProfile {
  return { channel, init, mat, elastic: false, elasticity: 0, mass: 1, notifiesOther: true, acceptDamage: true, ...o }
}

// --- projectiles (§7.1) ---------------------------------------------------------
/** std: ENEMY -> {PLAYER, PROJECTILE, OBSTACLE}, init 0 */
export const STD_PROJECTILE = profile(CH_PROJECTILE, 0, collMatrix(0, 0, ALL))
export const BOOMERANG_CC = profile(CH_PROJECTILE, -2, collMatrix(0, 0, BIT_PLAYER | BIT_OBSTACLE))
export const BOUNCER_CC = profile(CH_PROJECTILE, -1, collMatrix(BIT_PLAYER, BIT_PLAYER, ALL))
export const DRAIN_CC = profile(CH_PROJECTILE, 0, collMatrix(0, BIT_PLAYER, ALL))
export const GRAVITY_CC = profile(CH_PROJECTILE, 0, collMatrix(BIT_OBSTACLE, BIT_OBSTACLE, BIT_OBSTACLE))
export const HOMING_CC = profile(CH_PROJECTILE, -1, collMatrix(BIT_PLAYER, 0, ALL))
export const LINK_CC = profile(CH_PROJECTILE, -1, collMatrix(0, BIT_PLAYER, BIT_PLAYER | BIT_OBSTACLE))
export const MAGNETIZE_CC = profile(CH_PROJECTILE, -1, collMatrix(BIT_PLAYER, BIT_PLAYER, ALL))
export const SPAWNER_CC = profile(CH_PROJECTILE, -1, collMatrix(0, 0, 0))
export const SWAP_CC = profile(CH_PROJECTILE, 0, collMatrix(0, BIT_PLAYER, BIT_PLAYER))
export const SWAP_CC_COMBAT = profile(CH_PROJECTILE, 0, collMatrix(0, BIT_PLAYER, BIT_PLAYER | BIT_OBSTACLE))
export const WARPZONE_CC = profile(CH_PROJECTILE, -5, collMatrix(0, 0, BIT_PROJECTILE), { notifiesOther: false, acceptDamage: false })

// --- pawn temporary CCs (§3.3) ----------------------------------------------------
export const SHIELD_CC = profile(CH_PLAYER, -3, collMatrix(0, 0, BIT_PROJECTILE), { notifiesOther: false, acceptDamage: false })
export const ALTERATION_CC = SHIELD_CC
export const THRUST_CC = profile(CH_PLAYER, -4, collMatrix(0, 0, BIT_PLAYER), { acceptDamage: false })
export const WINDWALK_CC = profile(CH_PLAYER, 0, collMatrix(0, 0, BIT_PLAYER))

/** Which collider of a pawn: 'body' or the id of the modifier that owns a temporary CC. */
export type PawnCC = 'body' | string

export type BodyRef =
  | { kind: 'pawn'; pawn: PawnState; cc: PawnCC; mod: ModifierState | null }
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
  /** centre distance at time of impact */
  distance: number
  /** the pair already overlapped at the start of the tick (TOI 0) */
  overlapping: boolean
  /** this side's own collider radius */
  radius: number
  otherRadius: number
}
