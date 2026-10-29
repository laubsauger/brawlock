/**
 * Pillar awareness (pillars spawn every round): keep targets out of pillars, walk around
 * them instead of pushing into them, and know when a pillar shields us from a bolt.
 * Pillars are `state.obstacles` (static circles; projectiles collide with them).
 */
import { asin, atan2, cos, hypot, sin } from '../sim/math'
import type { ObstacleState, ProjectileState, SimState, Vec2 } from '../sim/types'
import { isSafe } from './arena'

export const BODY = 30
/** slack beyond pillar radius + body so we pass, not graze */
export const PILLAR_MARGIN = 14

const clearance = (o: ObstacleState, extra: number) => o.radius + BODY + extra

/** Standing here would overlap (or brush) a pillar. */
export function inPillar(state: SimState, x: number, y: number, extra = PILLAR_MARGIN): boolean {
  for (const o of state.obstacles) if (hypot(x - o.x, y - o.y) < clearance(o, extra)) return true
  return false
}

/** The pillar nearest along the walk from -> to that the walk would run into, or null. */
export function firstBlocking(state: SimState, from: Vec2, to: Vec2, extra = PILLAR_MARGIN): ObstacleState | null {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-6) return null
  let best: ObstacleState | null = null
  let bestT = Infinity
  for (const o of state.obstacles) {
    const t = Math.max(0, Math.min(1, ((o.x - from.x) * dx + (o.y - from.y) * dy) / len2))
    const d = hypot(from.x + dx * t - o.x, from.y + dy * t - o.y)
    if (d < clearance(o, extra) && t < bestT) {
      bestT = t
      best = o
    }
  }
  return best
}

/** A waypoint, and which way round a pillar it goes (0: no pillar in the way). */
export type Route = Vec2 & { side: -1 | 0 | 1 }

/**
 * Where to walk next on the way to `to`: `to` itself when the way is clear, else a waypoint
 * around the first pillar in the way, on the side that keeps us on safe ground:
 * - from outside its clearance ring: the tangent point (the shortest way round);
 * - already on the ring (pushed against it): a step around the ring toward `to`.
 * `prefer` tries that side first (a side kept for the whole approach) instead of the shorter one.
 */
export function routeAround(state: SimState, from: Vec2, to: Vec2, layer: number, prefer?: -1 | 1): Route {
  const o = firstBlocking(state, from, to)
  if (!o) return { x: to.x, y: to.y, side: 0 }
  const R = clearance(o, PILLAR_MARGIN) + 8
  const fx = from.x - o.x
  const fy = from.y - o.y
  const d0 = hypot(fx, fy)
  const ok = (w: Vec2) => isSafe(layer, w.x, w.y) && !inPillar(state, w.x, w.y, 0)
  // which way round is shorter: the side `to` lies on, seen from the pillar
  const cross = fx * (to.y - o.y) - fy * (to.x - o.x)
  const first: -1 | 1 = prefer ?? (cross >= 0 ? 1 : -1)
  for (const side of [first, first === 1 ? -1 : 1] as const) {
    let w: Vec2
    if (d0 <= R + 4) {
      const a = atan2(fy, fx) + side * 1.1 // ~63 degrees around the ring
      w = { x: o.x + cos(a) * (R + 10), y: o.y + sin(a) * (R + 10) }
    } else {
      const alpha = asin(Math.min(1, R / d0))
      const base = atan2(-fy, -fx) // from -> pillar centre
      const a = base - side * alpha
      const t = Math.sqrt(Math.max(0, d0 * d0 - R * R)) * 1.08
      w = { x: from.x + cos(a) * t, y: from.y + sin(a) * t }
    }
    if (ok(w)) return { ...w, side }
  }
  return { x: to.x, y: to.y, side: 0 }
}

/** Time (s) at which a projectile's straight flight first meets a pillar, or null. */
function pillarHitTime(p: ProjectileState, o: ObstacleState): number | null {
  const fx = p.x - o.x
  const fy = p.y - o.y
  const r = o.radius + p.radius
  const a = p.vx * p.vx + p.vy * p.vy
  if (a < 1e-9) return null
  const b = 2 * (fx * p.vx + fy * p.vy)
  const c = fx * fx + fy * fy - r * r
  const disc = b * b - 4 * a * c
  if (disc < 0) return null
  const t = (-b - Math.sqrt(disc)) / (2 * a)
  return t > 0 ? t : null
}

/** A pillar stops this projectile before it reaches (x, y) (we are in its cover). */
export function shieldedFrom(state: SimState, p: ProjectileState, x: number, y: number): boolean {
  const a = p.vx * p.vx + p.vy * p.vy
  if (a < 1e-9 || state.obstacles.length === 0) return false
  const tClosest = ((x - p.x) * p.vx + (y - p.y) * p.vy) / a
  if (tClosest <= 0) return false
  for (const o of state.obstacles) {
    const t = pillarHitTime(p, o)
    if (t !== null && t < tClosest) return true
  }
  return false
}
