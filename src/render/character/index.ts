/**
 * Warlock characters (owned by the character workstream).
 *
 *   await preloadWarlock()                       // once, before the first createWarlock('cc0')
 *   const w = createWarlock({ color: 0x31d0c4 }) // style: 'cc0' (default) | 'procedural'
 *   parent.add(w.object3d)                       // owner places it at the pawn's ground point
 *   // every render frame:
 *   w.update(pawn, prevPawn, alpha, dt, newEvents)
 *   w.castOrigin(v)                              // palm(s) (or staff crystal), world space
 *   w.castArm(arm, hand?)                        // shoulder / elbow / wrist / palm / dir of a casting arm
 *   w.castHands                                  // 'left' | 'right' | 'both' for the current / last spell ('left' = staff hand when casting from a staff)
 *   w.castCharge                                 // 0..1 over the windup, 0 when released / cancelled
 *   w.setCastColor(0xff7a1a)                     // spell colour for hands, sleeve runes, emblem (null = player colour)
 *   w.deathFx('lava') / w.tumble(dx, dy)         // optional overrides (both also happen automatically)
 *   w.levelUp(spellColorHex)                     // purchase burst (render calls it on the sim's purchase event)
 *   w.hitFlash(false)                            // skip the built-in damage flash while a VFX module draws its own
 *   w.dispose()
 *
 * Contract
 * - `object3d` is local: feet at y = 0, unit scale (metres = world units). The
 *   owner sets its position (interpolated pawn x/y, tile or lava height). The
 *   warlock turns itself to `pawn.facing` (interpolated with prev/alpha), leans,
 *   tumbles and animates; it never moves its own origin. Size: 129 game units
 *   tall, ~78 units across top-down (CC0_SCALE, RIG_HEIGHT_M, HEM_RX_M).
 * - `update(pawn, prev, alpha, dt, events)`: `events` are this frame's new sim
 *   events for all pawns (each tick's events once); filtered here by pawn id /
 *   owner: castStart, cast, castCancel, damage, death (cause, kb), respawn,
 *   teleport, swap, roundWin, phase. dt = 0 (frozen time, hit-stop) holds
 *   everything still.
 * - Casts (castStyles.ts): spell id -> category -> pose and hand(s):
 *   directional (left thrust), aoe (both hands overhead, slam), sky (right arm
 *   to the sky, meteor), buff (cross, flare), ground (hand driven down), beam
 *   (two-hand channel), move (flick / lunge). Windup = cast point (scaled),
 *   release snaps on 'cast', backswing is cut by walking or a new cast (Dota
 *   animation cancel), 'castCancel' fizzles.
 * - Windup telegraph (gameplay): the casting arm(s) ignite from shoulder to
 *   cuff, every trim pulses, palms / eyes / chest emblem flare, all in
 *   `castColor`; flare on release, flicker out on cancel. Render draws the
 *   charging orb at castOrigin() using castCharge (and rings along castArm()).
 * - Visual progression (progression.ts, PLAN §5.7.1): read from pawn.slots /
 *   levels each update. Owned shop columns light an accent band in the spell's
 *   colour (1 sleeves, 2 hood stripe, 3 sash, 4 cape border, 5 mantle edge,
 *   6 tabard column), secondary to the team trims; total levels raise rune
 *   density / brightness and eye glow in 4 steps, with a hem ember aura near max.
 * - Material fx are driven internally: hit flash (damage: white rim core, then
 *   crimson, scaled by damage / kb; hitFlash(false) skips it), lava burn
 *   (pawn.lavaTicks > 0), invulnerability shimmer, death looks (DeathKind:
 *   charred / frozen / x-ray / withered / sinking / shrinking + dissolve edge).
 *   Shadow flags are set (castShadow / receiveShadow) on all parts.
 * - Animation (cc0): idle / walk / run by walk speed (clip speed matched),
 *   upper-body casts over moving legs (full body when standing), additive hit
 *   reactions, tumble on big knockback (falls backwards along the push), death,
 *   victory (round win, until the next phase). Hunched stance, lean into runs,
 *   banking into turns, lean back against knockback, torso coil / twist on casts.
 * - Cloth (cc0): split coat + tabard, sash, underlayer, long cape, closed
 *   mantle, bell sleeves; per-pawn springs (lag, turn inertia, impulses) in the
 *   vertex shader, pendulum-clamped so hems never invert, pushed out of leg /
 *   torso / arm capsules from the live bones; front panels follow a spring-
 *   smoothed per-leg envelope so they swing over striding legs.
 * - Staff: off by default (warlockParams.staff); variants 'gnarled' | 'iron' |
 *   'bone' via setStaff(). Held in the closed left fist (grip socket, wrist
 *   turned to the shaft), carried upright beside the robe and kept clear of it,
 *   raised / thrust by the cast poses, falls along the body on tumble / death.
 *   castFrom 'staff' (default): every spell is cast by the staff hand, the
 *   charge, release flash and castOrigin sit at the head crystal and castArm
 *   runs up the shaft; 'palm' keeps the hand casts.
 * - Performance: geometry, materials and clips are shared; per-pawn values are
 *   per-object uniforms (gpuState.ts). One mixer and one skeleton per warlock,
 *   2 draws (outfit + hands, cloth + hood void), ~12.1k triangles. update()
 *   allocates nothing, does no full matrix update (the renderer's one is
 *   enough) and animates fingers only in cast clips. w.setDetail(0 | 1 | 2):
 *   full / far (secondary motion at half rate) / offscreen (skeleton ~15 Hz,
 *   no pose layer or cloth) for the owner's distance / frustum test.
 * - Debug: warlockParams.debugFootprint (collision ring r30 + Fireball ball
 *   r25), clothParams.debugClip (robe-covered body red, lower legs green).
 * - Look-dev switches: `warlockParams` (style, look, staff, staffVariant,
 *   castFrom, debugFootprint, version counter) for the Inspector; style needs a
 *   rebuild, look ('readable' default | 'void', the earlier near-black robe) is live.
 */
import { loadWarlockAsset, getWarlockAsset, WARLOCK_URL } from './asset'
import { warlockParams, type CastFrom, type WarlockLook, type WarlockStyle } from './config'
import type { StaffVariant } from './geometry'
import { ProceduralWarlock } from './procedural'
import type { CastArm, DeathKind, WarlockHandle, WarlockOptions } from './types'
import { CC0Warlock } from './warlock'

export type { CastArm, DeathKind, WarlockHandle, WarlockOptions, WarlockStyle, WarlockLook, CastFrom, StaffVariant }
export { warlockParams, WARLOCK_URL }
export { CC0_SCALE, RIG_HEIGHT_M } from './config'
export { HEM_RX_M } from './geometry'
export { deathKindFor } from './warlock'
export { CAST_CATEGORY, CAST_HANDS, castCategory, type CastCategory, type CastHands } from './castStyles'
export { clothParams } from './materials'
export { PROGRESSION_LOCATIONS, POWER_STEPS } from './progression'

/** Loads and prepares the CC0 warlock (GLB, materials, cloth). Safe to call repeatedly. */
export async function preloadWarlock(): Promise<void> {
  await loadWarlockAsset()
}

/** True once preloadWarlock() resolved (createWarlock('cc0') falls back to 'procedural' before that). */
export function warlockReady(): boolean {
  return getWarlockAsset() !== null
}

export function createWarlock(opts: WarlockOptions): WarlockHandle {
  const style = opts.style ?? warlockParams.style
  const asset = getWarlockAsset()
  if (style === 'procedural' || !asset) {
    if (style === 'cc0' && !asset) console.warn('createWarlock: preloadWarlock() not finished, using the procedural warlock')
    return new ProceduralWarlock(opts.color, opts.ctx)
  }
  const staff = opts.staff !== undefined ? opts.staff : warlockParams.staff ? warlockParams.staffVariant : null
  return new CC0Warlock(asset, opts.color, staff, opts.castFrom ?? warlockParams.castFrom)
}
