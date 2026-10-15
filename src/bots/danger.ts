/**
 * Danger field from the original AI (docs/research/systems.md §8.3).
 * Each enemy projectile that is not moving away and is within 2000 units adds
 * 1000 / (1 + perpendicular distance to its flight line). One projectile on a
 * collision course is ~1000; a path 332 units to the side is 3 (the dodge threshold).
 */
import type { ProjectileState, Vec2 } from '../sim/types'

export const DANGER_SCALE = 1000
export const DANGER_MAX_DIST = 2000
export const DANGER_MIN_COS = -0.1
export const DANGER_DODGE_THRESHOLD = 3

export function dangerAt(projectiles: readonly ProjectileState[], x: number, y: number): number {
  let danger = 0
  for (const p of projectiles) {
    const dx = x - p.x
    const dy = y - p.y
    const dist = Math.hypot(dx, dy)
    if (dist > DANGER_MAX_DIST) continue
    const speed = Math.hypot(p.vx, p.vy)
    // a resting projectile has no direction; the original's normalize() yields NaN and the
    // dot test fails, so it is ignored there too
    if (speed < 1e-6) continue
    if (dist > 1e-6 && (p.vx * dx + p.vy * dy) / (speed * dist) < DANGER_MIN_COS) continue
    const line = Math.abs(p.vx * dy - p.vy * dx) / speed
    danger += DANGER_SCALE / (1 + line)
  }
  return danger
}

/**
 * Unit vector down the danger gradient.
 *
 * The original took forward differences with axis offsets (10, 0) and (0, 10). The field
 * has a kink on each flight line, so standing on a diagonal line both offsets lower danger
 * and the "gradient" points along the line, toward the projectile. We use the analytic
 * gradient of the same field instead: each threat pushes along its line normal, weighted
 * by 1000 / (1 + d)^2. Exactly on a line, `prefer` picks the side (else the left normal).
 */
export function dodgeDirection(projectiles: readonly ProjectileState[], x: number, y: number, prefer?: Vec2): Vec2 {
  let gx = 0
  let gy = 0
  for (const p of projectiles) {
    const dx = x - p.x
    const dy = y - p.y
    const dist = Math.hypot(dx, dy)
    if (dist > DANGER_MAX_DIST) continue
    const speed = Math.hypot(p.vx, p.vy)
    if (speed < 1e-6) continue
    if (dist > 1e-6 && (p.vx * dx + p.vy * dy) / (speed * dist) < DANGER_MIN_COS) continue
    const ux = p.vx / speed
    const uy = p.vy / speed
    const cross = ux * dy - uy * dx
    const line = Math.abs(cross)
    // left normal of the flight direction is (-uy, ux); pick the side we are on
    let side = Math.sign(cross)
    if (line < 1) side = prefer ? Math.sign(prefer.x * -uy + prefer.y * ux) || 1 : 1
    const w = DANGER_SCALE / ((1 + line) * (1 + line))
    gx += w * side * -uy
    gy += w * side * ux
  }
  const len = Math.hypot(gx, gy)
  if (len < 1e-12) return { x: 0, y: 0 }
  return { x: gx / len, y: gy / len }
}
