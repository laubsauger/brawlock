import type * as THREE from 'three/webgpu'
import type { PawnState, SimEvent } from '../../sim/types'
import type { CastFrom, WarlockStyle } from './config'
import type { StaffVariant } from './geometry'
import type { WorldCtx } from '../scene/world'

/**
 * Death looks (deathFx). Picked automatically from the sim 'death' event's
 * `cause` / `kb` (lava -> lava, fireball/splitter/cluster -> fireball, ...),
 * or forced by render / VFX with deathFx(kind).
 *   ash        collapse, charring, ember-edged burn-up (generic)
 *   lava       collapse while sinking and shrinking, flames, charred
 *   fireball   blown backwards along the push, charred with ember cracks
 *   meteor     as fireball
 *   lightning  x-ray / silhouette flash, then charred, blue-white burn-up
 *   freeze     ice tint + frost rim, pose freezes, shatters (fast icy dissolve)
 *   gravity    blown back while spinning and shrinking into a point, violet
 *   drain      withers grey, shrinks a little, collapses, sickly green burn-up
 */
export type DeathKind = 'ash' | 'lava' | 'fireball' | 'meteor' | 'lightning' | 'freeze' | 'gravity' | 'drain'

export interface WarlockOptions {
  /** player colour 0xRRGGBB */
  color: number
  /** default: warlockParams.style ('cc0') */
  style?: WarlockStyle
  /** staff attachment variant, null = no staff. Default: warlockParams.staff ? warlockParams.staffVariant : null */
  staff?: StaffVariant | null
  /** spell origin: palm (default) or staff crystal (needs a staff) */
  castFrom?: CastFrom
  /** procedural style only: the match world ctx (shared clock + noise). Optional. */
  ctx?: WorldCtx
}

/** World-space casting arm chain (filled by castArm()). */
export interface CastArm {
  shoulder: THREE.Vector3
  elbow: THREE.Vector3
  wrist: THREE.Vector3
  palm: THREE.Vector3
  /** unit direction wrist -> palm (where the hand points) */
  dir: THREE.Vector3
}

export interface WarlockHandle {
  /** Local-space model: the owner places it at the pawn's ground point (feet at y = 0). */
  readonly object3d: THREE.Object3D
  readonly style: WarlockStyle
  /**
   * Advance one render frame. `events` = this frame's new sim events (all pawns;
   * filtered here by pawn id / owner). `alpha` interpolates prev -> pawn.
   */
  update(pawn: PawnState, prev: PawnState | null, alpha: number, dt: number, events: readonly SimEvent[]): void
  /** World position spells originate from (casting palm, or staff crystal). */
  castOrigin(out: THREE.Vector3): THREE.Vector3
  /** Casting arm chain in world space this frame (for halo rings travelling down the arm); `hand` picks one of two casting hands. */
  castArm(out: CastArm, hand?: 'left' | 'right'): CastArm
  /** Hand(s) of the current / last cast (castStyles.ts): 'both' for aoe, buff and beam spells; castOrigin is then between the palms. */
  readonly castHands: 'left' | 'right' | 'both'
  /** 0..1 over the cast point (windup), 0 when idle / released / cancelled. */
  readonly castCharge: number
  /** Colour of the current cast glow (hand, sleeve runes, staff crystal). Default: player colour. */
  setCastColor(color: number | null): void
  setColor(color: number): void
  setStaff(variant: StaffVariant | null): void
  setCastFrom(from: CastFrom): void
  /** Extra cloth kick (game-space direction, strength ~ knockback speed). Damage events already do this. */
  impulse(dx: number, dy: number, strength: number): void
  /** Thrown off the feet along game direction (dx, dy): falls backwards, recovers when the slide slows. Big knockbacks do this automatically. */
  tumble(dx: number, dy: number): void
  /** Force / override the death look (also starts the death if the pawn is still alive here). (dx, dy) = push direction for blown-back kinds. */
  deathFx(kind: DeathKind, dx?: number, dy?: number): void
  dispose(): void
}
