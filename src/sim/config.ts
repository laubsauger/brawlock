/**
 * Original constants (docs/research/systems.md §13, spells.md §1) and lobby defaults.
 * Seconds stay seconds here; convert with `ticks()` at the use site.
 */
import { DT, ORIGINAL_TICK, TICK_HZ } from './types'
import type { MatchSettings } from './types'
import { exp, log } from './math'

// --- pawn ------------------------------------------------------------------
export const PAWN_MAX_LIFE = 1000
export const PAWN_MOVE_SPEED = 210
/** HP per second */
export const PAWN_HEALTH_REG = 5
/** knockback points per second (Dota hero StatusManaRegen -0.04) */
export const PAWN_DP_REGEN = -0.04
export const PAWN_MASS = 100
export const PAWN_RADIUS = 30
export const PAWN_ELASTICITY = 0.5
/** cap on the derived walk velocity (Pawn.WALK_SPEED) */
export const PAWN_WALK_SPEED_CAP = 1000
/** Dota MovementTurnRate: radians per 0.03 s */
export const PAWN_TURN_RATE = 1.2
export const DOTA_TURN_INTERVAL = 0.03
/** radians the pawn turns per sim tick (1.2 rad / 0.03 s = 40 rad/s) */
export const TURN_PER_TICK = (PAWN_TURN_RATE * DT) / DOTA_TURN_INTERVAL
/**
 * The pawn only walks (and a cast point only starts) once facing is within this angle of the
 * desired direction. Dota's own tolerance is about 0.2 rad (~11.5 deg); the original inherited
 * it from the engine, so we use the same.
 */
export const FACING_TOLERANCE = 0.2
/** distance under which a move order counts as arrived */
export const ARRIVE_EPSILON = 1

export const KB_DMG_TO_VELOCITY = 10
export const SPAWN_INVULN_SECONDS = 2

// --- world / arena -----------------------------------------------------------
export const GAME_ARENA_RADIUS = 5910
export const ARENA_TILE_SIZE = 192
export const ARENA_MAX_COORD = 20
export const ARENA_MAX_LAYER = 21
export const ARENA_RADIUS_PER_LAYER = 100
export const ARENA_BASE_LAYER = 13
export const ARENA_LAYER_PER_PLAYER = 1
export const ARENA_SPAWN_INSET = 600
/** platform layer during the shop phase (13 + 1) */
export const ARENA_SHOP_LAYER = ARENA_BASE_LAYER + ARENA_LAYER_PER_PLAYER
export const SHRINK_PERIOD = 10
export const LAVA_DAMAGE_PERIOD = 0.25
export const LAVA_KB_POINT_FACTOR = 0.5

// --- obstacles -----------------------------------------------------------------
export const OBSTACLE_MASS = 10000
export const OBSTACLE_HP = 400
export const OBSTACLE_ELASTICITY = 0.5
export const OBSTACLE_EXPLODE_RADIUS = 300
export const OBSTACLE_EXPLODE_DMG_MIN = 5
export const OBSTACLE_EXPLODE_DMG_GAIN = 5
export const OBSTACLE_MAX_COORD = 1000
export const OBSTACLE_COUNT_MIN = 2
export const OBSTACLE_COUNT_MAX = 8
/** collision radius per variant, per theme (ruins, rocks, debris) */
export const OBSTACLE_RADII: readonly (readonly number[])[] = [
  [60, 60, 60, 60, 60],
  [70, 45, 60, 40],
  [50, 50, 35, 35, 50],
]
/**
 * M0: obstacles are fully simulated (collision, damage, explosion) but not spawned, because
 * render has no pillar art yet. Flip to true for the faithful 2-8 random pillars per round.
 */
export const SPAWN_OBSTACLES = false

// --- rounds / shop -------------------------------------------------------------
export const ROUND_END_SECONDS = 2
/** Faithful: the original never closes the shop server-side (PLAN §11 open decision). */
export const SHOP_ANY_PHASE = true
export const SPELL_MAX_LEVEL = 7
export const MASTERY_MAX_LEVEL = 6
export const MASTERY_COST = 5
export const MASTERY_ALL_COST = 13
/** cumulative gain per level: duration, range, lifesteal (Shop.MASTERY_GAIN) */
export const MASTERY_GAIN = {
  duration: [0.1, 0.08, 0.07, 0.06, 0.05, 0.04],
  range: [0.12, 0.1, 0.09, 0.08, 0.07, 0.06],
  lifesteal: [0.09, 0.08, 0.07, 0.06, 0.05, 0.04],
} as const
export const MAX_ITEMS = 6

// --- slots -----------------------------------------------------------------------
/** 0..5 spell columns, 6..11 item slots */
export const SLOT_COUNT = 12
export const SPELL_COLUMNS = 6
export const ITEM_SLOT_START = 6
export const FIREBALL_SLOT = 6
export const SCOURGE_SLOT = 7

/** roundWin.team for a draw (nobody alive) */
export const TEAM_DRAW = -1

export const DEFAULT_SETTINGS: MatchSettings = {
  teamMode: 'ffa',
  gameMode: 'rounds',
  winScore: 11,
  startGold: 30,
  roundGold: 10,
  killGold: 0,
  winGold: 0,
  lavaDps: 100,
  kbMultiplier: 1,
  dmgMultiplier: 1,
  friction: 0.96,
  shopSeconds: 30,
  botsReplaceLeavers: true,
}

/** Seconds to whole sim ticks (rounded to nearest). */
export function ticks(seconds: number): number {
  return Math.round(seconds * TICK_HZ)
}

/**
 * Original friction is applied once per 0.035 s tick. Per 60 Hz tick:
 * friction ** (DT / ORIGINAL_TICK), via the deterministic exp/log from math.ts (not Math.pow,
 * whose last bit is engine dependent). Exact per-second decay = friction ** (1 / 0.035).
 */
export function frictionPerTick(friction: number): number {
  if (friction <= 0) return 0
  if (friction === 1) return 1
  return exp(log(friction) * (DT / ORIGINAL_TICK))
}

/** Per-original-tick quantities (push-out) scaled to one sim tick. */
export const ORIGINAL_TICK_SCALE = DT / ORIGINAL_TICK
