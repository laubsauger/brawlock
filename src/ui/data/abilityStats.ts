/**
 * Key numbers for the ability card (shop, HUD spell bar and item slots), read
 * from the sim's spell table for a level: damage, knockback, cooldown, range
 * or area, cast time, duration and each spell's special values. Scaling follows
 * the spell behaviors, including the spells whose placement/dash range is fixed.
 * Context is supplied by the caller, never read from a live global during inspection.
 */
import { PASSIVE_ITEMS, SPELL_MAX_LEVEL, attr, cooldownSeconds, masteryFactor, spellDef, type SpellId } from '../../sim'
import { debuffFactor, type MasteryKind } from '../../sim/stats'
import type { ModifierState } from '../../sim/types'
import { ITEM_SLOT_START } from '../../sim/config'

/** Explicit owner context. Historical inspection passes only its committed kit. */
export interface AbilityStatContext {
  readonly masteries?: Readonly<Partial<Record<MasteryKind, number>>>
  readonly loadout?: { readonly slots: readonly (SpellId | null)[]; readonly levels: readonly number[] }
  readonly modifiers?: readonly ModifierState[]
  readonly damageMultiplier?: number
  readonly knockbackMultiplier?: number
}

export interface AbilityStat {
  label: string
  value: string
  note?: string
}

const num = (n: number, digits = 2) => (Number.isInteger(n) ? String(n) : n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, ''))
const secs = (n: number) => `${num(n)}s`

/**
 * Per-spell special values worth showing, by sim key. Values are formatted
 * from the data; keys missing on a spell are skipped.
 */
const SPECIALS: { key: string; label: string; fmt: (v: number) => string }[] = [
  { key: 'self_buff_duration', label: 'Self buff lasts', fmt: secs },
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
  { key: 'damage_decay', label: 'Damage per bounce', fmt: (v) => `×${num(v)}` },
  { key: 'lifetime_bonus', label: 'Extra flight time', fmt: secs },
]

const TARGET_DEBUFF_NOTE = 'Before the target’s debuff modifiers.'
const ALLY_DURATION_NOTE = 'Other allies also apply their own Duration mastery.'

function ownDebuffFactor(ctx: AbilityStatContext, preview?: { id: SpellId; level: number }): number {
  const slots = ctx.loadout?.slots ?? []
  const levels = ctx.loadout?.levels ?? []
  const factor = debuffFactor({ slots, levels, modifiers: ctx.modifiers ?? [] })
  if (preview) {
    const item = PASSIVE_ITEMS[preview.id]
    const slot = slots.findIndex((id, i) => i >= ITEM_SLOT_START && id === preview.id)
    const oldLevel = slot < 0 ? 0 : levels[slot]
    const old = oldLevel > 0 ? item.levels.debuff_factor[Math.min(oldLevel, item.maxLevel) - 1] : 0
    return factor - old + item.levels.debuff_factor[Math.min(preview.level, item.maxLevel) - 1]
  }
  return factor
}

/** Maximum commanded/travel range from each behavior, not merely a similarly named KV field. */
function effectiveRange(def: NonNullable<ReturnType<typeof spellDef>>, level: number, factor: number): number | null {
  const a = (key: string) => attr(def, key, level)
  switch (def.id) {
    case 'teleport': case 'meteor': case 'warpzone': case 'rockpillar': case 'thrust':
      return a('range')
    case 'splitter': return a('speed') * a('max_time') * factor
    case 'swap': return a('speed') * a('max_time') * factor
    case 'grip': case 'magnetize': case 'recharge': return a('speed') * a('lifetime') * factor
    case 'bouncer': return a('speed') * a('ttl') * factor
    default: {
      const range = has(def, 'range', level)
      return range === null ? null : range * factor
    }
  }
}

/** Value of a sim attribute that exists on this spell (consts or per-level), else null. */
function has(def: NonNullable<ReturnType<typeof spellDef>>, key: string, level: number): number | null {
  if (def.consts[key] === undefined && !def.levels[key]?.length) return null
  return attr(def, key, level)
}

/**
 * Stats for a spell or item at a level (1-based; 0 is shown as level 1, what
 * buying gives you). A numeric context retains the old Range-level-only API.
 */
export function abilityStats(id: SpellId, level: number, context: number | AbilityStatContext = {}): AbilityStat[] {
  const ctx: AbilityStatContext = typeof context === 'number' ? { masteries: { range: context } } : context
  const rm = masteryFactor('range', ctx.masteries?.range ?? 0)
  const dm = masteryFactor('duration', ctx.masteries?.duration ?? 0)
  const lvl = Math.max(1, level)
  const def = spellDef(id)
  if (def) {
    const out: AbilityStat[] = []
    const pact = (ctx.modifiers ?? []).filter((m) => m.id === 'pact').reduce((factor, m) => factor * m.data.mult, 1)
    const damageScale = ctx.damageMultiplier ?? 1
    const castDamage = (value: number) => value * pact
    const dealtDamage = (value: number) => castDamage(value) * damageScale
    const dmg = has(def, 'damage', lvl)
    if (dmg) {
      const streak = id === 'recharge' ? (ctx.modifiers?.find((m) => m.id === 'rechargeStreak')?.data.streak ?? 0) : 0
      const effective = (castDamage(dmg) + attr(def, 'damage_per_consecutive', lvl) * streak) * damageScale
      out.push({ label: id === 'gravity' || id === 'link' || id === 'snowball' ? 'Damage / second' : 'Damage', value: num(effective, 1),
        note: id === 'thrust' ? 'Maximum at full dash speed, before target damage reduction.' : 'Before target damage reduction.' })
    }
    // area falloff (Meteor: edge to centre; Snowball's burst at the end)
    const dMin = has(def, 'damage_min', lvl)
    const dMax = has(def, 'damage_max', lvl)
    if (dMax) out.push({ label: dmg ? 'Burst damage' : 'Damage', value: `${num(dealtDamage(dMin ?? 0), 1)}–${num(dealtDamage(dMax), 1)}`, note: 'Before target damage reduction.' })
    const kb = has(def, 'knockback_factor', lvl)
    const kbMin = has(def, 'kb_factor_min', lvl)
    const kbMax = has(def, 'kb_factor_max', lvl)
    const km = ctx.knockbackMultiplier ?? 1
    if (kb !== null) out.push({ label: 'Knockback', value: `×${num(kb * km)}`, note: 'Before target knockback resistance and accumulated points.' })
    else if (kbMin !== null && kbMax !== null) out.push({ label: 'Knockback', value: `×${num(kbMin * km)}–${num(kbMax * km)}`, note: 'Before target knockback resistance and accumulated points.' })
    const range = effectiveRange(def, lvl, rm)
    if (range) {
      out.push({ label: 'Range', value: num(Math.round(range)) })
    }
    // area of effect: per-level radius (a projectile's own collision radius is a constant, not shown)
    if (def.levels.radius?.length) out.push({ label: 'Area radius', value: num(attr(def, 'radius', lvl)) })
    const dur = has(def, 'duration', lvl)
    if (dur) {
      if (id === 'magnetize') {
        out.push({ label: 'Enemy duration', value: secs(dur * dm), note: TARGET_DEBUFF_NOTE })
        out.push({ label: 'Ally duration', value: secs(dur * dm), note: ALLY_DURATION_NOTE })
      } else {
        out.push({ label: 'Duration', value: secs(dur * dm), ...(id === 'grip' ? { note: TARGET_DEBUFF_NOTE } : {}) })
      }
    }
    const buff = has(def, 'buff_duration', lvl)
    if (buff) {
      out.push({ label: 'Enemy slow lasts', value: secs(buff * dm), note: TARGET_DEBUFF_NOTE })
      out.push({ label: 'Ally haste lasts', value: secs(buff * dm), note: ALLY_DURATION_NOTE })
    }
    if (def.cooldown.length) out.push({ label: 'Cooldown', value: secs(cooldownSeconds(def, lvl)) })
    out.push({ label: 'Cast time', value: def.immediate || def.castPoint === 0 ? 'Instant' : secs(def.castPoint) })
    for (const s of SPECIALS) {
      let v = has(def, s.key, lvl)
      if (v !== null && ['self_buff_duration'].includes(s.key)) v *= dm
      if (v !== null && ['slow_duration', 'kb_penalty_duration'].includes(s.key)) v *= ownDebuffFactor(ctx)
      if (v !== null && s.key === 'lifetime_bonus') v *= rm
      // Scourge level 1 spends its cast damage; higher levels spend the fixed cost.
      if (v !== null && s.key === 'self_cost' && id === 'scourge' && lvl === 1) v = castDamage(attr(def, 'damage', lvl))
      if (v !== null && v !== 0) out.push({ label: s.label, value: s.fmt(v) })
    }
    const ls = masteryFactor('lifesteal', ctx.masteries?.lifesteal ?? 0)
    if ((dmg || dMax) && ls > 0) out.push({ label: 'Lifesteal', value: `${num(ls * 100)}%`, note: 'Share of damage actually dealt.' })
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
  if (p.levels.debuff_factor[i]) {
    out.push({ label: 'Debuffs on you', value: `×${num(1 + p.levels.debuff_factor[i])}`, note: 'This item’s contribution; item and modifier changes add together.' })
    if (ctx.loadout) out.push({ label: 'Total debuff duration', value: `×${num(ownDebuffFactor(ctx, { id, level: lvl }))}` })
  }
  return out
}

/** A stat as the shop shows it: the current value, and the next level's when it changes. */
export interface StatDelta extends AbilityStat {
  next?: string
}

/** Stats at `level` with the values the next level changes (undefined `next` = unchanged or max). */
export function abilityDelta(id: SpellId, level: number, maxLevel: number, context: number | AbilityStatContext = {}): StatDelta[] {
  const now = abilityStats(id, level, context)
  if (level < 1 || level >= maxLevel) return now
  const nxt = abilityStats(id, level + 1, context)
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
