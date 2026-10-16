/**
 * Key numbers for the ability card (shop, HUD spell bar and item slots), read
 * from the sim's spell table for a level: damage, knockback, cooldown, range
 * or area, cast time, duration and each spell's special values. Range uses
 * the Range mastery the way the cast does (game/input.ts slotRange): projectile
 * range scales, Teleport does not. Only labels and formatting live here;
 * every number comes from the sim data.
 */
import { PASSIVE_ITEMS, SPELL_MAX_LEVEL, attr, cooldownSeconds, masteryFactor, spellDef, type SpellId } from '../../sim'

export interface AbilityStat {
  label: string
  value: string
}

const num = (n: number, digits = 2) => (Number.isInteger(n) ? String(n) : n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, ''))
const secs = (n: number) => `${num(n)}s`

/**
 * Per-spell special values worth showing, by sim key. Values are formatted
 * from the data; keys missing on a spell are skipped.
 */
const SPECIALS: { key: string; label: string; fmt: (v: number) => string }[] = [
  { key: 'buff_duration', label: 'Buff lasts', fmt: secs },
  { key: 'max_hits', label: 'Max enemies hit', fmt: (v) => num(v) },
  { key: 'move_bonus', label: 'Move speed', fmt: (v) => `+${num(v)}` },
  { key: 'dp_reduce', label: 'Points shed per enemy hit', fmt: (v) => num(v) },
  { key: 'absorb_max', label: 'Absorbs up to', fmt: (v) => `${num(v)} damage` },
  { key: 'strength', label: 'Pull strength', fmt: (v) => num(v) },
  { key: 'time_scale', label: 'Enemy projectile speed', fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'dp_gain', label: 'Points per enemy cast', fmt: (v) => num(v) },
  { key: 'damage_multiplier', label: 'Next spell damage', fmt: (v) => `×${num(v)}` },
  { key: 'speed_reduction', label: 'Slow afterwards', fmt: (v) => `−${num(v)} speed` },
  { key: 'slow_duration', label: 'Slow lasts', fmt: secs },
  { key: 'kb_penalty', label: 'Knockback you take', fmt: (v) => `+${Math.round(Math.abs(v) * 100)}%` },
  { key: 'kb_penalty_duration', label: 'Penalty lasts', fmt: secs },
  { key: 'self_cost', label: 'Costs you', fmt: (v) => `${num(v)} HP` },
  { key: 'hp', label: 'Pillar HP', fmt: (v) => num(v) },
]

/** Value of a sim attribute that exists on this spell (consts or per-level), else null. */
function has(def: NonNullable<ReturnType<typeof spellDef>>, key: string, level: number): number | null {
  if (def.consts[key] === undefined && !def.levels[key]?.length) return null
  return attr(def, key, level)
}

/**
 * Stats for a spell or item at a level (1-based; 0 is shown as level 1, what
 * buying gives you). `rangeLevel` is the owner's Range mastery level.
 */
export function abilityStats(id: SpellId, level: number, rangeLevel = 0): AbilityStat[] {
  const lvl = Math.max(1, level)
  const def = spellDef(id)
  if (def) {
    const out: AbilityStat[] = []
    const dmg = has(def, 'damage', lvl)
    if (dmg) out.push({ label: 'Damage', value: num(dmg, 1) })
    // area falloff (Meteor: edge to centre; Snowball's burst at the end)
    const dMin = has(def, 'damage_min', lvl)
    const dMax = has(def, 'damage_max', lvl)
    if (dMax) out.push({ label: dmg ? 'Burst damage' : 'Damage', value: `${num(dMin ?? 0, 1)}–${num(dMax, 1)}` })
    const kb = has(def, 'knockback_factor', lvl)
    const kbMin = has(def, 'kb_factor_min', lvl)
    const kbMax = has(def, 'kb_factor_max', lvl)
    if (kb !== null) out.push({ label: 'Knockback', value: `×${num(kb)}` })
    else if (kbMin !== null && kbMax !== null) out.push({ label: 'Knockback', value: `×${num(kbMin)}–${num(kbMax)}` })
    const range = has(def, 'range', lvl)
    if (range) {
      // spells.md §8.9: Teleport ignores the Range mastery
      const r = id === 'teleport' ? range : range * masteryFactor('range', rangeLevel)
      out.push({ label: 'Range', value: num(Math.round(r)) })
    }
    // area of effect: per-level radius (a projectile's own collision radius is a constant, not shown)
    if (def.levels.radius?.length) out.push({ label: 'Area radius', value: num(attr(def, 'radius', lvl)) })
    const dur = has(def, 'duration', lvl)
    if (dur) out.push({ label: 'Duration', value: secs(dur) })
    if (def.cooldown.length) out.push({ label: 'Cooldown', value: secs(cooldownSeconds(def, lvl)) })
    out.push({ label: 'Cast time', value: def.immediate || def.castPoint === 0 ? 'Instant' : secs(def.castPoint) })
    for (const s of SPECIALS) {
      const v = has(def, s.key, lvl)
      if (v !== null && v !== 0) out.push({ label: s.label, value: s.fmt(v) })
    }
    return out
  }
  const p = PASSIVE_ITEMS[id]
  if (!p) return []
  const i = Math.min(lvl, p.maxLevel) - 1
  const out: AbilityStat[] = []
  if (p.levels.hp_bonus[i]) out.push({ label: 'Max HP', value: `+${num(p.levels.hp_bonus[i])}` })
  if (p.levels.hp_regen[i]) out.push({ label: 'Regeneration', value: `+${num(p.levels.hp_regen[i])}/s` })
  if (p.levels.kb_reduction[i]) out.push({ label: 'Knockback taken', value: `−${Math.round(p.levels.kb_reduction[i] * 100)}%` })
  if (p.levels.speed_bonus_abs[i]) out.push({ label: 'Move speed', value: `+${num(p.levels.speed_bonus_abs[i])}` })
  if (p.levels.debuff_factor[i]) out.push({ label: 'Debuffs on you', value: `×${num(1 + p.levels.debuff_factor[i])}` })
  return out
}

/** A stat as the shop shows it: the current value, and the next level's when it changes. */
export interface StatDelta {
  label: string
  value: string
  next?: string
}

/** Stats at `level` with the values the next level changes (undefined `next` = unchanged or max). */
export function abilityDelta(id: SpellId, level: number, maxLevel: number, rangeLevel = 0): StatDelta[] {
  const now = abilityStats(id, level, rangeLevel)
  if (level < 1 || level >= maxLevel) return now
  const nxt = abilityStats(id, level + 1, rangeLevel)
  return now.map((s) => {
    const n = nxt.find((x) => x.label === s.label)
    return n && n.value !== s.value ? { ...s, next: n.value } : s
  })
}

/** Max level of a spell or item. */
export function maxLevelOf(id: SpellId): number {
  const def = spellDef(id)
  if (def) return def.kind === 'spell' ? SPELL_MAX_LEVEL : def.maxLevel
  return PASSIVE_ITEMS[id]?.maxLevel ?? 1
}
