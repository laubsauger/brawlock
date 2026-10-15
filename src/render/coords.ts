import { Vector3 } from 'three/webgpu'
import { WORLD_SCALE } from '../sim/types'

/**
 * Game <-> three.js mapping.
 *
 *   game (x, y) [units]  ->  three (x * S, h * S, -y * S)   with S = WORLD_SCALE (0.01)
 *
 * Game +x is screen right, game +y is screen up (three -z, the camera looks "north").
 * Heights `h` are in game units too, measured from the lava surface (three y = 0).
 * Facing (radians, 0 = +x, CCW in game space) maps to `rotation.y = facing + PI/2`
 * for a model whose forward axis is three +z.
 */
export const S = WORLD_SCALE

/** Height of the lava surface (game units). */
export const LAVA_H = 0
/** Height of the walkable tile tops above the lava (game units). */
export const TILE_TOP_H = 30
/** Tile bottom (hidden in lava). */
export const TILE_BOTTOM_H = -80
/** Projectile flight height (chest height of a warlock). */
export const PROJECTILE_H = 70

export function toWorld(x: number, y: number, h = 0, out: Vector3 = new Vector3()): Vector3 {
  return out.set(x * S, h * S, -y * S)
}

export function toGame(v: { x: number; z: number }, out: { x: number; y: number } = { x: 0, y: 0 }): { x: number; y: number } {
  out.x = v.x / S
  out.y = -v.z / S
  return out
}

/** Model rotation.y for a game facing angle (model forward = three +z). */
export function facingToYaw(facing: number): number {
  return facing + Math.PI / 2
}
