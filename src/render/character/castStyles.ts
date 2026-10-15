/**
 * How each spell is cast (animation + which hand(s) charge and release).
 * The original mod had cast animation types none / generic / lightning /
 * meteor; we split "generic" further so the pose tells the spell family.
 *
 *   directional  one hand thrust forward (left): windup raises the palm, release pushes
 *   aoe          both hands rise overhead during the windup, slam down on release (full body)
 *   sky          one arm (right) raised to the sky during the windup, pulled down on release
 *   buff         arms cross in front, then flare outward on release
 *   ground       hand driven down toward the target point on release
 *   beam         two-hand forward thrust, held as a channel
 *   move         quick flick / lunge (instant)
 */
export type CastCategory = 'directional' | 'aoe' | 'sky' | 'buff' | 'ground' | 'beam' | 'move'
export type CastHands = 'left' | 'right' | 'both'

export const CAST_CATEGORY: Readonly<Record<string, CastCategory>> = {
  fireball: 'directional',
  homing: 'directional',
  boomerang: 'directional',
  twin: 'directional',
  cluster: 'directional',
  bouncer: 'directional',
  splitter: 'directional',
  snowball: 'directional',
  drain: 'directional',
  recharge: 'directional',
  swap: 'directional',
  redirector: 'directional',
  scourge: 'aoe',
  gravity: 'aoe',
  pact: 'aoe',
  meteor: 'sky',
  shield: 'buff',
  rush: 'buff',
  alteration: 'buff',
  windwalk: 'buff',
  rockpillar: 'ground',
  warpzone: 'ground',
  lightning: 'beam',
  link: 'beam',
  magnetize: 'beam',
  grip: 'beam',
  teleport: 'move',
  thrust: 'move',
}

export const CAST_HANDS: Readonly<Record<CastCategory, CastHands>> = {
  directional: 'left',
  aoe: 'both',
  sky: 'right',
  buff: 'both',
  ground: 'left',
  beam: 'both',
  move: 'left',
}

/** Spell id (item / level suffixes ignored: 'fireball_2' -> 'fireball'). Unknown spells cast as directional. */
export function castCategory(spell: string): CastCategory {
  const direct = CAST_CATEGORY[spell]
  if (direct) return direct
  for (const [id, cat] of Object.entries(CAST_CATEGORY)) if (spell.startsWith(id)) return cat
  return 'directional'
}
