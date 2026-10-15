/**
 * Render scale contract: every gameplay-relevant visual size is derived from
 * a sim number here, and scale.test.ts pins it, so visuals can never drift
 * from what the sim actually tests (hit radii, tile cells, pawn footprint).
 * Pure (no three imports): safe for node tests.
 */
import { PAWN_RADIUS, TILE_SIZE } from '../sim'

/** grout between neighbouring tile slabs (game units); slab = TILE_SIZE - TILE_GAP */
export const TILE_GAP = 4
/** visual half-extent of one tile slab */
export const TILE_HALF = TILE_SIZE / 2 - TILE_GAP / 2

/** projectile hitbox core: drawn at this fraction of the sim collision radius */
export const PROJECTILE_CORE_SCALE = 0.95
export function projectileCoreRadius(simRadius: number): number {
  return Math.max(8, simRadius) * PROJECTILE_CORE_SCALE
}

/** AoE boundary ring: centre inset and gaussian width (game units) */
export const AOE_RING_INSET = 1.5
export const AOE_RING_THICK = 3
/** the visible outer edge (centre + one thickness) of an aoeRing for a gameplay radius */
export function aoeRingEdge(radius: number): number {
  return radius - AOE_RING_INSET + AOE_RING_THICK * 0.5
}

/** sim collision circle under every pawn (debug ring + footprint matching) */
export const COLLISION_RING_R = PAWN_RADIUS
