/**
 * Teleport saves: a Teleport that lands on safe ground from the lava, or out of a knockback slide
 * that would come to rest in the lava. One definition for the match stats ("Teleport saves") and
 * the announcer ("Denied!").
 */
import { lavaOutcome } from '../bots/predict'
import { isLocationSafeAtLayer } from '../sim/arena'
import type { PawnState, SimState } from '../sim/types'

/** a Teleport counts as a save from a slide this fast toward the lava (u/s) */
export const SAVE_SLIDE_SPEED = 100
/** "Denied!" only with at most this much lava survival left (s), in the lava or after the slide */
export const LAVA_DENIED_SECONDS = 1

/** The pawn state a Teleport save is judged from: the last snapshot before the Teleport. */
export interface SlideSnapshot {
  x: number
  y: number
  /** knockback velocity (velocity minus walking), u/s */
  kbx: number
  kby: number
  inLava: boolean
}

type SlidePawn = Pick<PawnState, 'x' | 'y' | 'vx' | 'vy' | 'walkVx' | 'walkVy' | 'alive' | 'lavaTicks'>

export function slideSnapshot(p: SlidePawn): SlideSnapshot {
  return writeSlide({ x: 0, y: 0, kbx: 0, kby: 0, inLava: false }, p)
}

/** slideSnapshot into an existing object (per-tick trackers, no allocation). */
export function writeSlide<T extends SlideSnapshot>(out: T, p: SlidePawn): T {
  out.x = n(p.x)
  out.y = n(p.y)
  out.kbx = n(p.vx) - n(p.walkVx)
  out.kby = n(p.vy) - n(p.walkVy)
  out.inLava = p.alive && n(p.lavaTicks) > 0
  return out
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

/**
 * Announce an actual escape from death, rather than every routine lava blink or push toward
 * the edge: at most LAVA_DENIED_SECONDS of lava survival left, now or after the lava the slide
 * would cost (slide plus walking back, as the bots predict it).
 */
export function isDeniedEscape(before: SlideSnapshot, pawn: Pick<PawnState, 'hp' | 'moveSpeed'>, toX: number, toY: number, sim: Pick<SimState, 'settings' | 'arena'>): boolean {
  const layer = sim.arena.layer
  const lavaDps = sim.settings.lavaDps
  const decay = slideDecay(sim.settings.friction)
  if (lavaDps <= 0 || !isTeleportSave(before, toX, toY, layer, decay)) return false
  const margin = lavaDps * LAVA_DENIED_SECONDS
  if (before.inLava && pawn.hp <= margin) return true
  const slidingOut = Math.hypot(before.kbx, before.kby) >= SAVE_SLIDE_SPEED && decay > 0 &&
    !isLocationSafeAtLayer(layer, before.x + before.kbx / decay, before.y + before.kby / decay)
  if (!slidingOut) return false
  const out = lavaOutcome(sim, before, { x: before.kbx, y: before.kby }, pawn.hp, pawn.moveSpeed, layer)
  return out.lethal || pawn.hp - out.damage <= margin
}

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
