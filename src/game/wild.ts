/**
 * Wild's words and colours (docs/moonshot/specs/wild.md), shared by the lobby, the omen card, the
 * badge and the results: the rules themselves live in sim/wild.ts.
 */
import { WILD_SHRINK_SECONDS, type OmenId } from '../sim/wild'
import type { SimEvent } from '../sim/types'

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

export const REACTION_INFO: Record<ReactionId, { name: string; rule: string }> = {
  shatter: { name: 'Shatter', rule: 'Lightning breaks a Snowball into four shards' },
  nova: { name: 'Nova', rule: 'A Fireball pulled into a Gravity orb goes off as a ring blast' },
  fork: { name: 'Fork', rule: 'Lightning stopped by a Shield splits back into two beams' },
}
