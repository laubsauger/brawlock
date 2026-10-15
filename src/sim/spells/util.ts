/**
 * Helpers shared by spell behaviors.
 */
import { cos, sin } from '../math'
import type { PawnState } from '../types'
import { attr } from './data'
import type { CastContext } from './types'

/** CastInfo:attribute: per-cast override (Pact), class constant, per-level value, else 0. */
export function castAttr(ctx: CastContext, name: string): number {
  const o = ctx.overrides[name]
  return o !== undefined ? o : attr(ctx.def, name, ctx.level)
}

export interface Aim {
  /** unit direction caster -> target (facing when the target is the caster itself) */
  dx: number
  dy: number
  /** distance caster -> target */
  dist: number
}

export function aimFrom(pawn: PawnState, x: number, y: number): Aim {
  const dx = x - pawn.x
  const dy = y - pawn.y
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist > 0) return { dx: dx / dist, dy: dy / dist, dist }
  return { dx: cos(pawn.facing), dy: sin(pawn.facing), dist: 0 }
}

export function aim(ctx: CastContext): Aim {
  return aimFrom(ctx.caster, ctx.x, ctx.y)
}

/** Target point clamped to `range` from the caster. */
export function clampTarget(ctx: CastContext, range: number): { x: number; y: number } {
  const a = aim(ctx)
  const d = a.dist < range ? a.dist : range
  return { x: ctx.caster.x + a.dx * d, y: ctx.caster.y + a.dy * d }
}

/** Rotate a unit vector by `angle` radians. */
export function rotate(dx: number, dy: number, angle: number): [number, number] {
  const c = cos(angle)
  const s = sin(angle)
  return [dx * c - dy * s, dx * s + dy * c]
}
