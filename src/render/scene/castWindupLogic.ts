/**
 * What a hand-cast windup draws (pure logic, tested).
 *
 * Hand-marked spells charge only through their CastMarks glyph, drawn after the final pose and
 * camera update so it cannot lag the hand; a spell's own VFX module replaces the shared arm
 * layers; a module's windup style can hide any layer. A cancelled charge leaves a short fading
 * mark at the hand, except where the windup itself was hidden from this viewer (an enemy's
 * Scourge).
 */
import { windupHiddenFrom } from '../character/castStyles'
import { hasHandMark } from './CastMarks'

export interface WindupLayers {
  /** rune rings travelling shoulder to hand */
  rings: boolean
  /** energy spiral around the forearm (needs motion) */
  spiral: boolean
  /** soft palm glow */
  orb: boolean
  /** ground ring under the caster */
  ground: boolean
  /** floor light in the spell colour */
  light: boolean
}

/** The shared windup layers for `spell`; `module`: a VFX module draws this spell. Writes `out`. */
export function windupLayers(spell: string, module: boolean, motion: boolean, hide: readonly string[], out: WindupLayers): WindupLayers {
  const shared = !hasHandMark(spell) && !module
  out.rings = shared && !hide.includes('rings')
  out.spiral = shared && motion && !hide.includes('spiral')
  out.orb = shared && !hide.includes('orb')
  out.ground = !hide.includes('ground')
  out.light = !hide.includes('light')
  return out
}

export interface MarkPawn {
  owner: number
  alive: boolean
  cast: { spell: string; started?: boolean } | null
}

export interface MarkView {
  /** 0..1 through the fade of the last cancelled charge, -1 when none */
  castCancelFraction: number
  canceledCastSpell: string
}

/** Which hand mark a pawn shows this frame for `localPlayer` (-1 = spectator). */
export function castMarkOf(p: MarkPawn, v: MarkView, localPlayer: number): 'charge' | 'cancel' | null {
  if (!p.alive) return null
  if (p.cast && p.cast.started !== false) return hasHandMark(p.cast.spell) ? 'charge' : null
  if (!p.cast && v.castCancelFraction >= 0 && !windupHiddenFrom(v.canceledCastSpell, p.owner, localPlayer)) return 'cancel'
  return null
}
