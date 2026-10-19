/**
 * Forward predictions the bots plan with (PLAN §7: bots forward-simulate the sim's own rules).
 * Everything here mirrors the sim's movement model: each tick the physics (knockback) part of
 * a pawn's velocity decays by frictionPerTick, its walk part is re-added, and lava burns
 * lavaDps in 0.25 s bursts. Pure functions of visible state.
 */
import { hypot, pow } from '../sim/math'
import { DT, TICK_HZ } from '../sim/types'
import type { PawnState, SimState, Vec2 } from '../sim/types'
import { attr, frictionPerTick, knockbackSpeed, spellDef } from '../sim'
import { isSafe, nearestTileCentre } from './arena'

export interface LavaOutcome {
  /** seconds spent on lava before standing on a tile again (or until the horizon) */
  lavaTime: number
  /** lava damage taken on the way */
  damage: number
  /** the pawn would burn to death */
  lethal: boolean
  /** where the slide ends */
  rest: Vec2
}

/** Physics (knockback) velocity: total minus the walk part. */
export function physVelocity(p: PawnState): Vec2 {
  return { x: p.vx - p.walkVx, y: p.vy - p.walkVy }
}

/** Where a slide with this physics velocity comes to rest, from `from`. */
export function slideRest(state: SimState, from: Vec2, phys: Vec2): Vec2 {
  const f = frictionPerTick(state.settings.friction)
  const k = (DT * f) / (1 - f)
  return { x: from.x + phys.x * k, y: from.y + phys.y * k }
}

/**
 * Simulate a pawn sliding with `phys` from `from` while it walks back to the nearest tile at
 * `moveSpeed` (what anyone does on lava): lava time and damage over `horizon` seconds.
 */
export function lavaOutcome(
  state: SimState,
  from: Vec2,
  phys: Vec2,
  hp: number,
  moveSpeed: number,
  layer = state.arena.layer,
  horizon = 4,
): LavaOutcome {
  const f = frictionPerTick(state.settings.friction)
  const rest = slideRest(state, from, phys)
  const home = nearestTileCentre(layer, rest.x, rest.y, true) ?? nearestTileCentre(layer, from.x, from.y, false)
  const burn = state.settings.lavaDps * 0.25
  const period = Math.round(0.25 * TICK_HZ)
  let x = from.x
  let y = from.y
  let vx = phys.x
  let vy = phys.y
  let onLava = 0
  let damage = 0
  const n = Math.round(horizon * TICK_HZ)
  for (let i = 0; i < n; i++) {
    vx *= f
    vy *= f
    let wx = 0
    let wy = 0
    if (home) {
      const dx = home.x - x
      const dy = home.y - y
      const d = hypot(dx, dy)
      if (d > 1) {
        wx = (dx / d) * moveSpeed
        wy = (dy / d) * moveSpeed
      }
    }
    x += (vx + wx) * DT
    y += (vy + wy) * DT
    if (isSafe(layer, x, y)) {
      // back on a tile and no longer being carried off it
      if (hypot(vx, vy) < moveSpeed) break
      continue
    }
    onLava++
    if (onLava % period === 0) damage += burn
    if (!home || damage >= hp - 1) break
  }
  return { lavaTime: onLava / TICK_HZ, damage, lethal: damage >= hp - 1 || !home, rest }
}

/** Damage and knockback-factor of a projectile's spell at its level (for "what if it hits"). */
export function projectileHit(spell: string, level: number): { damage: number; kbFactor: number } {
  const def = spellDef(spell)
  if (!def) return { damage: 70, kbFactor: 1 }
  const damage = attr(def, 'damage', level) || 70
  const kf = attr(def, 'knockback_factor', level)
  return { damage, kbFactor: kf > 0 ? kf : 1 }
}

/** Physics velocity a pawn would have right after taking this hit along (dx, dy) (unit). */
export function afterHit(state: SimState, p: PawnState, damage: number, spellKb: number, dx: number, dy: number): Vec2 {
  const amount = damage * state.settings.dmgMultiplier
  const kb = knockbackSpeed(amount, p.kbPoints + amount, p.kbFactor, spellKb, state.settings.kbMultiplier)
  const v = physVelocity(p)
  return { x: v.x + dx * kb, y: v.y + dy * kb }
}

/**
 * Where a knocked (decelerating) target will be after `t` seconds: its physics velocity
 * decays with friction, its walk velocity is assumed to continue.
 */
export function positionAfter(state: SimState, p: PawnState, t: number): Vec2 {
  const f = frictionPerTick(state.settings.friction)
  const n = t * TICK_HZ
  const k = (DT * f * (1 - pow(f, n))) / (1 - f)
  const ph = physVelocity(p)
  return { x: p.x + ph.x * k + p.walkVx * t, y: p.y + ph.y * k + p.walkVy * t }
}

/**
 * Lead with friction (Uber): the shot meets a target whose knockback is still decaying.
 * Fixed-point iteration on the flight time.
 */
export function leadWithFriction(state: SimState, from: Vec2, target: PawnState, speed: number, delay: number): Vec2 {
  let t = hypot(target.x - from.x, target.y - from.y) / speed
  let at = positionAfter(state, target, delay + t)
  for (let i = 0; i < 6; i++) {
    t = hypot(at.x - from.x, at.y - from.y) / speed
    at = positionAfter(state, target, delay + t)
  }
  return at
}
