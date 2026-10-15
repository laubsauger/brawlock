import type { StaffVariant } from './geometry'

export type WarlockStyle = 'cc0' | 'procedural'
/** Where spells visually originate: the casting palm (default) or the staff crystal. */
export type CastFrom = 'palm' | 'staff'

/**
 * World metres per model metre for the CC0 rig. Matches the gameplay footprint
 * (collision radius 30 units): height 1.87 m -> 1.29 m (129 units, Dota-like),
 * and a broader, chunkier build: hem ~66 units across, mantle ~58 units.
 */
export const CC0_SCALE = { xz: 0.82, y: 0.69 } as const

/**
 * Live look-dev switches for warlocks (Inspector / preview). Read when a
 * warlock is created; `version` bumps on every change so the owner can
 * rebuild its warlocks (style) or call `setStaff` / `setCastFrom` on them.
 */
export const warlockParams = {
  _style: 'cc0' as WarlockStyle,
  _staff: false,
  _staffVariant: 'gnarled' as StaffVariant,
  _castFrom: 'palm' as CastFrom,
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
