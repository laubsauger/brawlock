/**
 * Descriptions say what a spell does, never its numbers: the ability card
 * shows those from the sim table for the level in question.
 *
 * Shop catalog for display. Numbers (costs, levels, cooldowns, max levels,
 * what is implemented) come from the sim's spell table, so the shop can never
 * disagree with what a purchase does. This file adds only presentation:
 * column names and hues, descriptions (written fresh for Brawlock) and the
 * stat lines shown in previews.
 */
import {
  MASTERY_ALL_COST,
  MASTERY_COST,
  MASTERY_MAX_LEVEL,
  PASSIVE_ITEMS,
  RELEASED_SPELLS,
  SPELL_IDS,
  SPELL_MAX_LEVEL,
  cooldownSeconds,
  masteryFactor,
  spellDef as simSpell,
  type SpellId,
} from '../../sim'
import { abilityStats, type AbilityStatContext } from './abilityStats'

export { MASTERY_ALL_COST, MASTERY_COST, MASTERY_MAX_LEVEL, SPELL_MAX_LEVEL }

export type Stat = [label: string, value: string, note?: string]
export type MasteryId = 'duration' | 'range' | 'lifesteal'

export interface ShopSpell {
  id: SpellId
  name: string
  /** 0..5 */
  column: number
  buy: number
  /** cost from level L to L+1 at index L-1 */
  upgrades: readonly number[]
  implemented: boolean
  desc: string
}

export interface ShopItem {
  id: SpellId
  name: string
  /** cost per level (buying an owned item upgrades it) */
  cost: number
  maxLevel: number
  implemented: boolean
  desc: string
}

export const COLUMNS: { name: string; hint: string; hue: string }[] = [
  { name: 'Knockout', hint: 'Fast shots built to push', hue: '#ff7a2a' },
  { name: 'Transport', hint: 'Get out, get in', hue: '#a58bff' },
  { name: 'Damage', hint: 'Wear them down', hue: '#ff4a5c' },
  { name: 'Devastator', hint: 'Big plays', hue: '#ffc548' },
  { name: 'Defense', hint: 'Turn their spells against them', hue: '#55d6ec' },
  { name: 'Control', hint: 'No push, all leverage', hue: '#86e07e' },
]

export const ITEM_HUE = '#e9d3b0'
export const MASTERY_HUE = '#ffb36b'

const DESC: Record<string, string> = {
  fireball: 'Your starting bolt. Straight, fast, reliable. Every upgrade adds damage.',
  scourge: 'After a short windup, blast everyone around you. It costs you some health but never kills you. Stop cancels the windup.',
  redirector: 'Steer your nearest projectile toward the cursor and extend its flight. You take more knockback for a while afterwards.',
  pact: 'Your next damaging spell soon after hits harder, then you are slowed for a while.',
  ring_of_health: 'More maximum health.',
  cursed_ring: 'More health and less knockback, but debuffs on you last longer.',
  cape: 'Faster health regeneration.',
  armor: 'Take less knockback from every hit.',
  boots: 'Move faster.',
  pocket_watch: 'Debuffs wear off sooner.',
  boomerang: 'A curved blade that flies out and arcs back to you, cutting through other projectiles.',
  lightning: 'An instant strike along a line that hits the first thing in its path. Sets off your own Fireballs.',
  homing: 'A seeker that hunts the nearest enemy. Touch it yourself to detonate it for a burst of speed.',
  twin: 'A pair of bolts swing out on mirrored arcs and meet at the target point.',
  teleport: 'Blink to the cursor. You keep most of your momentum, so pick the landing.',
  thrust: 'Dash at the target and slam into whoever you meet. The faster you go, the harder it hits.',
  swap: 'A quick bolt that trades places with the first warlock or pillar it touches.',
  cluster: 'A fan of small fireballs. Less push each, more chances to land.',
  drain: 'Turns toward the nearest warlock. Saps enemies and sends health back to you.',
  bouncer: 'Ricochets between nearby warlocks, weaker with every enemy it hits.',
  recharge: 'Grows stronger with every consecutive hit; the returning orb resets its cooldown.',
  windwalk: 'Vanish and run faster for a moment. The first enemy you touch takes the hit.',
  meteor: 'Call down a rock that cannot be blocked or redirected. Hardest at the center.',
  splitter: 'A bolt that bursts into waves of smaller bolts.',
  snowball: 'A slow ball that drags enemies along and explodes at the end.',
  shield: 'A short bubble that reflects enemy projectiles and makes them yours.',
  rush: 'Absorb half of the damage you take and turn it into speed.',
  alteration: 'Trade places with the next enemy projectile that comes close.',
  gravity: 'A slow orb that pulls warlocks and projectiles in, including your own.',
  grip: 'Root a warlock in place. Rooted targets take less knockback but build points when they cast.',
  warpzone: 'A zone that slows enemy projectiles to a crawl.',
  magnetize: 'On an enemy, your projectiles bend toward them. On a friend, enemy projectiles bend away.',
  rockpillar: 'Raise a pillar that blocks shots and explodes when destroyed.',
  link: 'A tether that drags the target toward you and burns enemies.',
}

export const SPELLS: ShopSpell[] = SPELL_IDS.map((id) => simSpell(id)!)
  .filter((d) => d.kind === 'spell')
  .map((d) => ({
    id: d.id,
    name: d.name,
    column: d.column - 1,
    buy: d.cost,
    upgrades: d.upgradeCosts,
    // the same set the sim's shop checks before accepting a purchase
    implemented: RELEASED_SPELLS.has(d.id),
    desc: DESC[d.id] ?? '',
  }))

/** Shop order: the two starters, the passives, then the other actives. */
const ITEM_ORDER = ['fireball', 'scourge', 'ring_of_health', 'cursed_ring', 'cape', 'armor', 'boots', 'pocket_watch', 'redirector', 'pact']

export const ITEMS: ShopItem[] = ITEM_ORDER.flatMap((id): ShopItem[] => {
  const active = simSpell(id)
  if (active && active.kind === 'item') {
    return [{ id, name: active.name, cost: active.cost, maxLevel: active.maxLevel, implemented: RELEASED_SPELLS.has(id), desc: DESC[id] ?? '' }]
  }
  const passive = PASSIVE_ITEMS[id]
  if (passive) return [{ id, name: passive.name, cost: passive.cost, maxLevel: passive.maxLevel, implemented: RELEASED_SPELLS.has(id), desc: DESC[id] ?? '' }]
  return []
})

export const MASTERIES: { id: MasteryId; name: string; desc: string }[] = [
  { id: 'duration', name: 'Duration', desc: 'Your buffs, and the debuffs you inflict, last longer.' },
  { id: 'range', name: 'Range', desc: 'Your projectiles fly further.' },
  { id: 'lifesteal', name: 'Lifesteal', desc: 'Heal for a share of the damage you deal. Healing also sheds knockback points.' },
]

/** Duration and range are factors (1.10), lifesteal a share (0.09). */
export function masteryValue(id: MasteryId, level: number): number {
  return masteryFactor(id, level)
}

/** Preview lines for a spell or item at a level (1-based). */
export function levelStats(id: SpellId, level: number, context?: AbilityStatContext): Stat[] {
  return abilityStats(id, level, context).map((s) => [s.label, s.value, s.note])
}

export function spellDef(id: SpellId | null | undefined): ShopSpell | undefined {
  return id ? SPELLS.find((s) => s.id === id) : undefined
}

export function itemDef(id: SpellId | null | undefined): ShopItem | undefined {
  return id ? ITEMS.find((s) => s.id === id) : undefined
}

/** Passive items (Ring of Health, Cape, ...) only change stats; nothing to cast. */
export function isPassive(id: SpellId | null | undefined): boolean {
  return !!id && !!PASSIVE_ITEMS[id]
}

/** One-line stats summary ("Max HP +100, Regen +1.5/s") for tooltips. */
export function statsSummary(id: SpellId, level: number): string {
  return levelStats(id, Math.max(1, level))
    .map(([k, v]) => `${k} ${v}`)
    .join(', ')
}

/** Display name for any spell or item id. */
export function displayName(id: SpellId | null | undefined): string {
  if (!id) return ''
  return simSpell(id)?.name ?? PASSIVE_ITEMS[id]?.name ?? id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Full cooldown in seconds at a level, for HUD sweeps before the first observed cast. */
export function knownCooldown(id: SpellId, level: number): number | undefined {
  const def = simSpell(id)
  return def && def.cooldown.length ? cooldownSeconds(def, level) : undefined
}

export function hueFor(id: SpellId | null | undefined): string {
  const s = spellDef(id)
  if (s) return COLUMNS[s.column].hue
  if (id === 'fireball') return '#ff7a2a'
  if (id === 'scourge') return '#ff4a5c'
  return ITEM_HUE
}
