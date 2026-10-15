/**
 * Warlock characters (owned by the character workstream).
 *
 *   await preloadWarlock()                       // once, before the first createWarlock('cc0')
 *   const w = createWarlock({ color: 0x31d0c4 }) // style: 'cc0' (default) | 'procedural'
 *   parent.add(w.object3d)                       // owner places it at the pawn's ground point
 *   // every render frame:
 *   w.update(pawn, prevPawn, alpha, dt, newEvents)
 *   w.castOrigin(v)                              // palm (default) or staff crystal, world space
 *   w.castCharge                                 // 0..1 over the windup, 0 when released / cancelled
 *   w.setCastColor(0xff7a1a)                     // spell colour for hand, sleeve runes, crystal (null = player colour)
 *   w.dispose()
 *
 * Contract
 * - `object3d` is local: feet at y = 0, unit scale (metres = world units). The
 *   owner sets its position (interpolated pawn x/y, tile or lava height). The
 *   warlock turns itself to `pawn.facing` (interpolated with prev/alpha), leans,
 *   tumbles and animates; it never moves its own origin.
 * - `update(pawn, prev, alpha, dt, events)`: `events` are this frame's new sim
 *   events for all pawns (each tick's events once); filtered here by pawn id /
 *   owner: castStart, cast, castCancel, damage, death, respawn, teleport, swap,
 *   roundWin, phase.
 * - Windup telegraph (gameplay): during the cast point the casting arm's sleeve
 *   runes and palm charge up in `castColor`, flare on 'cast', flicker out on
 *   'castCancel'. Render draws the charging orb / particles at castOrigin()
 *   using castCharge.
 * - Material fx are driven internally: hit flash (damage), lava burn
 *   (pawn.lavaTicks > 0), invulnerability shimmer, death burn-up after the death
 *   clip. Shadow flags are set (castShadow / receiveShadow) on all parts.
 * - Animation (cc0): idle / walk / run by walk speed (clip speed matched), cast
 *   windup -> release -> backswing on the upper body (cut instantly by walking or
 *   a new cast: Dota animation cancel), fizzle on cancel, Scourge = ground slam,
 *   additive hit reactions, tumble on big knockback (falls backwards along the
 *   push), death, victory (round win, until the next phase). Lean into runs,
 *   banking into turns, lean back against knockback.
 * - Cloth (cc0): long split coat + tabard, long cape, mantle and bell sleeves
 *   with a per-pawn spring (lag, inertia on turns and impulses) displaced in
 *   the vertex shader, pendulum-clamped so hems never invert, and pushed out
 *   of leg / torso / arm capsules taken from the live bones each frame.
 * - Staff: optional attachment (default off; warlockParams.staff), variants
 *   'gnarled' | 'iron' | 'bone' via setStaff(); castFrom 'palm' | 'staff'.
 * - Performance: geometry, materials and clips are shared; per-pawn values are
 *   per-object uniforms (gpuState.ts). One mixer and one skeleton per warlock,
 *   4 draws (outfit, gloves, cloth, hood void) + staff. No per-frame allocation
 *   in update().
 * - Look-dev switches: `warlockParams` (style, staff, staffVariant, castFrom,
 *   version counter) for the Inspector; style needs a rebuild of the warlocks.
 */
import { loadWarlockAsset, getWarlockAsset, WARLOCK_URL } from './asset'
import { warlockParams, type CastFrom, type WarlockStyle } from './config'
import type { StaffVariant } from './geometry'
import { ProceduralWarlock } from './procedural'
import type { CastArm, DeathKind, WarlockHandle, WarlockOptions } from './types'
import { CC0Warlock } from './warlock'

export type { CastArm, DeathKind, WarlockHandle, WarlockOptions, WarlockStyle, CastFrom, StaffVariant }
export { warlockParams, WARLOCK_URL }
export { CC0_SCALE, RIG_HEIGHT_M } from './config'
export { HEM_RX_M } from './geometry'
export { deathKindFor } from './warlock'
export { CAST_CATEGORY, CAST_HANDS, castCategory, type CastCategory, type CastHands } from './castStyles'
export { clothParams } from './materials'

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
