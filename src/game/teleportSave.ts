/**
 * Teleport saves: a Teleport that lands on safe ground from the lava, or out of a knockback slide
 * that would come to rest in the lava. One definition for the match stats ("Teleport saves") and
 * the announcer ("Denied!").
 */
import { isLocationSafeAtLayer } from '../sim/arena'
import type { PawnState } from '../sim/types'

/** a Teleport counts as a save from a slide this fast toward the lava (u/s) */
export const SAVE_SLIDE_SPEED = 100

/** The pawn state a Teleport save is judged from: the last snapshot before the Teleport. */
export interface SlideSnapshot {
  x: number
  y: number
  /** knockback velocity (velocity minus walking), u/s */
  kbx: number
  kby: number
  inLava: boolean
}

export function slideSnapshot(p: Pick<PawnState, 'x' | 'y' | 'vx' | 'vy' | 'walkVx' | 'walkVy' | 'alive' | 'lavaTicks'>): SlideSnapshot {
  return {
    x: n(p.x),
    y: n(p.y),
    kbx: n(p.vx) - n(p.walkVx),
    kby: n(p.vy) - n(p.walkVy),
    inLava: p.alive && n(p.lavaTicks) > 0,
  }
}

/** Per-second decay rate of knockback velocity, v(t) = v0 * e^(-decay t), for a friction setting. */
export function slideDecay(friction: unknown): number {
  const f = n(friction) || 0.96
  return f > 0 && f < 1 ? -Math.log(f) / 0.035 : 0
}

/**
 * A Teleport save: it lands on safe ground, from the lava or from a knockback slide whose
 * resting point is in the lava. The match stats count these ("Teleport saves"); the announcer
 * calls them ("Denied!").
 */
export function isTeleportSave(before: SlideSnapshot, toX: number, toY: number, layer: number, decay: number): boolean {
  if (!isLocationSafeAtLayer(layer, toX, toY)) return false
  if (before.inLava) return true
  const speed = Math.hypot(before.kbx, before.kby)
  if (speed < SAVE_SLIDE_SPEED || decay <= 0) return false
  // geometric decay: total remaining slide = v / decay
  return !isLocationSafeAtLayer(layer, before.x + before.kbx / decay, before.y + before.kby / decay)
}

/** Announce an actual escape from danger, rather than every routine lava blink. */
export function isDeniedEscape(before: SlideSnapshot, pawn: Pick<PawnState, 'hp' | 'maxHp'>, toX: number, toY: number, layer: number, decay: number, lavaDps: number): boolean {
  if (lavaDps <= 0 || !isTeleportSave(before, toX, toY, layer, decay)) return false
  const slidingOut = Math.hypot(before.kbx, before.kby) >= SAVE_SLIDE_SPEED && decay > 0 &&
    !isLocationSafeAtLayer(layer, before.x + before.kbx / decay, before.y + before.kby / decay)
  return slidingOut || (before.inLava && (pawn.hp <= pawn.maxHp * 0.35 || pawn.hp / lavaDps <= 1.5))
}

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
