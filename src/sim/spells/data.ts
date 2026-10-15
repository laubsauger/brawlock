/**
 * Spell and item data for every original spell (docs/research/spells.md §2.2, §8, §11).
 * Numbers only; behavior lives in sim/spells/*.ts.
 *
 * Release gate: a spell is only buyable once sim behavior, tests AND its VFX ship together.
 * RELEASED_SPELLS (below) is that list; the coordinator adds ids as render lands their VFX.
 * IMPLEMENTED_SPELLS (spells/index.ts) = has sim behavior (used by tests).
 *
 * Attribute lookup follows the original (`CastInfo:attribute`): a class constant wins over
 * a per-level KV value of the same name; a missing name reads as 0.
 */
import type { SpellId } from '../types'

/** Buyable in the shop (sim + tests + VFX done). Spell, active item and passive item ids. */
export const RELEASED_SPELLS: ReadonlySet<SpellId> = new Set<SpellId>([
  'fireball',
  'scourge',
  'teleport',
  // column 4-6 spells whose VFX passed review (2026-10-15)
  'meteor',
  'snowball',
  'windwalk',
  'shield',
  'rush',
  'alteration',
  'gravity',
  'warpzone',
  'magnetize',
  // passive stat items (no VFX needed)
  'ring_of_health',
  'cursed_ring',
  'cape',
  'armor',
  'boots',
  'pocket_watch',
])

export interface SpellDef {
  id: SpellId
  name: string
  /** 'spell' = shop column ability, 'item' = active inventory item */
  kind: 'spell' | 'item'
  /** shop column 1..6 for spells, 0 for items */
  column: number
  /** spells: buy cost. items: cost per level (buying an owned item upgrades it) */
  cost: number
  /** spells only: cost to go from level L to L+1 at index L-1 (6 entries) */
  upgradeCosts: readonly number[]
  maxLevel: number
  target: 'point' | 'none'
  /** DOTA_ABILITY_BEHAVIOR_IMMEDIATE: fires on the order, no turn, no cast point */
  immediate: boolean
  /** DOTA_ABILITY_BEHAVIOR_IGNORE_TURN: no turn before the cast point */
  ignoreTurn: boolean
  /** seconds (AbilityCastPoint) */
  castPoint: number
  /** real cooldown per level, seconds (KV AbilityCooldown) */
  cooldown: readonly number[]
  /** tooltip cooldown (`cooldown2`) where it differs from the real one */
  tooltipCooldown?: readonly number[]
  /** per-level KV specials */
  levels: Readonly<Record<string, readonly number[]>>
  /** class constants (win over `levels`) */
  consts: Readonly<Record<string, number>>
  /** purchasable now (= RELEASED_SPELLS.has(id)); kept under this name for the UI catalog */
  implemented: boolean
}

const UP_6 = [6, 7, 8, 9, 10, 11] as const
const UP_7 = [7, 8, 9, 10, 11, 12] as const
const UP_8 = [8, 9, 10, 11, 12, 13] as const
const UP_5 = [5, 6, 7, 8, 9, 10] as const

const rep = (v: number, n = 7): number[] => Array.from({ length: n }, () => v)

function spell(
  id: SpellId,
  name: string,
  column: number,
  cost: number,
  upgradeCosts: readonly number[],
  o: Partial<SpellDef> & Pick<SpellDef, 'cooldown' | 'castPoint' | 'target'>,
): SpellDef {
  return {
    id,
    name,
    kind: 'spell',
    column,
    cost,
    upgradeCosts,
    maxLevel: 7,
    immediate: false,
    ignoreTurn: false,
    levels: {},
    consts: {},
    ...o,
    implemented: RELEASED_SPELLS.has(id),
  }
}

function item(
  id: SpellId,
  name: string,
  cost: number,
  maxLevel: number,
  o: Partial<SpellDef> & Pick<SpellDef, 'cooldown' | 'castPoint' | 'target'>,
): SpellDef {
  return {
    id,
    name,
    kind: 'item',
    column: 0,
    cost,
    upgradeCosts: [],
    maxLevel,
    immediate: false,
    ignoreTurn: false,
    levels: {},
    consts: {},
    ...o,
    implemented: RELEASED_SPELLS.has(id),
  }
}

const DEFS: SpellDef[] = [
  // ---- items (granted or bought) ------------------------------------------------
  item('fireball', 'Fireball', 7, 7, {
    target: 'point',
    castPoint: 0.2,
    cooldown: rep(4.8),
    levels: { damage: [70, 77, 84, 91, 98, 105, 112], range: rep(1000) },
    consts: { speed: 1000, radius: 25, knockback_factor: 1 },
  }),
  item('scourge', 'Scourge', 7, 3, {
    target: 'none',
    castPoint: 0.9,
    cooldown: rep(3, 3),
    levels: { damage: [100, 110, 120], radius: [250, 250, 250], dp_reduce: [0, 20, 30] },
    consts: { kb_factor_min: 0.75, kb_factor_max: 1, self_cost: 100 },
  }),
  item('redirector', 'Redirector', 8, 1, {
    target: 'point',
    castPoint: 0.2,
    cooldown: [24],
    levels: { kb_penalty: [-0.3], kb_penalty_duration: [8] },
    consts: { lifetime_bonus: 0.5 },
  }),
  item('pact', 'Pact', 10, 1, {
    target: 'none',
    castPoint: 0.2,
    cooldown: [30],
    levels: { duration: [5], damage_multiplier: [1.5], speed_reduction: [66], slow_duration: [6] },
  }),

  // ---- column 1: knockout ---------------------------------------------------------
  spell('boomerang', 'Boomerang', 1, 11, UP_7, {
    target: 'point',
    castPoint: 0.2,
    cooldown: [16, 13.9, 12.5, 11.7, 11, 10.3, 9.6],
    levels: { damage: [70, 76, 82, 88, 94, 100, 106], range: rep(800) },
    consts: { radius: 38, knockback_factor: 0.95, launch_speed: 1500, lateral_speed: 300, min_dist: 300, return_speed: 1000, return_accel: 1000, return_dist: 75 },
  }),
  spell('lightning', 'Lightning', 1, 11, UP_8, {
    target: 'point',
    castPoint: 0.2,
    cooldown: [16.5, 15.5, 15, 14.5, 14, 13.5, 13],
    levels: { damage: [70, 78, 86, 94, 102, 110, 118], range: rep(600) },
    consts: { beam_radius: 25, knockback_factor: 0.92, fb_radius: 225, fb_knockback_factor: 1.35 },
  }),
  spell('homing', 'Homing', 1, 11, UP_8, {
    target: 'point',
    castPoint: 0.2,
    cooldown: [16.5, 14.5, 13, 12, 11, 10, 9],
    tooltipCooldown: [15, 13.5, 12.5, 12, 11.5, 11, 10.5],
    levels: { damage: [70, 80, 90, 100, 110, 120, 130], range: rep(4500) },
    consts: { radius: 30, speed: 1000, launch_speed: 800, spawn_offset: 64, steer: 0.03, self_radius: 292, self_kb: 0.9, self_speed_bonus: 50, self_speed_bonus_thrust: 120, self_buff_duration: 4 },
  }),
  spell('twin', 'Twin', 1, 12, UP_7, {
    target: 'point',
    castPoint: 0.2,
    cooldown: [16, 13.9, 12.5, 11.7, 11, 10.3, 9.6],
    tooltipCooldown: [14, 13.4, 12.8, 12.2, 11.6, 11, 10.4],
    levels: { damage: [44, 48, 52, 56, 62, 66, 72], range: rep(800) },
    consts: { radius: 35, ellipse_area: 202500, path_speed: 1000, knockback_factor: 1 },
  }),

  // ---- column 2: transport --------------------------------------------------------
  spell('teleport', 'Teleport', 2, 12, UP_6, {
    target: 'point',
    immediate: true,
    castPoint: 0,
    cooldown: [16, 13.5, 11.5, 10, 9, 8, 7],
    levels: { range: [770, 840, 910, 980, 1050, 1120, 1190] },
    consts: { velocity_keep: 0.8 },
  }),
  spell('thrust', 'Thrust', 2, 11, UP_6, {
    target: 'point',
    immediate: true,
    castPoint: 0,
    cooldown: [16.5, 14.5, 13, 12, 11, 10, 9],
    levels: { damage: [50, 55, 60, 65, 70, 75, 80] },
    consts: { velocity: 1300, launch_factor: 0.77, acceleration: 1733.3333333333333, radius: 60, range: 900, extra_time: 0.09, knockback_factor: 1.2, miss_brake: 0.2 },
  }),
  spell('swap', 'Swap', 2, 11, UP_6, {
    target: 'point',
    immediate: true,
    castPoint: 0,
    cooldown: [15.8, 13.3, 11.3, 9.8, 8.8, 7.8, 7],
    consts: { speed: 1983, radius: 40, max_time: 0.4706 },
  }),

  // ---- column 3: damage -----------------------------------------------------------
  spell('cluster', 'Cluster', 3, 14, UP_6, {
    target: 'point',
    castPoint: 0.2,
    cooldown: [15.5, 14.75, 14, 13.25, 12.5, 11.75, 11],
    levels: { damage: [33, 36, 39, 42, 45, 48, 51], range: rep(672) },
    consts: { speed: 844, radius: 22, knockback_factor: 0.65, spread_inner: 0.06, spread_outer: 0.18 },
  }),
  spell('drain', 'Drain', 3, 14, UP_6, {
    target: 'point',
    castPoint: 0.2,
    cooldown: [22, 21, 20, 19, 18, 17, 16],
    levels: { damage: [60, 70, 80, 90, 100, 110, 120], buff_duration: [4, 5, 6, 7, 8, 9, 10] },
    // the original read a missing `coll_radius` (= 0, a point); v1 uses the defined 24.5 (§12.3)
    consts: { projectile_speed: 700, changed_speed: 600, radius: 24.5, range: 850, extra_time: 1.2, knockback_factor: 0.2, speed_change: 50, heal_speed: 650, heal_dist: 64 },
  }),
  spell('bouncer', 'Bouncer', 3, 14, UP_6, {
    target: 'point',
    castPoint: 0.2,
    cooldown: [19, 18, 17, 16, 15, 14, 13],
    levels: { damage: [54, 62, 70, 78, 86, 94, 102], max_hits: [5, 6, 6, 6, 7, 7, 7], range: rep(900) },
    consts: { speed: 900, radius: 38, ttl: 1, knockback_factor: 1.2, damage_decay: 0.7, min_damage: 10 },
  }),
  spell('recharge', 'Recharge', 3, 13, UP_6, {
    target: 'point',
    castPoint: 0.2,
    cooldown: [23.5, 22, 21, 20.5, 20, 19.5, 19],
    levels: { damage: [60, 67, 74, 81, 88, 95, 102] },
    consts: { speed: 900, radius: 35, lifetime: 1, damage_per_consecutive: 10, refresh_speed: 400, refresh_dist: 64, knockback_factor: 1 },
  }),

  // ---- column 4: devastator -------------------------------------------------------
  spell('windwalk', 'Windwalk', 4, 14, UP_6, {
    target: 'none',
    immediate: true,
    castPoint: 0,
    cooldown: [29, 26, 23.5, 21, 19.5, 18.5, 17.5],
    levels: { damage: [54, 60, 66, 72, 78, 84, 90], duration: rep(2.6), move_bonus: rep(200) },
    consts: { radius: 60, knockback_factor: 1, thrust_knockback_factor: 0.7 },
  }),
  spell('meteor', 'Meteor', 4, 14, UP_6, {
    target: 'point',
    castPoint: 0.2,
    cooldown: [20, 19.5, 19, 18.5, 18, 17.5, 17],
    levels: {
      damage_min: rep(40),
      damage_max: [110, 120, 130, 140, 150, 160, 170],
      radius: [225, 240, 255, 269, 282, 294, 304],
      range: rep(1000),
      hover_time: rep(0.55),
      fall_time: rep(0.6),
    },
    consts: { knockback_factor: 0.66, spawn_back: 400, spawn_z: 700 },
  }),
  spell('splitter', 'Splitter', 4, 15, UP_7, {
    target: 'point',
    ignoreTurn: true,
    castPoint: 0,
    cooldown: [24, 23, 22, 21, 20, 19, 18],
    levels: { damage: [30, 35, 40, 45, 50, 55, 60], range: rep(900) },
    consts: { speed: 700, radius: 50, max_time: 1, spawner_speed: 250, spawner_time: 0.48, waves: 4, child_speed: 600, child_radius: 21, child_time: 1.2, knockback_factor: 1 },
  }),
  spell('snowball', 'Snowball', 4, 14, UP_6, {
    target: 'point',
    castPoint: 0.2,
    cooldown: [19, 18, 17, 16, 15, 14, 13],
    levels: {
      damage: [30, 35, 40, 45, 50, 55, 60],
      damage_min: rep(0),
      damage_max: [45, 60, 75, 90, 105, 120, 135],
      coll_radius: [75, 77, 79, 81, 83, 85, 87],
      radius: rep(200),
      range: rep(575),
    },
    consts: { speed: 400, knockback_factor: 0.8, drag_speed: 425, slow: 100, dot_period: 0.5 },
  }),

  // ---- column 5: defense ----------------------------------------------------------
  spell('shield', 'Shield', 5, 12, UP_6, {
    target: 'none',
    immediate: true,
    castPoint: 0,
    cooldown: [14, 13, 12, 11, 10, 9, 8],
    levels: { duration: rep(1.2), radius: [200, 210, 220, 230, 240, 250, 260] },
  }),
  spell('rush', 'Rush', 5, 12, UP_6, {
    target: 'none',
    immediate: true,
    castPoint: 0,
    cooldown: [21, 20, 19, 18, 17, 16, 15],
    levels: { duration: [6, 6.5, 7, 7.5, 8, 8.5, 9], absorb_max: [50, 70, 90, 110, 130, 150, 170] },
    consts: { initial_speed_bonus: 35, absorb_ratio: 0.5, speed_per_absorbed: 1.5 },
  }),
  spell('alteration', 'Alteration', 5, 11, UP_5, {
    target: 'none',
    immediate: true,
    castPoint: 0,
    cooldown: [19, 17.5, 16, 14.5, 13, 11.5, 10],
    levels: { duration: rep(2), radius: rep(120) },
  }),

  // ---- column 6: knockbackless ----------------------------------------------------
  spell('gravity', 'Gravity', 6, 12, UP_7, {
    target: 'point',
    castPoint: 0.2,
    cooldown: [21, 20.5, 20, 19.5, 19, 18.5, 18],
    levels: { strength: [500, 530, 560, 590, 620, 650, 680], damage: [20, 33.33, 46.67, 60, 73.33, 86.67, 100], range: rep(900) },
    consts: { speed: 450, radius: 25, pawn_pull_radius: 550, projectile_pull_radius: 600, projectile_pull: 1650, dps_radius: 250, dps_period: 0.2 },
  }),
  spell('grip', 'Grip', 6, 12, UP_6, {
    target: 'point',
    castPoint: 0.2,
    cooldown: [24, 20, 17, 15, 13, 12, 10.5],
    levels: { duration: [4.5, 4.75, 5, 5.25, 5.5, 5.75, 6], dp_gain: rep(5) },
    consts: { speed: 1000, radius: 39, lifetime: 1.1, kb_reduction: 0.67, speed_bonus: -10000 },
  }),
  spell('warpzone', 'Warpzone', 6, 12, UP_6, {
    target: 'point',
    castPoint: 0.2,
    cooldown: [23, 21, 20, 19, 18, 17, 16],
    tooltipCooldown: [30, 29, 28, 27, 26, 25, 24],
    levels: { time_scale: [0.4, 0.36, 0.32, 0.28, 0.24, 0.2, 0.16], radius: [200, 210, 220, 230, 240, 250, 260], duration: rep(4.5), range: rep(700) },
  }),
  spell('magnetize', 'Magnetize', 6, 14, UP_5, {
    target: 'point',
    castPoint: 0.2,
    cooldown: [22, 21, 20, 19, 18, 17, 16],
    tooltipCooldown: [20, 19, 18, 17, 16, 15, 14],
    levels: { duration: [3.5, 4, 4.5, 5, 5.5, 6, 6.5] },
    consts: { speed: 800, radius: 36, lifetime: 1.2, field_radius: 300, field_strength: 0.2 },
  }),
  spell('rockpillar', 'Rockpillar', 6, 13, UP_5, {
    target: 'point',
    castPoint: 0.2,
    cooldown: [26, 24, 22, 20, 18, 16, 14],
    tooltipCooldown: [24, 22, 20, 18, 16, 14, 12],
    levels: { range: [650, 725, 800, 875, 950, 1025, 1100], duration: rep(4) },
    consts: { radius: 90, hp: 400 },
  }),
  spell('link', 'Link', 6, 12, UP_6, {
    target: 'point',
    castPoint: 0.2,
    // KV has 6 values; Dota reuses the last for Lv7 (spells.md §12.4)
    cooldown: [17, 15, 13, 11, 9, 7, 7],
    tooltipCooldown: [20, 18, 16, 14, 12, 10, 8],
    levels: { damage: [12, 20, 28, 36, 44, 52, 60] },
    consts: { radius: 35, speed: 950, range: 860, pull_accel: 1550, break_dist: 100, break_dist_obstacle: 120, return_dist: 75, dps_period: 0.2 },
  }),
]

export const SPELLS: Readonly<Record<SpellId, SpellDef>> = Object.fromEntries(DEFS.map((d) => [d.id, d]))

/** Every spell/item id in catalog order (items first, then columns 1..6). */
export const SPELL_IDS: readonly SpellId[] = DEFS.map((d) => d.id)

export function spellDef(id: SpellId): SpellDef | undefined {
  return SPELLS[id]
}

/** Original attribute lookup: class constant, else per-level value, else 0. */
export function attr(def: SpellDef, name: string, level: number): number {
  const c = def.consts[name]
  if (c !== undefined) return c
  const arr = def.levels[name]
  if (!arr || arr.length === 0) return 0
  const i = Math.min(Math.max(level, 1), arr.length) - 1
  return arr[i]
}

export function cooldownSeconds(def: SpellDef, level: number): number {
  const i = Math.min(Math.max(level, 1), def.cooldown.length) - 1
  return def.cooldown[i]
}

// ---------------------------------------------------------------------------
// Passive items (systems.md §3.1): stat modifiers applied by stats.ts recomputeStats.
// ---------------------------------------------------------------------------

export interface PassiveItemDef {
  id: string
  name: string
  cost: number
  maxLevel: number
  /** absolute per-level stat deltas (not additive between levels) */
  levels: Readonly<Record<'hp_bonus' | 'hp_regen' | 'kb_reduction' | 'speed_bonus_abs' | 'debuff_factor', readonly number[]>>
  /** purchasable now (= RELEASED_SPELLS.has(id)) */
  implemented: boolean
}

const z = (n: number): number[] => rep(0, n)

export const PASSIVE_ITEMS: Readonly<Record<string, PassiveItemDef>> = {
  ring_of_health: {
    id: 'ring_of_health',
    name: 'Ring of Health',
    cost: 4,
    maxLevel: 5,
    levels: { hp_bonus: [100, 190, 270, 340, 400], hp_regen: z(5), kb_reduction: z(5), speed_bonus_abs: z(5), debuff_factor: z(5) },
    implemented: RELEASED_SPELLS.has('ring_of_health'),
  },
  cursed_ring: {
    id: 'cursed_ring',
    name: 'Cursed Ring',
    cost: 4,
    maxLevel: 2,
    levels: { hp_bonus: [100, 200], hp_regen: z(2), kb_reduction: [0.15, 0.15], speed_bonus_abs: z(2), debuff_factor: [0.25, 0.3] },
    implemented: RELEASED_SPELLS.has('cursed_ring'),
  },
  cape: {
    id: 'cape',
    name: 'Cape',
    cost: 3,
    maxLevel: 3,
    // server values; the original shop UI showed 2 / 3.5 / 4.5 (systems.md §3.1)
    levels: { hp_bonus: z(3), hp_regen: [1.5, 2.5, 3.5], kb_reduction: z(3), speed_bonus_abs: z(3), debuff_factor: z(3) },
    implemented: RELEASED_SPELLS.has('cape'),
  },
  armor: {
    id: 'armor',
    name: 'Armor',
    cost: 6,
    maxLevel: 3,
    levels: { hp_bonus: z(3), hp_regen: z(3), kb_reduction: [0.12, 0.18, 0.22], speed_bonus_abs: z(3), debuff_factor: z(3) },
    implemented: RELEASED_SPELLS.has('armor'),
  },
  boots: {
    id: 'boots',
    name: 'Boots',
    cost: 5,
    maxLevel: 3,
    levels: { hp_bonus: z(3), hp_regen: z(3), kb_reduction: z(3), speed_bonus_abs: [18, 29, 40], debuff_factor: z(3) },
    implemented: RELEASED_SPELLS.has('boots'),
  },
  pocket_watch: {
    id: 'pocket_watch',
    name: 'Pocket Watch',
    cost: 2,
    maxLevel: 2,
    levels: { hp_bonus: z(2), hp_regen: z(2), kb_reduction: z(2), speed_bonus_abs: z(2), debuff_factor: [-0.35, -0.45] },
    implemented: RELEASED_SPELLS.has('pocket_watch'),
  },
}
