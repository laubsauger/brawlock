/**
 * Lead aim (docs/research/systems.md §8.4, `getPredictedDir`).
 * The original solves |delta + v t| = speed * t for the smallest t >= 0. We solve the
 * geometric intercept |(target - shooter) + v t| = speed * t (the research note writes
 * delta as shooter - target, which flips the sign of the linear term; the intent is
 * clearly the intercept, so that is what we implement).
 */
import { cos, sin } from '../sim/math'
import type { Vec2 } from '../sim/types'

/** Smallest t >= 0 at which a projectile of `speed` from the origin meets a target at (dx, dy) moving with (vx, vy). */
export function interceptTime(dx: number, dy: number, vx: number, vy: number, speed: number): number | null {
  const a = vx * vx + vy * vy - speed * speed
  const b = 2 * (dx * vx + dy * vy)
  const c = dx * dx + dy * dy
  if (c === 0) return 0
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) < 1e-9) return null
    const t = -c / b
    return t >= 0 ? t : null
  }
  const disc = b * b - 4 * a * c
  if (disc < 0) return null
  const sq = Math.sqrt(disc)
  const t1 = (-b - sq) / (2 * a)
  const t2 = (-b + sq) / (2 * a)
  const lo = Math.min(t1, t2)
  const hi = Math.max(t1, t2)
  if (lo >= 0) return lo
  if (hi >= 0) return hi
  return null
}

/**
 * Point where a projectile fired from `shooter` after `delay` seconds meets a target
 * moving at constant velocity. Falls back to the target's (delayed) position when the
 * target outruns the projectile.
 */
export function leadPoint(shooter: Vec2, target: Vec2, targetVel: Vec2, speed: number, delay = 0): Vec2 {
  const tx = target.x + targetVel.x * delay
  const ty = target.y + targetVel.y * delay
  const t = interceptTime(tx - shooter.x, ty - shooter.y, targetVel.x, targetVel.y, speed)
  if (t === null) return { x: tx, y: ty }
  return { x: tx + targetVel.x * t, y: ty + targetVel.y * t }
}

/** Rotate `point` around `origin` by `angle` radians. */
export function rotateAround(origin: Vec2, point: Vec2, angle: number): Vec2 {
  const c = cos(angle)
  const s = sin(angle)
  const dx = point.x - origin.x
  const dy = point.y - origin.y
  return { x: origin.x + dx * c - dy * s, y: origin.y + dx * s + dy * c }
}
