/**
 * Wild's words and colours (docs/moonshot/specs/wild.md), shared by the lobby, the omen card, the
 * badge and the results: the rules themselves live in sim/wild.ts.
 */
import { WILD_SHRINK_SECONDS, type OmenId } from '../sim/wild'
import type { SimEvent, SpellId } from '../sim/types'
import { safeLocalStorage, type KV } from './profile'

export type ReactionId = Extract<SimEvent, { type: 'reaction' }>['reaction']

export interface OmenInfo {
  name: string
  /** the round's rule in one line */
  rule: string
  /** the card's and badge's accent */
  color: string
}

export const OMEN_INFO: Record<OmenId, OmenInfo> = {
  bloodMoon: { name: 'Blood Moon', rule: 'Every push lands half again as hard', color: '#ff5a48' },
  slickStone: { name: 'Slick Stone', rule: 'The tiles sweat: every slide runs long', color: '#86d6ff' },
  overcharge: { name: 'Overcharge', rule: 'Cooldowns run at double speed', color: '#c9a2ff' },
  suddenCollapse: { name: 'Sudden Collapse', rule: `The floor gives way every ${WILD_SHRINK_SECONDS} seconds`, color: '#ffb347' },
  meteorShower: { name: 'Meteor Shower', rule: 'Meteors fall near warlocks, faster as the round goes on', color: '#ff8a3d' },
  pillarStorm: { name: 'Pillar Storm', rule: 'Pillars burst from glowing cracks, and explode when broken', color: '#e2cf9f' },
}

export const REACTION_INFO: Record<ReactionId, { name: string; rule: string; spells: readonly [SpellId, SpellId] }> = {
  shatter: { name: 'Shatter', rule: 'Lightning breaks a Snowball into four shards', spells: ['lightning', 'snowball'] },
  nova: { name: 'Nova', rule: 'A Fireball pulled into a Gravity orb goes off as a ring blast', spells: ['fireball', 'gravity'] },
  fork: { name: 'Fork', rule: 'Lightning stopped by a Shield splits back into two beams', spells: ['lightning', 'shield'] },
}
export const REACTION_IDS = Object.keys(REACTION_INFO) as ReactionId[]

const SEEN_KEY = 'brawlock.wild.reactions'
/** this session's sightings, for when storage is blocked */
const seenNow = new Set<ReactionId>()

/** The reactions this browser has seen (the discovery card and the Spell library's Reactions). */
export function seenReactions(kv: KV | null = safeLocalStorage()): Set<ReactionId> {
  const seen = new Set(seenNow)
  try {
    const v = JSON.parse(kv?.getItem(SEEN_KEY) ?? '[]') as unknown
    if (Array.isArray(v)) for (const id of REACTION_IDS) if (v.includes(id)) seen.add(id)
  } catch {
    /* unreadable: this session's only */
  }
  return seen
}

/** Remember a reaction as seen; false when it already was. */
export function markReactionSeen(id: ReactionId, kv: KV | null = safeLocalStorage()): boolean {
  const seen = seenReactions(kv)
  if (seen.has(id)) return false
  seen.add(id)
  seenNow.add(id)
  try {
    kv?.setItem(SEEN_KEY, JSON.stringify([...seen]))
  } catch {
    /* storage blocked: it may show again next match */
  }
  return true
}
