/**
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
  SPELL_IDS,
  SPELL_MAX_LEVEL,
  attr,
  cooldownSeconds,
  masteryFactor,
  spellDef as simSpell,
  type SpellId,
} from '../../sim'

export { MASTERY_ALL_COST, MASTERY_COST, MASTERY_MAX_LEVEL, SPELL_MAX_LEVEL }

export type Stat = [label: string, value: string]
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
  fireball: 'Your starting bolt. Straight, fast, reliable. Each upgrade adds 7 damage.',
  scourge: 'After a short windup, blast everyone around you. Costs you 100 HP but never kills you. Stop (S) cancels the windup.',
  redirector: 'Steer your nearest projectile toward the cursor and extend its flight. You take 30% more knockback for 8 seconds.',
  pact: 'Your next damaging spell within 5 seconds hits 50% harder, then you are slowed for 6 seconds.',
  ring_of_health: 'More maximum health.',
  cursed_ring: 'More health and less knockback, but debuffs on you last longer.',
  cape: 'Faster health regeneration.',
  armor: 'Take less knockback from every hit.',
  boots: 'Move faster.',
  pocket_watch: 'Debuffs wear off sooner.',
  boomerang: 'A curved blade that flies out and arcs back to you, cutting through other projectiles.',
  lightning: 'An instant strike along a line that hits the first thing in its path. Sets off your own Fireballs.',
  homing: 'A seeker that hunts the nearest enemy. Touch it yourself to detonate it for a burst of speed.',
  twin: 'Two bolts swing out on mirrored arcs and meet at the target point.',
  teleport: 'Blink to the cursor. You keep most of your momentum, so pick the landing.',
  thrust: 'Dash at the target and slam into whoever you meet. The faster you go, the harder it hits.',
  swap: 'A quick bolt that trades places with the first warlock or pillar it touches.',
  cluster: 'Four small fireballs in a fan. Less push each, more chances to land.',
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
    implemented: d.implemented,
    desc: DESC[d.id] ?? '',
  }))

/** Shop order: the two starters, the passives, then the other actives. */
const ITEM_ORDER = ['fireball', 'scourge', 'ring_of_health', 'cursed_ring', 'cape', 'armor', 'boots', 'pocket_watch', 'redirector', 'pact']

export const ITEMS: ShopItem[] = ITEM_ORDER.flatMap((id): ShopItem[] => {
  const active = simSpell(id)
  if (active && active.kind === 'item') {
    return [{ id, name: active.name, cost: active.cost, maxLevel: active.maxLevel, implemented: active.implemented, desc: DESC[id] ?? '' }]
  }
  const passive = PASSIVE_ITEMS[id]
  if (passive) return [{ id, name: passive.name, cost: passive.cost, maxLevel: passive.maxLevel, implemented: passive.implemented, desc: DESC[id] ?? '' }]
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

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ''))

/** Preview lines for a spell or item at a level (1-based). */
export function levelStats(id: SpellId, level: number): Stat[] {
  const def = simSpell(id)
  if (def) {
    const out: Stat[] = []
    const dmg = def.levels.damage ? attr(def, 'damage', level) : 0
    if (dmg) out.push(['Damage', fmt(dmg)])
    if (id === 'scourge') out.push(['Points shed per enemy hit', fmt(attr(def, 'dp_reduce', level))])
    if (id === 'teleport' || (def.levels.range && new Set(def.levels.range).size > 1)) out.push(['Range', fmt(attr(def, 'range', level))])
    if (def.cooldown.length) out.push(['Cooldown', `${fmt(cooldownSeconds(def, level))}s`])
    return out
  }
  const p = PASSIVE_ITEMS[id]
  if (!p) return []
  const i = Math.min(Math.max(level, 1), p.maxLevel) - 1
  const out: Stat[] = []
  if (p.levels.hp_bonus[i]) out.push(['Max HP', `+${p.levels.hp_bonus[i]}`])
  if (p.levels.hp_regen[i]) out.push(['Regen', `+${p.levels.hp_regen[i]}/s`])
  if (p.levels.kb_reduction[i]) out.push(['Knockback taken', `-${Math.round(p.levels.kb_reduction[i] * 100)}%`])
  if (p.levels.speed_bonus_abs[i]) out.push(['Move speed', `+${p.levels.speed_bonus_abs[i]}`])
  if (p.levels.debuff_factor[i]) out.push(['Debuffs on you', `×${(1 + p.levels.debuff_factor[i]).toFixed(2)}`])
  return out
}

export function spellDef(id: SpellId | null | undefined): ShopSpell | undefined {
  return id ? SPELLS.find((s) => s.id === id) : undefined
}

export function itemDef(id: SpellId | null | undefined): ShopItem | undefined {
  return id ? ITEMS.find((s) => s.id === id) : undefined
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
