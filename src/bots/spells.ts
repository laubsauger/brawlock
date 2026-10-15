/**
 * What the bot knows about spells: role, projectile speed for lead aim, range for
 * range checks, cast point, and the original buy pools (docs/research/systems.md §8.1,
 * numbers from docs/research/spells.md §2.2 and §8).
 *
 * Bots read their spells from `pawn.slots` every think, so they also work when taking
 * over a human's pawn. Buy pools are filtered by the sim's `implemented` flag; a purchase
 * the sim still rejects is detected from state and that spell is skipped until the next
 * shop phase.
 */
import { attr, spellDef } from '../sim'
import type { SpellId } from '../sim/types'

export type BotSpellRole = 'projectile' | 'escape' | 'scourge'

export interface BotSpellInfo {
  role: BotSpellRole
  /** projectile speed in units/s; absent = no lead (instant, lobbed or curved) */
  speed?: number
  /** max useful distance to the aim point, units */
  range?: number
  /** seconds of windup before the effect fires */
  castPoint: number
}

export const BOT_SPELLS: Record<SpellId, BotSpellInfo> = {
  fireball: { role: 'projectile', speed: 1000, range: 1000, castPoint: 0.2 },
  scourge: { role: 'scourge', castPoint: 0.9 },
  // column 1
  boomerang: { role: 'projectile', range: 800, castPoint: 0.2 },
  lightning: { role: 'projectile', range: 600, castPoint: 0.2 },
  homing: { role: 'projectile', range: 4500, castPoint: 0.2 },
  twin: { role: 'projectile', range: 800, castPoint: 0.2 },
  // column 2 (escape)
  teleport: { role: 'escape', castPoint: 0 },
  thrust: { role: 'escape', castPoint: 0 },
  swap: { role: 'escape', speed: 1983, castPoint: 0 },
  // column 3
  cluster: { role: 'projectile', speed: 844, range: 672, castPoint: 0.2 },
  drain: { role: 'projectile', speed: 700, range: 850, castPoint: 0.2 },
  bouncer: { role: 'projectile', speed: 900, range: 900, castPoint: 0.2 },
  recharge: { role: 'projectile', speed: 900, range: 900, castPoint: 0.2 },
  // column 4 (Windwalk never bought or used by the original AI)
  meteor: { role: 'projectile', range: 1000, castPoint: 0.2 },
  splitter: { role: 'projectile', speed: 700, range: 900, castPoint: 0 },
  snowball: { role: 'projectile', speed: 400, range: 575, castPoint: 0.2 },
  // column 6
  gravity: { role: 'projectile', speed: 450, range: 900, castPoint: 0.2 },
  grip: { role: 'projectile', speed: 1000, range: 1100, castPoint: 0.2 },
  warpzone: { role: 'projectile', range: 700, castPoint: 0.2 },
  magnetize: { role: 'projectile', speed: 800, range: 960, castPoint: 0.2 },
  rockpillar: { role: 'projectile', range: 650, castPoint: 0.2 },
  link: { role: 'projectile', speed: 950, range: 860, castPoint: 0.2 },
}

/** Original buy pools. Column 5 (Shield, Rush, Alteration) and Windwalk are never bought. */
export const ESCAPE_SPELLS: readonly SpellId[] = ['teleport', 'thrust', 'swap']
export const TARGET_COLUMNS: readonly (readonly SpellId[])[] = [
  ['boomerang', 'lightning', 'homing', 'twin'],
  ['cluster', 'drain', 'bouncer', 'recharge'],
  ['meteor', 'splitter', 'snowball'],
  ['gravity', 'grip', 'warpzone', 'magnetize', 'rockpillar', 'link'],
]

/** The original AI only buys when cash >= 15 (the most expensive spell). */
export const BUY_MIN_GOLD = 15
/** Seconds between purchases (original next_buy_time += 40). */
export const BUY_INTERVAL = 40

/** False for spells the sim cannot cast yet (buying them is rejected). */
export function isBuyable(spell: SpellId): boolean {
  return spellDef(spell)?.implemented === true
}

/** How far an escape spell moves us; the aim point is clamped to this. */
export function escapeRange(spell: SpellId, level: number): number {
  const def = spellDef(spell)
  const r = def ? attr(def, 'range', level) : 0
  // Thrust / Swap have no plain range attribute; keep a conservative reach.
  return r > 0 ? r : 700
}
