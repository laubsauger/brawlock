/**
 * Uber's shop build: a fixed priority list bought in order as gold allows, several buys per
 * shop phase like a player would (the original AI bought one random spell per 40 s and never
 * upgraded). It saves up for the next step instead of spending on something lower.
 * - Teleport first: the save spell, and the reach for offensive repositioning.
 * - Lightning: instant hit and the Fireball detonation combo.
 * - Fireball and Scourge upgrades: more damage is more knockback.
 * - Link: pulls a target in for a Scourge.
 */
import { ITEM_SLOT_START, RELEASED_SPELLS, SPELLS } from '../sim'
import type { InputCommand, PawnState, SpellId } from '../sim/types'

interface Step {
  kind: 'spell' | 'item'
  id: SpellId
  /** buy / upgrade until this level */
  level: number
}

export const UBER_PLAN: readonly Step[] = [
  { kind: 'spell', id: 'teleport', level: 1 },
  { kind: 'spell', id: 'lightning', level: 1 },
  { kind: 'item', id: 'fireball', level: 3 },
  { kind: 'item', id: 'scourge', level: 2 },
  { kind: 'spell', id: 'teleport', level: 2 },
  { kind: 'item', id: 'fireball', level: 5 },
  { kind: 'spell', id: 'link', level: 1 },
  { kind: 'spell', id: 'teleport', level: 4 },
  { kind: 'item', id: 'scourge', level: 3 },
  { kind: 'item', id: 'fireball', level: 7 },
  { kind: 'spell', id: 'lightning', level: 4 },
  { kind: 'spell', id: 'teleport', level: 7 },
]

/** The next purchase of the plan, or null (done, or saving up for the next step). */
export function planStep(me: PawnState | null, gold: number, failed: ReadonlySet<SpellId>): { cmd: InputCommand; id: SpellId } | null {
  if (!me) return null
  for (const step of UBER_PLAN) {
    const def = SPELLS[step.id]
    if (!def || !RELEASED_SPELLS.has(step.id) || failed.has(step.id)) continue
    const slot = step.kind === 'spell' ? def.column - 1 : me.slots.indexOf(step.id, ITEM_SLOT_START)
    const owned = slot >= 0 && me.slots[slot] === step.id
    // a column already holding another spell is closed for good (no selling)
    if (step.kind === 'spell' && !owned && me.slots[slot] !== null) continue
    const level = owned ? me.levels[slot] : 0
    if (level >= step.level || level >= def.maxLevel) continue
    const cost = step.kind === 'spell' ? (level === 0 ? def.cost : def.upgradeCosts[level - 1]) : def.cost
    if (gold < cost) return null
    const cmd: InputCommand = step.kind === 'spell' ? { kind: 'buySpell', spell: step.id } : { kind: 'buyItem', item: step.id }
    return { cmd, id: step.id }
  }
  return null
}
