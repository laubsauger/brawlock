import { uniform } from 'three/tsl'
import type { StaffVariant } from './geometry'

export type WarlockStyle = 'cc0' | 'procedural'
/**
 * Material look of the cc0 warlock (live switch, no rebuild):
 *   readable  dark-but-not-black robe tinted by the player colour, mid-value
 *             player-colour trims, top / rim fill so folds, pose and facing read
 *             at the gameplay camera on every tier (default)
 *   void      the earlier near-black robe with thin neon trims (kept as a variant)
 */
export type WarlockLook = 'readable' | 'void'
/** 1 = readable, 0 = void; read by every warlock material */
export const lookUniform = uniform(1)
/**
 * Facing cue (live switch): the front of the garment carries a soft player
 * colour tint and a woven shoulder chevron while the back stays dark, so an
 * idle warlock's facing reads without a glowing stripe across the shoulders.
 */
export const facingUniform = uniform(1)
/** Where spells visually originate: the casting palm (default) or the staff crystal. */
export type CastFrom = 'palm' | 'staff'

/**
 * World metres per model metre for the CC0 rig, matched to the original's
 * gameplay read (collision radius 30 units, top-down silhouette ~70-80 units):
 * height 1.87 m -> 1.29 m (129 units), and a broad, hunched build: hem ~80
 * units across, mantle ~75, arms + bell sleeves ~80.
 */
export const CC0_SCALE = { xz: 0.76, y: 0.69 } as const

/** height of the CC0 rig incl. the hood (GLB metres, before CC0_SCALE) */
export const RIG_HEIGHT_M = 1.865

/**
 * Live look-dev switches for warlocks (Inspector / preview). Read when a
 * warlock is created; `version` bumps on every change so the owner can
 * rebuild its warlocks (style) or call `setStaff` / `setCastFrom` on them.
 */
export const warlockParams = {
  _style: 'cc0' as WarlockStyle,
  _staff: false,
  _staffVariant: 'gnarled' as StaffVariant,
  // with a staff, spells leave from its crystal by default ('palm' keeps the
  // hand casts for comparison); without one this has no effect
  _castFrom: 'staff' as CastFrom,
  get look(): WarlockLook {
    return lookUniform.value > 0.5 ? 'readable' : 'void'
  },
  set look(v: WarlockLook) {
    lookUniform.value = v === 'void' ? 0 : 1
  },
  get facingCue(): boolean {
    return facingUniform.value > 0.5
  },
  set facingCue(v: boolean) {
    facingUniform.value = v ? 1 : 0
  },
  /** debug: collision circle (r 30) and a Fireball-sized sphere (r 25) beside every warlock */
  debugFootprint: false,
  version: 0,
  get style(): WarlockStyle {
    return this._style
  },
  set style(v: WarlockStyle) {
    if (v !== this._style) {
      this._style = v
      this.version++
    }
  },
  get staff(): boolean {
    return this._staff
  },
  set staff(v: boolean) {
    if (v !== this._staff) {
      this._staff = v
      this.version++
    }
  },
  get staffVariant(): StaffVariant {
    return this._staffVariant
  },
  set staffVariant(v: StaffVariant) {
    if (v !== this._staffVariant) {
      this._staffVariant = v
      this.version++
    }
  },
  get castFrom(): CastFrom {
    return this._castFrom
  },
  set castFrom(v: CastFrom) {
    if (v !== this._castFrom) {
      this._castFrom = v
      this.version++
    }
  },
}
